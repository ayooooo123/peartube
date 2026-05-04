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
    /router\.push\(\{\s*pathname: '\/video\/\[id\]'[\s\S]*?channel: channelKey[\s\S]*?videoData: JSON\.stringify/s,
    'native channel videos should open /video/[id] with channel and videoData params',
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
  const webHome = read('app/(tabs)/index.web.tsx')
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

  assert.match(webHome, /encodeURIComponent\(channelKey\)/, 'web watch-page channel navigation should encode channel keys')
  assert.match(webHome, /encodeURIComponent\(viewingChannel\)/, 'web channel modal navigation should encode channel keys')
  assert.match(webHome, /encodeURIComponent\(video\.channelKey\)/, 'web feed channel navigation should encode channel keys')
  assert.match(webHome, /encodeURIComponent\(identity\.driveKey!\)/, 'web own-channel navigation should encode channel keys')
  assert.match(webChannel, /encodeURIComponent\(resolvedChannelKey\)/, 'web channel video navigation should encode channel keys')
})

test('web hash route parsing decodes watch and channel params safely', () => {
  const webHome = read('app/(tabs)/index.web.tsx')
  const webChannel = read('app/channel/[key].web.tsx')

  assert.match(webHome, /function safeDecodeURIComponent/, 'web home hash parser should use safe decoding')
  assert.match(webHome, /channelKey: safeDecodeURIComponent\(parts\[1\]\)/, 'watch route channel key should be decoded')
  assert.match(webHome, /videoId: safeDecodeURIComponent\(parts\[2\]\)/, 'watch route video id should be decoded')
  assert.match(webChannel, /function safeDecodeURIComponent/, 'web channel page hash parser should use safe decoding')
})

test('channel view preserves publicBeeKey across native and web navigation/data fetches', () => {
  const nativeHome = read('app/(tabs)/index.tsx')
  const subscriptions = read('app/(tabs)/subscriptions.tsx')
  const nativeVideo = read('app/video/[id].tsx')
  const nativeChannel = read('app/channel/[key].tsx')
  const webHome = read('app/(tabs)/index.web.tsx')
  const webChannel = read('app/channel/[key].web.tsx')

  assert.match(
    nativeHome,
    /router\.push\(\{ pathname: '\/channel\/\[key\]', params: \{ key: video\.channelKey, publicBeeKey: video\.publicBeeKey \|\| undefined \} \}\)/,
    'native feed channel navigation should include publicBeeKey for remote channel reads',
  )
  assert.match(
    subscriptions,
    /router\.push\(\{ pathname: '\/channel\/\[key\]', params: \{ key: item\.channelKey, publicBeeKey: item\.publicBeeKey \|\| undefined \} \}\)/,
    'subscription channel navigation should include publicBeeKey for remote channel reads',
  )
  assert.match(
    nativeVideo,
    /router\.push\(\{ pathname: '\/channel\/\[key\]', params: \{ key: videoData\.channelKey, publicBeeKey: videoData\.publicBeeKey \|\| undefined \} \}\)/,
    'native video channel navigation should preserve publicBeeKey',
  )
  assert.match(nativeChannel, /const channelPublicBeeKey = useMemo/, 'native channel view should resolve publicBeeKey route params')
  assert.match(nativeChannel, /rpc\.getChannelMeta\(\{ channelKey, publicBeeKey: channelPublicBeeKey \|\| undefined \}\)/, 'native channel metadata should pass publicBeeKey')
  assert.match(nativeChannel, /rpc\.listVideos\(\{ channelKey, publicBeeKey: channelPublicBeeKey \|\| undefined \}\)/, 'native channel video list should pass publicBeeKey')
  assert.match(nativeChannel, /publicBeeKey: channelPublicBeeKey \|\| undefined/, 'native channel video navigation should preserve publicBeeKey')

  assert.match(webHome, /#\/channel\/\$\{encodeURIComponent\(channelKey\)\}\?publicBeeKey=\$\{encodeURIComponent\(publicBeeKey\)\}/, 'web watch channel navigation should include publicBeeKey in hash query')
  assert.match(webHome, /#\/channel\/\$\{encodeURIComponent\(video\.channelKey\)\}\?publicBeeKey=\$\{encodeURIComponent\(video\.publicBeeKey\)\}/, 'web feed channel navigation should include publicBeeKey in hash query')
  assert.match(webChannel, /publicBeeKey: safeDecodeURIComponent\(params\.get\('publicBeeKey'\) \|\| ''\)/, 'web channel hash parser should decode publicBeeKey')
  assert.match(webChannel, /rpc\.getChannelMeta\(\{ channelKey: resolvedChannelKey, publicBeeKey: resolvedPublicBeeKey \|\| undefined \}\)/, 'web channel metadata should pass publicBeeKey')
  assert.match(webChannel, /rpc\.listVideos\(\{ channelKey: resolvedChannelKey, publicBeeKey: resolvedPublicBeeKey \|\| undefined \}\)/, 'web channel video list should pass publicBeeKey')
})
