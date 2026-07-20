// 共享类型定义，对应 src/shared/types/index.ts
// 渲染进程与 Rust 后端通过 serde JSON 通信，字段名保持 snake_case 与 TS 一致需借助 serde rename
// 但 TS 端原本就是 camelCase，所以我们这里全部用 camelCase 字段名（Rust 标识符用 snake_case，serde rename_all）

use serde::{Deserialize, Serialize};

/// 连接类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionType {
    Ssh,
    Serial,
    Telnet,
    Bash,
}

/// 键盘锁状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardLockState {
    pub caps_lock: bool,
    pub num_lock: bool,
    pub scroll_lock: bool,
}

/// 日志配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogConfig {
    pub log_enabled: bool,
    pub log_path: String,
    pub log_with_timestamp: bool,
    pub log_split_by_size: bool,
    pub log_split_by_time: bool,
    pub log_max_size: u64,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            log_enabled: false,
            log_path: String::new(),
            log_with_timestamp: false,
            log_split_by_size: false,
            log_split_by_time: false,
            log_max_size: 10 * 1024 * 1024,
        }
    }
}

/// SSH 认证方式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SshAuthType {
    Password,
    PrivateKey,
    None,
}

/// SSH 连接配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    #[serde(rename = "type")]
    pub kind: String, // "ssh"
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: SshAuthType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_config: Option<LogConfig>,
}

/// 串口信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pnp_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friendly_name: Option<String>,
}

/// 串口校验位
/// 原实现用 String("none"/"even"/"odd"/"mark"/"space")在 serial.rs match,
/// "mark"/"space" 被静默降级为 Parity::None,与原 TS 声明的 5 种值不符。
/// 改用枚举 + serde rename,显式映射全部 5 种,序列化失败时报错而非静默降级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialParity {
    None,
    Even,
    Odd,
    Mark,
    Space,
}

/// 串口配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    #[serde(rename = "type")]
    pub kind: String, // "serial"
    pub id: String,
    pub name: String,
    pub path: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: SerialParity,
    pub flow_control: String, // none|hardware|software
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_config: Option<LogConfig>,
}

/// Telnet 连接配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelnetConfig {
    #[serde(rename = "type")]
    pub kind: String, // "telnet"
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_config: Option<LogConfig>,
}

/// Bash Shell 类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BashShellType {
    Auto,
    Cmd,
    Powershell,
}

/// 本地 Bash 连接配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BashConfig {
    #[serde(rename = "type")]
    pub kind: String, // "bash"
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<BashShellType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_config: Option<LogConfig>,
}

/// 连接配置联合体（用 untagged enum 对应 TS 的 union）
///
/// untagged enum 反序列化按变体顺序尝试匹配字段集,不看 `type` 字段值。
/// 各变体字段集差异足够区分(Ssh 有 host/port/username/auth_type,Serial 有 path/baud_rate,
/// Telnet 有 host/port,Bash 有 shell/cwd),正常前端发来的完整 config 不会误匹配。
/// 评审曾指出脆弱性:若前端漏发字段,理论上可能误匹配到字段最少的 Bash。
/// 但实际流程是前端先 load 拿到完整 SavedSession 再发回 create,字段不会丢。
/// 改 tagged enum 需各变体去掉 `kind: String` 字段 + manager.rs 的 `config.kind()` 改造,
/// 且前端 API 协议可能已依赖现有结构,权衡后保留 untagged 并明确限制。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConnectionConfig {
    Ssh(SshConfig),
    Serial(SerialConfig),
    Telnet(TelnetConfig),
    Bash(BashConfig),
}

impl ConnectionConfig {
    pub fn id(&self) -> &str {
        match self {
            ConnectionConfig::Ssh(c) => &c.id,
            ConnectionConfig::Serial(c) => &c.id,
            ConnectionConfig::Telnet(c) => &c.id,
            ConnectionConfig::Bash(c) => &c.id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            ConnectionConfig::Ssh(c) => &c.name,
            ConnectionConfig::Serial(c) => &c.name,
            ConnectionConfig::Telnet(c) => &c.name,
            ConnectionConfig::Bash(c) => &c.name,
        }
    }

    pub fn kind(&self) -> ConnectionType {
        match self {
            ConnectionConfig::Ssh(_) => ConnectionType::Ssh,
            ConnectionConfig::Serial(_) => ConnectionType::Serial,
            ConnectionConfig::Telnet(_) => ConnectionType::Telnet,
            ConnectionConfig::Bash(_) => ConnectionType::Bash,
        }
    }

    pub fn log_config(&self) -> Option<&LogConfig> {
        match self {
            ConnectionConfig::Ssh(c) => c.log_config.as_ref(),
            ConnectionConfig::Serial(c) => c.log_config.as_ref(),
            ConnectionConfig::Telnet(c) => c.log_config.as_ref(),
            ConnectionConfig::Bash(c) => c.log_config.as_ref(),
        }
    }
}

/// 会话状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

/// 主机密钥验证请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyVerifyRequest {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub changed: bool,
}

/// SSH 密码输入请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordRequest {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub prompt: String,
    pub retry: bool,
}

/// SSH 密钥生成结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPairResult {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 可用 Shell 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    #[serde(rename = "type")]
    pub kind: BashShellType,
    pub label: String,
    pub available: bool,
}

/// SFTP 文件条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpFileEntry {
    pub filename: String,
    pub longname: String,
    pub attrs: SftpFileAttrs,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpFileAttrs {
    pub size: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub atime: i64,
    pub mtime: i64,
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symbolic_link: bool,
}

/// SFTP 操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpResult {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 视图状态
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
    pub sidebar_open: bool,
    pub command_input_visible: bool,
    pub status_bar_visible: bool,
    pub button_bar_visible: bool,
}

/// 保存的会话模板
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: String,
    pub name: String,
    pub config: ConnectionConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<ProfileOverrides>,
    #[serde(default)]
    pub scheduled_tasks: Vec<ScheduledTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default)]
    pub order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 保存的会话分组
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSessionGroup {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    pub order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 命令按钮
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandButton {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default = "default_delay")]
    pub delay: u64,
    pub group_id: String,
}

fn default_delay() -> u64 { 100 }

/// 命令按钮分组
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandButtonGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub buttons: Vec<CommandButton>,
}

/// 应用设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub font_size: u32,
    pub font_family: String,
    pub font_weight: String,
    pub font_weight_bold: String,
    pub line_height: f64,
    pub letter_spacing: i32,
    pub background: String,
    pub foreground: String,
    pub background_image: String,
    pub background_opacity: f64,
    pub cursor_style: String, // block|underline|bar
    pub cursor_blink: bool,
    pub scrollback: u32,
    pub renderer: String, // webgl|dom
    pub log_enabled: bool,
    pub log_path: String,
    pub log_with_timestamp: bool,
    pub log_split_by_size: bool,
    pub log_split_by_time: bool,
    pub log_max_size: u64,
    pub language: String, // zh-CN|en-US
    pub right_click_paste: bool,
    pub trim_paste: bool,
    pub multi_line_paste_warning: String, // always|auto|never
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "catppuccin-mocha".into(),
            font_size: 14,
            font_family: "Cascadia Code, Consolas, 'Courier New', monospace".into(),
            font_weight: "normal".into(),
            font_weight_bold: "bold".into(),
            line_height: 1.0,
            letter_spacing: 0,
            background: "#1e1e2e".into(),
            foreground: "#cdd6f4".into(),
            background_image: String::new(),
            background_opacity: 1.0,
            cursor_style: "block".into(),
            cursor_blink: true,
            scrollback: 5000,
            renderer: "webgl".into(),
            log_enabled: false,
            log_path: String::new(),
            log_with_timestamp: false,
            log_split_by_size: false,
            log_split_by_time: false,
            log_max_size: 10 * 1024 * 1024,
            language: "zh-CN".into(),
            right_click_paste: true,
            trim_paste: true,
            multi_line_paste_warning: "auto".into(),
        }
    }
}

/// 定时任务
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub command: String,
    pub interval: u64,
    pub enabled: bool,
    pub send_enter: bool,
    pub repeat_count: u32,
    pub executed_count: u32,
}

/// Profile 覆盖项（对应 shared/types/profile.ts）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_weight: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_weight_bold: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter_spacing: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_blink: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scrollback: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renderer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_with_timestamp: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_split_by_size: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_split_by_time: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_max_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_click_paste: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trim_paste: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_line_paste_warning: Option<String>,
}

/// Profile
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub applies_to: Vec<ConnectionType>,
    pub overrides: ProfileOverrides,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 更新状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateStatus {
    Idle,
    Checking,
    Available,
    #[serde(rename = "not-available")]
    NotAvailable,
    Downloading,
    Downloaded,
    Error,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfoSnapshot {
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressSnapshot {
    pub bytes_per_second: u64,
    pub percent: f64,
    pub total: u64,
    pub transferred: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusSnapshot {
    pub status: UpdateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info: Option<UpdateInfoSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<UpdateProgressSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub manual: bool,
}

impl Default for UpdateStatusSnapshot {
    fn default() -> Self {
        Self {
            status: UpdateStatus::Idle,
            info: None,
            progress: None,
            error: None,
            manual: false,
        }
    }
}
