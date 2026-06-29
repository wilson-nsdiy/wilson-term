import { readFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { UpdateCheckResult, ChangelogEntry, VersionEntry } from '@shared/types'

const GITHUB_REPO = 'wilson-zhounan/wilson-term'
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`

/** 网络请求超时（毫秒） */
const NETWORK_TIMEOUT = 10000

/**
 * 带超时的 fetch 请求
 */
function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  return Promise.race([
    fetch(url, {
      headers: { 'User-Agent': 'Wilson-Term-Update-Checker' }
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`请求超时 (${ms}ms)`)), ms)
    )
  ])
}

/**
 * 获取当前应用版本
 */
export function getAppVersion(): string {
  try {
    const pkgPath = join(app.getAppPath(), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 从 GitHub Releases 检查更新
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = getAppVersion()

  try {
    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/releases`,
      NETWORK_TIMEOUT
    )

    if (!response.ok) {
      return {
        hasUpdate: false,
        currentVersion,
        error: `GitHub API 请求失败: ${response.status}`
      }
    }

    const releases: GithubRelease[] = await response.json()

    const newVersions: VersionEntry[] = []

    for (const release of releases) {
      const tagVersion = release.tag_name.replace(/^v/i, '')
      if (compareVersions(tagVersion, currentVersion) <= 0) break

      const changes = release.body
        ? release.body.split('\n').filter((line) => line.trim() !== '')
        : []

      newVersions.push({
        version: tagVersion,
        date: release.published_at?.split('T')[0],
        author: release.author?.login,
        changes
      })
    }

    const hasUpdate = newVersions.length > 0
    const latest = newVersions[0]

    // 查找最新版本对应的 Windows 安装包下载链接
    let downloadUrl: string | undefined
    if (latest && releases.length > 0) {
      const latestRelease = releases.find(
        (r) => r.tag_name.replace(/^v/i, '') === latest.version
      )
      if (latestRelease) {
        const asset = latestRelease.assets?.find(
          (a) => a.name.endsWith('.exe') && !a.name.includes('.blockmap')
        )
        downloadUrl = asset?.browser_download_url
      }
    }

    return {
      hasUpdate,
      currentVersion,
      remoteVersion: latest?.version,
      releaseDate: latest?.date,
      downloadUrl,
      releaseNotes: latest?.changes?.join('\n'),
      author: latest?.author,
      versions: hasUpdate ? newVersions : undefined
    }
  } catch (err) {
    return {
      hasUpdate: false,
      currentVersion,
      error: err instanceof Error ? err.message : '未知错误'
    }
  }
}

/**
 * 读取本地 CHANGELOG
 */
export async function getChangelog(): Promise<ChangelogEntry[]> {
  try {
    const changelogPath = join(app.getAppPath(), 'CHANGELOG.json')
    const content = await readFile(changelogPath, 'utf-8')
    return JSON.parse(content) as ChangelogEntry[]
  } catch (err) {
    console.error('[getChangelog] 读取更新日志失败:', err)
    return []
  }
}

/**
 * 比较语义化版本号
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.replace(/^v/, '').split('.').map(Number)
  const partsB = b.replace(/^v/, '').split('.').map(Number)
  const len = Math.max(partsA.length, partsB.length)

  for (let i = 0; i < len; i++) {
    const numA = partsA[i] ?? 0
    const numB = partsB[i] ?? 0
    if (numA > numB) return 1
    if (numA < numB) return -1
  }

  return 0
}

/** GitHub Release API 响应类型 */
interface GithubRelease {
  tag_name: string
  published_at?: string
  body?: string
  author?: { login: string }
  assets?: GithubAsset[]
}

interface GithubAsset {
  name: string
  browser_download_url: string
}
