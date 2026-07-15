import type { Terminal } from '@xterm/xterm'

export interface SearchMatchInfo {
  /** 当前选中匹配的索引（从 0 开始），-1 表示无法定位 */
  resultIndex: number
  /** 匹配总数 */
  resultCount: number
}

/**
 * 自行计算搜索匹配总数和当前选中匹配的索引。
 *
 * xterm search addon 的 onDidChangeResults 在以下场景不可靠：
 *  - resultIndex 为 -1 时表示当前选中匹配不在高亮列表中（超过 highlightLimit，
 *    或选中项与高亮项坐标因 wrap line 处理不一致），此时无法定位当前位置。
 *  - resultCount 受 highlightLimit 限制，且 _highlightAllMatches 的去重循环
 *    在 wrap line 场景可能提前退出，导致 count 偏小。
 *
 * 此函数通过遍历整个缓冲区文本，按搜索条件统计所有匹配，再用当前选中位置
 * 定位到第几个匹配，从而给出准确的 index/count。
 *
 * wrap line 处理：xterm 将一个逻辑行（超过终端宽度自动换行）存储为多个
 * buffer row，后续行 isWrapped=true。translateToString(true) 只返回单行文本，
 * 因此需要把同一逻辑行的所有 wrap 续行拼接成完整 haystack 再搜索。
 */
export function computeSearchMatchInfo(
  xterm: Terminal,
  searchText: string,
  matchCase: boolean,
  matchRegex: boolean
): SearchMatchInfo | null {
  if (!searchText) return null

  const buffer = xterm.buffer.active
  const totalLines = buffer.length

  // 收集所有匹配的 (row, col) 起始坐标
  const matches: Array<{ row: number; col: number }> = []

  const flags = matchCase ? 'g' : 'gi'

  let pattern: RegExp | null = null
  if (matchRegex) {
    try {
      pattern = new RegExp(searchText, flags)
    } catch {
      // 无效正则，当作无匹配
      return { resultIndex: -1, resultCount: 0 }
    }
  }

  const needle = matchCase ? searchText : searchText.toLowerCase()

  for (let row = 0; row < totalLines; row++) {
    const line = buffer.getLine(row)
    if (!line) continue

    // 跳过 wrap 续行：它们已在所属逻辑行的起始 row 处被一并扫描
    if (line.isWrapped) continue

    // 拼接同一逻辑行的所有 wrap 续行，构成完整 haystack
    // 例如一个长 URL 被自动换行成两行，搜索词可能跨 wrap 边界
    const parts: string[] = [line.translateToString(true)]
    let nextRow = row + 1
    while (nextRow < totalLines) {
      const nextLine = buffer.getLine(nextRow)
      if (!nextLine || !nextLine.isWrapped) break
      parts.push(nextLine.translateToString(true))
      nextRow++
    }
    const text = parts.join('')
    const haystack = matchCase ? text : text.toLowerCase()

    if (matchRegex && pattern) {
      pattern.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = pattern.exec(haystack)) !== null) {
        if (m[0].length === 0) {
          pattern.lastIndex++
          continue
        }
        matches.push({ row, col: m.index })
      }
    } else {
      let from = 0
      while (from <= haystack.length) {
        const idx = haystack.indexOf(needle, from)
        if (idx < 0) break
        matches.push({ row, col: idx })
        from = idx + 1
      }
    }

    // 跳过已处理的 wrap 续行（nextRow 指向下一个非 wrap 行或 totalLines）
    row = nextRow - 1
  }

  const resultCount = matches.length

  // 定位当前选中匹配
  let resultIndex = -1
  const selPos = xterm.getSelectionPosition()
  if (selPos && resultCount > 0) {
    const selRow = selPos.start.y
    const selCol = selPos.start.x
    // 找到第一个 row/col 与选中起始位置一致的匹配
    for (let i = 0; i < matches.length; i++) {
      if (matches[i].row === selRow && matches[i].col === selCol) {
        resultIndex = i
        break
      }
    }
    // 若精确匹配失败（wrap line 偏移等），退化用行匹配取第一个
    if (resultIndex < 0) {
      for (let i = 0; i < matches.length; i++) {
        if (matches[i].row === selRow) {
          resultIndex = i
          break
        }
      }
    }
  }

  return { resultIndex, resultCount }
}
