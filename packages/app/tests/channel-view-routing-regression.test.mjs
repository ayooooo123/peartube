import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
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

test('channel route navigation encodes dynamic keys before path/hash concatenation', () => {
  const nativeHome = read('app/(tabs)/index.tsx')
  const subscriptions = read('app/(tabs)/subscriptions.tsx')
  const nativeVideo = read('app/video/[id].tsx')
  const webChannel = read('app/channel/[key].web.tsx')

  for (const [label, source] of [
    ['native home', nativeHome],
    ['subscriptions', subscriptions],
    ['native video', nativeVideo],
  ]) {
    assert.doesNotMatch(
      source,
      /router\.push\('\/channel\/' \+ [^)]+\)/,
      `${label} should not concatenate raw channel keys into Expo Router paths`,
    )
  }

  assert.match(webChannel, /encodeURIComponent\(resolvedChannelKey\)/, 'web channel video navigation should encode channel keys')
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
