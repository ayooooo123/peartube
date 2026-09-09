import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const appRoot = path.resolve(import.meta.dirname, '..')

// Icon glyphs and press springs are irrelevant to what this test renders.
// Stub the font-backed icon package and reanimated (which resolves its native
// module at import time) so esbuild can bundle the view for a server render.
const REANIMATED_STUB = [
  'import React from "react"',
  'export const useSharedValue = (value) => ({ value })',
  'export const useAnimatedStyle = () => ({})',
  'export const withTiming = (value) => value',
  'export const withSpring = (value) => value',
  'export const withRepeat = (value) => value',
  'export const cancelAnimation = () => {}',
  'export const interpolate = () => 0',
  'export const Extrapolation = { CLAMP: "clamp" }',
  'export const Easing = new Proxy({}, { get: () => () => null })',
  'const View = (props) => React.createElement("div", null, props.children)',
  'export default { View, Text: View, createAnimatedComponent: (c) => c }',
  '',
].join('\n')

const nativeStubs = {
  name: 'native-stubs',
  setup(context) {
    context.onResolve({ filter: /^@expo\/vector-icons$/ }, () => ({ path: 'vector-icons', namespace: 'test-stub' }))
    context.onResolve({ filter: /^react-native-reanimated/ }, () => ({ path: 'reanimated', namespace: 'test-stub' }))
    context.onLoad({ filter: /^vector-icons$/, namespace: 'test-stub' }, () => ({
      contents: "import React from 'react'; export const Ionicons = (props) => React.createElement('span', props); export const Feather = Ionicons;",
      loader: 'js',
      resolveDir: appRoot,
    }))
    context.onLoad({ filter: /^reanimated$/, namespace: 'test-stub' }, () => ({
      contents: REANIMATED_STUB,
      loader: 'js',
      resolveDir: appRoot,
    }))
  },
}

async function loadView(platform) {
  const result = await build({
    entryPoints: [path.join(appRoot, 'components/media/MediaCatalogView.tsx')],
    bundle: true,
    format: 'cjs',
    external: ['react', 'react-dom'],
    platform: 'node',
    resolveExtensions: platform === 'web'
      ? ['.web.tsx', '.web.ts', '.tsx', '.ts', '.web.jsx', '.web.js', '.jsx', '.js', '.json']
      : ['.tsx', '.ts', '.jsx', '.js', '.json'],
    alias: { 'react-native': 'react-native-web' },
    plugins: [nativeStubs],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, `.media-catalog-${platform}-`))
  const output = path.join(directory, 'view.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const item = {
  entityId: 'work:alpha',
  entityKind: 'work',
  title: 'Alpha',
  subtitle: 'Episode one',
  claimCount: 3,
  conflictCount: 1,
  availability: {
    state: 'healthy',
    renditionId: 'rendition:one',
    observedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    requiredRangeCount: 1,
    reachableRangeCount: 1,
    independentPeerCount: 2,
    completePeerCount: 2,
    offlinePlayable: false,
    archivePledged: true,
    reasonCodes: ['COMPLETE_PEER_EVIDENCE'],
  },
  sources: [{
    publicationId: 'pub:one',
    publisherId: 'publisher:trusted',
    manifestId: 'manifest:one',
    selected: true,
    archiveState: 'pledged',
    availabilityState: 'available',
  }],
  renditions: [{
    renditionId: 'rendition:one',
    purpose: 'primary',
    format: 'video/mp4',
    coreKey: 'a'.repeat(64),
    coreLength: 2,
    treeHash: 'b'.repeat(64),
    byteLength: 2048,
  }],
}

test('native and web media catalog views server-render source, archive, and trust summaries', async t => {
  for (const platform of ['native', 'web']) {
    await t.test(platform, async () => {
      const view = await loadView(platform)
      const html = renderToStaticMarkup(React.createElement(view.MediaCatalogView, {
        title: 'Discover media',
        state: { status: 'ready', items: [item], refreshing: false, loadingMore: false, nextCursor: 'next' },
        diagnostic: null,
        onRefresh() {},
        onLoadNext() {},
        onEntityPress() {},
      }))
      assert.match(html, /Alpha/)
      assert.match(html, /publisher:trusted/)
      assert.match(html, /Archive[\s\S]{0,400}?pledged/, 'the card labels the archive state')
      assert.match(html, /Available now/, 'the card quotes the assessed availability state')
      assert.doesNotMatch(html, /awaiting-replication|healthy<|limited</, 'raw state ids never reach the card')
      assert.match(html, /3 verified claims/)
      assert.match(html, /1 conflict/)
      assert.match(html, /Load more/)
    })
  }
})

test('media catalog view renders structured empty and error diagnostics', async () => {
  const view = await loadView('native')
  for (const diagnostic of [
    { kind: 'empty', title: 'No media is available yet', detail: 'Joining trusted catalogs', actionLabel: 'Refresh catalog' },
    { kind: 'error', title: 'Media catalog unavailable', detail: 'Replay failed', errorCode: 'REPLAY_FAILED', actionLabel: 'Try again' },
  ]) {
    const html = renderToStaticMarkup(React.createElement(view.MediaCatalogView, {
      state: { status: diagnostic.kind === 'error' ? 'error' : 'ready', items: [], refreshing: false, loadingMore: false },
      diagnostic,
      onRefresh() {},
      onLoadNext() {},
      onEntityPress() {},
    }))
    assert.match(html, new RegExp(diagnostic.title))
    assert.match(html, new RegExp(diagnostic.detail))
    if (diagnostic.errorCode) assert.match(html, /REPLAY_FAILED/)
  }
})
