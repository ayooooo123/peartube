/**
 * Watch progress is best-effort, and a device with nowhere to put it must stop
 * asking.
 *
 * On a fresh install whose vault refuses the personal-store secret there is no
 * writable personal store at all. The player wrote progress every ten seconds
 * anyway; each write threw inside the backend, and every backend throw is
 * reported on the host error channel, so a video that played perfectly well
 * still put "Backend error: No writable personal store" in front of the viewer
 * several times a minute.
 *
 * This drives the real provider against the real watch-state adapter and the
 * real provisioning module — only the personal store behind them is a stand-in
 * — so the assertion is about what the store was asked for, not about how any
 * of the three is spelled.
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
  'const store = () => globalThis.__peartubeWatchProgressStore',
  'export const isInitialized = () => true',
  'export const rpc = new Proxy({}, { get: (_target, method) => (args) => store().call(String(method), args) })',
].join('\n')

const stubPlugin = {
  name: 'peartube-watch-progress-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^@peartube\/platform\/rpc$/ }, () => ({ path: 'platform-rpc', namespace: 'stub' }))
    builder.onResolve({ filter: /^expo-file-system(\/legacy)?$/ }, () => ({ path: 'file-system', namespace: 'stub' }))
    builder.onResolve({ filter: /^expo-secure-store$/ }, () => ({ path: 'secure-store', namespace: 'stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'platform-rpc' ? PLATFORM_RPC_STUB : 'export default {}',
      loader: 'js',
    }))
  },
}

/**
 * A fresh instance of the whole chain. Provisioning and the watch-state cache
 * are module state, so each case gets its own copy of the bundle.
 */
async function loadPlayer(label) {
  const result = await build({
    stdin: {
      contents: [
        "export * as player from './lib/VideoPlayerContext'",
        "export * as personalEncryption from './lib/personal-encryption'",
        '',
      ].join('\n'),
      resolveDir: appRoot,
      sourcefile: 'watch-progress-entry.ts',
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
  const directory = fs.mkdtempSync(path.join(appRoot, `.watch-progress-${label}-`))
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
  globalThis.__peartubeWatchProgressStore = store
  return store
}

/** The desktop vault bridge, backed by memory: a device that does hold secrets. */
function installVault() {
  const slots = new Map()
  globalThis.window = {
    bridge: {
      personalSecureGet: async (key) => slots.get(key) ?? null,
      personalSecureSet: async (key, value) => { slots.set(key, value) },
      personalSecureDelete: async (key) => { slots.delete(key) },
    },
  }
}

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

test('a device whose vault holds no personal-store secret is never asked to store watch progress', async (t) => {
  t.after(() => { delete globalThis.window })
  delete globalThis.window

  const store = installStore()
  const { player, personalEncryption } = await loadPlayer('no-vault')

  // Startup provisioning: no vault, so the backend was left with no store.
  await personalEncryption.ensurePersonalEncryption({
    provisionPersonalEncryption: async () => ({ success: true, encrypted: true }),
  })
  assert.equal(personalEncryption.hasPersonalStore(), false, 'provisioning failed, so there is no store')

  const actions = mountPlayer(player)
  actions.loadAndPlayVideo(NEBULA, URL)
  actions.onProgress({ currentTime: 1_200_000, duration: DURATION_MS })
  await settle()

  assert.deepEqual(store.logged(), [], 'playback asked the store for nothing it cannot hold')
})

test('a device that did provision a personal store still writes watch progress', async (t) => {
  t.after(() => { delete globalThis.window })
  installVault()

  const store = installStore()
  const { player, personalEncryption } = await loadPlayer('vault')

  await personalEncryption.ensurePersonalEncryption({
    provisionPersonalEncryption: async () => ({ success: true, encrypted: true, bootstrapKey: 'ef'.repeat(32) }),
  })
  assert.equal(personalEncryption.hasPersonalStore(), true, 'the store opened')

  const actions = mountPlayer(player)
  actions.loadAndPlayVideo(NEBULA, URL)
  actions.onProgress({ currentTime: 1_200_000, duration: DURATION_MS })
  await settle()

  assert.deepEqual(
    store.logged().map((request) => request.position),
    [1_200],
    'the progress tick reached the store exactly once',
  )
})

test('provisioning that only failed for one identity does not write the device off', async (t) => {
  t.after(() => { delete globalThis.window })
  installVault()

  installStore()
  const { personalEncryption } = await loadPlayer('one-owner-failed')

  await personalEncryption.ensurePersonalEncryption({
    provisionPersonalEncryption: async () => ({ success: false, error: 'store-already-unencrypted' }),
  }, 'ab'.repeat(32))
  assert.equal(personalEncryption.hasPersonalStore(), false, 'nothing has opened yet')

  await personalEncryption.ensurePersonalEncryption({
    provisionPersonalEncryption: async () => ({ success: true, encrypted: true }),
  })
  assert.equal(personalEncryption.hasPersonalStore(), true, 'a device-local store that did open outranks the refusal')
})
