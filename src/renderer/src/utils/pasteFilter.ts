import { useAppStore } from '../store'
import type { Terminal } from '@xterm/xterm'

/**
 * 过滤粘贴文本中的危险控制字符
 *
 * 保留：HT(\t), LF(\n), CR(\r), ESC 及其后续 ANSI 序列
 * 移除：其他 C0 (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F) 和 DEL(0x7F)
 * 过滤：\x1b[201~（恶意提前终止 bracketed paste 的攻击）
 */
function filterControlChars(text: string): string {
  let result = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      result += text[i]
      continue
    }
    if (code === 0x1b) {
      // 过滤恶意提前终止 bracketed paste 标记 \x1b[201~
      if (text.slice(i, i + 5) === '\x1b[201~') {
        i += 4
        continue
      }
      result += text[i]
      continue
    }
    if (code < 0x20 || code === 0x7f) {
      continue
    }
    result += text[i]
  }
  return result
}

/**
 * 单行粘贴时修剪尾部空白
 *
 * 多行内容保持不变（用户可能有意粘贴多行脚本）
 * 单行和最后一行去除尾部空白，防止命令意外执行
 */
function trimTrailingWhitespace(text: string): string {
  const lines = text.split(/\r?\n/)
  if (lines.length <= 1) {
    return text.replace(/[\t ]+$/, '')
  }
  const lastIdx = lines.length - 1
  lines[lastIdx] = lines[lastIdx].replace(/[\t ]+$/, '')
  return lines.join('\n')
}

export function isMultiLinePaste(text: string): boolean {
  return text.includes('\n')
}

export function countPasteLines(text: string): number {
  return text.split(/\r?\n/).length
}

/**
 * 判断多行粘贴是否需要警告
 *
 * @param text 原始剪贴板文本
 * @param xterm xterm 实例，用于读取 bracketedPasteMode 状态
 */
export function shouldWarnMultiLinePaste(text: string, xterm?: Terminal): boolean {
  const settings = useAppStore.getState().settings
  const mode = settings.multiLinePasteWarning ?? 'auto'
  if (mode === 'never') return false
  if (mode === 'always') return isMultiLinePaste(text)
  // 'auto': 仅在远端未开启 bracketed paste 模式时警告
  const bracketedPasteEnabled = xterm?.modes?.bracketedPasteMode ?? false
  return isMultiLinePaste(text) && !bracketedPasteEnabled
}

/** 检查 xterm 当前是否处于 VT 鼠标追踪模式 */
export function isVtMouseModeEnabled(xterm: Terminal): boolean {
  return xterm.modes.mouseTrackingMode !== 'none'
}

/**
 * 粘贴过滤管线入口
 *
 * 职责：只做 xterm.js paste() 不做的事情
 * - 控制字符过滤（含恶意 bracketed paste 终止标记）
 * - 尾部空白修剪
 *
 * 不做以下事情（xterm.js paste() 已内置）：
 * - 换行符标准化（xterm.js 做 \n → \r）
 * - bracketed paste 包裹（xterm.js 自动包裹 \x1b[200~ ... \x1b[201~）
 */
export function filterPasteText(text: string): string {
  const settings = useAppStore.getState().settings
  let result = filterControlChars(text)
  if (settings.trimPaste ?? true) {
    result = trimTrailingWhitespace(result)
  }
  return result
}
