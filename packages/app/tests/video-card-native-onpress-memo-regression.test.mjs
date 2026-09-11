import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadVideoCard() {
  const stubs = {
    'reanimated-stub': [
      'export const useSharedValue = value => ({ value })',
      'export const useAnimatedStyle = fn => fn()',
      'export const withSpring = value => value',
      'export const withTiming = value => value',
      'const Animated = { createAnimatedComponent: component => component }',
      'export default Animated',
      '',
    ].join('\n'),
    'thumbnail-stub': [
      "import React from 'react'",
      'export const ThumbnailImage = () => React.createElement("img", null)',
      '',
    ].join('\n'),
  }
  const plugin = {
    name: 'stub-video-card-native-deps',
    setup(builder) {
      builder.onResolve({ filter: /^react-native-reanimated/ }, () => ({ path: 'reanimated-stub', namespace: 'video-card-stub' }))
      builder.onResolve({ filter: /\/ThumbnailImage$/ }, () => ({ path: 'thumbnail-stub', namespace: 'video-card-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'video-card-stub' }, args => ({
        contents: stubs[args.path],
        loader: 'js',
      }))
    },
  }
  const result = await build({
    stdin: {
      contents: "export { VideoCard } from './components/video/VideoCard.tsx'",
      resolveDir: appRoot,
      sourcefile: 'video-card-entry.ts',
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
  const directory = fs.mkdtempSync(path.join(appRoot, '.video-card-native-'))
  const output = path.join(directory, 'card.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('native VideoCard memo comparison treats onPress and creator changes as render-relevant', async () => {
  const { VideoCard } = await loadVideoCard()
  const onPress = () => {}
  const onChannelPress = () => {}
  const base = {
    video: {
      id: 'video-1',
      title: 'Video',
      creatorName: 'Creator',
      channel: { name: 'Channel' },
    },
    onPress,
    onChannelPress,
    showChannelInfo: true,
  }

  assert.equal(VideoCard.compare(base, { ...base }), true, 'unchanged public props should remain memo-equal')
  assert.equal(
    VideoCard.compare(base, { ...base, onPress: () => {} }),
    false,
    'the live comparator must invalidate a changed press handler',
  )
  assert.equal(
    VideoCard.compare(base, { ...base, video: { ...base.video, creatorName: 'Another creator' } }),
    false,
    'the live comparator must invalidate changed creator attribution',
  )
})
