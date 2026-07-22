//! `VTActor` trait 桥接层
//!
//! fork 自 wezterm `vtparse/` 的状态机产生底层事件（`print`、`csi_dispatch` 等）,
//! 本模块定义一个高层 `Action` 枚举,把低层事件结构化,供后续 `escape/` 语义层消费。
//!
//! 分层（借鉴 wezterm `wezterm-escape-parser/src/lib.rs:42-62`）：
//! ```text
//! vtparse 状态机  →  VTActor trait（低层回调）
//!                          ↓
//!                    CollectingActor / SemanticActor
//!                          ↓
//!                    Action 枚举（结构化,供 state/ 应用）
//! ```
//!
//! 当前阶段 1.1 仅定义 `Action` 枚举 + 一个 `CollectingActor`（聚合所有事件到 `Vec<Action>`）,
//! 具体的 CSI/OSC/DCS/APC 语义解析在阶段 1.2 的 `escape/` 子模块实现。

use crate::parser::vtparse::{CsiParam, VTAction};

/// 高层结构化动作,把 vtparse 的低层回调聚合为终端语义层可消费的枚举。
///
/// 借鉴 wezterm `wezterm-escape-parser/src/lib.rs:42-62` 的 `Action` 设计,
/// 但更精简:本阶段只关心 Print / Control / CSI / Esc / Osc 五类,
/// DCS/APC 的图形协议语义在阶段 4（图形协议）展开。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// 打印单个可见字符
    Print(char),
    /// 打印一串可见字符（批量优化,减少堆分配）
    PrintString(String),
    /// C0 / C1 控制字符（LF / CR / BS / HT / BEL 等）
    Control(u8),
    /// CSI 派发:参数列表 + 是否截断 + 终结字节
    CsiDispatch {
        params: Vec<CsiParam>,
        parameters_truncated: bool,
        byte: u8,
    },
    /// ESC 派发:参数 + 中间字节 + 终结字节
    EscDispatch {
        params: Vec<i64>,
        intermediates: Vec<u8>,
        ignored_excess_intermediates: bool,
        byte: u8,
    },
    /// OSC 派发:分号分隔的参数列表（原始字节）
    OscDispatch(Vec<Vec<u8>>),
    /// DCS 派发（Sixel / 终端能力查询等）
    DcsHook {
        params: Vec<i64>,
        intermediates: Vec<u8>,
        ignored_excess_intermediates: bool,
        byte: u8,
    },
    DcsPut(u8),
    DcsUnhook,
    /// APC 派发（Kitty 图形协议入口）
    ApcDispatch(Vec<u8>),
}

impl Action {
    /// 把一个 `VTAction`（vtparse 低层输出）转成高层 `Action`。
    ///
    /// 这是阶段 1.1 的桥接核心:后续 `escape/` 语义层不再直接面对 `VTAction`,
    /// 而是面对本 `Action`,从而把"状态机"与"语义解析"彻底解耦。
    fn from_vt(vt: VTAction) -> Self {
        match vt {
            VTAction::Print(c) => Action::Print(c),
            VTAction::ExecuteC0orC1(b) => Action::Control(b),
            VTAction::CsiDispatch {
                params,
                parameters_truncated,
                byte,
            } => Action::CsiDispatch {
                params,
                parameters_truncated,
                byte,
            },
            VTAction::EscDispatch {
                params,
                intermediates,
                ignored_excess_intermediates,
                byte,
            } => Action::EscDispatch {
                params,
                intermediates,
                ignored_excess_intermediates,
                byte,
            },
            VTAction::OscDispatch(params) => Action::OscDispatch(params),
            VTAction::DcsHook {
                params,
                intermediates,
                ignored_excess_intermediates,
                byte,
            } => Action::DcsHook {
                params,
                intermediates,
                ignored_excess_intermediates,
                byte,
            },
            VTAction::DcsPut(b) => Action::DcsPut(b),
            VTAction::DcsUnhook => Action::DcsUnhook,
            VTAction::ApcDispatch(data) => Action::ApcDispatch(data),
        }
    }
}

/// 聚合型 Actor:把 vtparse 的所有低层回调收集到 `Vec<Action>`。
///
/// 阶段 1.1 用它做端到端验证（输入字节流 → Vec<Action>）;
/// 阶段 1.3 的 `state/performer.rs` 会用同样的 trait impl 直接驱动 `TerminalState`,
/// 而非先聚合再回放。
#[derive(Default)]
pub struct CollectingActor {
    pub actions: Vec<Action>,
}

impl CollectingActor {
    pub fn new() -> Self {
        Self { actions: Vec::new() }
    }

    /// 消费一个低层 `VTAction`,转成高层 `Action` 后追加到内部缓冲。
    pub fn push_vt(&mut self, vt: VTAction) {
        let action = Action::from_vt(vt);
        // 相邻 Print 合并为 PrintString,减少下游堆分配
        // （借鉴 wezterm-escape-parser Action::append_to 的优化思路）
        if let Action::Print(c) = &action {
            match self.actions.last_mut() {
                Some(Action::PrintString(s)) => {
                    s.push(*c);
                    return;
                }
                Some(Action::Print(prev)) => {
                    let mut s = String::new();
                    s.push(*prev);
                    s.push(*c);
                    self.actions.pop();
                    self.actions.push(Action::PrintString(s));
                    return;
                }
                _ => {}
            }
        }
        self.actions.push(action);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::vtparse::{CollectingVTActor, VTParser};

    /// 用 vtparse 解析一段字节流,通过 CollectingActor 聚合成 Vec<Action>。
    fn parse(input: &[u8]) -> Vec<Action> {
        // CollectingVTActor 产出 VTAction;我们再桥接到高层 Action
        let mut vt_collector = CollectingVTActor::default();
        {
            let mut parser = VTParser::new();
            parser.parse(input, &mut vt_collector);
        }
        let vt_actions = vt_collector.into_vec();
        let mut actor = CollectingActor::new();
        for vt in vt_actions {
            actor.push_vt(vt);
        }
        actor.actions
    }

    #[test]
    fn test_print_ascii() {
        let actions = parse(b"hello");
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0], Action::PrintString("hello".to_string()));
    }

    #[test]
    fn test_control_lf() {
        let actions = parse(b"a\nb");
        // a / \n / b 三段,LF 不合并
        assert!(actions.iter().any(|a| matches!(a, Action::Control(b'\n'))));
    }

    #[test]
    fn test_csi_sgr_reset() {
        // ESC [ 0 m  →  CSI dispatch,byte = b'm'
        let actions = parse(b"\x1b[0m");
        let csi = actions
            .iter()
            .find(|a| matches!(a, Action::CsiDispatch { .. }))
            .expect("should have a CsiDispatch");
        if let Action::CsiDispatch { byte, .. } = csi {
            assert_eq!(*byte, b'm');
        }
    }
}
