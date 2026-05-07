import test from 'brittle'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadRelayConfig, resolveRelayConfig } from '../src/config.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('resolveRelayConfig defaults to public discovery mode', async (t) => {
  const config = resolveRelayConfig({}, { env: {} })

  t.is(config.mode, 'public')
  t.is(config.policy, 'discovery')
  t.is(config.discovery.enabled, true)
  t.is(config.storage.path, './peartube-relay')
  t.is(config.paths.corestore, 'peartube-relay/corestore')
})

test('resolveRelayConfig forces private mode to allowlist policy', async (t) => {
  const config = resolveRelayConfig({ mode: 'private' }, { env: {} })

  t.is(config.mode, 'private')
  t.is(config.policy, 'allowlist')
})

test('resolveRelayConfig rejects private discovery mode', async (t) => {
  t.exception(() => resolveRelayConfig({ mode: 'private', policy: 'discovery' }, { env: {} }))
})

test('resolveRelayConfig reads comma-separated admission env vars', async (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_ADMISSION_CHANNELS: 'chan-a, chan-b ,,chan-c',
      PEARTUBE_ADMISSION_OWNERS: 'owner-a,owner-b'
    }
  })

  t.alike(config.admission.channels, ['chan-a', 'chan-b', 'chan-c'])
  t.alike(config.admission.owners, ['owner-a', 'owner-b'])
})

test('loadRelayConfig parses yaml-like config files', async (t) => {
  const dir = makeTempDir('peartube-relay-config-')
  const configPath = join(dir, 'relay.yml')

  try {
    writeFileSync(configPath, [
      'mode: public',
      'policy: allowlist',
      'storage:',
      '  path: ./relay-data',
      '  maxBytes: 4096',
      'admission:',
      '  channels:',
      '    - chan-1',
      '    - chan-2',
      '  owners:',
      '    - owner-1',
      'logging:',
      '  level: debug',
      ''
    ].join('\n'))

    const config = await loadRelayConfig({ config: configPath }, { env: {} })

    t.is(config.mode, 'public')
    t.is(config.policy, 'allowlist')
    t.is(config.storage.path, './relay-data')
    t.is(config.paths.corestore, 'relay-data/corestore')
    t.is(config.storage.maxBytes, 4096)
    t.alike(config.admission.channels, ['chan-1', 'chan-2'])
    t.alike(config.admission.owners, ['owner-1'])
    t.is(config.logging.level, 'debug')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadRelayConfig uses built-in defaults without a config file', async (t) => {
  const config = await loadRelayConfig({}, { env: {} })

  t.is(config.mode, 'public')
  t.is(config.policy, 'discovery')
  t.is(config.storage.path, './peartube-relay')
  t.is(config.paths.corestore, 'peartube-relay/corestore')
  t.is(config.paths.config, undefined)
})

test('loadRelayConfig supports env-only relay configuration', async (t) => {
  const config = await loadRelayConfig({}, {
    env: {
      PEARTUBE_MODE: 'private',
      PEARTUBE_STORAGE_PATH: '/var/lib/peartube-relay',
      PEARTUBE_STORAGE_MAX_BYTES: '2048',
      PEARTUBE_ADMISSION_CHANNELS: 'chan-a,chan-b',
      PEARTUBE_ADMISSION_OWNERS: 'owner-a',
      PEARTUBE_DISCOVERY_ENABLED: 'false',
      PEARTUBE_DISCOVERY_MAX_CHANNELS: '12',
      PEARTUBE_DISCOVERY_MAX_CHANNELS_PER_OWNER: '3',
      PEARTUBE_NETWORK_ANNOUNCE: 'false',
      PEARTUBE_NETWORK_BOOTSTRAP: 'local',
      PEARTUBE_RETENTION_PROTECT_PRIVATE: 'false',
      PEARTUBE_RETENTION_PROTECT_ALLOWLIST: 'false',
      PEARTUBE_LOG_LEVEL: 'debug'
    }
  })

  t.is(config.mode, 'private')
  t.is(config.policy, 'allowlist')
  t.is(config.storage.path, '/var/lib/peartube-relay')
  t.is(config.paths.corestore, '/var/lib/peartube-relay/corestore')
  t.is(config.storage.maxBytes, 2048)
  t.alike(config.admission.channels, ['chan-a', 'chan-b'])
  t.alike(config.admission.owners, ['owner-a'])
  t.is(config.discovery.enabled, false)
  t.is(config.discovery.maxChannels, 12)
  t.is(config.discovery.maxChannelsPerOwner, 3)
  t.is(config.network.announce, false)
  t.is(config.network.bootstrap, 'local')
  t.is(config.retention.protectPrivate, false)
  t.is(config.retention.protectAllowlist, false)
  t.is(config.logging.level, 'debug')
})

test('resolveRelayConfig reads archive cookies and JS runtime env vars', async (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_ARCHIVE_UI_ENABLED: 'true',
      PEARTUBE_ARCHIVE_COOKIES_PATH: '/var/lib/peartube-relay/youtube-cookies.txt',
      PEARTUBE_ARCHIVE_JS_RUNTIME: 'deno:/usr/local/bin/deno'
    }
  })

  t.is(config.archive.cookiesPath, '/var/lib/peartube-relay/youtube-cookies.txt')
  t.is(config.archive.jsRuntime, 'deno:/usr/local/bin/deno')
})

test('resolveRelayConfig reads archive ffmpeg path env var', async (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_ARCHIVE_UI_ENABLED: 'true',
      PEARTUBE_ARCHIVE_FFMPEG_PATH: '/usr/local/bin/ffmpeg'
    }
  })

  t.is(config.archive.ffmpegPath, '/usr/local/bin/ffmpeg')
})
