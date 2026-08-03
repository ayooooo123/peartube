/**
 * The player's half of the delete barrier.
 *
 * Deleting a title from the Library does not unmount the player that is on it.
 * The player goes on ticking, and its next progress write used to land on the
 * coordinates the viewer had just removed and put the record straight back.
 *
 * This drives the real provider against the real watch-state adapter — only
 * the personal store behind them is a stand-in — so the assertion is about
 * what the store was asked to write, not about how either file is spelled.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const appRoot = path.resolve(import.meta.dirname, '..')

const PLATFORM_RPC_STUB = [
  'const store = () => globalThis.__peartubePlayerStore',
  'export const isInitialized = () => true',
  'export const rpc = new Proxy({}, { get: (_target, method) => (args) => store().call(String(method), args) })',
].join('\n')

/**
 * The personal store the adapter writes through. Native-only device modules
 * are stubbed away; the platform facade is answered here so every write the
 * session makes is observable.
 */
const stubPlugin = {
  name: 'peartube-player-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^@peartube\/platform\/rpc$/ }, () => ({ path: 'platform-rpc', namespace: 'player-stub' }))
    builder.onResolve({ filter: /^expo-file-system(\/legacy)?$/ }, () => ({ path: 'file-system', namespace: 'player-stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'player-stub' }, (args) => ({
      contents: args.path === 'platform-rpc' ? PLATFORM_RPC_STUB : 'export default {}',
      loader: 'js',
    }))
  },
}

async function loadPlayer() {
  const result = await build({
    stdin: {
      contents: [
        "export * as player from './lib/VideoPlayerContext'",
        "export * as watchHistory from './lib/watch-history'",
        '',
      ].join('\n'),
      resolveDir: appRoot,
      sourcefile: 'player-watch-session-entry.ts',
      loader: 'ts',
    },
    absWorkingDir: appRoot,
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom'],
    alias: { 'react-native': 'react-native-web' },
    define: { __DEV__: 'false' },
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    plugins: [stubPlugin],
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.player-session-'))
  const output = path.join(directory, 'player.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(pathToFileURL(output).href)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function installStore() {
  const calls = []
  const store = {
    calls,
    async call(method, args) {
      calls.push({ method, args })
      if (method === 'getWatchHistory' || method === 'listResumePositions') return { entries: [] }
      return { success: true }
    },
    logged() {
      return calls.filter((call) => call.method === 'logWatchHistory').map((call) => call.args)
    },
  }
  globalThis.__peartubePlayerStore = store
  return store
}

/** Mount the provider and keep the actions it hands its subtree. */
function mountPlayer(player) {
  let actions = null
  function Probe() {
    actions = player.useVideoPlayerActions()
    return null
  }
  renderToStaticMarkup(React.createElement(player.VideoPlayerProvider, null, React.createElement(Probe)))
  assert.equal(typeof actions?.loadAndPlayVideo, 'function', 'the provider must hand its subtree real actions')
  return actions
}

/** Progress writes are fire-and-forget, so let the queued write settle. */
async function settle() {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

const NEBULA = {
  id: 'nebula-drift',
  channelKey: 'ab'.repeat(32),
  title: 'Nebula Drift',
  entityRef: 'work:nebula-drift',
}
const URL = 'http://127.0.0.1:49152/blob/nebula-drift'
const DURATION_MS = 3_600_000

test('a title deleted mid-playback is not written back by the player still on it', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 })
  const store = installStore()
  const { player, watchHistory } = await loadPlayer()
  const actions = mountPlayer(player)

  actions.loadAndPlayVideo(NEBULA, URL)
  actions.onProgress({ currentTime: 1_200_000, duration: DURATION_MS })
  await settle()

  const played = store.logged()
  assert.deepEqual(played.map((request) => request.position), [1_200], 'the session recorded where the viewer got to')

  // The viewer removes it from the Library. The player is still mounted.
  await watchHistory.removeEntry(NEBULA.channelKey, NEBULA.id)
  const grave = store.logged().at(-1)
  assert.equal(grave.tombstone, true)

  // The next progress tick from that still-running player.
  t.mock.timers.tick(11_000)
  actions.onProgress({ currentTime: 1_800_000, duration: DURATION_MS })
  await settle()

  assert.equal(store.logged().at(-1), grave, 'the running player wrote nothing after the delete')
  assert.deepEqual(await watchHistory.getHistory(), [], 'the title the viewer removed stayed removed')

  // The viewer deliberately plays it again. Progress is recorded once more, and
  // as a new watch: it outranks the delete rather than racing it.
  t.mock.timers.tick(11_000)
  actions.loadAndPlayVideo(NEBULA, URL)
  actions.onProgress({ currentTime: 60_000, duration: DURATION_MS })
  await settle()

  const rewatch = store.logged().at(-1)
  assert.equal(rewatch.position, 60, 'the deliberate rewatch is recorded')
  assert.equal(rewatch.tombstone, undefined)
  assert.ok(
    rewatch.playbackGeneration > grave.playbackGeneration,
    'the new watch starts strictly above the delete, so no device resurrects the old record',
  )
  assert.deepEqual((await watchHistory.getHistory()).map((entry) => entry.positionSec), [60])
})

test('the player keys watch state on media identity, not on the publisher upload', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 })
  const store = installStore()
  const { player, watchHistory } = await loadPlayer()
  const actions = mountPlayer(player)

  actions.loadAndPlayVideo({ ...NEBULA, editionRef: 'edition:4k', memberRef: 'episode:1' }, URL)
  actions.onProgress({ currentTime: 600_000, duration: DURATION_MS })
  await settle()

  assert.deepEqual(store.logged().at(-1).identity, {
    entityRef: 'work:nebula-drift',
    editionRef: 'edition:4k',
    memberRef: 'episode:1',
  })

  // A delete addresses the same record through the legacy channel/video pair
  // the Library renders, and the barrier it raises has to cover the identity
  // key the player writes under, or the next tick undoes it.
  await watchHistory.removeEntry(NEBULA.channelKey, NEBULA.id)
  t.mock.timers.tick(11_000)
  const writesBefore = store.logged().length
  actions.onProgress({ currentTime: 900_000, duration: DURATION_MS })
  await settle()

  assert.equal(store.logged().length, writesBefore, 'the delete reached the coordinates the player writes to')
})
