import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useAppStore } from '../store'

const SearchBar: React.FC = () => {
  const [searchText, setSearchText] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [matchRegex, setMatchRegex] = useState(false)
  const [matchCount, setMatchCount] = useState(-1)
  const [matchIndex, setMatchIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  const searchVisible = useAppStore((state) => state.searchVisible)
  const activeSessionId = useAppStore((state) => state.activeSessionId)

  // 打开时聚焦，关闭时清理
  useEffect(() => {
    if (searchVisible) {
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      setSearchText('')
      setMatchCount(-1)
      setMatchIndex(-1)
      if (activeSessionId) {
        window.dispatchEvent(new CustomEvent('terminal:search', {
          detail: { sessionId: activeSessionId, action: 'clear' }
        }))
      }
    }
  }, [searchVisible])

  // 监听搜索结果
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: resultSid, resultIndex, resultCount } = (e as CustomEvent).detail
      const activeSid = useAppStore.getState().activeSessionId
      // 只接受当前活动会话的搜索结果，避免其他标签页事件污染
      if (resultSid !== activeSid) return
      setMatchIndex(resultIndex)
      setMatchCount(resultCount)
    }
    window.addEventListener('terminal:searchResult', handler)
    return () => window.removeEventListener('terminal:searchResult', handler)
  }, [])

  // 查找内容至少两个字符（避免单字符高频全缓冲区扫描）
  const canSearch = searchText.length >= 2

  const doSearch = useCallback((direction: 'next' | 'prev' | 'init') => {
    const sid = useAppStore.getState().activeSessionId
    if (!sid || !canSearch) {
      setMatchCount(-1)
      setMatchIndex(-1)
      return
    }
    window.dispatchEvent(new CustomEvent('terminal:search', {
      detail: { sessionId: sid, action: direction, searchText, matchCase, matchRegex }
    }))
  }, [searchText, matchCase, matchRegex])

  // 搜索文本或选项变化时重新搜索（debounce，避免每次按键触发全缓冲区扫描）
  const initTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!searchVisible || !canSearch) {
      if (initTimerRef.current) clearTimeout(initTimerRef.current)
      setMatchCount(-1)
      setMatchIndex(-1)
      return
    }
    if (initTimerRef.current) clearTimeout(initTimerRef.current)
    initTimerRef.current = setTimeout(() => doSearch('init'), 200)
    return () => {
      if (initTimerRef.current) clearTimeout(initTimerRef.current)
    }
  }, [searchText, matchCase, matchRegex, searchVisible, doSearch])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      doSearch(e.shiftKey ? 'prev' : 'next')
    } else if (e.key === 'Escape') {
      useAppStore.getState().setSearchVisible(false)
    }
  }

  if (!searchVisible) return null

  // 自行计算匹配总数与当前位置，不依赖 xterm search addon 的 onDidChangeResults
  // （后者在 wrap line 场景下 resultCount/resultIndex 不可靠）
  let matchInfo = ''
  if (matchCount > 0) {
    matchInfo = matchIndex >= 0 ? `${matchIndex + 1}/${matchCount}` : `?/${matchCount}`
  } else if (matchCount === 0) {
    matchInfo = '0/0'
  }

  return (
    <div className="absolute top-1 right-2 z-20 flex items-center gap-2 px-3 py-1.5 bg-[#1e1e2e] border border-[#4a4a5a] rounded-lg shadow-xl text-sm">
      <input
        ref={inputRef}
        type="text"
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="查找..."
        className="flex-1 min-w-0 bg-[#313244] text-gray-200 px-2 py-1 rounded border border-[#4a4a5a] focus:border-blue-500 focus:outline-none placeholder-gray-500"
      />
      <span className="text-gray-400 text-xs min-w-[3rem] text-center">{matchInfo}</span>
      <button
        title="区分大小写"
        onClick={() => setMatchCase(!matchCase)}
        className={`px-1.5 py-0.5 rounded text-xs ${matchCase ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-[#3a3a4a]'}`}
      >Aa</button>
      <button
        title="正则表达式"
        onClick={() => setMatchRegex(!matchRegex)}
        className={`px-1.5 py-0.5 rounded text-xs font-mono ${matchRegex ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-[#3a3a4a]'}`}
      >.*</button>
      <button
        title="上一个 (Shift+Enter)"
        onClick={() => doSearch('prev')}
        disabled={!canSearch}
        className="text-gray-400 hover:text-gray-200 disabled:text-gray-600 disabled:cursor-not-allowed"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 15l-6-6-6 6"/></svg>
      </button>
      <button
        title="下一个 (Enter)"
        onClick={() => doSearch('next')}
        disabled={!canSearch}
        className="text-gray-400 hover:text-gray-200 disabled:text-gray-600 disabled:cursor-not-allowed"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <button
        title="关闭 (Esc)"
        onClick={() => useAppStore.getState().setSearchVisible(false)}
        className="text-gray-400 hover:text-gray-200 ml-1"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
  )
}

export default SearchBar
