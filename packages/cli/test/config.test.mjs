import test from 'brittle'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadRelayConfig, resolveRelayConfig, renderExampleConfig } from '../src/config.js'

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

test('direct downloads have no file-size ceiling config surface', async (t) => {
  const fromDefaults = await loadRelayConfig({}, { env: {} })
  t.is(fromDefaults.archive.maxDirectDownloadBytes, 0, 'zero means no archive file-size cap')

  const fromEnv = await loadRelayConfig({}, { env: { PEARTUBE_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES: '17179869184' } })
  t.is(fromEnv.archive.maxDirectDownloadBytes, 0, 'legacy env ceiling is ignored')

  const fromProgrammaticLegacy = await loadRelayConfig({ maxDirectDownloadBytes: '4096' }, { env: { PEARTUBE_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES: '17179869184' } })
  t.is(fromProgrammaticLegacy.archive.maxDirectDownloadBytes, 0, 'legacy programmatic ceiling is ignored')

  t.absent(
    renderExampleConfig(fromEnv).includes('maxDirectDownloadBytes'),
    'the example config does not advertise an archive file-size cap'
  )
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

test('the archive challenge cadence is an operator setting, and a nonsense one is ignored', async (t) => {
  // The backend has always accepted these two; the relay never passed them, so
  // custody could not be confirmed sooner than the backend's own five minutes,
  // and no test could observe an archivist proving possession at all.
  const configured = resolveRelayConfig({
    archive: { challengeIntervalMs: 5_000, challengeTimeoutMs: 4_000 },
  }, { env: {} })
  t.is(configured.archive.challengeIntervalMs, 5_000)
  t.is(configured.archive.challengeTimeoutMs, 4_000)

  const unset = resolveRelayConfig({}, { env: {} })
  t.is(unset.archive.challengeIntervalMs, undefined, 'an unset cadence leaves the backend default alone')
  t.is(unset.archive.challengeTimeoutMs, undefined)

  for (const value of [5, 0, -1, 25 * 60 * 60 * 1000, 'soon', 1.5]) {
    const rejected = resolveRelayConfig({ archive: { challengeIntervalMs: value } }, { env: {} })
    t.is(rejected.archive.challengeIntervalMs, undefined, `${JSON.stringify(value)} is not a cadence`)
  }
})

test('a config file can set the archive UI host and port, and flags still win', async (t) => {
  // uiCommand used to pass its own fallback in as a CLI value, which outranked
  // the file it was meant to fall back to: every relay started from a config
  // bound 0.0.0.0:8174, so a second one on the same machine died with
  // EADDRINUSE while its own file named a free port.
  const dir = makeTempDir('peartube-relay-ui-config-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const configPath = join(dir, 'relay.json')
  writeFileSync(configPath, JSON.stringify({
    storage: { path: join(dir, 'store') },
    archive: { uiHost: '127.0.0.1', uiPort: 8175 },
  }))

  // Guard the fix itself: with the old code this call also carried
  // uiHost/uiPort fallbacks, which is exactly what silenced the file.
  const fromFile = await loadRelayConfig({ config: configPath, archive: { uiEnabled: true } }, { env: {} })
  t.is(fromFile.archive.uiHost, '127.0.0.1')
  t.is(fromFile.archive.uiPort, 8175)

  const overridden = await loadRelayConfig({
    config: configPath,
    archive: { uiEnabled: true, uiHost: '0.0.0.0', uiPort: 9999 },
  }, { env: {} })
  t.is(overridden.archive.uiHost, '0.0.0.0', 'an explicit flag still overrides the file')
  t.is(overridden.archive.uiPort, 9999)
})

test('block offload is off unless the operator asks for it', async (t) => {
  const unset = resolveRelayConfig({}, { env: {} })
  t.is(unset.archive.s3.offload, false, 'block offload defaults to off')
  t.is(unset.archive.s3.offloadWindowBytes, 2 * 1024 * 1024 * 1024, 'the resident window defaults to 2 GiB')

  // A fully configured bucket is still not permission to start deleting local
  // block data: offload is the separate decision.
  const bucketOnly = resolveRelayConfig({}, {
    env: {
      PEARTUBE_ARCHIVE_S3_ENDPOINT: 'https://s3.us-west-002.backblazeb2.com',
      PEARTUBE_ARCHIVE_S3_BUCKET: 'peartube-relay',
      PEARTUBE_ARCHIVE_S3_ACCESS_KEY_ID: 'key',
      PEARTUBE_ARCHIVE_S3_SECRET_ACCESS_KEY: 'secret'
    }
  })
  t.is(bucketOnly.archive.s3.offload, false, 'a configured bucket alone does not enable offload')
})

test('resolveRelayConfig reads the block offload env vars', async (t) => {
  const config = resolveRelayConfig({}, {
    env: {
      PEARTUBE_ARCHIVE_S3_ENDPOINT: 'https://s3.us-west-002.backblazeb2.com',
      PEARTUBE_ARCHIVE_S3_BUCKET: 'peartube-relay',
      PEARTUBE_ARCHIVE_S3_REGION: 'us-west-002',
      PEARTUBE_ARCHIVE_S3_ACCESS_KEY_ID: 'key',
      PEARTUBE_ARCHIVE_S3_SECRET_ACCESS_KEY: 'secret',
      PEARTUBE_ARCHIVE_S3_PREFIX: 'relay-a',
      PEARTUBE_ARCHIVE_S3_OFFLOAD: 'true',
      PEARTUBE_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES: '1073741824'
    }
  })

  t.is(config.archive.s3.offload, true)
  t.is(config.archive.s3.offloadWindowBytes, 1073741824)
  t.is(config.archive.s3.prefix, 'relay-a')

  // A window that is not a byte count falls back to the default rather than
  // becoming NaN and offloading every block on the first append.
  for (const value of ['soon', '-1', '1.5']) {
    const fallback = resolveRelayConfig({}, {
      env: {
        PEARTUBE_ARCHIVE_S3_ENDPOINT: 'https://s3.example.com',
        PEARTUBE_ARCHIVE_S3_BUCKET: 'bucket',
        PEARTUBE_ARCHIVE_S3_ACCESS_KEY_ID: 'key',
        PEARTUBE_ARCHIVE_S3_SECRET_ACCESS_KEY: 'secret',
        PEARTUBE_ARCHIVE_S3_OFFLOAD: 'true',
        PEARTUBE_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES: value
      }
    })
    t.is(fallback.archive.s3.offloadWindowBytes, 2 * 1024 * 1024 * 1024, `${value} is not a window`)
  }
})

test('block offload with a half-configured bucket is refused, never downgraded to local-only', async (t) => {
  // Offload makes the bucket load bearing for playback. Starting local-only
  // would fill the exact volume the operator was trying to stop filling, and
  // they would not find out until it was full.
  const complete = {
    endpoint: 'https://s3.example.com',
    bucket: 'peartube-relay',
    accessKeyId: 'key',
    secretAccessKey: 'secret'
  }
  for (const field of ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']) {
    const s3 = { ...complete, offload: true }
    delete s3[field]
    t.exception(
      () => resolveRelayConfig({ archive: { s3 } }, { env: {} }),
      new RegExp(`incomplete: missing ${field}`),
      `offload without ${field} refuses at startup`
    )
  }


  const accepted = resolveRelayConfig({ archive: { s3: { ...complete, offload: true } } }, { env: {} })
  t.is(accepted.archive.s3.offload, true, 'a complete bucket is accepted')
})
