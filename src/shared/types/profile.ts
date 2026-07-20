/** 可在 Session 级别覆盖的设置子集 */
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
  /** 终端渲染器（可在 Session 级别覆盖） */
  renderer?: 'webgl' | 'dom'
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
