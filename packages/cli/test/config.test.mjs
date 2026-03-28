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
    t.is(config.storage.maxBytes, 4096)
    t.alike(config.admission.channels, ['chan-1', 'chan-2'])
    t.alike(config.admission.owners, ['owner-1'])
    t.is(config.logging.level, 'debug')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
