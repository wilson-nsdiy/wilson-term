import type { Terminal } from '@xterm/xterm'

export interface SearchMatch {
  /** 起始 buffer row（逻辑行起始 row） */
  row: number
  /** 起始列（buffer 列坐标） */
  col: number
  /** 匹配长度（字符数；用于 decoration 宽度） */
  length: number
}

export interface SearchMatchInfo {
  /** 当前选中匹配的索引（从 0 开始），-1 表示无法定位 */
  resultIndex: number
  /** 匹配总数 */
  resultCount: number
  /** 所有匹配分段列表（按缓冲区顺序），用于驱动 registerDecoration */
  matches: SearchMatch[]
  /**
   * 每个逻辑匹配的起点分段在 matches 中的索引。
   * logicalStarts[k] .. (logicalStarts[k+1] ?? matches.length) - 1
   * 是第 k 个逻辑匹配对应的所有分段。
   */
  logicalStarts: number[]
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

  // 收集所有匹配分段信息：matches 用于驱动 registerDecoration，
  // 每个分段都是单一视觉行内的 decoration；跨 wrap 边界的逻辑匹配
  // 会被拆成多段。logicalCount 单独累计逻辑匹配数，用于 resultCount。
  // logicalStarts 记录每个逻辑匹配的"起点分段"在 matches 中的索引，
  // 便于通过 selPos 反查当前选中的是第几个逻辑匹配。
  const matches: SearchMatch[] = []
  let logicalCount = 0
  const logicalStarts: number[] = []

  const flags = matchCase ? 'g' : 'gi'

  let pattern: RegExp | null = null
  if (matchRegex) {
    try {
      pattern = new RegExp(searchText, flags)
    } catch {
      // 无效正则，当作无匹配
      return { resultIndex: -1, resultCount: 0, matches: [], logicalStarts: [] }
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
    const segRows: number[] = [row] // 每个 wrap 段对应的视觉 buffer row
    const segOffsets: number[] = [0] // 每个 wrap 段在拼接 haystack 中的起始偏移
    let nextRow = row + 1
    while (nextRow < totalLines) {
      const nextLine = buffer.getLine(nextRow)
      if (!nextLine || !nextLine.isWrapped) break
      parts.push(nextLine.translateToString(true))
      nextRow++
    }
    const text = parts.join('')
    const haystack = matchCase ? text : text.toLowerCase()

    // 记录每个 wrap 段的视觉 row 与起始偏移，用于把 haystack 偏移转回视觉坐标
    let cum = 0
    for (let i = 0; i < parts.length; i++) {
      segRows[i] = row + i
      segOffsets[i] = cum
      cum += parts[i].length
    }

    // 把 haystack 偏移转换为视觉 (row, col)，并按 wrap 段切分跨段匹配
    // 返回的每个分段都是单一视觉行内的 decoration
    const pushSegments = (idx: number, len: number) => {
      logicalCount++
      logicalStarts.push(matches.length)
      // 找到匹配起点所在的 wrap 段
      let seg = 0
      while (seg + 1 < segOffsets.length && idx >= segOffsets[seg + 1]) seg++
      let remaining = len
      let curIdx = idx
      while (remaining > 0 && seg < segRows.length) {
        const segEnd = seg + 1 < segOffsets.length ? segOffsets[seg + 1] : haystack.length
        const segRow = segRows[seg]
        const lineObj = buffer.getLine(segRow)
        const segCols = lineObj ? lineObj.length : xterm.cols
        const localCol = curIdx - segOffsets[seg]
        // 当前段内可容纳的字符数：不超过段尾、不超过终端列宽
        const avail = Math.min(segEnd - curIdx, segCols - localCol)
        const take = Math.min(remaining, Math.max(avail, 1))
        matches.push({ row: segRow, col: localCol, length: take })
        remaining -= take
        curIdx += take
        seg++
        // 跨段时下一段从偏移 0 开始
        while (seg < segRows.length && remaining > 0) {
          const nextLineObj = buffer.getLine(segRows[seg])
          const nextSegCols = nextLineObj ? nextLineObj.length : xterm.cols
          const nextTake = Math.min(remaining, nextSegCols)
          matches.push({ row: segRows[seg], col: 0, length: nextTake })
          remaining -= nextTake
          seg++
        }
      }
    }

    if (matchRegex && pattern) {
      pattern.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = pattern.exec(haystack)) !== null) {
        if (m[0].length === 0) {
          pattern.lastIndex++
          continue
        }
        pushSegments(m.index, m[0].length)
      }
    } else {
      let from = 0
      while (from <= haystack.length) {
        const idx = haystack.indexOf(needle, from)
        if (idx < 0) break
        pushSegments(idx, needle.length)
        from = idx + 1
      }
    }

    // 跳过已处理的 wrap 续行（nextRow 指向下一个非 wrap 行或 totalLines）
    row = nextRow - 1
  }

  const resultCount = logicalCount

  // 定位当前选中匹配（按逻辑匹配序号）
  let resultIndex = -1
  const selPos = xterm.getSelectionPosition()
  if (selPos && logicalCount > 0) {
    const selRow = selPos.start.y
    const selCol = selPos.start.x
    // 先在所有分段中找到 row/col 与选中起始位置一致的分段
    let segIdx = -1
    for (let i = 0; i < matches.length; i++) {
      if (matches[i].row === selRow && matches[i].col === selCol) {
        segIdx = i
        break
      }
    }
    // 若精确匹配失败（wrap line 偏移等），退化用行匹配取第一个
    if (segIdx < 0) {
      for (let i = 0; i < matches.length; i++) {
        if (matches[i].row === selRow) {
          segIdx = i
          break
        }
      }
    }
    // 把分段索引映射回逻辑匹配序号：找到最后一个 logicalStarts[i] <= segIdx
    if (segIdx >= 0) {
      for (let i = logicalStarts.length - 1; i >= 0; i--) {
        if (logicalStarts[i] <= segIdx) {
          resultIndex = i
          break
        }
      }
    }
  }

  return { resultIndex, resultCount, matches, logicalStarts }
}
