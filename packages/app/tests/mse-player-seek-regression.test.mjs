import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { test } from 'node:test'

const mseBackendPath = new URL('../components/video-player/WebMseVideoBackend.web.tsx', import.meta.url)
const inlineViewPath = new URL('../components/video-player/PearInlineVideoView.tsx', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}
async function loadMseBackend() {
  const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const reactStub = [
    'const runtime = () => globalThis.__peartubeMseHooks',
    'const same = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))',
    'export const memo = component => component',
    'export const useRef = initial => { const rt = runtime(); const index = rt.index++; if (!rt.refs[index]) rt.refs[index] = { current: initial }; return rt.refs[index] }',
    'export const useCallback = (fn, deps) => { const rt = runtime(); const index = rt.index++; const previous = rt.callbacks[index]; if (!previous || !same(previous.deps, deps)) rt.callbacks[index] = { deps, fn }; return rt.callbacks[index].fn }',
    'export const useEffect = (effect, deps) => { const rt = runtime(); const index = rt.index++; const previous = rt.effects[index]; const changed = !previous || !same(previous.deps, deps); rt.effects[index] = { deps, effect: changed ? effect : null } }',
    'export const jsx = (type, props) => ({ type, props: props || {} })',
    'export const jsxs = jsx',
    'export const Fragment = Symbol("Fragment")',
    '',
  ].join('\n')
  const stubs = {
    'react-stub': reactStub,
    'player-stub': 'export const createWebMsePlayerPort = controller => controller\n',
    'hls-stub': [
      'export const isMasterPlaylist = () => false',
      'export const parseMasterPlaylist = () => null',
      'export const parseMediaPlaylist = () => null',
      'export const resolveAgainstPlaylist = value => value',
      'export const findSegmentIndexForTime = () => 0',
      'export const buildCompatMimeCandidates = () => []',
      '',
    ].join('\n'),
    'mediabunny-stub': [
      'export class Input { constructor() { throw new Error("pipeline stub") } }',
      'export class UrlSource {}',
      'export class EncodedPacketSink {}',
      'export const ALL_FORMATS = []',
      '',
    ].join('\n'),
  }
  const plugin = {
    name: 'run-mse-backend-retry',
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, () => ({ path: 'react-stub', namespace: 'mse-stub' }))
      builder.onResolve({ filter: /^@\/lib\/video-player$/ }, () => ({ path: 'player-stub', namespace: 'mse-stub' }))
      builder.onResolve({ filter: /^@\/lib\/hls-fragment-source\.mjs$/ }, () => ({ path: 'hls-stub', namespace: 'mse-stub' }))
      builder.onResolve({ filter: /^mediabunny$/ }, () => ({ path: 'mediabunny-stub', namespace: 'mse-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'mse-stub' }, args => ({
        contents: stubs[args.path],
        loader: 'js',
      }))
    },
  }
  const result = await build({
    stdin: {
      contents: "export { WebMseVideoBackend } from './components/video-player/WebMseVideoBackend.web.tsx'",
      resolveDir: appRoot,
      sourcefile: 'mse-backend-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    plugins: [plugin],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.mse-backend-'))
  const output = path.join(directory, 'backend.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function runPendingEffects(runtime) {
  for (const slot of runtime.effects) {
    if (typeof slot?.effect !== 'function') continue
    slot.cleanup = slot.effect()
  }
}

test('MSE backend remuxes on demand instead of linearly converting the whole file', async () => {
  const src = await source(mseBackendPath)

  assert.doesNotMatch(src, /Conversion\.init|conversion\.execute/, 'the linear Conversion pipeline must not come back — it forces seeks to wait for everything before the target')
  assert.match(src, /EncodedPacketSink/, 'random-access packet reading is required for seek-on-demand')
  assert.match(src, /getKeyPacket\(/, 'seeks must start from the keyframe at/before the target')
  assert.match(src, /verifyKeyPackets: true/, 'key packet flags must be verified (Matroska key flags are unreliable)')
})

test('MSE backend restarts the remux pipeline from the seek target', async () => {
  const src = await source(mseBackendPath)
  const seekStart = src.indexOf('// --- Seek handler: restart the pipeline from the seek target ---')
  assert.notEqual(seekStart, -1, 'expected onseeking handler')
  const handler = src.slice(seekStart, src.indexOf('await runPipeline(0, generation)', seekStart))

  assert.match(handler, /const handleSeeking = \(\) => \{/, 'remux seek handling should be an additive event listener')
  assert.match(handler, /el\.addEventListener\('seeking', handleSeeking\)/, 'remux seek handling should compose with other video listeners')
  assert.match(handler, /el\.removeEventListener\('seeking', handleSeeking\)/, 'remux seek listener must be removed on backend disposal')
  assert.match(handler, /generation\+\+/, 'seeking must invalidate the previous pipeline generation')
  assert.match(handler, /cancel/, 'the superseded output must be canceled so it stops consuming bandwidth')
  assert.match(handler, /runPipeline\(Math\.max\(0, target - 0\.5\), gen\)/, 'a new pipeline must start from the seek target')
  assert.doesNotMatch(src, /el\.onseeking\s*=/, 'MSE backend should not overwrite the video element seeking handler')
})

test('MSE compat backend uses Expo-compatible seeking listeners', async () => {
  const src = await source(mseBackendPath)
  const compatStart = src.indexOf('async function runCompatHlsPipeline')
  const compatEnd = src.indexOf('export const WebMseVideoBackend', compatStart)
  assert.notEqual(compatStart, -1, 'compat pipeline should exist')
  assert.notEqual(compatEnd, -1, 'compat pipeline block should be bounded')
  const compatBlock = src.slice(compatStart, compatEnd)

  assert.match(compatBlock, /const handleSeeking = \(\) => \{/, 'compat seek handling should be an additive event listener')
  assert.match(compatBlock, /el\.addEventListener\('seeking', handleSeeking\)/, 'compat seek handling should compose with other video listeners')
  assert.match(compatBlock, /el\.removeEventListener\('seeking', handleSeeking\)/, 'compat seek listener must be removed on backend disposal')
})

test('MSE backend exposes Expo-style controller controls through PlayerPort', async () => {
  const src = await source(mseBackendPath)

  assert.match(src, /type WebMseBackendController = \{[\s\S]*play\(\): Promise<void>[\s\S]*pause\(\): void[\s\S]*seek\(timeSeconds: number\): void/)
  assert.match(src, /type WebMseBackendController = \{[\s\S]*seekBy\(seconds: number\): void[\s\S]*replace\(sourceUrl: string \| null\): void/)
  assert.match(src, /get currentTime\(\): number/)
  assert.match(src, /set currentTime\(value: number\)/)
  assert.match(src, /function createWebMseBackendController\(el: HTMLVideoElement\): WebMseBackendController/)
  assert.match(src, /const controller = createWebMseBackendController\(el\)[\s\S]*createWebMsePlayerPort\(controller\)/)
  assert.match(src, /const controller = mseBackendControllerRef\.current[\s\S]*if \(isPlaying\)[\s\S]*requestDesiredPlayback\(\)[\s\S]*else[\s\S]*controller\.pause\(\)/)
})

test('MSE backend reports the full duration up front so the whole timeline is seekable', async () => {
  const src = await source(mseBackendPath)
  assert.match(src, /input\.computeDuration\(\)/, 'duration must come from the container index, not from conversion progress')
  assert.match(src, /ms\.duration = duration/, 'MediaSource duration must be set before playback so seeks anywhere are possible')
})

test('MSE backend releases its shared player port when React swaps player branches or video URLs', async () => {
  const src = await source(mseBackendPath)
  const detachStart = src.indexOf('if (!el) {')
  const detachEnd = src.indexOf('if (initStarted.current) return', detachStart)
  assert.notEqual(detachStart, -1, 'MSE backend should handle ref detach')
  assert.notEqual(detachEnd, -1, 'MSE backend should guard duplicate ref attach after detach handling')
  const detachBranch = src.slice(detachStart, detachEnd)

  assert.match(detachBranch, /initStarted\.current = false/, 'ref detach must reset the init guard so a new URL can start a new pipeline')
  assert.match(detachBranch, /videoElRef\.current = null/, 'ref detach must forget the detached HTML video element')
  assert.match(src, /const mseBackendPortRef = useRef<PlayerPort \| null>\(null\)/, 'MSE backend should retain its own port identity for safe cleanup')
  assert.match(
    detachBranch,
    /playerRef\?\.current === mseBackendPortRef\.current[\s\S]*playerRef\.current = null/,
    'ref detach must clear the shared playerRef only when it still points at this MSE backend instance'
  )
})

test('MSE backend keeps its DOM ref stable across progress rerenders', async () => {
  const src = await source(mseBackendPath)
  const callbackStart = src.indexOf('const videoRefCallback = useCallback')
  const renderStart = src.indexOf('  return (', callbackStart)
  assert.notEqual(callbackStart, -1, 'MSE backend should use a callback ref')
  assert.notEqual(renderStart, -1, 'MSE backend should render after the callback ref')
  const callbackBlock = src.slice(callbackStart, renderStart)
  const depsMatch = callbackBlock.match(/\}, \[([^\]]+)\]\)/)

  assert.match(src, /const callbacksRef = useRef\(/, 'volatile event callbacks should be read from a ref')
  assert.ok(depsMatch, 'MSE backend callback ref should expose its dependency list')
  const dependencyList = depsMatch ? depsMatch[1] : ''
  assert.doesNotMatch(
    dependencyList,
    /onProgress|onLoad|onError|onPlaying|onPaused|onEnded|requestCompatPlayback/,
    'progress/load/error callback prop changes must not detach and restart the MSE video ref'
  )
  assert.match(dependencyList, /videoUrl/, 'video URL changes should still rebind the ref and start a fresh pipeline')
})
test('MSE backend retries a dropped desired play while the parent still wants playback', async (t) => {
  const { WebMseVideoBackend } = await loadMseBackend()
  const runtime = { index: 0, refs: [], callbacks: [], effects: [] }
  globalThis.__peartubeMseHooks = runtime
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let playCalls = 0
  const video = {
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    play() {
      playCalls += 1
      return playCalls === 1 ? Promise.reject(new Error('startup play dropped')) : Promise.resolve()
    },
    pause() {},
    load() {},
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
  }
  const element = WebMseVideoBackend({
    videoUrl: 'http://127.0.0.1/video.mp4',
    style: null,
    playerRef: { current: null },
    isPlaying: true,
    playbackRate: 1,
    requestCompatPlayback: async () => null,
  })

  element.props.ref(video)
  runPendingEffects(runtime)
  await Promise.resolve()
  assert.equal(playCalls, 1, 'the first desired play should reach the MSE controller')

  t.mock.timers.tick(300)
  await Promise.resolve()
  assert.equal(playCalls, 2, 'the actual MSE retry timer should reassert playback after a dropped play')

  delete globalThis.__peartubeMseHooks
})
