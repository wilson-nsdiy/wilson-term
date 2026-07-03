/** 连接类型 */
export type ConnectionType = 'ssh' | 'serial' | 'telnet' | 'bash'

import type { Profile, ProfileOverrides } from './profile'
export type { Profile, ProfileOverrides }
export type { PluginPermission, PluginManifest, PluginRegistryEntry, PluginStatusBarItem, PluginMenuItem, PluginContext, PluginLifecycle, MainPlugin, RendererPlugin, PluginDefinition, PluginImportResult, PluginExportResult, PluginListItem, PluginAPI } from './plugin'

/** 键盘锁状态 */
export interface KeyboardLockState {
  capsLock: boolean
  numLock: boolean
  scrollLock: boolean
}

/** 日志配置（每个连接可独立配置） */
export interface LogConfig {
  logEnabled: boolean
  logPath: string
  logWithTimestamp: boolean
  logSplitBySize: boolean
  logSplitByTime: boolean
  logMaxSize: number
}

/** SSH 认证方式 */
export type SSHAuthType = 'password' | 'privateKey' | 'none'

/** SSH 连接配置 */
export interface SSHConfig {
  type: 'ssh'
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: SSHAuthType
  password?: string
  privateKey?: string
  passphrase?: string
  logConfig?: LogConfig
}

/** 串口信息（对应 serialport 的 PortInfo） */
export interface SerialPortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
  locationId?: string
  productId?: string
  vendorId?: string
  /** Windows 友好名称，如 "USB-Enhanced-SERIAL-D CH344 (COM24)" */
  friendlyName?: string
}

/** 串口配置 */
export interface SerialConfig {
  type: 'serial'
  id: string
  name: string
  path: string
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  stopBits: 1 | 2
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space'
  flowControl: 'none' | 'hardware' | 'software'
  logConfig?: LogConfig
}

/** Telnet 连接配置 */
export interface TelnetConfig {
  type: 'telnet'
  id: string
  name: string
  host: string
  port: number
  /** 超时时间（毫秒），默认 15000 */
  timeout?: number
  logConfig?: LogConfig
}

/** Bash Shell 类型 */
export type BashShellType = 'auto' | 'cmd' | 'powershell'

/** 本地 Bash 连接配置 */
export interface BashConfig {
  type: 'bash'
  id: string
  name: string
  /** Shell 类型，默认 auto */
  shell?: BashShellType
  /** 启动目录，默认用户 HOME */
  cwd?: string
  logConfig?: LogConfig
}

/** 保存的会话模板（可重复使用的连接配置） */
export interface SavedSession {
  id: string
  name: string
  config: ConnectionConfig
  /** 继承的 Profile ID */
  profileId?: string
  /** 会话级增量覆盖 */
  overrides?: Partial<ProfileOverrides>
  /** 预设的定时任务列表（连接后自动创建到会话） */
  scheduledTasks: ScheduledTask[]
  createdAt: number
  updatedAt: number
}

/** 连接配置联合类型 */
export type ConnectionConfig = SSHConfig | SerialConfig | TelnetConfig | BashConfig

/** 会话状态 */
export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

/** 终端会话 */
export interface TerminalSession {
  id: string
  config: ConnectionConfig
  profileId?: string
  overrides?: Partial<ProfileOverrides>
  status: SessionStatus
  /** 连接错误信息（仅在 status 为 error 时有值） */
  errorMessage?: string
  createdAt: number
  lastActiveAt: number
}

/** 主题配置 */
export interface ThemeConfig {
  name: string
  colors: Record<string, string>
}

/** 命令按钮定义 */
export interface CommandButton {
  /** 按钮唯一 ID */
  id: string
  /** 按钮显示标签 */
  label: string
  /** 点击发送的命令列表（每条依次发送） */
  commands: string[]
  /** 命令间延迟（毫秒），默认 100 */
  delay: number
  /** 所属分组 ID */
  groupId: string
}

/** 命令按钮分组 */
export interface CommandButtonGroup {
  /** 分组唯一 ID */
  id: string
  /** 分组名称 */
  name: string
  /** 分组内的按钮列表 */
  buttons: CommandButton[]
}

/** 应用设置 */
export interface AppSettings {
  theme: string
  fontSize: number
  /** 主字体名，回退字体自动拼接 */
  fontFamily: string
  /** 字体粗细（normal/bold/100-900） */
  fontWeight: string
  /** 粗体字体粗细 */
  fontWeightBold: string
  /** 行高倍数，默认 1.0 */
  lineHeight: number
  /** 字间距（像素），默认 0 */
  letterSpacing: number
  /** 终端背景色 */
  background: string
  /** 终端前景色（字体颜色） */
  foreground: string
  /** 背景图片路径 */
  backgroundImage: string
  /** 背景图片不透明度 0-1 */
  backgroundOpacity: number
  /** 光标样式 */
  cursorStyle: 'block' | 'underline' | 'bar'
  /** 光标是否闪烁 */
  cursorBlink: boolean
  /** 滚动缓冲行数 */
  scrollback: number
  logEnabled: boolean
  logPath: string
  logWithTimestamp: boolean
  logSplitBySize: boolean
  logSplitByTime: boolean
  logMaxSize: number
  language: 'zh-CN' | 'en-US'
  /** 鼠标右键行为：true=复制/粘贴，false=显示菜单 */
  rightClickPaste: boolean
  /** 单行粘贴时去除尾部空白（防止命令意外执行） */
  trimPaste: boolean
  /** 多行粘贴警告：'always' | 'auto' | 'never' */
  multiLinePasteWarning: 'always' | 'auto' | 'never'
}

/** 窗口控制 API */
export interface WindowAPI {
  minimize: () => void
  maximize: () => void
  close: () => void
  isMaximized: () => Promise<boolean>
  toggleDevtools: () => void
}

/** 文件对话框 API */
export interface DialogAPI {
  openDirectory: () => Promise<string | null>
  openImage: () => Promise<string | null>
  readImageAsDataURL: (filePath: string) => Promise<string | null>
}

/** 存储 API */
export interface StorageAPI {
  loadSavedSessions: () => Promise<SavedSession[]>
  saveSavedSessions: (sessions: SavedSession[]) => Promise<void>
  loadCommandButtonGroups: () => Promise<CommandButtonGroup[]>
  saveCommandButtonGroups: (groups: CommandButtonGroup[]) => Promise<void>
  loadAppSettings: () => Promise<AppSettings | null>
  saveAppSettings: (settings: AppSettings) => Promise<void>
  loadViewState: () => Promise<ViewState | null>
  saveViewState: (state: ViewState) => Promise<void>
  loadScheduledTasks: () => Promise<Record<string, ScheduledTask[]>>
  saveScheduledTasks: (tasks: Record<string, ScheduledTask[]>) => Promise<void>
  loadProfiles: () => Promise<Profile[]>
  saveProfiles: (profiles: Profile[]) => Promise<void>
}

/** 视图状态（需要持久化的 UI 开关） */
export interface ViewState {
  sidebarOpen: boolean
  commandInputVisible: boolean
  statusBarVisible: boolean
  buttonBarVisible: boolean
}

/** 主机密钥验证请求 */
export interface HostKeyVerifyRequest {
  /** 会话 ID */
  sessionId: string
  /** 主机地址 */
  host: string
  /** 端口 */
  port: number
  /** 密钥类型，如 ED25519、RSA */
  keyType: string
  /** 密钥指纹 */
  fingerprint: string
  /** 是否为密钥变更（已存在但指纹不匹配） */
  changed: boolean
}

/** SSH 密码输入请求 */
export interface PasswordRequest {
  /** 会话 ID */
  sessionId: string
  /** 主机地址 */
  host: string
  /** 端口 */
  port: number
  /** 用户名 */
  username: string
  /** 服务端提示信息 */
  prompt: string
  /** 是否为重试（上次密码不正确） */
  retry: boolean
}

/** SSH 密钥生成结果 */
export interface KeyPairResult {
  success: boolean
  privateKeyPath?: string
  publicKeyPath?: string
  error?: string
}

/** SSH 专属 API（主机密钥验证、密钥生成、密码输入） */
export interface SSHAPI {
  onHostKeyVerify: (callback: (request: HostKeyVerifyRequest) => void) => () => void
  respondHostKey: (sessionId: string, accepted: boolean) => void
  generateKeyPair: (type?: 'ed25519' | 'rsa') => Promise<KeyPairResult>
  onPasswordRequest: (callback: (request: PasswordRequest) => void) => () => void
  respondPassword: (sessionId: string, password: string) => void
}

/** 串口专属 API（列表查询） */
export interface SerialAPI {
  listPorts: () => Promise<SerialPortInfo[]>
}

/** 可用 Shell 信息 */
export interface ShellInfo {
  type: BashShellType
  label: string
  available: boolean
}

/** Bash 专属 API（Shell 列表查询） */
export interface BashAPI {
  listShells: () => Promise<ShellInfo[]>
}

/** 日志 API */
export interface LogAPI {
  start: (sessionId: string, logConfig: LogConfig, connectionConfig: ConnectionConfig) => Promise<void>
  stop: (sessionId: string) => Promise<void>
  getDefaultLogDir: () => Promise<string>
  getFilePath: (sessionId: string) => Promise<string | null>
  getDir: (sessionId: string) => Promise<string>
  openFile: (sessionId: string) => Promise<boolean>
  openDir: (sessionId: string) => Promise<void>
}

/** 键盘 API */
export interface KeyboardAPI {
  getLockState: () => Promise<KeyboardLockState>
  onLockStateChanged: (callback: (state: KeyboardLockState) => void) => () => void
  setPollingEnabled: (enabled: boolean) => void
}

/** 更新状态 */
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

/** 更新信息快照 */
export interface UpdateInfoSnapshot {
  version: string
  releaseDate?: string
  releaseNotes?: string | null
}

/** 下载进度快照 */
export interface UpdateProgressSnapshot {
  bytesPerSecond: number
  percent: number
  total: number
  transferred: number
}

/** 更新状态快照 */
export interface UpdateStatusSnapshot {
  status: UpdateStatus
  info?: UpdateInfoSnapshot
  progress?: UpdateProgressSnapshot
  error?: string
  autoInstallCountdown?: number
  /** 是否由用户手动触发检查 */
  manual?: boolean
}

/** 定时任务定义 */
export interface ScheduledTask {
  /** 任务唯一 ID */
  id: string
  /** 所属会话 ID */
  sessionId: string
  /** 任务名称 */
  name: string
  /** 要发送的命令文本 */
  command: string
  /** 间隔时间（秒） */
  interval: number
  /** 是否启用 */
  enabled: boolean
  /** 发送命令后是否自动输入回车 */
  sendEnter: boolean
  /** 循环次数，0 表示无限循环 */
  repeatCount: number
  /** 当前已执行次数 */
  executedCount: number
}

/** 应用 API */
export interface AppAPI {
  getVersion: () => Promise<string>
  checkUpdate: (force?: boolean) => Promise<UpdateStatusSnapshot>
  downloadUpdate: () => Promise<void>
  installUpdate: () => void
  cancelAutoInstall: () => void
  getUpdateStatus: () => Promise<UpdateStatusSnapshot>
  getIgnoredVersions: () => Promise<string[]>
  saveIgnoredVersions: (versions: string[]) => Promise<void>
  onUpdateStatusChanged: (callback: (snapshot: UpdateStatusSnapshot) => void) => () => void
  getDomain: () => Promise<string>
  getSystemFonts: () => Promise<string[]>
}

/** SFTP 文件条目 */
export interface SFTPFileEntry {
  filename: string
  longname: string
  attrs: {
    size: number
    mode: number
    uid: number
    gid: number
    atime: number
    mtime: number
    isDirectory: boolean
    isFile: boolean
    isSymbolicLink: boolean
  }
}

/** SFTP 操作结果 */
export interface SFTPResult {
  success: boolean
  error?: string
}

/** SFTP API */
export interface SFTPAPI {
  list: (sessionId: string, remotePath: string) => Promise<SFTPFileEntry[]>
  upload: (sessionId: string, localPath: string, remotePath: string) => Promise<SFTPResult>
  download: (sessionId: string, remotePath: string, localPath: string) => Promise<SFTPResult>
  delete: (sessionId: string, remotePath: string, isDir: boolean) => Promise<SFTPResult>
  mkdir: (sessionId: string, remotePath: string) => Promise<SFTPResult>
  rename: (sessionId: string, oldPath: string, newPath: string) => Promise<SFTPResult>
  selectUploadFiles: () => Promise<string[]>
  selectDownloadPath: (defaultName: string) => Promise<string | null>
}

/** 连接 API（统一） */
export interface ConnectionAPI {
  connect: (config: ConnectionConfig, logConfig?: LogConfig) => Promise<void>
  disconnect: (sessionId: string) => Promise<void>
  write: (sessionId: string, data: string) => void
  resize: (sessionId: string, cols: number, rows: number) => void
  onData: (callback: (sessionId: string, data: string) => void) => () => void
  onStatus: (callback: (sessionId: string, status: string, errorMessage?: string) => void) => () => void
}

/** 暴露给渲染进程的 API */
export interface ExposedAPI {
  window: WindowAPI
  connection: ConnectionAPI
  ssh: SSHAPI
  serial: SerialAPI
  bash: BashAPI
  sftp: SFTPAPI
  dialog: DialogAPI
  storage: StorageAPI
  keyboard: KeyboardAPI
  log: LogAPI
  plugin: PluginAPI
  app: AppAPI
  shell: {
    openExternal: (url: string) => Promise<void>
  }
}

/** 扩展 Window 接口 */
declare global {
  interface Window {
    api: ExposedAPI
  }
}
