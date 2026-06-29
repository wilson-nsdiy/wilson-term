import React, { useEffect, useCallback } from 'react'
import type { HostKeyVerifyRequest } from '@shared/types'

interface HostKeyDialogProps {
  request: HostKeyVerifyRequest | null
  onRespond: (sessionId: string, accepted: boolean) => void
}

const HostKeyDialog: React.FC<HostKeyDialogProps> = ({ request, onRespond }) => {
  const handleAccept = useCallback(() => {
    if (request) {
      onRespond(request.sessionId, true)
    }
  }, [request, onRespond])

  const handleReject = useCallback(() => {
    if (request) {
      onRespond(request.sessionId, false)
    }
  }, [request, onRespond])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!request) return
      if (e.key === 'Enter') {
        handleAccept()
      } else if (e.key === 'Escape') {
        handleReject()
      }
    },
    [request, handleAccept, handleReject]
  )

  useEffect(() => {
    if (request) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [request, handleKeyDown])

  if (!request) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50">
      <div
        className="bg-gray-800 rounded-lg shadow-xl w-[460px] border border-gray-600"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-700">
          <span className="text-yellow-400 text-lg">⚠</span>
          <h2 className="text-base font-medium text-gray-200">
            {request.changed ? '主机密钥变更警告' : '主机密钥验证'}
          </h2>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4 space-y-3">
          {request.changed ? (
            <>
              <p className="text-sm text-red-300 leading-relaxed">
                <span className="font-semibold">警告：主机 {request.host}:{request.port} 的密钥已变更！</span>
              </p>
              <p className="text-sm text-gray-300 leading-relaxed">
                这可能意味着有人正在尝试窃听您的通信（中间人攻击），
                也可能是主机密钥确实已经更换。
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-300 leading-relaxed">
              无法确认主机 <span className="text-white font-medium">{request.host}:{request.port}</span> 的真实性。
            </p>
          )}

          <div className="bg-gray-900 rounded px-4 py-3 space-y-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-gray-500 w-16 shrink-0">密钥类型</span>
              <span className="text-sm text-gray-200 font-mono">{request.keyType}</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-gray-500 w-16 shrink-0">指纹</span>
              <span className="text-sm text-green-400 font-mono break-all">
                SHA256:{request.fingerprint}
              </span>
            </div>
          </div>

          {request.changed ? (
            <p className="text-sm text-red-300 leading-relaxed">
              如果您不确定密钥变更的原因，建议拒绝连接并联系管理员确认。
            </p>
          ) : (
            <p className="text-sm text-gray-400 leading-relaxed">
              此主机的密钥尚未记录在已知主机列表中。确认后将自动保存到应用的 known_hosts 文件中。
            </p>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-3 px-5 py-3 border-t border-gray-700">
          <button
            onClick={handleReject}
            className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300 transition-colors"
          >
            拒绝
          </button>
          <button
            onClick={handleAccept}
            className={`px-4 py-1.5 rounded text-sm transition-colors ${
              request.changed
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            接受并连接
          </button>
        </div>
      </div>
    </div>
  )
}

export default HostKeyDialog
