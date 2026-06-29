import type { LogConfig, AppSettings } from '@shared/types'
import { useAppStore } from '../store'

/** 从全局设置创建 LogConfig（复制一份作为连接的独立配置） */
export function createLogConfigFromSettings(settings: AppSettings): LogConfig {
  // 如果 settings.logPath 为空，尝试从 store 中获取已初始化的默认路径
  const effectivePath = settings.logPath || useAppStore.getState().settings.logPath
  return {
    logEnabled: settings.logEnabled,
    logPath: effectivePath,
    logWithTimestamp: settings.logWithTimestamp,
    logSplitBySize: settings.logSplitBySize,
    logSplitByTime: settings.logSplitByTime,
    logMaxSize: settings.logMaxSize
  }
}

/** 合并连接级别的日志配置与全局配置 */
export function resolveLogConfig(
  logConfig: LogConfig | undefined,
  settings: AppSettings
): LogConfig {
  if (logConfig) {
    // 如果连接级别配置中 logPath 为空，也尝试填充默认路径
    if (!logConfig.logPath) {
      const storePath = useAppStore.getState().settings.logPath
      if (storePath) {
        return { ...logConfig, logPath: storePath }
      }
    }
    return { ...logConfig }
  }
  return createLogConfigFromSettings(settings)
}
