import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}
async function loadWebChannelCard() {
  const reactStub = [
    'export const jsx = (type, props) => ({ type, props: props || {} })',
    'export const jsxs = (type, props) => ({ type, props: props || {} })',
    'export const Fragment = Symbol("Fragment")',
    'export const useCallback = fn => fn',
    'export const useEffect = () => {}',
    'export const useMemo = fn => fn()',
    'export const useRef = value => ({ current: value })',
    'export const useState = value => [value, () => {}]',
    '',
  ].join('\n')
  const stubs = {
    'react-stub': reactStub,
    'react-native-stub': 'export const ActivityIndicator = () => null\n',
    'layout-stub': 'export const colors = { primary: "#000", text: "#000", textMuted: "#666" }\nexport const useApp = () => ({})\n',
  }
  const plugin = {
    name: 'instrument-web-channel-card',
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, () => ({ path: 'react-stub', namespace: 'channel-stub' }))
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'react-native-stub', namespace: 'channel-stub' }))
      builder.onResolve({ filter: /^\.\.\/_layout$/ }, args => (
        args.importer.endsWith('/app/channel/[key].web.tsx')
          ? { path: 'layout-stub', namespace: 'channel-stub' }
          : undefined
      ))
      builder.onLoad({ filter: /.*/, namespace: 'channel-stub' }, args => ({
        contents: stubs[args.path],
        loader: 'js',
      }))
      builder.onLoad({ filter: /\[key\]\.web\.tsx$/ }, args => ({
        contents: `${fs.readFileSync(args.path, 'utf8')}
export { ChannelVideoCard }
`,
        loader: 'tsx',
        resolveDir: path.dirname(args.path),
      }))
    },
  }
  const result = await build({
    stdin: {
      contents: "export { ChannelVideoCard } from './app/channel/[key].web.tsx'",
      resolveDir: appRoot,
      sourcefile: 'channel-card-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    plugins: [plugin],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.channel-card-'))
  const output = path.join(directory, 'card.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('native channel page video cards navigate to the video route with channel context', () => {
  const source = read('app/channel/[key].tsx')

  assert.match(
    source,
    /function ChannelVideoCard\([\s\S]*?onPress,[\s\S]*?\}: \{[\s\S]*?onPress: \(\) => void/s,
    'ChannelVideoCard should accept a real onPress handler instead of rendering a no-op card',
  )

  assert.match(
    source,
    /router\.(?:push|replace)\(\{\s*pathname: '\/video\/\[id\]'[\s\S]*?channel: channelKey[\s\S]*?videoData: JSON\.stringify/s,
    'native channel videos should open /video/[id] with channel and videoData params',
  )

  assert.match(
    source,
    /publicBeeKey: playbackPayload\.publicBeeKey,[\s\S]*?videoData: JSON\.stringify/s,
    'native channel videos should preserve the resolved publication key before serialized videoData',
  )

  assert.doesNotMatch(
    source,
    /<PressableFeedback className="mb-4" onPress=\{\(\) => \{\}\}/,
    'channel video card presses must not be wired to a no-op handler',
  )
})


test('web hash route parsing decodes watch and channel params safely', () => {
  const webChannel = read('app/channel/[key].web.tsx')

  assert.match(webChannel, /function safeDecodeURIComponent/, 'web channel page hash parser should use safe decoding')
})

test('channel view preserves publicBeeKey across native and web navigation/data fetches', () => {
  const nativeVideo = read('app/video/[id].tsx')
  const nativeChannel = read('app/channel/[key].tsx')
  const webChannel = read('app/channel/[key].web.tsx')

  assert.match(
    nativeVideo,
    /router\.push\(\{ pathname: '\/channel\/\[key\]', params: \{ key: videoData\.channelKey, publicBeeKey: videoData\.publicBeeKey \|\| undefined \} \}\)/,
    'native video channel navigation should preserve publicBeeKey',
  )
  assert.match(nativeVideo, /const rawPublicBeeParam = params\.publicBeeKey \?\? params\.publicBee/, 'native watch route should accept both publicBeeKey and legacy publicBee route params')
  assert.match(nativeVideo, /const fetchedVideoData = result\?\.video \|\| result/, 'native watch route should unwrap backend getVideoData responses before playback')
  assert.match(nativeVideo, /rpc\.getVideoData\(\{[\s\S]*?blobId: videoData\?\.blobId \|\| undefined,[\s\S]*?blobsCoreKey: videoData\?\.blobsCoreKey \|\| undefined,/s, 'native watch route should pass direct blob refs when refreshing video metadata')
  assert.match(nativeChannel, /catalogController\.loadCatalog\(\{[\s\S]*channelKey,[\s\S]*publicBeeKey: channelPublicBeeKey,/s, 'native channel catalog should preserve the publication key')
  assert.match(nativeChannel, /publicBeeKey: playbackPayload\.publicBeeKey/, 'native channel video navigation should preserve the publication key')

  assert.match(webChannel, /publicBeeKey: safeDecodeURIComponent\(params\.get\('publicBeeKey'\) \|\| ''\)/, 'web channel hash parser should decode publicBeeKey')
  assert.match(webChannel, /catalogController\.loadCatalog\(\{[\s\S]*channelKey: resolvedChannelKey,[\s\S]*publicBeeKey: resolvedPublicBeeKey,/s, 'web channel catalog should preserve the publication key')
})
test('web channel cards encode reserved channel and video keys in the watch hash', async () => {
  const { ChannelVideoCard } = await loadWebChannelCard()
  const previousWindow = globalThis.window
  const previousCustomEvent = globalThis.CustomEvent
  const events = []
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type
      this.detail = init.detail
    }
  }
  globalThis.window = {
    location: { hash: '' },
    dispatchEvent: event => events.push(event),
  }

  try {
    const channelKey = 'channel/with?reserved#key%'
    const videoId = 'video/part?one#two%'
    const card = ChannelVideoCard({
      card: {
        id: videoId,
        item: { id: videoId, title: 'Reserved key video' },
        artworkCandidates: [],
      },
      channelKey,
      publicBeeKey: 'public-bee-key',
      channelName: 'Reserved channel',
      thumbnailCache: {},
      resolveCardArtwork() {},
    })

    card.props.onClick()

    assert.equal(
      globalThis.window.location.hash,
      `/watch/${encodeURIComponent(channelKey)}/${encodeURIComponent(videoId)}`,
    )
    assert.equal(globalThis.window.__peartubePendingWatchVideo.channelKey, channelKey)
    assert.equal(globalThis.window.__peartubePendingWatchVideo.publicBeeKey, 'public-bee-key')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'peartube:watch-video')
  } finally {
    globalThis.window = previousWindow
    globalThis.CustomEvent = previousCustomEvent
  }
})
