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

// Home is a hero over a grid of posters: a featured carousel at the top, then
// one labelled section per shelf whose titles wrap into rows. It used to be
// horizontal rails with no hero, which left a single-title catalog as one card
// against an empty screen; the design this app now follows leads with the hero.
test('home presents a hero over a grid of sections', async () => {
  const html = await renderHome([{
    entityId: 'playable-entity',
    entityKind: 'work',
    title: 'Ready To Watch',
    posterUrl: 'https://image.example/ready.jpg',
    availability: { state: 'healthy', label: 'Available now', playable: true },
  }])

  assert.ok(html.includes('Ready To Watch'), 'the title appears in its section')
  assert.ok(html.includes('Recently Added'), 'the section is labelled')
  assert.ok(html.includes('home-hero'), 'a featured carousel leads the screen')
  assert.ok(html.includes('home-section-recently-added'), 'the shelf renders as a grid section')
  // The earlier feature panel was reverted because it cropped a portrait poster
  // into a landscape frame and cut the artwork off, and because it promised
  // playback Home cannot deliver. The hero here does neither: a title with no
  // landscape source keeps its whole poster, and acting on anything still means
  // opening it.
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
  // Every undiscovered title reads 'awaiting replication' until someone asks a
  // peer, and pressing Play is what asks - so a shelf of them told a viewer
  // their whole catalogue was broken. The mechanics live on the detail screen.
  assert.ok(!html.includes('Awaiting replication'), 'replication wording stays off the shelf')
  assert.ok(!html.includes('Play Still Arriving'), 'home does not offer Play; the detail screen does')
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

// The publisher's cover art is a rendition of the publication, served over the
// same authorized asset path as the video. A card names the entity and is handed
// a URL that is already byte-local; it never names bytes or a core itself.
// The last answer repeats, so a caller can spell out only what changes.
function artworkRpc(...answers) {
  const calls = []
  return {
    calls,
    getEntityArtwork: async request => {
      calls.push(request)
      return answers.length > 1 ? answers.shift() : answers[0]
    },
  }
}

// The very same card with nothing to put in its poster frame: what a viewer
// looks at while artwork resolves, so any difference here is a layout shift.
function placeholderCard(module, item) {
  const bare = { ...item }
  delete bare.posterBlobId
  delete bare.posterBlobsCoreKey
  delete bare.posterMimeType
  delete bare.posterUrl
  return renderWith(module, [bare])
}

const BLOB_CLAIM_ITEM = {
  entityId: 'entity-blob-art',
  entityKind: 'work',
  title: 'Blob Art',
  publicationId: 'publication-blob-art',
  posterBlobId: '3:1:0:512',
  posterBlobsCoreKey: BLOBS_CORE_KEY,
  posterMimeType: 'image/jpeg',
}

// Cover art lives inside the publication a relay already seeds, never at an
// outside origin: an origin says who is browsing what, is blockable, and is
// absent offline. Resolving it through the raw blob core the claim names found
// peers: 0 and left every card grey, so the card asks for the entity instead.
test('a home card resolves entity artwork through the backend', async () => {
  const module = await loadHomeView()
  const rpc = artworkRpc({ success: true, exists: true, url: BLOB_SERVER_URL })

  const before = renderWith(module, [BLOB_CLAIM_ITEM], rpc)
  assert.ok(before.includes('Blob Art'), 'the card renders while the poster is still resolving')
  assert.equal(before, placeholderCard(module, BLOB_CLAIM_ITEM),
    'an unresolved poster is exactly the placeholder, so nothing shifts when it lands')

  await settle()
  const after = renderWith(module, [BLOB_CLAIM_ITEM], rpc)

  assert.equal(rpc.calls.length, 1, 'the same entity resolves once, not once per render')
  assert.deepEqual(rpc.calls[0], { entityId: 'entity-blob-art', publicationId: 'publication-blob-art' },
    'the entity is named, never the bytes')
  assert.ok(after.includes(BLOB_SERVER_URL), 'the resolved loopback URL reaches the rendered card')
})

// A poster that has not replicated here yet is the ordinary first answer, not a
// verdict. Recording that miss would leave a permanent placeholder on art that
// arrives seconds later, which is why the card keeps asking.
test('a home card asks again for a poster that has not replicated yet', async () => {
  const module = await loadHomeView()
  const rpc = artworkRpc(
    { success: true, exists: false },
    { success: true, exists: true, url: BLOB_SERVER_URL },
  )
  const item = { ...BLOB_CLAIM_ITEM, entityId: 'entity-slow-art', title: 'Slow Art' }

  renderWith(module, [item], rpc)
  await settle()
  assert.equal(rpc.calls.length, 1, 'the card asks the backend for the entity')

  const afterMiss = renderWith(module, [item], rpc)
  assert.equal(afterMiss, placeholderCard(module, item),
    'a poster that has not arrived leaves the placeholder standing')
  assert.equal(rpc.calls.length, 2, 'the miss is not cached as final, so the card asks again')

  await settle()
  const landed = renderWith(module, [item], rpc)
  assert.ok(landed.includes(BLOB_SERVER_URL), 'the poster appears as soon as it replicates')
  assert.equal(rpc.calls.length, 2, 'and the resolved URL is remembered rather than fetched twice')
})

// The one case a miss is final. A backend reporting a hard failure will not
// start succeeding mid-session, and a whole shelf walking the retry ladder at
// it is noise for art that is genuinely gone.
test('a home card stops asking when artwork resolution fails outright', async () => {
  const module = await loadHomeView()
  const rpc = artworkRpc({ success: false, exists: false, errorCode: 'ARTWORK_UNAVAILABLE' })
  const item = { ...BLOB_CLAIM_ITEM, entityId: 'entity-failed-art', title: 'Failed Art' }

  renderWith(module, [item], rpc)
  await settle()
  const html = renderWith(module, [item], rpc)

  assert.equal(html, placeholderCard(module, item), 'the card degrades to its placeholder')
  assert.equal(rpc.calls.length, 1,
    'a hard failure is final, unlike a poster that simply has not arrived yet')
})

// A backend older than this screen has no artwork method at all. Reaching for
// one has to end at the placeholder rather than throwing out of a render.
test('a home card renders its placeholder when the backend cannot resolve artwork', async () => {
  const module = await loadHomeView()
  const item = { ...BLOB_CLAIM_ITEM, entityId: 'entity-unsupported-art', title: 'Unsupported Art' }

  const html = renderWith(module, [item], { getVideoThumbnail: async () => ({ exists: false }) })

  assert.equal(html, placeholderCard(module, item),
    'no artwork method means the placeholder, not a crash')
})

// Claims made before publishers carried their own artwork still name an origin.
// Those keep rendering as they always did, and ask the swarm for nothing.
test('a home card with only a poster locator resolves nothing', async () => {
  const module = await loadHomeView()
  const rpc = artworkRpc({ success: true, exists: true, url: BLOB_SERVER_URL })
  const posterUrl = 'https://image.example/legacy-claim.jpg'

  const html = renderWith(module, [{
    entityId: 'entity-legacy-art',
    entityKind: 'work',
    title: 'Legacy Art',
    posterUrl,
  }], rpc)

  assert.ok(html.includes(posterUrl), 'the claimed locator still renders')
  assert.equal(rpc.calls.length, 0, 'a locator needs no resolution')
})

// Relay-archived media that never matched a metadata provider carries neither,
// and must cost nothing rather than asking the backend for artwork no publisher
// ever claimed.
test('a home card with no artwork at all resolves nothing', async () => {
  const module = await loadHomeView()
  const rpc = artworkRpc({ success: true, exists: true, url: BLOB_SERVER_URL })
  const item = { entityId: 'entity-no-art', entityKind: 'work', title: 'Bare Entity' }

  const html = renderWith(module, [item], rpc)

  assert.equal(html, placeholderCard(module, item),
    'the card is exactly what it renders with no client at all: the placeholder')
  assert.equal(rpc.calls.length, 0, 'nothing is asked of the backend')
})

// The year is published on the claim precisely because a consumer cannot look
// it up. Carrying it across the network and then not drawing it wastes the
// only chance a viewer has to see it.
test('a home card shows the year the publisher claimed', async () => {
  const html = await renderHome([{
    entityId: 'entity-year',
    entityKind: 'work',
    title: 'Dated Work',
    releaseYear: 2005,
  }])

  assert.ok(html.includes('2005'), 'the claimed year reaches the rendered card')
})

test('a claimed year and a publisher subtitle share the caption', async () => {
  const html = await renderHome([{
    entityId: 'entity-year-subtitle',
    entityKind: 'work',
    title: 'Dated Work',
    subtitle: 'Some Publisher',
    releaseYear: 1999,
  }])

  assert.ok(html.includes('1999'), 'the year is shown')
  assert.ok(html.includes('Some Publisher'), 'the publisher subtitle is not dropped for it')
})

test('a card with no claimed year still renders its subtitle alone', async () => {
  const html = await renderHome([{
    entityId: 'entity-no-year',
    entityKind: 'work',
    title: 'Undated Work',
    subtitle: 'Some Publisher',
  }])

  assert.ok(html.includes('Some Publisher'), 'the subtitle survives on its own')
  assert.ok(!html.includes('·'), 'no separator is drawn with nothing to separate')
})
