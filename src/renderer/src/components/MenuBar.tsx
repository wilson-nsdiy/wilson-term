import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useAppStore } from '../store'
import { rendererPluginHost } from '@renderer/plugin-host.ts'
import AboutDialog from './AboutDialog'
import UpdateDialog from './UpdateDialog'
import GlobalOptionsDialog from './GlobalOptionsDialog'
import ButtonBarManager from './ButtonBarManager'

import ScheduledTaskDialog from './ScheduledTaskDialog'
import PluginManager from './PluginManager'

/** 菜单项定义 */
interface MenuItemDef {
  /** 显示标签 */
  label: string
  /** 点击回调 */
  onClick?: () => void
  /** 是否禁用 */
  disabled?: boolean
  /** 是否有勾选 */
  checked?: boolean
  /** 分隔线 */
  separator?: boolean
  /** 分组标题 */
  groupTitle?: boolean
}

/** 菜单定义 */
interface MenuDef {
  /** 菜单标题 */
  label: string
  /** 子菜单项 */
  items: MenuItemDef[]
}

const MenuBar: React.FC = () => {
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null)
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false)
  const [globalOptionsDialogOpen, setGlobalOptionsDialogOpen] = useState(false)
  const [scheduledTaskDialogOpen, setScheduledTaskDialogOpen] = useState(false)
  const [pluginManagerOpen, setPluginManagerOpen] = useState(false)
  const menuBarRef = useRef<HTMLDivElement>(null)

  const hasNewVersion = useAppStore((state) => state.hasNewVersion)
  const updateDialogOpen = useAppStore((state) => state.updateDialogOpen)
  const setUpdateDialogOpen = useAppStore((state) => state.setUpdateDialogOpen)
  const commandInputVisible = useAppStore((state) => state.commandInputVisible)
  const statusBarVisible = useAppStore((state) => state.statusBarVisible)
  const buttonBarVisible = useAppStore((state) => state.buttonBarVisible)
  const commandButtonGroupCount = useAppStore((state) => state.commandButtonGroups.length)

  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const activeSessionType = useAppStore((state) => {
    const s = state.sessions.find((s) => s.id === state.activeSessionId)
    return s?.config.type
  })
  const activeSessionStatus = useAppStore((state) => {
    const s = state.sessions.find((s) => s.id === state.activeSessionId)
    return s?.status
  })
  const isSftpAvailable =
    activeSessionType === 'ssh' && activeSessionStatus === 'connected'

  const sessionLogEnabled = useAppStore((state) => {
    if (!state.activeSessionId) return false
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return state.settings.logEnabled
    return session.config.logConfig?.logEnabled ?? state.settings.logEnabled
  })

  const menus: MenuDef[] = useMemo(() => [
    {
      label: '文件',
      items: [
        {
          label: '新建连接',
          onClick: () => {
            useAppStore.getState().setNewConnectDialogOpen(true)
            setOpenMenuIndex(null)
          }
        },
        { separator: true } as MenuItemDef,
        { label: '日志', groupTitle: true } as MenuItemDef,
        {
          label: '启用记录',
          checked: sessionLogEnabled,
          disabled: !activeSessionId,
          onClick: () => {
            const id = useAppStore.getState().activeSessionId
            if (id) {
              useAppStore.getState().toggleSessionLog(id)
            }
            setOpenMenuIndex(null)
          }
        },
        {
          label: '打开日志文件',
          disabled: !activeSessionId,
          onClick: () => {
            const id = useAppStore.getState().activeSessionId
            if (id) {
              window.api.log.openFile(id)
            }
            setOpenMenuIndex(null)
          }
        },
        {
          label: '打开日志所在目录',
          disabled: !activeSessionId,
          onClick: () => {
            const id = useAppStore.getState().activeSessionId
            if (id) {
              window.api.log.openDir(id)
            }
            setOpenMenuIndex(null)
          }
        }
      ]
    },
    {
      label: '编辑',
      items: [
        {
          label: '复制',
          onClick: () => {
            document.execCommand('copy')
            setOpenMenuIndex(null)
          },
          disabled: !activeSessionId
        },
        {
          label: '粘贴',
          onClick: async () => {
            try {
              const text = await navigator.clipboard.readText()
              if (text) {
                const id = useAppStore.getState().activeSessionId
                const event = new CustomEvent('terminal:paste', { detail: { sessionId: id, text } })
                window.dispatchEvent(event)
              }
            } catch (err) {
              console.error('粘贴失败:', err)
            }
            setOpenMenuIndex(null)
          },
          disabled: !activeSessionId
        },
        { separator: true } as MenuItemDef,
        {
          label: '查找',
          onClick: () => {
            useAppStore.getState().setSearchVisible(true)
            setOpenMenuIndex(null)
          },
          disabled: !activeSessionId
        }
      ]
    },
    {
      label: '视图',
      items: [
        {
          label: '命令行窗口',
          checked: commandInputVisible,
          onClick: () => {
            const visible = useAppStore.getState().commandInputVisible
            useAppStore.getState().setCommandInputVisible(!visible)
            setOpenMenuIndex(null)
          }
        },
        {
          label: '按钮栏',
          checked: buttonBarVisible,
          onClick: () => {
            const next = !buttonBarVisible
            useAppStore.getState().setButtonBarVisible(next)
            if (next && commandButtonGroupCount > 0) {
              const { activeButtonGroupId, commandButtonGroups } = useAppStore.getState()
              if (!activeButtonGroupId || !commandButtonGroups.some(g => g.id === activeButtonGroupId)) {
                useAppStore.getState().setActiveButtonGroupId(commandButtonGroups[0].id)
              }
            }
            setOpenMenuIndex(null)
          }
        },
        {
          label: '状态栏',
          checked: statusBarVisible,
          onClick: () => {
            const visible = useAppStore.getState().statusBarVisible
            useAppStore.getState().setStatusBarVisible(!visible)
            setOpenMenuIndex(null)
          }
        }
      ]
    },
    {
      label: '选项',
      items: [
        {
          label: '全局选项',
          onClick: () => {
            setGlobalOptionsDialogOpen(true)
            setOpenMenuIndex(null)
          }
        },
        {
          label: '编辑默认设置',
          onClick: () => {
            useAppStore.getState().setSettingsDialogOpen(true)
            setOpenMenuIndex(null)
          }
        }
      ]
    },
    {
      label: '工具',
      items: [
        ...rendererPluginHost.collectMenuItems().map(item => ({
          label: item.label, checked: item.checked, disabled: item.disabled, onClick: item.onClick,
        })),
        ...(rendererPluginHost.collectMenuItems().length > 0 ? [{ separator: true } as MenuItemDef] : []),
        {
          label: '定时任务',
          onClick: () => {
            setScheduledTaskDialogOpen(true)
            setOpenMenuIndex(null)
          }
        },
        {
          label: '文件管理 (SFTP)',
          disabled: !isSftpAvailable,
          onClick: () => {
            useAppStore.getState().setSftpDialogOpen(true)
            setOpenMenuIndex(null)
          }
        },
        { separator: true } as MenuItemDef,
        {
          label: '插件管理',
          onClick: () => {
            setPluginManagerOpen(true)
            setOpenMenuIndex(null)
          }
        }
      ]
    },
    {
      label: '帮助',
      items: [
        {
          label: '检查更新',
          onClick: () => {
            setOpenMenuIndex(null)
            setUpdateDialogOpen(true)
          }
        },
        { separator: true } as MenuItemDef,
        {
          label: '关于',
          onClick: () => {
            setOpenMenuIndex(null)
            setAboutDialogOpen(true)
          }
        }
      ]
    }
  ], [activeSessionId, sessionLogEnabled, commandInputVisible, buttonBarVisible, commandButtonGroupCount, statusBarVisible, isSftpAvailable, hasNewVersion])

  /** 点击菜单栏外部关闭 */
  useEffect(() => {
    if (openMenuIndex === null) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenuIndex(null)
      }
    }

    // 延迟绑定避免当前点击事件立即触发关闭
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [openMenuIndex])

  /** ESC 键关闭菜单 */
  useEffect(() => {
    if (openMenuIndex === null) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenuIndex(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [openMenuIndex])

  /** 处理菜单标题点击 */
  const handleMenuClick = useCallback((index: number) => {
    setOpenMenuIndex((prev) => (prev === index ? null : index))
  }, [])

  /** 处理菜单标题 hover（当菜单已展开时，hover 切换到其他菜单） */
  const handleMenuHover = useCallback((index: number) => {
    setOpenMenuIndex((prev) => prev !== null ? index : prev)
  }, [])

  return (
    <>
      <div ref={menuBarRef} className="flex items-center h-full select-none">
        {menus.map((menu, menuIndex) => (
          <div key={menu.label} className="relative">
            {/* 菜单标题 */}
            <button
              className={`px-3 h-full text-sm transition-colors ${
                openMenuIndex === menuIndex
                  ? 'bg-gray-600 text-white'
                  : 'text-gray-300 hover:bg-gray-700 hover:text-white'
              }`}
              onClick={() => handleMenuClick(menuIndex)}
              onMouseEnter={() => handleMenuHover(menuIndex)}
            >
              {menu.label}
            </button>

            {/* 下拉菜单 */}
            {openMenuIndex === menuIndex && (
              <div className="absolute top-full left-0 z-50 min-w-[200px] bg-[#2a2a3a] border border-[#4a4a5a] rounded-lg shadow-xl py-1">
                {menu.items.map((item, itemIndex) => {
                  if (item.separator) {
                    return (
                      <div key={itemIndex} className="h-px bg-[#4a4a5a] mx-2 my-1" />
                    )
                  }
                  if (item.groupTitle) {
                    return (
                      <div key={itemIndex} className="px-3 pt-2 pb-1 text-xs text-gray-500 uppercase tracking-wider">{item.label}</div>
                    )
                  }
                  return (
                    <button
                      key={itemIndex}
                      className={`w-full px-3 py-2 text-sm text-left flex items-center justify-between transition-colors ${
                        item.disabled
                          ? 'text-gray-500 cursor-not-allowed'
                          : 'text-gray-200 hover:bg-[#3a3a4a]'
                      }`}
                      onClick={() => {
                        if (!item.disabled && item.onClick) {
                          item.onClick()
                        }
                      }}
                      disabled={item.disabled}
                    >
                      <span className="flex items-center gap-2">
                        {item.checked && <span className="w-4 text-blue-400">✓</span>}
                        <span className={item.checked ? '' : 'ml-6'}>{item.label}</span>
                        {hasNewVersion && item.label === '检查更新' && (
                          <span className="text-[10px] leading-none px-1 py-0.5 rounded bg-red-500 text-white font-bold">NEW</span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 关于对话框 */}
      <AboutDialog
        open={aboutDialogOpen}
        onClose={() => setAboutDialogOpen(false)}
      />

      {/* 检查更新对话框（含版本更新日志） */}
      <UpdateDialog
        open={updateDialogOpen}
        onClose={() => setUpdateDialogOpen(false)}
      />

      {/* 全局选项对话框 */}
      <GlobalOptionsDialog
        open={globalOptionsDialogOpen}
        onClose={() => setGlobalOptionsDialogOpen(false)}
      />

      {/* 按钮栏管理对话框 */}
      <ButtonBarManager />

      {/* 定时任务对话框 */}
      <ScheduledTaskDialog
        open={scheduledTaskDialogOpen}
        onClose={() => setScheduledTaskDialogOpen(false)}
      />

      {/* 插件管理对话框 */}
      <PluginManager
        open={pluginManagerOpen}
        onClose={() => setPluginManagerOpen(false)}
      />
    </>
  )
}

export default MenuBar
