/** 可复用的配置模板 */
export interface Profile {
  id: string
  name: string
  /** 适用的连接类型（空 = 所有类型） */
  appliesTo: import('@shared/types').ConnectionType[]
  /** 增量覆盖——仅非 undefined 的值生效 */
  overrides: Partial<ProfileOverrides>
  createdAt: number
  updatedAt: number
}

/** 可在 Profile 或 Session 级别覆盖的设置子集 */
export interface ProfileOverrides {
  fontSize?: number
  fontFamily?: string
  fontWeight?: string
  fontWeightBold?: string
  lineHeight?: number
  letterSpacing?: number
  background?: string
  foreground?: string
  backgroundImage?: string
  backgroundOpacity?: number
  cursorStyle?: 'block' | 'underline' | 'bar'
  cursorBlink?: boolean
  scrollback?: number
  /** 终端渲染器（可在 Profile/Session 级别覆盖） */
  renderer?: 'webgl' | 'canvas' | 'dom'
  logEnabled?: boolean
  logPath?: string
  logWithTimestamp?: boolean
  logSplitBySize?: boolean
  logSplitByTime?: boolean
  logMaxSize?: number
  rightClickPaste?: boolean
  trimPaste?: boolean
  multiLinePasteWarning?: 'always' | 'auto' | 'never'
}
