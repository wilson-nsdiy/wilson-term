import type { AppSettings, LogConfig } from '@shared/types'
import type { Profile, ProfileOverrides } from '@shared/types/profile'

/** 合并后的完整设置（所有字段都有值） */
export interface ResolvedSettings {
  fontSize: number
  fontFamily: string
  fontWeight: string
  fontWeightBold: string
  lineHeight: number
  letterSpacing: number
  background: string
  foreground: string
  backgroundImage: string
  backgroundOpacity: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  scrollback: number
  renderer: 'webgl' | 'canvas' | 'dom'
  logConfig: LogConfig
  rightClickPaste: boolean
  trimPaste: boolean
  multiLinePasteWarning: 'always' | 'auto' | 'never'
}

/**
 * 三层合并：全局默认 → Profile 覆盖 → Session 覆盖
 * 仅非 undefined 的值覆盖前层
 */
export function resolveSettings(
  global: AppSettings,
  profile: Profile | undefined,
  sessionOverrides: Partial<ProfileOverrides> | undefined
): ResolvedSettings {
  const layers: Partial<ProfileOverrides>[] = []

  layers.push(globalToOverrides(global))

  if (profile?.overrides) {
    layers.push(profile.overrides)
  }

  if (sessionOverrides) {
    layers.push(sessionOverrides)
  }

  const merged: Partial<ProfileOverrides> = {}
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) {
        ;(merged as any)[key] = value
      }
    }
  }

  return overridesToResolved(merged, global)
}

function globalToOverrides(settings: AppSettings): ProfileOverrides {
  return {
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    fontWeight: settings.fontWeight,
    fontWeightBold: settings.fontWeightBold,
    lineHeight: settings.lineHeight,
    letterSpacing: settings.letterSpacing,
    background: settings.background,
    foreground: settings.foreground,
    backgroundImage: settings.backgroundImage,
    backgroundOpacity: settings.backgroundOpacity,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    renderer: settings.renderer,
    logEnabled: settings.logEnabled,
    logPath: settings.logPath,
    logWithTimestamp: settings.logWithTimestamp,
    logSplitBySize: settings.logSplitBySize,
    logSplitByTime: settings.logSplitByTime,
    logMaxSize: settings.logMaxSize,
    rightClickPaste: settings.rightClickPaste,
    trimPaste: settings.trimPaste,
    multiLinePasteWarning: settings.multiLinePasteWarning
  }
}

function overridesToResolved(overrides: Partial<ProfileOverrides>, fallback: AppSettings): ResolvedSettings {
  return {
    fontSize: overrides.fontSize ?? fallback.fontSize,
    fontFamily: overrides.fontFamily ?? fallback.fontFamily,
    fontWeight: overrides.fontWeight ?? fallback.fontWeight,
    fontWeightBold: overrides.fontWeightBold ?? fallback.fontWeightBold,
    lineHeight: overrides.lineHeight ?? fallback.lineHeight,
    letterSpacing: overrides.letterSpacing ?? fallback.letterSpacing,
    background: overrides.background ?? fallback.background,
    foreground: overrides.foreground ?? fallback.foreground,
    backgroundImage: overrides.backgroundImage ?? fallback.backgroundImage,
    backgroundOpacity: overrides.backgroundOpacity ?? fallback.backgroundOpacity,
    cursorStyle: overrides.cursorStyle ?? fallback.cursorStyle,
    cursorBlink: overrides.cursorBlink ?? fallback.cursorBlink,
    scrollback: overrides.scrollback ?? fallback.scrollback,
    renderer: overrides.renderer ?? fallback.renderer,
    logConfig: {
      logEnabled: overrides.logEnabled ?? fallback.logEnabled,
      logPath: overrides.logPath ?? fallback.logPath,
      logWithTimestamp: overrides.logWithTimestamp ?? fallback.logWithTimestamp,
      logSplitBySize: overrides.logSplitBySize ?? fallback.logSplitBySize,
      logSplitByTime: overrides.logSplitByTime ?? fallback.logSplitByTime,
      logMaxSize: overrides.logMaxSize ?? fallback.logMaxSize
    },
    rightClickPaste: overrides.rightClickPaste ?? fallback.rightClickPaste,
    trimPaste: overrides.trimPaste ?? fallback.trimPaste,
    multiLinePasteWarning: overrides.multiLinePasteWarning ?? fallback.multiLinePasteWarning
  }
}
