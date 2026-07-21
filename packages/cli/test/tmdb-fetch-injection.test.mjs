import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRelayConfig } from '../src/config.js'
import { createRelayService } from '../src/service.js'

function fakeRuntime () {
  const metaDbMap = new Map()
  return {
    async start () {},
    setCandidateHandler () {},
    requestFeedSync () { return 0 },
    getNetworkStats () { return { peers: 0, connections: 0, dht: {} } },
    getStatus () { return {} },
    ctx: {
      metaDb: {
        async get (key) { return metaDbMap.has(key) ? { value: metaDbMap.get(key) } : null },
        async put (key, value) { metaDbMap.set(key, value) }
      }
    },
    async close () {}
  }
}

const silentLogger = {
  relay: { info () {}, warn () {}, error () {} },
  archive: { info () {}, warn () {}, error () {} }
}

// Regression guard for the deployed Bare relay, which has NO global `fetch`.
// The TMDB classifier/discover client default `fetchFn` to the global `fetch`,
// so before the fix the relay silently disabled classification (every archived
// video stayed `unknown` and Discover was always empty) even with a valid key.
// The service must inject a runtime-appropriate fetch instead. Node has a
// global fetch, so we delete it here to reproduce the Bare condition — the
// classifier must still come up enabled, proving injection rather than reliance
// on the absent global.
test('relay service injects fetch so TMDB stays enabled without a global fetch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-tmdb-fetch-'))
  const savedFetch = globalThis.fetch
  try {
    delete globalThis.fetch
    t.is(typeof globalThis.fetch, 'undefined', 'global fetch removed to mimic the Bare relay runtime')

    const config = resolveRelayConfig({
      mode: 'public',
      policy: 'discovery',
      storage: { path: dir, maxBytes: 10_000 },
      classification: { tmdb: { apiKey: 'test-key', enabled: true } }
    })

    const service = await createRelayService({
      config,
      logger: silentLogger,
      runtimeFactory: async () => fakeRuntime(),
      mirrorChannel: async () => ({}),
      writeStatusFile: async () => {}
    })

    t.ok(service.getClassifier().enabled, 'classifier enabled via injected fetch despite missing global fetch')

    const refreshed = await service.setTmdbSettings({ apiKey: 'rotated-key', enabled: true })
    t.is(refreshed.apiKey, 'rotated-key', 'setTmdbSettings persists the rotated key')
    t.ok(service.getClassifier().enabled, 'classifier stays enabled after a settings refresh')

    await service.close()
  } finally {
    if (savedFetch) globalThis.fetch = savedFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
