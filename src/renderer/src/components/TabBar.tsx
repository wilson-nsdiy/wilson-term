import React, { useRef, useState } from 'react'
import { useAppStore } from '../store'

const TabBar: React.FC = () => {
  const sessions = useAppStore((state) => state.sessions)
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const setActiveSession = useAppStore((state) => state.setActiveSession)
  const removeSession = useAppStore((state) => state.removeSession)
  const moveSessionTab = useAppStore((state) => state.moveSessionTab)
  const setNewConnectDialogOpen = useAppStore((state) => state.setNewConnectDialogOpen)

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const dragStartX = useRef(0)

  const handleTabClick = (id: string) => {
    setActiveSession(id)
  }

  const handleTabClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    removeSession(id)
  }

  const handleNewConnect = () => {
    setNewConnectDialogOpen(true)
  }

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index)
    dragStartX.current = e.clientX
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', index.toString())
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragIndex !== null && dragIndex !== index) {
      setDropIndex(index)
    }
  }

  const handleDragEnd = () => {
    if (dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) {
      moveSessionTab(dragIndex, dropIndex)
    }
    setDragIndex(null)
    setDropIndex(null)
  }

  return (
    <div className="flex items-center h-9 bg-gray-800 border-b border-gray-700 px-2">
      <div className="flex items-center gap-1 overflow-x-auto">
        {sessions.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-1 text-sm text-gray-500">
            <span>新终端</span>
          </div>
        ) : (
          sessions.map((session, index) => (
            <div
              key={session.id}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragEnd={handleDragEnd}
              onClick={() => handleTabClick(session.id)}
              className={`relative flex items-center gap-2 px-3 py-1 rounded-t text-sm cursor-pointer transition-colors select-none ${
                session.id === activeSessionId
                  ? 'bg-gray-700 text-gray-200'
                  : 'text-gray-400 hover:bg-gray-750 hover:text-gray-300'
              } ${dragIndex === index ? 'opacity-50' : ''} ${
                dropIndex === index && dragIndex !== null && dragIndex !== index
                  ? 'border-l-2 border-blue-400'
                  : ''
              }`}
            >
              {session.id === activeSessionId && (
                <div className="absolute top-0 left-0 right-0 h-0.5 bg-blue-400 rounded-t" />
              )}
              <span className={`text-[10px] font-mono font-bold px-1 rounded ${
                session.config.type === 'ssh'
                  ? 'text-blue-400 bg-blue-400/10'
                  : session.config.type === 'telnet'
                    ? 'text-purple-400 bg-purple-400/10'
                    : session.config.type === 'bash'
                      ? 'text-orange-400 bg-orange-400/10'
                      : 'text-green-400 bg-green-400/10'
              }`}>
                {session.config.type === 'ssh' ? 'SSH' : session.config.type === 'telnet' ? 'TLN' : session.config.type === 'bash' ? 'BASH' : 'SRL'}
              </span>
              <span>{session.config.name}</span>
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  session.status === 'connected'
                    ? 'bg-green-500'
                    : session.status === 'connecting'
                      ? 'bg-yellow-500'
                      : session.status === 'error'
                        ? 'bg-red-500'
                        : 'bg-gray-500'
                }`}
              />
              <button
                onClick={(e) => handleTabClose(e, session.id)}
                className="w-4 h-4 flex items-center justify-center rounded hover:bg-gray-600 text-gray-500 hover:text-white transition-colors"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
      <button
        onClick={handleNewConnect}
        className="ml-2 w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
        title="新建连接"
      >
        +
      </button>
    </div>
  )
}

export default TabBar
