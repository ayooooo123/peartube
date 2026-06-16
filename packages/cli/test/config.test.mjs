import test from 'brittle'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadRelayConfig, renderExampleConfig, resolveRelayConfig } from '../src/config.js'

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
  t.is(config.paths.catalog, 'peartube-relay/db/relay-catalog.json')
  t.is(config.paths.status, 'peartube-relay/db/relay-status.json')
})


test('resolveRelayConfig defaults public discovery relays to seed every discovered channel', async (t) => {
  const config = resolveRelayConfig({}, { env: {} })

  t.is(config.mode, 'public')
  t.is(config.policy, 'discovery')
  t.is(config.discovery.enabled, true)
  t.is(config.discovery.seedDiscovered, true)
  t.is(config.discovery.maxChannels, 0)
  t.is(config.discovery.maxChannelsPerOwner, 0)
})

test('resolveRelayConfig defaults relays to public index and relay cache roles', async (t) => {
  const config = resolveRelayConfig({}, { env: {} })

  t.alike(config.roles, ['public-index', 'relay-cache'])
})

test('resolveRelayConfig reads node roles from env', async (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_NODE_ROLES: 'relay-cache, public-index,, relay-cache'
    }
  })

  t.alike(config.roles, ['public-index', 'relay-cache'])
})

test('resolveRelayConfig infers archiver role when archive publishing is enabled', async (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_ARCHIVE_ENABLED: 'true',
      PEARTUBE_ARCHIVE_SOURCES: 'https://youtube.com/@example'
    }
  })

  t.alike(config.roles, ['public-index', 'relay-cache', 'archiver'])
})

test('resolveRelayConfig rejects unsupported node roles', async (t) => {
  t.exception(() => resolveRelayConfig({ roles: ['public-index', 'blind-relay'] }, { env: {} }))
})

test('renderExampleConfig shows node roles before legacy mode and policy', async (t) => {
  const rendered = renderExampleConfig(resolveRelayConfig({}, { env: {} }))

  t.ok(rendered.startsWith('roles: public-index,relay-cache\nmode: public\npolicy: discovery'))
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

test('resolveRelayConfig reads moderation rules from env vars', async (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_MODERATION_MODE: 'enforce',
      PEARTUBE_MODERATION_BLOCK_CHANNELS: 'chan-block',
      PEARTUBE_MODERATION_QUARANTINE_CHANNELS: 'chan-quarantine',
      PEARTUBE_MODERATION_ALLOW_CHANNELS: 'chan-allow',
      PEARTUBE_MODERATION_WATCH_OWNERS: 'owner-watch'
    }
  })

  t.is(config.moderation.mode, 'enforce')
  t.alike(config.moderation.rules, [
    { targetType: 'channelKey', target: 'chan-block', action: 'block', source: 'local' },
    { targetType: 'channelKey', target: 'chan-quarantine', action: 'quarantine', source: 'local' },
    { targetType: 'channelKey', target: 'chan-allow', action: 'allow', source: 'local' },
    { targetType: 'ownerKey', target: 'owner-watch', action: 'watch', source: 'local' }
  ])
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
    t.is(config.paths.catalog, 'relay-data/db/relay-catalog.json')
    t.is(config.paths.status, 'relay-data/db/relay-status.json')
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
  t.is(config.paths.catalog, 'peartube-relay/db/relay-catalog.json')
  t.is(config.paths.status, 'peartube-relay/db/relay-status.json')
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
      PEARTUBE_DISCOVERY_SEED_DISCOVERED: 'false',
      PEARTUBE_DISCOVERY_MAX_CHANNELS: '12',
      PEARTUBE_DISCOVERY_MAX_CHANNELS_PER_OWNER: '3',
      PEARTUBE_NETWORK_ANNOUNCE: 'false',
      PEARTUBE_NETWORK_BOOTSTRAP: 'local',
      PEARTUBE_RELAY_BLIND_PEER_ENABLED: 'false',
      PEARTUBE_RELAY_BLIND_PEER_TRUSTED_CLIENTS: 'aa,bb',
      PEARTUBE_RETENTION_PROTECT_PRIVATE: 'false',
      PEARTUBE_RETENTION_PROTECT_ALLOWLIST: 'false',
      PEARTUBE_LOG_LEVEL: 'debug'
    }
  })

  t.is(config.mode, 'private')
  t.is(config.policy, 'allowlist')
  t.is(config.storage.path, '/var/lib/peartube-relay')
  t.is(config.paths.corestore, '/var/lib/peartube-relay/corestore')
  t.is(config.paths.catalog, '/var/lib/peartube-relay/db/relay-catalog.json')
  t.is(config.paths.status, '/var/lib/peartube-relay/db/relay-status.json')
  t.is(config.storage.maxBytes, 2048)
  t.alike(config.admission.channels, ['chan-a', 'chan-b'])
  t.alike(config.admission.owners, ['owner-a'])
  t.is(config.discovery.enabled, false)
  t.is(config.discovery.seedDiscovered, false)
  t.is(config.discovery.maxChannels, 12)
  t.is(config.discovery.maxChannelsPerOwner, 3)
  t.is(config.network.announce, false)
  t.is(config.network.bootstrap, 'local')
  t.is(config.network.blindPeer, false)
  t.alike(config.network.trustedBlindPeerClients, ['aa', 'bb'])
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

test('resolveRelayConfig reads archive yt-dlp extra args env var', async (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_ARCHIVE_UI_ENABLED: 'true',
      PEARTUBE_ARCHIVE_YT_DLP_EXTRA_ARGS: '--plugin-dirs /usr/local/share/yt-dlp-plugins --extractor-args youtube:player_client=mweb;youtubepot-bgutilcli:cli_path=/usr/local/bin/bgutil-pot --force-ipv4'
    }
  })

  t.alike(config.archive.ytDlpExtraArgs, ['--plugin-dirs', '/usr/local/share/yt-dlp-plugins', '--extractor-args', 'youtube:player_client=mweb;youtubepot-bgutilcli:cli_path=/usr/local/bin/bgutil-pot', '--force-ipv4'])
})

test('resolveRelayConfig reads archive yt-dlp retry extra args env var', async (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_ARCHIVE_UI_ENABLED: 'true',
      PEARTUBE_ARCHIVE_YT_DLP_RETRY_EXTRA_ARGS: '--extractor-args youtube:player_client=web_safari || --extractor-args youtube:player_client=mweb;player_skip=webpage,configs'
    }
  })

  t.alike(config.archive.ytDlpRetryExtraArgs, [
    ['--extractor-args', 'youtube:player_client=web_safari'],
    ['--extractor-args', 'youtube:player_client=mweb;player_skip=webpage,configs']
  ])
})


test('resolveRelayConfig reads local mirror env vars', async (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_ARCHIVE_LOCAL_MIRROR_ENABLED: 'true',
      PEARTUBE_ARCHIVE_LOCAL_MIRROR_PATH: '/videos',
      PEARTUBE_ARCHIVE_LOCAL_MIRROR_POLL: '7',
      PEARTUBE_ARCHIVE_LOCAL_MIRROR_CHANNEL_NAME: 'Camera Roll',
      PEARTUBE_ARCHIVE_LOCAL_MIRROR_RECURSIVE: 'false',
      PEARTUBE_ARCHIVE_LOCAL_MIRROR_MAX_FILES: '12'
    }
  })

  t.alike(config.archive.localMirror, {
    enabled: true,
    path: '/videos',
    poll: 7,
    channelName: 'Camera Roll',
    description: '',
    recursive: false,
    maxFiles: 12
  })
})
