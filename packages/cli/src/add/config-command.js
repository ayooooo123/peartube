import nodeFs from 'node:fs/promises'
import { describeSecret, updateContentConfig } from './preferences.js'

export class ConfigUsageError extends Error {
  constructor (message, { code, exitCode = 2 } = {}) {
    super(message)
    this.name = 'ConfigUsageError'
    this.code = code
    this.exitCode = exitCode
  }
}

export async function buildConfigReport ({ preferences, fs = nodeFs, identityManager = null, probe = probeYtDlp } = {}) {
  const report = {
    storagePath: preferences.storagePath,
    tmdb: { status: describeSecret(preferences.tmdbApiKey), source: preferences.tmdbApiKeySource },
    ytDlp: { path: preferences.ytDlpPath, version: null, error: null },
    cookies: { status: describeSecret(preferences.ytDlpCookiesPath), valid: null },
    identities: [],
    activeIdentity: null,
    network: preferences.network
  }

  try {
    const probed = await probe(preferences.ytDlpPath)
    report.ytDlp.version = probed.version
  } catch (error) {
    report.ytDlp.error = error.code || 'ERR_PEARTUBE_YTDLP_MISSING'
  }

  if (preferences.ytDlpCookiesPath) {
    report.cookies.valid = await validateCookieFile(preferences.ytDlpCookiesPath, { fs })
  }

  if (identityManager && typeof identityManager.listIdentities === 'function') {
    const identities = await identityManager.listIdentities()
    const activeId = typeof identityManager.getActiveIdentityId === 'function'
      ? identityManager.getActiveIdentityId()
      : null
    report.identities = identities.map((identity) => ({
      id: identity.id,
      name: identity.name,
      publicKey: shortKey(identity.publicKey)
    }))
    report.activeIdentity = report.identities.find((identity) => identity.id === activeId) || null
  }

  return report
}

export function renderConfigReport (report) {
  const lines = [
    'PearTube content settings',
    `Storage: ${report.storagePath}`,
    `TMDB API key: ${report.tmdb.status}${report.tmdb.source ? ` (${report.tmdb.source})` : ''}`,
    report.ytDlp.version
      ? `yt-dlp: ${report.ytDlp.path} (${report.ytDlp.version})`
      : `yt-dlp: ${report.ytDlp.path} (${report.ytDlp.error || 'not found'})`,
    `Cookies: ${report.cookies.status}${report.cookies.valid === false ? ' (unreadable)' : ''}`
  ]
  if (report.activeIdentity) {
    lines.push(`Active identity: ${report.activeIdentity.name} · ${report.activeIdentity.publicKey}`)
  } else {
    lines.push('Active identity: none')
  }
  return lines
}

export async function validateCookieFile (path, { fs = nodeFs } = {}) {
  if (!path) return false
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

export async function probeYtDlp (path, { exec = defaultExec } = {}) {
  let result
  try {
    result = await exec(path, ['--version'])
  } catch (cause) {
    throw new ConfigUsageError(`yt-dlp is not available at ${path}`, {
      code: 'ERR_PEARTUBE_YTDLP_MISSING'
    })
  }
  if (!result || result.code !== 0) {
    throw new ConfigUsageError(`yt-dlp exited with an error at ${path}`, {
      code: 'ERR_PEARTUBE_YTDLP_MISSING'
    })
  }
  return String(result.stdout || '').trim()
}

export async function applyConfigUpdate ({ field, value, configPath, fs = nodeFs, identityManager = null } = {}) {
  if (field === 'activeIdentity') {
    if (!identityManager || typeof identityManager.setActiveIdentity !== 'function') {
      throw new ConfigUsageError('No identity manager is available to change the active identity', {
        code: 'ERR_PEARTUBE_NO_IDENTITY_MANAGER'
      })
    }
    await identityManager.setActiveIdentity(value)
    return { changed: 'activeIdentity' }
  }

  if (!CONTENT_FIELDS.has(field)) {
    throw new ConfigUsageError(`Unknown configuration field: ${field}`, { code: 'ERR_PEARTUBE_UNKNOWN_FIELD' })
  }
  if (!configPath) {
    throw new ConfigUsageError('A config path is required to persist settings', { code: 'ERR_PEARTUBE_NO_CONFIG_PATH' })
  }

  if (field === 'ytDlpCookiesPath' && value) {
    const readable = await validateCookieFile(value, { fs })
    if (!readable) {
      throw new ConfigUsageError(`Cookie file is not readable: ${value}`, { code: 'ERR_PEARTUBE_PATH_UNREADABLE' })
    }
  }

  const existing = await readFileOrEmpty(fs, configPath)
  const { text } = updateContentConfig(existing, { [field]: value })
  await fs.writeFile(configPath, text, { mode: 0o600 })
  if (typeof fs.chmod === 'function') await fs.chmod(configPath, 0o600)
  return { changed: field }
}

const CONTENT_FIELDS = new Set([
  'storagePath',
  'tmdbApiKey',
  'ytDlpPath',
  'ytDlpCookiesPath',
  'searchLimit',
  'claimRetentionDays'
])

async function readFileOrEmpty (fs, path) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return ''
    throw error
  }
}

function shortKey (publicKey) {
  if (typeof publicKey !== 'string') return ''
  return publicKey.length > 12 ? `${publicKey.slice(0, 8)}…${publicKey.slice(-4)}` : publicKey
}

async function defaultExec (file, args) {
  const { spawn } = await import('node:child_process')
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}
