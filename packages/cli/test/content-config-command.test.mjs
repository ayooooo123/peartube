import test from 'brittle'
import {
  applyConfigUpdate,
  buildConfigReport,
  probeYtDlp,
  renderConfigReport,
  validateCookieFile
} from '../src/add/config-command.js'
import { resolveAddPreferences } from '../src/add/preferences.js'

function fakeFs (existing = {}) {
  const files = { ...existing }
  const accessed = []
  const reads = []
  const writes = []
  return {
    files,
    accessed,
    reads,
    writes,
    async access (path) {
      accessed.push(path)
      if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    async readFile (path, encoding) {
      reads.push(path)
      if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files[path]
    },
    async writeFile (path, content, options) {
      writes.push({ path, content, options })
      files[path] = content
    },
    async chmod (path, mode) {
      writes.push({ path, mode })
    }
  }
}

function fakeIdentityManager () {
  let active = 'id-1'
  return {
    listCalls: 0,
    setCalls: [],
    async listIdentities () {
      this.listCalls += 1
      return [
        { id: 'id-1', name: 'Primary', publicKey: 'a'.repeat(64) },
        { id: 'id-2', name: 'Alt', publicKey: 'b'.repeat(64) }
      ]
    },
    getActiveIdentityId () {
      return active
    },
    async setActiveIdentity (id) {
      this.setCalls.push(id)
      active = id
    }
  }
}

test('buildConfigReport summarizes redacted status from injected probes', async (t) => {
  const prefs = resolveAddPreferences({
    flags: {},
    env: { TMDB_API_KEY: 'super-secret-token' },
    config: { content: { storagePath: '/data/content', ytDlpPath: '/bin/yt-dlp', ytDlpCookiesPath: '/data/cookies.txt' } }
  })
  const fs = fakeFs({ '/data/cookies.txt': 'NETSCAPE COOKIE FILE' })
  const identityManager = fakeIdentityManager()
  const report = await buildConfigReport({
    preferences: prefs,
    fs,
    identityManager,
    probe: async (path) => ({ path, version: '2026.07.01' })
  })

  t.is(report.storagePath, '/data/content')
  t.is(report.tmdb.status, 'configured')
  t.absent(JSON.stringify(report).includes('super-secret-token'), 'token never appears in report')
  t.is(report.ytDlp.path, '/bin/yt-dlp')
  t.is(report.ytDlp.version, '2026.07.01')
  t.is(report.cookies.status, 'configured')
  t.is(report.cookies.valid, true)
  t.absent(fs.reads.includes('/data/cookies.txt'), 'cookie contents are validated but never read')
  t.is(report.activeIdentity.id, 'id-1')
  t.is(report.identities.length, 2)

  const rendered = renderConfigReport(report)
  const text = rendered.join('\n')
  t.ok(text.includes('/data/content'))
  t.ok(text.includes('configured'))
  t.absent(text.includes('super-secret-token'))
})

test('validateCookieFile checks readability without reading contents', async (t) => {
  const fs = fakeFs({ '/data/cookies.txt': 'secret cookie jar' })
  const ok = await validateCookieFile('/data/cookies.txt', { fs })
  t.is(ok, true)
  t.alike(fs.accessed, ['/data/cookies.txt'])
  t.absent(fs.reads.includes('/data/cookies.txt'))

  const missing = await validateCookieFile('/data/missing.txt', { fs })
  t.is(missing, false)
})

test('probeYtDlp returns the reported version and classifies a missing executable', async (t) => {
  const version = await probeYtDlp('/bin/yt-dlp', {
    exec: async (file, args) => {
      t.is(file, '/bin/yt-dlp')
      t.alike(args, ['--version'])
      return { stdout: '2026.07.01\n', stderr: '', code: 0 }
    }
  })
  t.is(version, '2026.07.01')

  let error = null
  try {
    await probeYtDlp('missing-tool', {
      exec: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }
    })
  } catch (cause) {
    error = cause
  }
  t.ok(error)
  t.is(error.code, 'ERR_PEARTUBE_YTDLP_MISSING')
})

test('applyConfigUpdate persists storage with mode 0600 only when a secret is present', async (t) => {
  const fs = fakeFs({ '/etc/peartube.yml': 'mode: public\ncontent:\n  storagePath: /old\n' })
  await applyConfigUpdate({
    field: 'storagePath',
    value: '/new/content',
    configPath: '/etc/peartube.yml',
    fs
  })
  const storageWrite = fs.writes.find((entry) => entry.content)
  t.ok(storageWrite.content.includes('storagePath: /new/content'))
  t.ok(storageWrite.content.includes('mode: public'), 'unrelated keys survive')
  t.is(storageWrite.options && storageWrite.options.mode, 0o600, 'secret-safe default permission')

  const secretWrite = fakeFs({ '/etc/peartube.yml': 'content:\n  storagePath: /old\n' })
  await applyConfigUpdate({
    field: 'tmdbApiKey',
    value: 'new-token',
    configPath: '/etc/peartube.yml',
    fs: secretWrite
  })
  const write = secretWrite.writes.find((entry) => entry.content)
  t.ok(write.content.includes('tmdbApiKey: new-token'))
  t.is(write.options.mode, 0o600)
  t.absent(write.content.includes('super-secret'), 'only the provided token is written')
})

test('applyConfigUpdate changes active identity only through the identity manager', async (t) => {
  const identityManager = fakeIdentityManager()
  const fs = fakeFs({ '/etc/peartube.yml': 'content:\n  storagePath: /old\n' })
  await applyConfigUpdate({
    field: 'activeIdentity',
    value: 'id-2',
    configPath: '/etc/peartube.yml',
    fs,
    identityManager
  })
  t.alike(identityManager.setCalls, ['id-2'])
  t.absent(fs.writes.some((entry) => entry.content && entry.content.includes('activeIdentity')), 'identity is never written to config')
})
