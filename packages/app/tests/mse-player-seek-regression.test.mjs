import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const mseBackendPath = new URL('../components/video-player/WebMseVideoBackend.web.tsx', import.meta.url)
const inlineViewPath = new URL('../components/video-player/PearInlineVideoView.tsx', import.meta.url)
const desktopWatchPath = new URL('../app/(tabs)/index.web.tsx', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
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

test('MSE backend follows the parent playback state instead of forcing playback after fallback', async () => {
  const src = await source(mseBackendPath)

  assert.match(src, /const isPlayingRef = useRef\(isPlaying\)/, 'MSE backend should retain the latest desired playback state')
  assert.match(
    src,
    /useEffect\(\(\) => \{[\s\S]*const controller = mseBackendControllerRef\.current[\s\S]*if \(isPlaying\)[\s\S]*requestDesiredPlayback\(\)[\s\S]*else[\s\S]*controller\.pause\(\)/,
    'MSE backend should react to parent play/pause state changes'
  )
  assert.match(
    src,
    /if \(isPlayingRef\.current\) \{[\s\S]*requestDesiredPlayback\(\)[\s\S]*\}/,
    'MSE pipeline should only auto-start when the parent still wants playback'
  )
  assert.doesNotMatch(src, /\sautoPlay\s*[\r\n>]/, 'MSE backend video element should not bypass parent playback state with autoPlay')
})

test('MSE backend retries desired autoplay when the first play call is dropped', async () => {
  const src = await source(mseBackendPath)

  assert.match(
    src,
    /const requestDesiredPlayback = useCallback\(/,
    'MSE backend should centralize desired playback requests so rejected early play() calls can be retried',
  )
  assert.match(
    src,
    /mseAutoplayRetryTimerRef/,
    'MSE backend should keep a retry timer for startup play() calls that race MediaSource readiness',
  )
  assert.match(
    src,
    /catch\(\(\) => \{[\s\S]*scheduleMseAutoplayRetry/,
    'a rejected play() promise should schedule a retry while playback is still desired',
  )
  assert.match(
    src,
    /if \(isPlayingRef\.current\) \{[\s\S]*requestDesiredPlayback\(\)[\s\S]*\}/,
    'newly appended MSE data should reassert playback intent without requiring a pause/play toggle',
  )
  assert.match(
    src,
    /requestAutoplay: requestDesiredPlayback/,
    'compat HLS fallback should use the same retrying autoplay request path',
  )
})

test('format errors skip stall recovery so the desktop MSE fallback still triggers promptly', async () => {
  const src = await source(inlineViewPath)
  assert.match(src, /isUnrecoverableSourceError/, 'unrecoverable source errors must be detected')
  assert.match(
    src,
    /!isUnrecoverableSourceError\(error\) && tryRecoverFromPlaybackError\(\)/,
    'recovery must be skipped for format errors (code 4) so the watch page can fall back to the MSE backend immediately'
  )
})

test('desktop watch page sends MSE through PearInlineVideoView instead of rendering a second player branch', async () => {
  const src = await source(desktopWatchPath)
  const pearStart = src.indexOf('<PearInlineVideoView')
  assert.notEqual(pearStart, -1, 'watch page should render PearInlineVideoView for active video playback')
  const pearEnd = src.indexOf('/>', pearStart)
  assert.notEqual(pearEnd, -1, 'watch page PearInlineVideoView props should be inspectable')
  const pearBlock = src.slice(pearStart, pearEnd)

  assert.doesNotMatch(src, /import \{ MseVideoPlayer \}/, 'watch page should not import a separate MSE player')
  assert.doesNotMatch(src, /<MseVideoPlayer\b/, 'watch page should not render a separate MSE player branch')
  assert.match(pearBlock, /webPlaybackBackend=\{useMseBackend \? 'mse' : 'native'\}/, 'MSE must be selected as a PearInlineVideoView backend')
  assert.match(pearBlock, /requestCompatPlayback=\{requestCompatPlayback\}/, 'compat playback requests should stay wired through the inline player')
})

test('desktop watch page switches to the MSE backend only after native unsupported-source errors', async () => {
  const src = await source(desktopWatchPath)
  const mseSwitches = src.match(/setMseBackendWatchKey\(watchPageKey\)/g) || []

  assert.equal(mseSwitches.length, 1, 'watch page should switch to MSE only from the unsupported-source error path')
  assert.match(
    src,
    /if \(!useMseBackend && code == 4\) \{[\s\S]*Native player failed \(code 4\), switching to MSE backend[\s\S]*setMseBackendWatchKey\(watchPageKey\)/,
    'native MEDIA_ERR_SRC_NOT_SUPPORTED/code 4 errors should switch to the MSE backend',
  )
})

test('desktop watch page does not use timeout watchdogs to select MSE for generic native stalls', async () => {
  const src = await source(desktopWatchPath)

  assert.doesNotMatch(src, /INLINE_PLAYER_LOAD_FALLBACK_MS/, 'metadata load timeouts should not select the MSE backend')
  assert.doesNotMatch(src, /INLINE_PLAYER_STALL_FALLBACK_MS/, 'startup stall timeouts should not select the MSE backend')
  assert.doesNotMatch(src, /inlinePlayerLoadedAt|setInlinePlayerLoadedAt/, 'metadata load watchdog state should not exist')
  assert.doesNotMatch(src, /inlinePlayerStartedAt|setInlinePlayerStartedAt/, 'startup stall watchdog state should not exist')
  assert.doesNotMatch(src, /Inline player did not load metadata[\s\S]*setMseBackendWatchKey/, 'metadata timeout should not switch to MSE')
  assert.doesNotMatch(src, /Inline player stalled[\s\S]*setMseBackendWatchKey/, 'generic startup stall should not switch to MSE')
})
