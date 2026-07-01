import React, { useEffect, useState, useCallback } from 'react'
import TitleBar from './components/TitleBar'
import TabBar from './components/TabBar'
import Terminal from './components/Terminal'
import Sidebar from './components/Sidebar'
import SettingsDialog from './components/SettingsDialog'
import SftpFileManager from './components/SftpFileManager'
import HostKeyDialog from './components/HostKeyDialog'
import PasswordDialog from './components/PasswordDialog'
import PluginManager from './components/PluginManager'
import UpdateToast from './components/UpdateToast'
import { useAppStore } from './store'
import { rendererPluginHost } from '@renderer/plugin-host.ts'
import type { HostKeyVerifyRequest, PasswordRequest } from '@shared/types'

const App: React.FC = () => {
  const loadSavedSessions = useAppStore((state) => state.loadSavedSessions)
  const settingsDialogOpen = useAppStore((state) => state.settingsDialogOpen)
  const setSettingsDialogOpen = useAppStore((state) => state.setSettingsDialogOpen)
  const [hostKeyRequest, setHostKeyRequest] = useState<HostKeyVerifyRequest | null>(null)
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null)

  const [pluginManagerOpen, setPluginManagerOpen] = useState(false)

  const handleHostKeyRespond = useCallback((sessionId: string, accepted: boolean) => {
    window.api.ssh.respondHostKey(sessionId, accepted)
    setHostKeyRequest(null)
  }, [])

  const handlePasswordRespond = useCallback((sessionId: string, password: string) => {
    window.api.ssh.respondPassword(sessionId, password)
    setPasswordRequest(null)
  }, [])

  useEffect(() => {
    const unsub1 = window.api.ssh.onHostKeyVerify(setHostKeyRequest)
    const unsub2 = window.api.ssh.onPasswordRequest(setPasswordRequest)
    return () => { unsub1(); unsub2() }
  }, [])

  useEffect(() => {
    const init = async () => {
      // 加载持久化的应用设置和视图状态
      await useAppStore.getState().loadAppSettings()
      await useAppStore.getState().loadViewState()

      await useAppStore.getState().initDefaultLogDir()
      // 加载按钮栏分组数据
      await useAppStore.getState().loadCommandButtonGroups()

      // 加载定时任务
      await useAppStore.getState().loadScheduledTasks()

      // 加载 Profile 列表
      await useAppStore.getState().loadProfiles()

      // 加载并激活插件
      await rendererPluginHost.loadFromMain()
      for (const [, entry] of rendererPluginHost.getAll()) {
        const list = await window.api.plugin.list()
        const item = list.find(i => i.manifest.id === entry.definition.manifest.id)
        if (item?.enabled) await rendererPluginHost.activate(entry.definition.manifest.id)
      }

      // 自动检查更新
      window.api.app.checkUpdate()
    }
    loadSavedSessions()
    init()
  }, [])

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white overflow-hidden">
      {/* 自定义标题栏 */}
      <TitleBar />

      <div className="flex flex-1 overflow-hidden">
        {/* 侧边栏 - 会话管理 */}
        <Sidebar />

        <div className="flex flex-col flex-1 overflow-hidden">
          {/* 标签栏 */}
          <TabBar />

          {/* 终端区域 */}
          <div className="flex-1 overflow-hidden">
            <Terminal />
          </div>
        </div>
      </div>

      {/* 设置对话框（全局） */}
      <SettingsDialog
        open={settingsDialogOpen}
        onClose={() => setSettingsDialogOpen(false)}
      />

      {/* 自动检查更新 Toast 通知 */}
      <UpdateToast />

      {/* SFTP 文件管理器 */}
      <SftpFileManager />

      {/* 主机密钥验证对话框 */}
      <HostKeyDialog
        request={hostKeyRequest}
        onRespond={handleHostKeyRespond}
      />

      {/* 密码输入对话框 */}
      <PasswordDialog
        request={passwordRequest}
        onRespond={handlePasswordRespond}
      />

      {/* 插件管理对话框 */}
      <PluginManager
        open={pluginManagerOpen}
        onClose={() => setPluginManagerOpen(false)}
      />
    </div>
  )
}

export default App
