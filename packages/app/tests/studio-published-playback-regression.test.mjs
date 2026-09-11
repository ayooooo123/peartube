import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')

async function loadPublishedPlaybackHelpers() {
  const source = fs.readFileSync(path.join(appRoot, 'app/(tabs)/studio.tsx'), 'utf8')
  const start = source.indexOf('function resolvePublishedVideoRef')
  const end = source.indexOf('async function shareStudioChannelInvite', start)
  assert.ok(start >= 0 && end > start, 'production published playback boundary')
  const result = await build({
    stdin: {
      contents: [
        "import { makeVideoUrlCacheKey, getCachedVideoUrl, setCachedVideoUrl } from './lib/video-url-cache'",
        'const Alert = { alert: (...args) => { throw new Error(args.join(": ")) } }',
        source.slice(start, end),
        'export { resolvePublishedVideoRef, buildPublishedPlaybackRequest, playPublishedStudioVideo, makeVideoUrlCacheKey, getCachedVideoUrl, setCachedVideoUrl }',
      ].join('\n'),
      resolveDir: appRoot,
      sourcefile: 'studio-playback-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(appRoot, '.studio-playback-'))
  const output = path.join(directory, 'helpers.cjs')
  fs.writeFileSync(output, result.outputFiles[0].text)
  try {
    return await import(`${pathToFileURL(output).href}?${Math.random()}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('Studio published playback awaits preparation and opens only the returned URL', async () => {
  const {
    resolvePublishedVideoRef,
    buildPublishedPlaybackRequest,
    playPublishedStudioVideo,
    makeVideoUrlCacheKey,
    getCachedVideoUrl,
    setCachedVideoUrl,
  } = await loadPublishedPlaybackHelpers()
  const item = {
    id: 'published-video',
    path: '/videos/published-video.mp4',
    channelKey: 'channel-key',
    publicBeeKey: 'public-bee-key',
    blobId: 'blob-id',
    blobsCoreKey: 'blobs-core-key',
    mimeType: 'video/mp4',
  }
  const videoRef = resolvePublishedVideoRef(item)
  const cacheKey = makeVideoUrlCacheKey(item.channelKey, videoRef, item.blobId, item.blobsCoreKey)
  setCachedVideoUrl(cacheKey, 'stale-cached-url')
  const prepared = 'prepared-url'
  const prepareCalls = []
  const opened = []
  let resolvePreparation
  const preparation = new Promise(resolve => { resolvePreparation = resolve })

  const pending = playPublishedStudioVideo({
    item,
    identityDriveKey: 'identity-channel',
    rpc: {
      preparePlayback: async request => {
        prepareCalls.push(request)
        return await preparation
      },
    },
    loadAndPlayVideo: (video, url) => opened.push({ video, url }),
  })
  assert.deepEqual(opened, [], 'the stale cached URL must not open while preparation is pending')
  resolvePreparation({ url: prepared })
  await pending

  assert.deepEqual(prepareCalls, [buildPublishedPlaybackRequest(item, item.channelKey, videoRef)])
  assert.deepEqual(opened, [{ video: item, url: prepared }])
  assert.equal(getCachedVideoUrl(cacheKey), prepared, 'only the prepared URL may refresh the cache')
})
