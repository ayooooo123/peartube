import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { projectSearchResults } from '../lib/home-rails.js'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const appRoot = path.resolve(import.meta.dirname, '..')

async function loadCards() {
  const stubs = {
    'reanimated-stub': [
      'export const useSharedValue = value => ({ value })',
      'export const useAnimatedStyle = () => ({})',
      'export const withSpring = value => value',
      'export const withTiming = value => value',
      'const Animated = { createAnimatedComponent: component => component }',
      'export default Animated',
      '',
    ].join('\n'),
    'thumbnail-stub': [
      "import React from 'react'",
      'export const ThumbnailImage = props => React.createElement("img", { src: props.thumbnailUrl || "", alt: props.channelInitial || "" })',
      '',
    ].join('\n'),
  }
  const plugin = {
    name: 'stub-creator-card-native-deps',
    setup(builder) {
      builder.onResolve({ filter: /^react-native-reanimated/ }, () => ({ path: 'reanimated-stub', namespace: 'creator-stub' }))
      builder.onResolve({ filter: /\/ThumbnailImage$/ }, () => ({ path: 'thumbnail-stub', namespace: 'creator-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'creator-stub' }, args => ({
        contents: stubs[args.path],
        loader: 'js',
      }))
    },
  }
  const result = await build({
    stdin: {
      contents: [
        "export { VideoCard as NativeVideoCard } from './components/video/VideoCard.tsx'",
        "export { VideoCard as WebVideoCard } from './components/video/VideoCard.web.tsx'",
        '',
      ].join('\n'),
      resolveDir: appRoot,
      sourcefile: 'creator-card-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom'],
    alias: { 'react-native': 'react-native-web' },
    plugins: [plugin],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', baseUrl: appRoot, paths: { '@/*': ['./*'] } } },
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.creator-card-'))
  const output = path.join(directory, 'cards.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('VideoCard surfaces archived creator attribution before generic channel labels', async () => {
  const { NativeVideoCard, WebVideoCard } = await loadCards()
  const creatorVideo = {
    id: 'video-1',
    title: 'Published title',
    creatorName: 'Archived creator',
    channelKey: 'ab'.repeat(32),
    channel: { name: 'Publisher channel' },
  }
  const nativeHtml = renderToStaticMarkup(React.createElement(NativeVideoCard, {
    video: creatorVideo,
    onPress() {},
    onChannelPress() {},
  }))
  const webHtml = renderToStaticMarkup(React.createElement(WebVideoCard, {
    video: creatorVideo,
    onPress() {},
    onChannelPress() {},
  }))

  assert.ok(nativeHtml.includes('Archived creator'), 'native card should render the creator name')
  assert.ok(webHtml.includes('Archived creator'), 'web card wrapper should render the creator name')

  const fallbackHtml = renderToStaticMarkup(React.createElement(NativeVideoCard, {
    video: { ...creatorVideo, creatorName: null },
    onPress() {},
  }))
  assert.ok(fallbackHtml.includes('Publisher channel'), 'missing creator attribution should fall back to channel name')
})

test('projected search results preserve publisher-backed media summaries', () => {
  const results = projectSearchResults({
    items: [{
      entityId: 'work-1',
      entityKind: 'work',
      title: 'Projected title',
      subtitle: 'Archived creator',
      sources: [{ publicationId: 'publication-1', publisherId: 'publisher-1' }],
      availability: { state: 'healthy', independentPeerCount: 1 },
    }],
    query: 'projected',
    now: Date.now(),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].sources[0].publisherId, 'publisher-1')
  assert.equal(results[0].sourceCount, 1)
})
