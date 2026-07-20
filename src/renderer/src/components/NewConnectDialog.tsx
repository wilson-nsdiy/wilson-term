import React, { useState, useEffect } from 'react'
import type { SSHConfig, SerialConfig, TelnetConfig, BashConfig, SSHAuthType, ConnectionConfig, SerialPortInfo, LogConfig, ScheduledTask, BashShellType, ShellInfo } from '@shared/types'
import { useAppStore } from '../store'
import { createLogConfigFromSettings } from '../utils/logConfig'
import LogConfigSection from './LogConfigSection'
import ScheduledTaskEditor from './ScheduledTaskEditor'

type TabType = 'ssh' | 'serial' | 'telnet' | 'bash'

interface NewConnectDialogProps {
  open: boolean
  onClose: () => void
  onConnect: (config: ConnectionConfig, scheduledTasks?: ScheduledTask[]) => void
  editConfig?: ConnectionConfig | null
  onEdit?: (config: ConnectionConfig, scheduledTasks?: ScheduledTask[]) => void
  onSaveAndConnect?: (config: ConnectionConfig, scheduledTasks?: ScheduledTask[]) => void
}

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
const DATA_BITS: SerialConfig['dataBits'][] = [5, 6, 7, 8]
const STOP_BITS: SerialConfig['stopBits'][] = [1, 2]
const PARITIES: SerialConfig['parity'][] = ['none', 'even', 'odd']
const FLOW_CONTROLS: SerialConfig['flowControl'][] = ['none', 'hardware', 'software']

const inputClass = 'w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors'
const inputErrorClass = (err?: string) => err ? 'border-red-500' : 'border-gray-600'

const NewConnectDialog: React.FC<NewConnectDialogProps> = ({
  open,
  onClose,
  onConnect,
  editConfig,
  onEdit,
  onSaveAndConnect
}) => {
  const isEditMode = !!editConfig

  const [activeTab, setActiveTab] = useState<TabType>('ssh')
  const [logExpanded, setLogExpanded] = useState(false)
  const [tasksExpanded, setTasksExpanded] = useState(false)

  // SSH
  const [sshName, setSshName] = useState('')
  const [host, setHost] = useState('192.168.1.1')
  const [port, setPort] = useState(22)
  const [username, setUsername] = useState('admin')
  const [authType, setAuthType] = useState<SSHAuthType>('password')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [sshErrors, setSshErrors] = useState<Record<string, string>>({})

  // 串口
  const [serialName, setSerialName] = useState('')
  const [serialPath, setSerialPath] = useState('')
  const [baudRate, setBaudRate] = useState(115200)
  const [dataBits, setDataBits] = useState<SerialConfig['dataBits']>(8)
  const [stopBits, setStopBits] = useState<SerialConfig['stopBits']>(1)
  const [parity, setParity] = useState<SerialConfig['parity']>('none')
  const [flowControl, setFlowControl] = useState<SerialConfig['flowControl']>('none')
  const [serialErrors, setSerialErrors] = useState<Record<string, string>>({})
  const [availablePorts, setAvailablePorts] = useState<SerialPortInfo[]>([])

  // Telnet
  const [telnetName, setTelnetName] = useState('')
  const [telnetHost, setTelnetHost] = useState('')
  const [telnetPort, setTelnetPort] = useState(23)
  const [telnetErrors, setTelnetErrors] = useState<Record<string, string>>({})

  // Bash
  const [bashName, setBashName] = useState('')
  const [bashShell, setBashShell] = useState<BashShellType>('auto')
  const [bashCwd, setBashCwd] = useState('')
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([])

  // 高级设置
  const settings = useAppStore((state) => state.settings)
  const savedSessions = useAppStore((state) => state.savedSessions)
  const [logConfig, setLogConfig] = useState<LogConfig>(createLogConfigFromSettings(settings))
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([])

  useEffect(() => {
    if (open && !settings.logPath) {
      window.api.log.getDefaultLogDir().then((defaultDir) => {
        if (defaultDir) {
          setLogConfig((prev) => ({ ...prev, logPath: defaultDir }))
          useAppStore.getState().updateSettings({ logPath: defaultDir })
        }
      })
    }
  }, [open])

  useEffect(() => {
    if (open && editConfig) {
      if (editConfig.type === 'ssh') {
        setActiveTab('ssh')
        const ssh = editConfig as SSHConfig
        setSshName(ssh.name); setHost(ssh.host); setPort(ssh.port); setUsername(ssh.username)
        setAuthType(ssh.authType === 'privateKey' ? 'privateKey' : ssh.authType)
        setPassword(ssh.password || ''); setPrivateKey(ssh.privateKey || ''); setPassphrase(ssh.passphrase || '')
        setSshErrors({})
      } else if (editConfig.type === 'telnet') {
        setActiveTab('telnet')
        const telnet = editConfig as TelnetConfig
        setTelnetName(telnet.name); setTelnetHost(telnet.host); setTelnetPort(telnet.port)
        setTelnetErrors({})
      } else if (editConfig.type === 'bash') {
        setActiveTab('bash')
        const bash = editConfig as BashConfig
        setBashName(bash.name); setBashShell(bash.shell || 'auto'); setBashCwd(bash.cwd || '')
      } else {
        setActiveTab('serial')
        const serial = editConfig as SerialConfig
        setSerialName(serial.name); setSerialPath(serial.path); setBaudRate(serial.baudRate)
        setDataBits(serial.dataBits); setStopBits(serial.stopBits); setParity(serial.parity); setFlowControl(serial.flowControl)
        setSerialErrors({})
      }
      setLogConfig(editConfig.logConfig ? { ...editConfig.logConfig } : createLogConfigFromSettings(settings))
      const saved = savedSessions.find((s) => s.config.id === editConfig.id)
      setScheduledTasks(saved?.scheduledTasks ? saved.scheduledTasks.map((t) => ({ ...t })) : [])
    } else if (open && !editConfig) {
      setLogConfig(createLogConfigFromSettings(settings))
      setScheduledTasks([])
    }
  }, [open, editConfig, settings])

  useEffect(() => {
    if (open && activeTab === 'serial') listPorts()
    if (open && activeTab === 'bash') listShells()
  }, [open, activeTab])

  const listPorts = async () => {
    try {
      const ports = await window.api.serial.listPorts()
      ports.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
      setAvailablePorts(ports)
    } catch {
      setAvailablePorts([])
    }
  }

  const listShells = async () => {
    try {
      const shells = await window.api.bash.listShells()
      setAvailableShells(shells)
    } catch {
      setAvailableShells([])
    }
  }

  // ---- 验证 ----

  const validateSSH = (): boolean => {
    const e: Record<string, string> = {}
    if (!host.trim()) e.host = '主机地址不能为空'
    if (!port || port < 1 || port > 65535) e.port = '端口范围为 1-65535'
    if (!username.trim()) e.username = '用户名不能为空'
    if (authType === 'privateKey' && !privateKey.trim()) e.privateKey = '密钥路径不能为空'
    setSshErrors(e)
    return Object.keys(e).length === 0
  }

  const validateSerial = (): boolean => {
    const e: Record<string, string> = {}
    if (!serialPath.trim()) e.path = '串口路径不能为空'
    setSerialErrors(e)
    return Object.keys(e).length === 0
  }

  const validateTelnet = (): boolean => {
    const e: Record<string, string> = {}
    if (!telnetHost.trim()) e.host = '主机地址不能为空'
    if (!telnetPort || telnetPort < 1 || telnetPort > 65535) e.port = '端口范围为 1-65535'
    setTelnetErrors(e)
    return Object.keys(e).length === 0
  }

  // ---- 构建配置 ----

  const buildSSHConfig = (id: string): SSHConfig => {
    return {
      type: 'ssh', id,
      name: sshName.trim() || `${username}@${host}`,
      host: host.trim(), port, username: username.trim(), authType,
      ...(authType === 'password' ? { password: password || undefined } : authType === 'privateKey' ? { privateKey: privateKey.trim(), passphrase: passphrase.trim() || undefined } : {}),
      logConfig: { ...logConfig }
    }
  }

  const buildTelnetConfig = (id: string): TelnetConfig => ({
    type: 'telnet', id,
    name: telnetName.trim() || `${telnetHost}:${telnetPort}`,
    host: telnetHost.trim(), port: telnetPort,
    logConfig: { ...logConfig }
  })

  const buildSerialConfig = (id: string): SerialConfig => ({
    type: 'serial', id,
    name: serialName.trim() || `${serialPath} @ ${baudRate}`,
    path: serialPath.trim(), baudRate, dataBits, stopBits, parity, flowControl,
    logConfig: { ...logConfig }
  })

  const buildBashConfig = (id: string): BashConfig => ({
    type: 'bash', id,
    name: bashName.trim() || '本地终端',
    shell: bashShell,
    cwd: bashCwd.trim() || undefined,
    logConfig: { ...logConfig }
  })

  // ---- 提交 ----

  const validate = (): boolean => {
    if (activeTab === 'ssh') return validateSSH()
    if (activeTab === 'telnet') return validateTelnet()
    if (activeTab === 'bash') return true
    return validateSerial()
  }

  const buildConfig = (id: string): ConnectionConfig => {
    if (activeTab === 'ssh') return buildSSHConfig(id)
    if (activeTab === 'telnet') return buildTelnetConfig(id)
    if (activeTab === 'bash') return buildBashConfig(id)
    return buildSerialConfig(id)
  }

  const submit = (config: ConnectionConfig) => {
    if (isEditMode && onEdit) {
      onEdit(config, scheduledTasks)
    } else {
      onConnect(config, scheduledTasks)
    }
  }

  const handleSubmit = () => {
    if (!validate()) return
    submit(buildConfig(editConfig?.id || ''))
    handleClose()
  }

  const handleSaveAndConnect = () => {
    if (!validate()) return
    onSaveAndConnect?.(buildConfig(''), scheduledTasks)
    handleClose()
  }

  const handleClose = () => {
    setSshName(''); setHost(''); setPort(22); setUsername('admin'); setAuthType('password'); setPassword(''); setPrivateKey(''); setPassphrase(''); setSshErrors({})
    setSerialName(''); setSerialPath(''); setBaudRate(115200); setDataBits(8); setStopBits(1); setParity('none'); setFlowControl('none'); setSerialErrors({})
    setTelnetName(''); setTelnetHost(''); setTelnetPort(23); setTelnetErrors({})
    setBashName(''); setBashShell('auto'); setBashCwd('')
    setLogConfig(createLogConfigFromSettings(useAppStore.getState().settings))
    setScheduledTasks([])
    setLogExpanded(false)
    setTasksExpanded(false)
    setActiveTab('ssh')
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleClose()
  }

  if (!open) return null

  const accentClasses: Record<string, { tab: string; button: string }> = {
    blue: { tab: 'border-blue-500 text-blue-400', button: 'bg-blue-600 hover:bg-blue-700' },
    purple: { tab: 'border-purple-500 text-purple-400', button: 'bg-purple-600 hover:bg-purple-700' },
    green: { tab: 'border-green-500 text-green-400', button: 'bg-green-600 hover:bg-green-700' },
    orange: { tab: 'border-orange-500 text-orange-400', button: 'bg-orange-600 hover:bg-orange-700' }
  }
  const tabAccent = activeTab === 'ssh' ? 'blue' : activeTab === 'telnet' ? 'purple' : activeTab === 'bash' ? 'orange' : 'green'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onKeyDown={handleKeyDown}>
      <div className="bg-gray-800 rounded-lg shadow-xl w-[600px] border border-gray-600" onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <h2 className="text-base font-medium text-gray-200">
            {isEditMode ? '编辑' : '新建'} {activeTab === 'ssh' ? 'SSH' : activeTab === 'telnet' ? 'Telnet' : activeTab === 'bash' ? '本地终端' : '串口'}连接
          </h2>
          <button onClick={handleClose} className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors">✕</button>
        </div>

        {/* 连接类型 Tab */}
        <div className="flex border-b border-gray-700 px-5">
          {(['ssh', 'telnet', 'serial', 'bash'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => !isEditMode && setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? accentClasses[tabAccent].tab
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              } ${isEditMode ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              {tab === 'ssh' ? 'SSH' : tab === 'telnet' ? 'Telnet' : tab === 'serial' ? '串口' : '本地终端'}
            </button>
          ))}
        </div>

        {/* 主体内容 */}
        <div className="px-6 py-4 overflow-y-auto max-h-[50vh]">
            {/* 基本 */}
            <div className="space-y-4">
                {activeTab === 'ssh' && (
                  <>
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">连接名称（可选）</label>
                      <input type="text" value={sshName} onChange={(e) => setSshName(e.target.value)} placeholder="自动生成" className={inputClass} />
                    </div>
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="block text-sm text-gray-400 mb-1">主机地址 <span className="text-red-400">*</span></label>
                        <input type="text" value={host} onChange={(e) => { setHost(e.target.value); setSshErrors((p) => ({ ...p, host: '' })) }} placeholder="192.168.1.1" className={`${inputClass} ${inputErrorClass(sshErrors.host)}`} />
                        {sshErrors.host && <p className="text-xs text-red-400 mt-1">{sshErrors.host}</p>}
                      </div>
                      <div className="w-24">
                        <label className="block text-sm text-gray-400 mb-1">端口 <span className="text-red-400">*</span></label>
                        <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} min={1} max={65535} className={`${inputClass} ${inputErrorClass(sshErrors.port)}`} />
                        {sshErrors.port && <p className="text-xs text-red-400 mt-1">{sshErrors.port}</p>}
                      </div>
                      <div className="w-28">
                        <label className="block text-sm text-gray-400 mb-1">用户名 <span className="text-red-400">*</span></label>
                        <input type="text" value={username} onChange={(e) => { setUsername(e.target.value); setSshErrors((p) => ({ ...p, username: '' })) }} placeholder="admin" className={`${inputClass} ${inputErrorClass(sshErrors.username)}`} />
                        {sshErrors.username && <p className="text-xs text-red-400 mt-1">{sshErrors.username}</p>}
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">认证方式</label>
                      <div className="flex gap-4">
                        <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                          <input type="radio" name="authType" checked={authType === 'password'} onChange={() => setAuthType('password')} className="accent-blue-500" />
                          密码
                        </label>
                        <label className="flex items-center gap-2 cursor-not-allowed text-sm text-gray-500">
                          <input type="radio" name="authType" checked={authType === 'privateKey'} disabled className="accent-blue-500 cursor-not-allowed opacity-50" />
                          密钥（暂不支持）
                        </label>
                      </div>
                      {authType === 'password' && <p className="mt-1 text-xs text-gray-500">留空则自动使用 ssh-agent 或应用目录下的默认密钥文件进行免密认证</p>}
                    </div>
                    {authType === 'password' && (
                      <div>
                        <label className="block text-sm text-gray-400 mb-1">密码</label>
                        <div className="relative">
                          <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => { setPassword(e.target.value); setSshErrors((p) => ({ ...p, password: '' })) }} placeholder="留空则自动使用密钥或 ssh-agent 免密认证" className={`w-full px-3 py-1.5 pr-9 bg-gray-700 border rounded text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors ${inputErrorClass(sshErrors.password)}`} />
                          <button type="button" onClick={() => setShowPassword((p) => !p)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200 transition-colors p-0.5" tabIndex={-1}>
                            {showPassword ? (
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
                            ) : (
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                            )}
                          </button>
                        </div>
                        {sshErrors.password && <p className="text-xs text-red-400 mt-1">{sshErrors.password}</p>}
                      </div>
                    )}
                    {authType === 'privateKey' && (
                      <>
                        <div>
                          <label className="block text-sm text-gray-400 mb-1">密钥路径 <span className="text-red-400">*</span></label>
                          <input type="text" value={privateKey} onChange={(e) => { setPrivateKey(e.target.value); setSshErrors((p) => ({ ...p, privateKey: '' })) }} placeholder="密钥文件路径" className={`${inputClass} ${inputErrorClass(sshErrors.privateKey)}`} />
                          {sshErrors.privateKey && <p className="text-xs text-red-400 mt-1">{sshErrors.privateKey}</p>}
                        </div>
                        <div>
                          <label className="block text-sm text-gray-400 mb-1">密钥密码（可选）</label>
                          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="如果密钥有密码则填写" className={inputClass} />
                        </div>
                      </>
                    )}
                  </>
                )}

                {activeTab === 'telnet' && (
                  <>
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">连接名称（可选）</label>
                      <input type="text" value={telnetName} onChange={(e) => setTelnetName(e.target.value)} placeholder="自动生成" className={inputClass} />
                    </div>
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="block text-sm text-gray-400 mb-1">主机地址 <span className="text-red-400">*</span></label>
                        <input type="text" value={telnetHost} onChange={(e) => { setTelnetHost(e.target.value); setTelnetErrors((p) => ({ ...p, host: '' })) }} placeholder="192.168.1.1" className={`${inputClass} ${inputErrorClass(telnetErrors.host)}`} />
                        {telnetErrors.host && <p className="text-xs text-red-400 mt-1">{telnetErrors.host}</p>}
                      </div>
                      <div className="w-24">
                        <label className="block text-sm text-gray-400 mb-1">端口 <span className="text-red-400">*</span></label>
                        <input type="number" value={telnetPort} onChange={(e) => setTelnetPort(Number(e.target.value))} min={1} max={65535} className={`${inputClass} ${inputErrorClass(telnetErrors.port)}`} />
                        {telnetErrors.port && <p className="text-xs text-red-400 mt-1">{telnetErrors.port}</p>}
                      </div>
                    </div>
                  </>
                )}

                {activeTab === 'serial' && (
                  <>
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">连接名称（可选）</label>
                      <input type="text" value={serialName} onChange={(e) => setSerialName(e.target.value)} placeholder="自动生成" className={inputClass} />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">串口路径 <span className="text-red-400">*</span></label>
                      <div className="flex gap-2">
                        <select value={serialPath} onChange={(e) => { setSerialPath(e.target.value); setSerialErrors((p) => ({ ...p, path: '' })) }} className={`flex-1 px-3 py-1.5 bg-gray-700 border rounded text-sm text-gray-200 focus:outline-none focus:border-blue-500 transition-colors ${inputErrorClass(serialErrors.path)}`}>
                          <option value="">选择串口...</option>
                          {availablePorts.map((p) => (
                            <option key={p.path} value={p.path}>{p.friendlyName || (p.manufacturer ? `${p.path} - ${p.manufacturer}` : p.path)}</option>
                          ))}
                        </select>
                        <button onClick={listPorts} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded text-sm text-gray-300 transition-colors" title="刷新串口列表">🔄</button>
                      </div>
                      {serialErrors.path && <p className="text-xs text-red-400 mt-1">{serialErrors.path}</p>}
                    </div>
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">波特率</label>
                      <select value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))} className={inputClass}>
                        {BAUD_RATES.map((br) => <option key={br} value={br}>{br}</option>)}
                      </select>
                    </div>
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="block text-sm text-gray-400 mb-1">数据位</label>
                        <select value={dataBits} onChange={(e) => setDataBits(Number(e.target.value) as SerialConfig['dataBits'])} className={inputClass}>
                          {DATA_BITS.map((db) => <option key={db} value={db}>{db}</option>)}
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-sm text-gray-400 mb-1">停止位</label>
                        <select value={stopBits} onChange={(e) => setStopBits(Number(e.target.value) as SerialConfig['stopBits'])} className={inputClass}>
                          {STOP_BITS.map((sb) => <option key={sb} value={sb}>{sb}</option>)}
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-sm text-gray-400 mb-1">校验位</label>
                        <select value={parity} onChange={(e) => setParity(e.target.value as SerialConfig['parity'])} className={inputClass}>
                          {PARITIES.map((p) => <option key={p} value={p}>{p === 'none' ? '无' : p === 'even' ? '偶校验' : '奇校验'}</option>)}
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-sm text-gray-400 mb-1">流控</label>
                        <select value={flowControl} onChange={(e) => setFlowControl(e.target.value as SerialConfig['flowControl'])} className={inputClass}>
                          {FLOW_CONTROLS.map((fc) => <option key={fc} value={fc}>{fc === 'none' ? '无' : fc === 'hardware' ? '硬件' : '软件'}</option>)}
                        </select>
                      </div>
                    </div>
                  </>
                )}

                {activeTab === 'bash' && (
                  <>
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">连接名称（可选）</label>
                      <input type="text" value={bashName} onChange={(e) => setBashName(e.target.value)} placeholder="本地终端" className={inputClass} />
                    </div>
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">Shell 类型</label>
                      <select value={bashShell} onChange={(e) => setBashShell(e.target.value as BashShellType)} className={inputClass}>
                        {availableShells.map((s) => (
                          <option key={s.type} value={s.type} disabled={!s.available}>
                            {s.label}{!s.available ? '（不可用）' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">启动目录（可选）</label>
                      <div className="flex gap-2">
                        <input type="text" value={bashCwd} onChange={(e) => setBashCwd(e.target.value)} placeholder="默认用户目录" className={inputClass} />
                        <button
                          onClick={async () => {
                            const dir = await window.api.dialog.openDirectory()
                            if (dir) setBashCwd(dir)
                          }}
                          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded text-sm text-gray-300 transition-colors shrink-0"
                        >浏览</button>
                      </div>
                    </div>
                  </>
                )}
              </div>

            {/* 高级（折叠面板） */}
            <div className="mt-4 border-t border-gray-700 pt-3">
              <button
                onClick={() => setLogExpanded(!logExpanded)}
                className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 transition-colors w-full text-left"
              >
                <span className={`text-xs transition-transform ${logExpanded ? 'rotate-90' : ''}`}>▶</span>
                高级
              </button>
              {logExpanded && (
                <div className="mt-3">
                  <LogConfigSection value={logConfig} onChange={setLogConfig} />
                </div>
              )}
            </div>

            {/* 定时任务（折叠面板） */}
            <div className="mt-3 border-t border-gray-700 pt-3">
              <button
                onClick={() => setTasksExpanded(!tasksExpanded)}
                className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 transition-colors w-full text-left"
              >
                <span className={`text-xs transition-transform ${tasksExpanded ? 'rotate-90' : ''}`}>▶</span>
                定时任务
              </button>
              {tasksExpanded && (
                <div className="mt-3">
                  <p className="text-xs text-gray-500 mb-3">连接成功后自动执行的定时命令</p>
                  <ScheduledTaskEditor tasks={scheduledTasks} onChange={setScheduledTasks} />
                </div>
              )}
            </div>
          </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-700">
          {isEditMode && (
            <span className="text-xs text-yellow-400/80">修改将在下次连接时生效</span>
          )}
          {!isEditMode && <span />}
          <div className="flex gap-3">
            <button onClick={handleClose} className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors">取消</button>
            <button onClick={handleSubmit} className={`px-4 py-1.5 rounded text-sm text-white transition-colors ${accentClasses[tabAccent].button}`}>
              {isEditMode ? '保存' : '连接'}
            </button>
            {!isEditMode && onSaveAndConnect && (
              <button onClick={handleSaveAndConnect} className="px-4 py-1.5 bg-gray-600 hover:bg-gray-500 rounded text-sm text-gray-200 transition-colors">保存并连接</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default NewConnectDialog
