import type { Terminal } from '@xterm/xterm'

export interface SearchMatch {
  /** 起始 buffer row（逻辑行起始 row） */
  row: number
  /** 起始列（buffer 列坐标，即 registerDecoration 的 x） */
  col: number
  /** 匹配长度（buffer cell 数，即 registerDecoration 的 width） */
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
 * buffer line 的最小可用接口，便于单测时 stub。
 */
interface StringOffsetLine {
  getCell(x: number): { getWidth(): number; getChars(): string } | undefined
  length: number
}

/**
 * 把"段内字符串偏移"转换为该段的 buffer 列坐标。
 *
 * 必须与 xterm SearchAddon 的 `_stringLengthToBufferSize` 算法保持一致，
 * 否则自管理高亮的 registerDecoration(x) 会与 SearchAddon 选中位置
 * （selection.start.x）错位，表现为同一匹配出现两个偏移的高亮。
 *
 * 算法语义：遍历 buffer cell（i 即 buffer 列），循环到 i >= offset 退出；
 * 循环内修改 offset——
 *   - 多码点字符（emoji 等，getChars().length > 1）：offset -= len - 1，
 *     把字符串多算的字符数扣回，使 offset 仍代表"字符串字符数"。
 *   - 当前 cell 后跟一个 width=0 的跟随 cell（CJK 宽字符尾部）：
 *     offset++，让循环多跑一次跳过跟随 cell。
 *
 * 跟随 cell 自身不显式处理：它在循环 i++ 时被自然跳过，且其 getChars()
 * 返回 "" 不会触发 emoji 调整。
 *
 * @param line   该段的 buffer line 对象
 * @param strIdx 该段 translateToString 输出中的字符偏移
 * @param maxCells 该段的 buffer cell 上限（通常为 line.length 或终端列宽）
 * @returns 对应的 buffer 列坐标
 */
function stringIndexToBufferCol(
  line: StringOffsetLine | undefined,
  strIdx: number,
  maxCells: number
): number {
  if (!line) return strIdx
  let offset = strIdx
  for (let i = 0; i < offset && i < maxCells; i++) {
    const cell = line.getCell(i)
    if (!cell) break
    const char = cell.getChars()
    if (char.length > 1) {
      offset -= char.length - 1
    }
    const nextCell = line.getCell(i + 1)
    if (nextCell && nextCell.getWidth() === 0) {
      offset++
    }
  }
  return offset
}

/**
 * 把"段内字符串长度"换算为 buffer cell 数（registerDecoration 的 width）。
 *
 * 从起始 buffer 列开始遍历 cell，每遇到一个非零宽度 cell 就消耗一个字符串
 * 字符，并把该 cell 的宽度累加到结果；宽度为 0 的跟随 cell 已经包含在前一个
 * 宽字符的 w 列内，不额外计数。
 *
 * 前提：startCol 必须指向非跟随 cell（即由 stringIndexToBufferCol 计算得到）。
 * 若 startCol 落在跟随 cell 上，循环会跳过它而不消耗任何字符串字符，导致
 * 返回值偏小。当前调用链保证这一前提。
 *
 * @param line  该段的 buffer line 对象
 * @param startCol 起始 buffer 列（对应字符串偏移起点）
 * @param strLen 要覆盖的字符串字符数
 * @param maxCells buffer cell 上限
 * @returns buffer cell 数
 */
function stringLengthToBufferCells(
  line: StringOffsetLine | undefined,
  startCol: number,
  strLen: number,
  maxCells: number
): number {
  if (!line) return strLen
  let cells = 0
  let consumed = 0
  for (let x = startCol; x < maxCells && consumed < strLen; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    const w = cell.getWidth()
    if (w === 0) {
      // 宽字符的跟随 cell，已包含在前一个 +=w 中，这里直接跳过
      continue
    }
    consumed++
    cells += w
  }
  return cells
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
 *
 * 坐标换算：registerDecoration 的 x/width 以 buffer cell 为单位，而本函数
 * 在 translateToString 输出的字符串上做匹配。宽字符（CJK/emoji）在 buffer
 * 中占 2 列、在字符串中只占 1 个字符，所以必须通过 stringIndexToBufferCol
 * 把字符串偏移换算回 buffer 列，否则高亮位置会与实际匹配错位。
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
        // localStrIdx：在该段 translateToString 输出中的字符偏移
        const localStrIdx = curIdx - segOffsets[seg]
        // 段内可用字符串长度：不超过段尾
        const segAvail = segEnd - curIdx
        // 取本轮段内消费的字符串字符数
        const take = Math.min(remaining, Math.max(segAvail, 1))
        // 把字符串长度换算为 buffer cell 数：匹配长度范围内每个非零宽度 cell 占 w 列
        const maxCells = lineObj ? lineObj.length : xterm.cols
        const bufferCol = stringIndexToBufferCol(lineObj, localStrIdx, maxCells)
        const cellLen = stringLengthToBufferCells(lineObj, bufferCol, take, maxCells)
        matches.push({ row: segRow, col: bufferCol, length: cellLen })
        remaining -= take
        curIdx += take
        seg++
        // 跨段时下一段从偏移 0 开始
        while (seg < segRows.length && remaining > 0) {
          const nextLineObj = buffer.getLine(segRows[seg])
          const nextMaxCells = nextLineObj ? nextLineObj.length : xterm.cols
          const nextTake = Math.min(remaining, nextMaxCells)
          const nextBufferCol = stringIndexToBufferCol(nextLineObj, 0, nextMaxCells)
          const nextCellLen = stringLengthToBufferCells(nextLineObj, nextBufferCol, nextTake, nextMaxCells)
          matches.push({ row: segRows[seg], col: nextBufferCol, length: nextCellLen })
          remaining -= nextTake
          curIdx += nextTake
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
