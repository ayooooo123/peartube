import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('desktop channel page filters remote unavailable videos before rendering', () => {
  const source = readAppFile('app/channel/[key].web.tsx')

  assert.match(
    source,
    /import \{ shouldRenderFeedVideo \} from '@\/lib\/feed-hydration'/,
    'desktop channel page should use the shared availability gate',
  )

  assert.match(
    source,
    /const filteredVideos = \(Array\.isArray\(videosResult\?\.videos\) \? videosResult\.videos : \[\]\)\.filter\(\(video\) => shouldRenderFeedVideo\(/,
    'desktop channel page should filter unwatchable remote videos before storing them in state',
  )
})

test('desktop channel modal filters remote unavailable videos before watch routing', () => {
  const source = readAppFile('app/(tabs)/index.web.tsx')

  assert.match(
    source,
    /const videosWithChannel = videoList\.map\([\s\S]*?const watchableChannelVideos = videosWithChannel\.filter\(\(video: any\) => shouldRenderFeedVideo\(/,
    'desktop channel modal should filter raw listVideos results before setting channelVideos',
  )

  assert.match(
    source,
    /setChannelVideos\(watchableChannelVideos\)/,
    'desktop channel modal should only store watchable channel videos',
  )
})

test('desktop direct watch lookup rejects unwatchable videos from listVideos', () => {
  const source = readAppFile('app/(tabs)/index.web.tsx')

  assert.match(
    source,
    /const found = videoList\.find\(\(v: any\) => v\.id === videoId && shouldRenderFeedVideo\(/,
    'desktop watch deep-link resolution should refuse unavailable remote videos',
  )
})
