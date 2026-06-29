/** 基础回退字体链（按优先级排序），在首选字体不可用时使用 */
export const FALLBACK_FONTS = [
  'Cascadia Code', 'Cascadia Mono', 'Fira Code', 'Fira Mono',
  'JetBrains Mono', 'Source Code Pro', 'Consolas', 'Menlo',
  'Monaco', 'DejaVu Sans Mono', 'Ubuntu Mono', 'Noto Sans Mono',
  'Courier New', 'monospace'
]

/**
 * 根据主字体名构建完整 fontFamily，自动去除回退链中与主字体重复的项。
 * 字体名含空格时自动添加引号。
 */
export function buildFontFamily(primary: string): string {
  const primaryLower = primary.toLowerCase()
  const rest = FALLBACK_FONTS.filter((f) => f.toLowerCase() !== primaryLower)
  const all = [primary, ...rest]
  return all.map((f) => f.includes(' ') ? `'${f}'` : f).join(', ')
}
