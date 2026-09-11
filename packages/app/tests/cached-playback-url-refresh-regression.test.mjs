import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { build } from 'esbuild'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadPlaybackHelpers() {
  const source = fs.readFileSync(path.join(appRoot, 'app/video/[id].tsx'), 'utf8')
  const slice = (startMarker, endMarker) => {
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start)
    assert.ok(start >= 0 && end > start, `production boundary ${startMarker}`)
    return source.slice(start, end)
  }
  const result = await build({
    stdin: {
      contents: [
        "import { makeVideoUrlCacheKey, setCachedVideoUrl, getCachedVideoUrl } from './lib/video-url-cache'",
        slice('function isStatsComplete', '// P2P Stats Overlay Component'),
        slice('function getVideoRef', 'function isCurrentVideoActive'),
        'export function createWatchLoader(dependencies) {',
        'const { videoData, rpc, loadGenerationRef, mountedRef, clearStatsPolling, setLocalStats, setIsLoading, loadAndPlayVideo, scheduleStatsPolling } = dependencies',
        'const Platform = { OS: "android" }; const isPear = false; const useCallback = callback => callback',
        slice('const loadVideo = useCallback', '// Load video when videoData is available'),
        'return loadVideo',
        '}',
        'export { makePlaybackCacheKey, getCachedVideoUrl, setCachedVideoUrl }',
      ].join('\n'),
      resolveDir: appRoot,
      sourcefile: 'watch-playback-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.watch-playback-'))
  const output = path.join(directory, 'helpers.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const VIDEO = {
  id: 'episode-1',
  path: '/videos/episode-1.mp4',
  channelKey: 'channel-key',
  publicBeeKey: 'public-bee-key',
  blobId: 'blob-id',
  blobsCoreKey: 'blobs-core-key',
  mimeType: 'video/mp4',
}

test('watch playback waits for backend preparation before replacing a stale cached URL', async () => {
  const { createWatchLoader, makePlaybackCacheKey, getCachedVideoUrl, setCachedVideoUrl } = await loadPlaybackHelpers()
  const cacheKey = makePlaybackCacheKey(VIDEO, VIDEO.path)
  setCachedVideoUrl(cacheKey, 'stale-cached-url')
  let resolvePreparation
  const preparation = new Promise(resolve => { resolvePreparation = resolve })
  const opened = []
  const load = createWatchLoader({
    videoData: VIDEO,
    rpc: { preparePlayback: () => preparation },
    loadGenerationRef: { current: 0 },
    mountedRef: { current: true },
    clearStatsPolling() {},
    setLocalStats() {},
    setIsLoading() {},
    loadAndPlayVideo: (video, url) => opened.push({ video, url }),
    scheduleStatsPolling() {},
  })
  const pending = load()
  assert.deepEqual(opened, [], 'a cached URL cannot bypass backend preparation')
  assert.equal(getCachedVideoUrl(cacheKey), 'stale-cached-url')
  resolvePreparation({ url: 'prepared-url', stats: { status: 'complete' } })
  await pending
  assert.deepEqual(opened, [{ video: VIDEO, url: 'prepared-url' }])
  assert.equal(getCachedVideoUrl(cacheKey), 'prepared-url')
})

test('a changed direct reference receives a distinct playback cache identity', async () => {
  const { makePlaybackCacheKey } = await loadPlaybackHelpers()
  const original = makePlaybackCacheKey(VIDEO, '/videos/episode-1.mp4')
  const changed = makePlaybackCacheKey({ ...VIDEO, blobsCoreKey: 'new-core-key' }, '/videos/episode-1.mp4')

  assert.notEqual(original, changed)
})
