//! 同步更新（BSU/ESU）渲染逻辑
//!
//! 借鉴 wezterm 的 BSU/ESU 设计（`terminalstate/mod.rs:1573-1589`）,
//! 但补齐 wezterm 委托给 mux 层的渲染延迟逻辑。
//!
//! 本架构在渲染管线层实现「延迟一帧渲染」逻辑:
//! - BSU 后渲染器不提交帧,等待 ESU
//! - ESU 后立即触发一次 flush
//! - BSU 后 200ms 超时强制 flush（防止 TUI 崩溃时永久卡帧）
//!
//! 本模块不依赖 `std::time::Instant`,用 `u64` 毫秒时间戳,
//! 避免核心层直接依赖系统时钟（由渲染层注入时间）。

/// 同步更新状态
///
/// 借鉴 IMPLEMENTATION-GUIDELINE §10.4 的 `SyncUpdateState` 设计:
/// - `synced`:是否处于 BSU 中
/// - `bsu_time_ms`:BSU 起始时间戳（毫秒,由渲染层注入）
/// - `esu_time_ms`:最近一次 ESU 时间戳
/// - `timeout_ms`:超时时间（默认 200ms）
#[derive(Debug, Clone, Copy)]
pub struct SyncUpdateState {
    /// 是否处于同步更新中
    synced: bool,
    /// BSU 起始时间戳（毫秒,由渲染层调用 `begin(now_ms)` 时传入）
    bsu_time_ms: Option<u64>,
    /// 最近一次 ESU 时间戳（毫秒）
    esu_time_ms: Option<u64>,
    /// 超时时间（毫秒,默认 200）
    timeout_ms: u64,
}

impl Default for SyncUpdateState {
    fn default() -> Self {
        Self {
            synced: false,
            bsu_time_ms: None,
            esu_time_ms: None,
            timeout_ms: 200,
        }
    }
}

impl SyncUpdateState {
    /// 创建同步更新状态,指定超时时间
    pub fn new(timeout_ms: u64) -> Self {
        Self {
            timeout_ms,
            ..Default::default()
        }
    }

    /// 开始同步更新（BSU）
    ///
    /// `now_ms`:当前时间戳（毫秒）,由渲染层（如 `std::time::Instant`）提供。
    /// 借鉴 wezterm BSU 入口（`mod.rs:1573-1589`）。
    pub fn begin(&mut self, now_ms: u64) {
        self.synced = true;
        self.bsu_time_ms = Some(now_ms);
    }

    /// 结束同步更新（ESU）
    ///
    /// `now_ms`:当前时间戳（毫秒）。
    /// 借鉴 wezterm ESU 入口。
    pub fn end(&mut self, now_ms: u64) {
        self.synced = false;
        self.bsu_time_ms = None;
        self.esu_time_ms = Some(now_ms);
    }

    /// 是否应触发 flush
    ///
    /// 返回 `true` 表示应立即提交帧:
    /// - 不在 BSU 中（`synced == false`）→ 正常渲染,立即 flush
    /// - 在 BSU 中且已超时 → 强制 flush（防止永久卡帧）
    ///
    /// `now_ms`:当前时间戳（毫秒）。
    pub fn should_flush(&self, now_ms: u64) -> bool {
        if !self.synced {
            // 不在同步更新中,正常 flush
            return true;
        }
        // 在同步更新中,检查是否超时
        if let Some(bsu_time) = self.bsu_time_ms {
            now_ms.saturating_sub(bsu_time) >= self.timeout_ms
        } else {
            // 没有 bsu_time（异常状态）,强制 flush
            true
        }
    }

    /// 离开 BSU 已过去多久（毫秒）
    ///
    /// 返回 `None` 表示从未 ESU 或仍在 BSU 中。
    pub fn elapsed_since_esu(&self, now_ms: u64) -> Option<u64> {
        self.esu_time_ms.map(|t| now_ms.saturating_sub(t))
    }

    /// 是否处于 BSU 中
    pub fn is_synced(&self) -> bool {
        self.synced
    }

    /// 重置状态
    pub fn reset(&mut self) {
        self.synced = false;
        self.bsu_time_ms = None;
        self.esu_time_ms = None;
    }

    /// 设置超时时间（毫秒）
    pub fn set_timeout(&mut self, timeout_ms: u64) {
        self.timeout_ms = timeout_ms;
    }

    /// 获取超时时间（毫秒）
    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_not_synced() {
        let state = SyncUpdateState::default();
        assert!(!state.is_synced());
        assert!(state.should_flush(0));
    }

    #[test]
    fn test_bsu_starts_sync() {
        let mut state = SyncUpdateState::default();
        state.begin(1000);
        assert!(state.is_synced());
    }

    #[test]
    fn test_bsu_blocks_flush() {
        let mut state = SyncUpdateState::default();
        state.begin(1000);
        // 刚进入 BSU,未超时,不应 flush
        assert!(!state.should_flush(1000));
        assert!(!state.should_flush(1100));
    }

    #[test]
    fn test_bsu_timeout_forces_flush() {
        let mut state = SyncUpdateState::default();
        state.begin(1000);
        // 超过 200ms 超时,应强制 flush
        assert!(state.should_flush(1201));
        assert!(state.should_flush(1500));
    }

    #[test]
    fn test_esu_ends_sync() {
        let mut state = SyncUpdateState::default();
        state.begin(1000);
        assert!(state.is_synced());
        state.end(1200);
        assert!(!state.is_synced());
        // ESU 后立即 flush
        assert!(state.should_flush(1200));
    }

    #[test]
    fn test_esu_timestamp() {
        let mut state = SyncUpdateState::default();
        state.begin(1000);
        state.end(1500);
        assert_eq!(state.elapsed_since_esu(1600), Some(100));
        assert_eq!(state.elapsed_since_esu(2000), Some(500));
    }

    #[test]
    fn test_reset() {
        let mut state = SyncUpdateState::default();
        state.begin(1000);
        state.end(1200);
        state.reset();
        assert!(!state.is_synced());
        assert_eq!(state.bsu_time_ms, None);
        assert_eq!(state.esu_time_ms, None);
        assert!(state.should_flush(0));
    }

    #[test]
    fn test_custom_timeout() {
        let mut state = SyncUpdateState::new(500);
        assert_eq!(state.timeout_ms(), 500);
        state.begin(1000);
        // 400ms 未超时
        assert!(!state.should_flush(1400));
        // 500ms 超时
        assert!(state.should_flush(1500));
    }

    #[test]
    fn test_bsu_esu_cycle() {
        let mut state = SyncUpdateState::default();
        // 正常渲染
        assert!(state.should_flush(0));
        // BSU
        state.begin(100);
        assert!(!state.should_flush(150));
        // ESU
        state.end(180);
        assert!(state.should_flush(200));
        // 再次 BSU
        state.begin(300);
        assert!(!state.should_flush(350));
        // 超时强制 flush
        assert!(state.should_flush(501));
    }
}