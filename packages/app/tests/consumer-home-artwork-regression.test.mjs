import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const appRoot = path.resolve(import.meta.dirname, '..')

// Home pulls in icon sets and safe-area natives that do not exist off-device.
// This render only cares about whether a card reaches for its artwork.
const STUBS = {
  'expo-vector-icons': [
    'const Icon = () => null',
    'export const Ionicons = Icon',
    'export const Feather = Icon',
    'export const MaterialIcons = Icon',
    'export const MaterialCommunityIcons = Icon',
    'export const FontAwesome = Icon',
    'export const AntDesign = Icon',
    'export const Entypo = Icon',
    'export default { Ionicons: Icon, Feather: Icon }',
    '',
  ].join('\n'),
  'safe-area': 'export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 })\n',
  'expo-router': 'export const useLocalSearchParams = () => ({})\nexport const useRouter = () => ({ back() {}, push() {} })\n',
  // The real thumbnail renderer reaches for native image APIs that do not
  // exist off-device. Standing in for it keeps this test about the one thing
  // it asserts: that a home card hands its artwork to the poster.
  // Reanimated resolves its native module at import time, which cannot exist
  // in a server render.
  'reanimated': [
    'import React from "react"',
    'const passthrough = new Proxy({}, { get: () => () => null })',
    'export const useSharedValue = (value) => ({ value })',
    'export const useAnimatedStyle = () => ({})',
    'export const withTiming = (value) => value',
    'export const withSpring = (value) => value',
    'export const Easing = passthrough',
    'export const cancelAnimation = () => {}',
    'export const withRepeat = (value) => value',
    'export const withSequence = (value) => value',
    'export const withDelay = (_, value) => value',
    'export const interpolate = () => 0',
    'export const runOnJS = (fn) => fn',
    'const View = (props) => React.createElement("div", null, props.children)',
    'export default { View, Text: View, ScrollView: View, Image: View, createAnimatedComponent: (c) => c }',
    '',
  ].join('\n'),
  'thumbnail-image': [
    'import React from "react"',
    'export function ThumbnailImage(props) {',
    '  return React.createElement("img", { src: props.thumbnailUrl || "", alt: props.channelInitial || "" })',
    '}',
    'export default ThumbnailImage',
    '',
  ].join('\n'),
}

const stubNativeOnlyDeps = {
  name: 'stub-native-only-deps',
  setup(builder) {
    builder.onResolve({ filter: /^@expo\/vector-icons/ }, () => ({ path: 'expo-vector-icons', namespace: 'stub' }))
    builder.onResolve({ filter: /^react-native-safe-area-context$/ }, () => ({ path: 'safe-area', namespace: 'stub' }))
    builder.onResolve({ filter: /^expo-router$/ }, () => ({ path: 'expo-router', namespace: 'stub' }))
    builder.onResolve({ filter: /ThumbnailImage$/ }, () => ({ path: 'thumbnail-image', namespace: 'stub' }))
    builder.onResolve({ filter: /^react-native-reanimated/ }, () => ({ path: 'reanimated', namespace: 'stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
      contents: STUBS[args.path],
      loader: 'js',
      resolveDir: appRoot,
    }))
  },
}

async function loadHomeView() {
  const result = await build({
    // The catalog hands over a blob reference, and the card resolves it through
    // the app's RPC client. Pulling the context in alongside the view lets a
    // render supply a stub client instead of reaching for a real blob server.
    stdin: {
      contents: [
        "export { ConsumerHomeView } from './components/media/ConsumerHomeView'",
        "export { AppContext } from './lib/AppContext'",
        '',
      ].join('\n'),
      resolveDir: appRoot,
      sourcefile: 'consumer-home-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    external: ['react', 'react-dom'],
    platform: 'node',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
    alias: { 'react-native': 'react-native-web' },
    plugins: [stubNativeOnlyDeps],
    loader: { '.png': 'empty', '.ttf': 'empty', '.otf': 'empty', '.woff': 'empty', '.woff2': 'empty' },
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.consumer-home-'))
  const output = path.join(directory, 'home.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function renderWith(module, items, rpc) {
  const home = React.createElement(module.ConsumerHomeView, {
    state: { status: 'ready', items },
    onRefresh() {},
    onOpenEntity() {},
  })
  if (!rpc) return renderToStaticMarkup(home)
  return renderToStaticMarkup(
    React.createElement(module.AppContext.Provider, { value: { rpc, blobServerPort: 49_201 } }, home),
  )
}

function renderHome(items) {
  return loadHomeView().then(module => renderWith(module, items))
}

// The card starts resolution while it renders and adopts the URL once the blob
// server answers, so a second render is what a viewer sees a moment later.
function settle() {
  return new Promise(resolve => setImmediate(resolve))
}

// A card used to paint a flat surface with the title's first letter and never
// look at the entity's artwork at all, so a catalog of real media rendered as a
// row of grey rectangles. Artwork has to reach the poster.
test('a home card renders the artwork the entity carries', async () => {
  const posterUrl = 'https://image.example/poster-under-test.jpg'
  const html = await renderHome([{
    entityId: 'entity-with-art',
    entityKind: 'work',
    title: 'Has Artwork',
    posterUrl,
  }])

  assert.ok(html.includes('Has Artwork'), 'the title renders')
  assert.ok(html.includes(posterUrl), 'the poster URL reaches the rendered card')
})

// Relay-archived media that never matched a metadata provider has no artwork,
// and that is normal rather than an error state.
test('a home card without artwork still renders its title', async () => {
  const html = await renderHome([{
    entityId: 'entity-without-art',
    entityKind: 'work',
    title: 'No Artwork',
  }])

  assert.ok(html.includes('No Artwork'), 'the title renders without any artwork')
})

// Artwork may arrive under any of the provider fields the rest of the app
// already accepts; Home must not recognise only one of them.
test('a home card accepts thumbnail artwork as well as posters', async () => {
  const thumbnailUrl = 'https://image.example/thumb-under-test.jpg'
  const html = await renderHome([{
    entityId: 'entity-with-thumb',
    entityKind: 'work',
    title: 'Thumb Only',
    thumbnailUrl,
  }])

  assert.ok(html.includes(thumbnailUrl), 'the thumbnail URL reaches the rendered card')
})

// Home is a board of shelves, the way a catalog app presents itself: rows of
// posters, no feature panel promising playback. Anything a viewer can act on
// they act on by opening the title.
test('home presents shelves rather than a feature panel', async () => {
  const html = await renderHome([{
    entityId: 'playable-entity',
    entityKind: 'work',
    title: 'Ready To Watch',
    posterUrl: 'https://image.example/ready.jpg',
    availability: { state: 'healthy', label: 'Available now', playable: true },
  }])

  assert.ok(html.includes('Ready To Watch'), 'the title appears on a shelf')
  assert.ok(html.includes('Recently Added'), 'the shelf is labelled')
  assert.ok(!html.includes('Play Ready To Watch'), 'home does not carry a play affordance of its own')
})

// Availability stays on the card so a viewer knows what they are looking at
// before they open it, without the screen promising playback.
test('a card states availability for media that cannot play yet', async () => {
  const html = await renderHome([{
    entityId: 'pending-entity',
    entityKind: 'work',
    title: 'Still Arriving',
    availability: { state: 'awaiting-replication', label: 'Awaiting replication', playable: false },
  }])

  assert.ok(html.includes('Still Arriving'), 'the title is listed')
  assert.ok(html.includes('Awaiting replication'), 'the card says what it is waiting for')
  assert.ok(!html.includes('Play Still Arriving'), 'nothing offers to play a title that cannot play yet')
})

// Cover art reaches the catalog as the display locator the publisher claimed.
// The card has to render it, or a catalog that arrives complete with artwork
// still shows blank placeholders.
test('a home card renders the catalog poster locator', async () => {
  const posterUrl = 'https://image.example/claimed-poster.jpg'
  const html = await renderHome([{
    entityId: 'entity-claimed-art',
    entityKind: 'work',
    title: 'Claimed Art',
    posterUrl,
  }])

  assert.ok(html.includes(posterUrl), 'the claimed poster reaches the rendered card')
})

const BLOBS_CORE_KEY = 'a'.repeat(64)
const BLOB_SERVER_URL = 'http://127.0.0.1:49201/blobs/poster-under-test.jpg'

function recordingRpc(url = BLOB_SERVER_URL) {
  const calls = []
  return {
    calls,
    getVideoThumbnail: async request => {
      calls.push(request)
      return { exists: true, url }
    },
  }
}

// Cover art lives in the publisher's own blob core, never at an outside origin:
// an origin says who is browsing what, is blockable, and is absent offline. The
// card has to turn the reference into a local blob-server URL.
test('a home card resolves a poster blob reference through the blob server', async () => {
  const module = await loadHomeView()
  const rpc = recordingRpc()
  const items = [{
    entityId: 'entity-blob-art',
    entityKind: 'work',
    title: 'Blob Art',
    posterBlobId: '3:1:0:512',
    posterBlobsCoreKey: BLOBS_CORE_KEY,
    posterMimeType: 'image/jpeg',
  }]

  const before = renderWith(module, items, rpc)
  assert.ok(before.includes('Blob Art'), 'the card renders while the poster is still resolving')
  assert.equal(before, renderWith(module, [{ entityId: 'entity-blob-art', entityKind: 'work', title: 'Blob Art' }]),
    'an unresolved poster is exactly the placeholder, so nothing shifts when it lands')

  await settle()
  const after = renderWith(module, items, rpc)

  assert.equal(rpc.calls.length, 1, 'the same reference resolves once, not once per render')
  assert.deepEqual(rpc.calls[0], {
    channelKey: '',
    videoId: '',
    thumbnailBlobId: '3:1:0:512',
    thumbnailBlobsCoreKey: BLOBS_CORE_KEY,
    thumbnailMimeType: 'image/jpeg',
  }, 'the poster reference is forwarded under the thumbnail ref names the backend reads')
  assert.ok(after.includes(BLOB_SERVER_URL), 'the resolved blob-server URL reaches the rendered card')
})

// Claims made before publishers carried their own artwork still name an origin.
// Those keep rendering as they always did, and ask the swarm for nothing.
test('a home card with only a poster locator resolves nothing', async () => {
  const module = await loadHomeView()
  const rpc = recordingRpc()
  const posterUrl = 'https://image.example/legacy-claim.jpg'

  const html = renderWith(module, [{
    entityId: 'entity-legacy-art',
    entityKind: 'work',
    title: 'Legacy Art',
    posterUrl,
  }], rpc)

  assert.ok(html.includes(posterUrl), 'the claimed locator still renders')
  assert.equal(rpc.calls.length, 0, 'a locator needs no blob resolution')
})

// Relay-archived media that never matched a metadata provider carries neither,
// and must cost nothing rather than probing the swarm for a blob that is not
// referenced anywhere.
test('a home card with no artwork at all resolves nothing', async () => {
  const module = await loadHomeView()
  const rpc = recordingRpc()

  const html = renderWith(module, [{
    entityId: 'entity-no-art',
    entityKind: 'work',
    title: 'Bare Entity',
  }], rpc)

  assert.equal(html, renderWith(module, [{
    entityId: 'entity-no-art',
    entityKind: 'work',
    title: 'Bare Entity',
  }]), 'the card is exactly what it renders with no client at all: the placeholder')
  assert.equal(rpc.calls.length, 0, 'nothing is asked of the blob server')
})
