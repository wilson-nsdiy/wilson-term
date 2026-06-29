import koffi from 'koffi'
import { execSync } from 'child_process'

/** 缓存域名查询结果，避免重复调用系统 API（域名在运行期间不会变化，无需过期） */
let cachedDomain: string | null = null

// Windows API 常量
const ComputerNameDnsDomain = 2

// 惰性初始化，避免模块加载时 koffi 异常导致应用崩溃
let kernel32: koffi.IKoffiLib | null = null
let GetComputerNameExW: ((type: number, buffer: Buffer, size: { value: number }) => number) | null = null

function initWin32Api(): void {
  if (kernel32 !== null) return
  try {
    kernel32 = koffi.load('kernel32.dll')
    GetComputerNameExW = kernel32.func('GetComputerNameExW', 'bool', ['int', '_Out_ wchar_t *', '_Inout_ uint32_t *'])
  } catch {
    // koffi 或 kernel32 不可用，回退到环境变量
  }
}

/**
 * 获取当前计算机的 DNS 域名
 * Windows: 通过 GetComputerNameExW API 获取，回退到环境变量
 * macOS/Linux: 通过 hostname -d 获取
 */
export function getComputerDomain(): string {
  if (cachedDomain !== null) return cachedDomain

  let domain = ''

  if (process.platform === 'win32') {
    domain = getDomainWin32()
  } else {
    try {
      domain = execSync('hostname -d 2>/dev/null || echo ""', {
        encoding: 'utf-8',
        timeout: 3000
      }).trim()
    } catch {
      domain = ''
    }
  }

  cachedDomain = domain
  return domain
}

function getDomainWin32(): string {
  initWin32Api()

  if (GetComputerNameExW) {
    try {
      const size = { value: 256 }
      const buffer = Buffer.alloc(size.value * 2)
      const ok = GetComputerNameExW(ComputerNameDnsDomain, buffer, size)
      if (ok) {
        return buffer.toString('utf16le', 0, size.value * 2).replace(/\0+$/, '')
      }
    } catch {
      // API 调用失败
    }
  }

  return process.env.USERDNSDOMAIN || ''
}
