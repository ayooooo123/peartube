import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const appRoot = path.resolve(import.meta.dirname, '..')
const NOW = Date.now()

// The detail screen pulls in an icon set, safe-area natives, and the router,
// none of which exist off-device. The server render cares about copy, roles,
// and states, so those are stubbed rather than bundled. The screen takes its
// route id and item as props here, so the router stub returns empty params.
const STUBS = {
  'expo-vector-icons': 'export const Ionicons = () => null\nexport default { Ionicons }\n',
  'safe-area': 'export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 })\n',
  'expo-router': 'export const useLocalSearchParams = () => ({})\nexport const useRouter = () => ({ back() {}, push() {} })\n',
}

const stubNativeOnlyDeps = {
  name: 'stub-native-only-deps',
  setup(builder) {
    builder.onResolve({ filter: /^@expo\/vector-icons/ }, () => ({ path: 'expo-vector-icons', namespace: 'stub' }))
    builder.onResolve({ filter: /^react-native-safe-area-context$/ }, () => ({ path: 'safe-area', namespace: 'stub' }))
    builder.onResolve({ filter: /^expo-router$/ }, () => ({ path: 'expo-router', namespace: 'stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
      contents: STUBS[args.path],
      loader: 'js',
      resolveDir: appRoot,
    }))
  },
}

async function loadDetailScreen() {
  const result = await build({
    entryPoints: [path.join(appRoot, 'components/media/MediaEntityDetailScreen.tsx')],
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
  const directory = fs.mkdtempSync(path.join(appRoot, '.media-detail-'))
  const output = path.join(directory, 'detail.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function availability(state, overrides = {}) {
  return {
    state,
    observedAt: NOW,
    expiresAt: NOW + 60_000,
    requiredRangeCount: 1,
    reachableRangeCount: state === 'healthy' || state === 'limited' ? 1 : 0,
    independentPeerCount: state === 'healthy' ? 2 : 0,
    completePeerCount: state === 'healthy' ? 2 : 0,
    offlinePlayable: false,
    archivePledged: false,
    reasonCodes: [],
    ...overrides,
  }
}

function item(overrides = {}) {
  return {
    entityId: 'work:movie-1',
    localEntityId: 'work:movie-1',
    title: 'The Heist',
    subtitle: 'Director A',
    synopsis: 'A crew assembles for one last job.',
    availability: availability('healthy'),
    sources: [
      { publicationId: 'pub-a', publisherId: 'publisher-aaaaaaaa', renditionId: 'rendition-a', selected: true, eligible: true },
      { publicationId: 'pub-b', publisherId: 'publisher-bbbbbbbb', renditionId: 'rendition-b', eligible: true },
    ],
    claimCount: 7,
    ...overrides,
  }
}

function render(screen, props = {}) {
  return renderToStaticMarkup(React.createElement(screen.MediaEntityDetailScreen, {
    type: 'media',
    routeId: 'work:movie-1',
    itemParam: screen.encodeMediaEntityRouteParam(item(props.item || {})),
    ...props,
  }))
}

let screen
test('load the detail screen once', async () => {
  screen = await loadDetailScreen()
  assert.ok(screen.MediaEntityDetailScreen)
})

test('the detail screen leads with title, synopsis, availability, and one Play action', () => {
  const html = render(screen)

  assert.match(html, /The Heist/)
  assert.match(html, /Director A/)
  assert.match(html, /A crew assembles for one last job\./)
  assert.match(html, /Available now/, 'the assessed availability leads')
  assert.match(html, />Play</, 'exactly one primary action')
  assert.doesNotMatch(html, />Resume</, 'nothing to resume yet')
})

test('a partly watched title offers Resume instead of Play', () => {
  const html = render(screen, { resumeFraction: 0.4 })

  assert.match(html, />Resume</)
  assert.doesNotMatch(html, />Play</)
})

test('operational detail is hidden until a viewer opens it', () => {
  const html = render(screen)

  assert.match(html, /Details and other sources/, 'the disclosure exists')
  assert.doesNotMatch(html, /publisher-aaaaaaaa/, 'publisher ids stay behind the disclosure')
  assert.doesNotMatch(html, /publisher-bbbbbbbb/)
  assert.doesNotMatch(html, /7 verified claims|claimCount/, 'claim counts are not consumer copy')
  assert.doesNotMatch(html, /Archive:/, 'archive mechanics are not consumer copy')
})

test('the disclosure advertises how many sources are behind it', () => {
  const html = render(screen)
  assert.match(html, /Details and other sources \(2\)/)
})

test('an unavailable title disables Play and explains why', () => {
  const html = render(screen, { item: { availability: availability('unavailable') } })

  assert.match(html, /Unavailable/)
  assert.match(html, /No peer currently serves the required ranges/, 'the reason is stated plainly')
  assert.doesNotMatch(html, /soon|shortly|check back/i, 'no promise the title returns')
})

test('an awaiting-replication title is honest rather than hopeful', () => {
  const html = render(screen, { item: { availability: availability('awaiting-replication') } })

  assert.match(html, /Awaiting replication/)
  assert.match(html, /No peer has been checked/)
})

test('a title with no artwork or synopsis still renders its actions', () => {
  const html = render(screen, { item: { synopsis: null, posterUrl: null, thumbnailUrl: null } })

  assert.match(html, /The Heist/)
  assert.match(html, />Play</)
})

test('the Play action carries an accessible label and disabled state', () => {
  const playable = render(screen)
  assert.match(playable, /aria-label="Play The Heist"/)

  const blocked = render(screen, { item: { availability: availability('unavailable') } })
  assert.match(blocked, /aria-label="Play The Heist"/)
  assert.match(blocked, /disabled/, 'an unplayable title cannot be pressed')
})

// Runtime, year and genres are published on the claim because a consumer has
// no way to look them up. The detail page is where a viewer expects them.
test('the detail hero states what the publisher claimed about the title', () => {
  const html = render(screen, {
    item: { releaseYear: 2005, runtimeMinutes: 119, genres: ['Comedy', 'Romance'] },
  })

  assert.ok(html.includes('2005'), 'the claimed year is shown')
  assert.ok(html.includes('1h 59m'), 'runtime is shown as a viewer reads it, not raw minutes')
  assert.ok(html.includes('Comedy'), 'claimed genres are shown')
})

test('the detail hero omits facts the publisher never claimed', () => {
  const html = render(screen, { item: {} })

  assert.ok(!html.includes('NaN'), 'a missing runtime is absent, not malformed')
  assert.ok(!html.includes('undefined'), 'nothing renders a placeholder for an unclaimed fact')
})
