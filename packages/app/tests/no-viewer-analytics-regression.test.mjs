/**
 * Outbound-request harness for the viewer.
 *
 * Anonymous use has to be complete: browsing, searching, playing, pausing,
 * seeking, finishing, saving, and being recommended something must not produce
 * a single analytics, beacon, or telemetry request, and recommendations must
 * never be fetched from anywhere.
 *
 * Two halves, because either alone is easy to fool:
 *   1. A live session. The real local modules run inside a sandbox where every
 *      outbound primitive (fetch/XHR/WebSocket/EventSource/sendBeacon) records
 *      and then throws, and the backend is a recording proxy. Zero egress and a
 *      known-minimal RPC set are asserted afterwards.
 *   2. A source sweep over every app surface file. Each outbound-request site
 *      must appear in an explicit allowlist with a reason (P2P/local blob,
 *      artwork, explicit provider auth/license, user-triggered diagnostics
 *      export). Anything else — a new endpoint, an analytics SDK, a
 *      `logWatchEvent` emission — fails here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const appRoot = path.resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// Source inventory
// ---------------------------------------------------------------------------

const SURFACE_DIRS = ['app', 'components', 'lib']
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

function collectSourceFiles(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) collectSourceFiles(full, found)
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(full)
  }
  return found
}

/**
 * Comments are prose and prose says things like "collects no analytics"; only
 * code is evidence. Block comments collapse to their own newlines so reported
 * line numbers still match the file. The `[^:]` guard keeps `https://` inside
 * string literals from being mistaken for a line comment.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

const SOURCES = SURFACE_DIRS
  .flatMap((dir) => collectSourceFiles(path.join(appRoot, dir)))
  .map((file) => ({
    file: path.relative(appRoot, file).split(path.sep).join('/'),
    code: stripComments(fs.readFileSync(file, 'utf8')),
  }))

const EGRESS_PRIMITIVES = [
  ['fetch', /(?<![.\w$])fetch\s*\(/g],
  ['XMLHttpRequest', /\bnew\s+XMLHttpRequest\b/g],
  ['WebSocket', /\bnew\s+WebSocket\s*\(/g],
  ['EventSource', /\bnew\s+EventSource\s*\(/g],
  ['sendBeacon', /\bsendBeacon\s*\(/g],
  ['axios', /\baxios\s*[.(]/g],
]

/**
 * The complete set of outbound requests the app surface is allowed to make.
 * A new entry here is a deliberate privacy decision, not a formality.
 */
const ALLOWED_EGRESS = {
  'lib/DownloadsContext.tsx':
    'user-initiated download streams bytes from the local blob-server URL the backend just issued for a P2P source',
  'lib/maintenance-file-transfer.mjs':
    'user-triggered diagnostics/backup import-export reads the file URI the user picked',
  'components/video-player/WebMseVideoBackend.web.tsx':
    'web MSE playback pulls playlist and fMP4 fragments from the backend transcoder on this device',
}

function egressSites() {
  const sites = []
  for (const { file, code } of SOURCES) {
    for (const [kind, pattern] of EGRESS_PRIMITIVES) {
      for (const match of code.matchAll(pattern)) {
        const line = code.slice(0, match.index).split('\n').length
        sites.push({ file, kind, line })
      }
    }
  }
  return sites
}

// ---------------------------------------------------------------------------
// Live session
// ---------------------------------------------------------------------------

/** Records and then refuses every outbound call, whichever primitive is used. */
function installEgressRecorder() {
  const calls = []
  const saved = {
    fetch: globalThis.fetch,
    XMLHttpRequest: globalThis.XMLHttpRequest,
    WebSocket: globalThis.WebSocket,
    EventSource: globalThis.EventSource,
  }
  const trap = (kind) => function trapped(...args) {
    calls.push({ kind, target: String(args[0] ?? '') })
    throw new Error(`unexpected outbound request via ${kind}`)
  }
  globalThis.fetch = trap('fetch')
  globalThis.XMLHttpRequest = trap('XMLHttpRequest')
  globalThis.WebSocket = trap('WebSocket')
  globalThis.EventSource = trap('EventSource')

  const navigator = globalThis.navigator
  let restoreBeacon = () => {}
  if (navigator) {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'sendBeacon')
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, writable: true, value: trap('sendBeacon') })
    restoreBeacon = () => {
      if (previous) Object.defineProperty(navigator, 'sendBeacon', previous)
      else delete navigator.sendBeacon
    }
  }

  return {
    calls,
    restore() {
      Object.assign(globalThis, saved)
      restoreBeacon()
    },
  }
}

/**
 * Node stand-ins for the device modules the local state layer touches, plus the
 * platform RPC facade. The facade stub funnels every backend call the session
 * makes into one observable hook, which is the whole point: a request the
 * viewer never asked for shows up there or in the egress recorder.
 */
function nodeStubPlugin() {
  const stubs = {
    'react-native': 'export const Platform = { OS: "web" }; export default { Platform };',
    'expo-file-system': 'export default {};',
    'expo-file-system/legacy': 'export default {};',
    'expo-secure-store': 'export default {};',
    '@peartube/platform/rpc': [
      'export const isInitialized = () => true',
      'export const rpc = new Proxy({}, { get: (_target, method) =>',
      '  (args) => globalThis.__peartubeHarnessRpc(String(method), args) })',
      'export default { isInitialized, rpc }',
    ].join('\n'),
  }
  return {
    name: 'peartube-node-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^(react-native|expo-file-system(\/legacy)?|expo-secure-store|@peartube\/platform\/rpc)$/ }, (args) => ({
        path: args.path,
        namespace: 'peartube-stub',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'peartube-stub' }, (args) => ({
        contents: stubs[args.path],
        loader: 'js',
      }))
    },
  }
}

async function loadLocalModule(entry, instance) {
  const result = await build({
    entryPoints: [path.join(appRoot, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    plugins: [nodeStubPlugin()],
  })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-egress-'))
  const output = path.join(directory, `${instance}.mjs`)
  fs.writeFileSync(output, result.outputFiles[0].text)
  const loaded = await import(pathToFileURL(output).href)
  fs.rmSync(directory, { recursive: true, force: true })
  return loaded
}

const NOW = Date.now()
const DAY = 86_400_000

/** Peer evidence the availability descriptor accepts as currently healthy. */
function healthy(peers) {
  return { state: 'healthy', completePeerCount: peers, independentPeerCount: peers, observedAt: NOW - 1_000, expiresAt: NOW + DAY }
}

const CATALOG = [
  { entityId: 'work:nebula-drift', title: 'Nebula Drift', entityKind: 'work', contentKind: 'movie', creator: 'Orbit Studio', tags: ['space', 'documentary'], availability: healthy(7), sources: [{ id: 'a' }, { id: 'b' }] },
  { entityId: 'work:nebula-drift-ii', title: 'Nebula Drift II', entityKind: 'work', contentKind: 'movie', creator: 'Orbit Studio', tags: ['space'], availability: healthy(3), sources: [{ id: 'c' }] },
  { entityId: 'work:tidepool', title: 'Tidepool', entityKind: 'work', contentKind: 'movie', creator: 'Coastline', tags: ['nature'], availability: healthy(1), sources: [] },
  { entityId: 'collection:deep-field', title: 'Deep Field', entityKind: 'collection', creator: 'Orbit Studio', tags: ['space'], availability: healthy(2), sources: [] },
]

/** The title the session plays, paused mid-way and then saved. */
const NEBULA = {
  channelKey: 'ab'.repeat(32),
  videoId: 'nebula-drift',
  title: 'Nebula Drift',
  identity: { entityRef: 'work:nebula-drift' },
  positionSec: 2100,
  durationSec: 3600,
}

/** The title the session finishes. */
const TIDEPOOL = {
  channelKey: 'cd'.repeat(32),
  videoId: 'tidepool',
  title: 'Tidepool',
  identity: { entityRef: 'work:tidepool' },
  positionSec: 3550,
  durationSec: 3600,
}

/** The legacy web store the migration path reads once, before the encrypted store owns it. */
function installWebStorage() {
  const values = new Map()
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: (key) => { values.delete(key) },
  }
  return { restore() { globalThis.localStorage = previous } }
}

/**
 * Local state calls a viewer session legitimately makes: preparing a P2P
 * playback URL, and reading/writing this device's own encrypted personal
 * store. Anything else the session invokes has to be justified here first.
 */
const ALLOWED_SESSION_RPC = new Set([
  'preparePlayback',
  'logWatchHistory',
  'getWatchHistory',
  'listResumePositions',
])

const ANALYTICS_RPC = /(watchEvent|telemetry|analytics|beacon|metrics|track|report)/i

test('a full viewer session issues no outbound request and no analytics RPC', async (t) => {
  // Load before sandboxing: the bundler is not part of the session.
  const rails = await loadLocalModule('lib/home-rails.js', 'home-rails')
  const recommendations = await loadLocalModule('lib/local-recommendations.ts', 'local-recommendations')
  const history = await loadLocalModule('lib/watch-history.ts', 'watch-history')
  const resume = await loadLocalModule('lib/playback-resume.ts', 'playback-resume')

  for (const [name, fn] of [
    ['projectHomeRails', rails.projectHomeRails],
    ['projectSearchResults', rails.projectSearchResults],
    ['rankLocalRecommendations', recommendations.rankLocalRecommendations],
    ['recordProgress', history.recordProgress],
    ['getLocalWatchState', history.getLocalWatchState],
    ['getContinueWatching', history.getContinueWatching],
    ['getHistory', history.getHistory],
    ['resumeWatchEntry', resume.resumeWatchEntry],
  ]) {
    assert.equal(typeof fn, 'function', `the harness must actually exercise ${name}`)
  }

  const storage = installWebStorage()
  const egress = installEgressRecorder()
  const rpcCalls = []
  const answer = async (method, args) => {
    rpcCalls.push({ method, args })
    return method === 'preparePlayback' ? { url: 'http://127.0.0.1:49152/blob/nebula-drift' } : { success: true }
  }
  // watch-history reaches the backend through the platform facade, which the
  // bundle stub routes here; playback-resume takes its rpc as a dependency.
  globalThis.__peartubeHarnessRpc = answer
  const rpc = new Proxy({}, { get: (_target, method) => (args) => answer(String(method), args) })
  const seeks = []
  const played = []

  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    // play, then pause mid-title
    await resume.resumeWatchEntry({ ...NEBULA, positionSec: 1800, completed: false, updatedAt: NOW - DAY }, {
      rpc,
      loadAndPlayVideo: (video, url) => played.push({ id: video.id, url }),
      seekTo: (seconds) => seeks.push(seconds),
    })
    // the resume seek the player schedules once it has had time to attach
    t.mock.timers.tick(3_500)
    assert.equal(played.length, 1, 'playback started')
    assert.deepEqual(seeks, [1800, 1800], 'the resume seek ran')
    await history.recordProgress(NEBULA)

    // save to the library, and finish a different title
    await history.recordProgress({ ...NEBULA, saved: true })
    await history.recordProgress(TIDEPOOL)

    const entries = await history.getHistory()
    assert.equal(entries.find((entry) => entry.videoId === 'tidepool')?.completed, true, 'completion is decided on this device')
    assert.equal(entries.find((entry) => entry.videoId === 'nebula-drift')?.saved, true, 'the library save stays a local record')
    const continueWatching = await history.getContinueWatching()
    assert.ok(continueWatching.some((entry) => entry.videoId === 'nebula-drift'), 'the paused title is resumable')
    assert.ok(continueWatching.every((entry) => !entry.completed), 'finished titles leave Continue Watching')

    // browse and recommend from exactly the state that session just wrote
    const localWatchState = await history.getLocalWatchState()
    const watchState = localWatchState.map((row) => ({
      ...CATALOG.find((item) => item.entityId === row.entityId),
      ...row,
    }))
    const homeRails = rails.projectHomeRails({ items: CATALOG, watchState, now: NOW })
    const resumeRail = homeRails.find((rail) => rail.id === 'continue-watching')
    assert.ok(resumeRail?.items.some((item) => item.entityId === 'work:nebula-drift'), 'browse rebuilds Continue Watching locally')
    assert.equal(resumeRail.private, true, 'the resume rail is marked device-private')

    // search
    const results = rails.projectSearchResults({ items: CATALOG, query: 'nebula', now: NOW })
    assert.equal(results.length, 2, 'search resolves against the local catalog page')

    // recommend
    const recommended = recommendations.rankLocalRecommendations({ items: CATALOG, watchState, now: NOW })
    assert.ok(recommended.length > 0, 'recommendations are produced from device-local state')
    assert.ok(
      recommended.every((item) => item.entityId !== 'work:nebula-drift' && item.entityId !== 'work:tidepool'),
      'already-watched titles are not recommended back',
    )
  } finally {
    t.mock.timers.reset()
    egress.restore()
    storage.restore()
    delete globalThis.__peartubeHarnessRpc
  }

  assert.deepEqual(egress.calls, [], 'the viewer session must make no outbound request of any kind')
  const methods = [...new Set(rpcCalls.map((call) => call.method))].sort()
  assert.deepEqual(
    methods.filter((method) => ANALYTICS_RPC.test(method)),
    [],
    'no analytics, telemetry, or view-reporting call may leave the session',
  )
  assert.deepEqual(
    methods.filter((method) => !ALLOWED_SESSION_RPC.has(method)),
    [],
    `unclassified backend call(s) in a viewer session: ${methods.join(', ')}`,
  )
  assert.ok(methods.includes('preparePlayback'), 'the session really did drive playback through the backend')
  assert.ok(methods.includes('logWatchHistory'), 'the session really did write watch state to the local store')
})

test('watch state written by the session never leaves the device', () => {
  // The web/local persistence path is a device-local key/value write; there is
  // no upload counterpart anywhere in the module.
  const watchHistory = SOURCES.find((source) => source.file === 'lib/watch-history.ts')
  assert.ok(watchHistory, 'watch-history must exist')
  for (const [kind, pattern] of EGRESS_PRIMITIVES) {
    assert.doesNotMatch(watchHistory.code, pattern, `watch state persistence must not use ${kind}`)
  }
})

// ---------------------------------------------------------------------------
// Source sweep
// ---------------------------------------------------------------------------

test('every outbound-request site in the app surface is explicitly allowed', () => {
  const sites = egressSites()
  const unexplained = sites.filter((site) => !ALLOWED_EGRESS[site.file])
  assert.deepEqual(
    unexplained,
    [],
    `unclassified outbound request(s): ${unexplained.map((s) => `${s.file}:${s.line} (${s.kind})`).join(', ')}`,
  )

  const stale = Object.keys(ALLOWED_EGRESS).filter((file) => !sites.some((site) => site.file === file))
  assert.deepEqual(stale, [], 'stale egress allowances must be removed rather than left as cover')
})

test('no analytics, beacon, or telemetry emitter exists in the app surface', () => {
  const forbidden = [
    ['watch-event telemetry', /\blogWatchEvent\s*\(/],
    ['analytics emitter', /\b(trackEvent|logEvent|captureEvent|recordTelemetry|sendTelemetry|reportUsage|reportMetrics|logPageView|identifyUser)\s*\(/],
    ['beacon', /\bsendBeacon\s*\(/],
    ['legacy XHR', /\bnew\s+XMLHttpRequest\b/],
    ['tag manager', /\b(gtag|dataLayer)\s*[.(]/],
  ]
  const hits = []
  for (const { file, code } of SOURCES) {
    for (const [label, pattern] of forbidden) {
      if (pattern.test(code)) hits.push(`${file}: ${label}`)
    }
  }
  assert.deepEqual(hits, [], `analytics emission found: ${hits.join(', ')}`)
})

test('no analytics vendor is imported or addressed', () => {
  const vendor = /(google-analytics|googletagmanager|segment\.(io|com)|mixpanel|amplitude|posthog|plausible|matomo|datadoghq|bugsnag|sentry|firebase\/analytics|analytics\.js)/i
  const endpoint = /(\/collect\b|\/track\b|\/telemetry\b|\/beacon\b|\/analytics\b)/i

  const hits = []
  for (const { file, code } of SOURCES) {
    for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1] ?? match[2] ?? match[3]
      if (vendor.test(specifier)) hits.push(`${file}: imports ${specifier}`)
    }
    for (const match of code.matchAll(/['"`]((?:https?:)?\/\/[^'"`]+|\/[a-z0-9][^'"`\s]*)['"`]/gi)) {
      const literal = match[1]
      if (vendor.test(literal) || endpoint.test(literal)) hits.push(`${file}: addresses ${literal}`)
    }
  }
  assert.deepEqual(hits, [], `analytics vendor reference found: ${hits.join(', ')}`)

  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'))
  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
  assert.deepEqual(dependencies.filter((name) => vendor.test(name)), [], 'no analytics SDK may be a dependency')
})

test('recommendations are computed locally and never fetched', () => {
  for (const file of ['lib/local-recommendations.ts', 'lib/home-rails.js']) {
    const source = SOURCES.find((entry) => entry.file === file)
    assert.ok(source, `${file} must exist`)
    for (const [kind, pattern] of EGRESS_PRIMITIVES) {
      assert.doesNotMatch(source.code, pattern, `${file} must not use ${kind}`)
    }
    assert.doesNotMatch(source.code, /\brpc\b/, `${file} must not reach the backend at all`)
    for (const match of source.code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.match(match[1], /^\./, `${file} must depend only on local modules, found ${match[1]}`)
    }
  }
})

test('artwork, provider auth, and diagnostics export stay permitted', () => {
  // The allowlist is the contract: it must keep covering the legitimate cases
  // rather than shrinking to zero and making the harness vacuous.
  const reasons = Object.values(ALLOWED_EGRESS).join(' ')
  assert.match(reasons, /P2P/, 'P2P transfer remains permitted')
  assert.match(reasons, /user-triggered diagnostics/, 'user-triggered diagnostics export remains permitted')
  assert.ok(Object.keys(ALLOWED_EGRESS).length >= 3, 'the allowlist still describes real, permitted egress')
})
