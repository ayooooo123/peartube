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

test('VideoPlayerOverlay source keeps the PiP cleanup and modal tail after auto-PiP setup', () => {
  const source = readAppFile('components/VideoPlayerOverlayImpl.tsx')

  assert.match(
    source,
    /} else if \(Platform\.OS === 'ios'\) {\s+setIosPipEnabled\(shouldAutoPip\)\s+}\s+}, \[playerMode, currentVideo, isCasting, isPlaying, pipSupported, isInPipMode, disableMiniLayoutOnAndroidSplit, androidSplitPlayerEnabled\]\)/,
    'auto-PiP effect should complete with the iOS branch and dependency list',
  )
  assert.match(
    source,
    /<PearInlineVideoView[\s\S]*onVideoStateChange=\{onVideoStateChange\}/,
    'native inline video host should still be rendered in the restored overlay body',
  )
  assert.match(
    source,
    /<DevicePickerModal[\s\S]*onRefresh=\{cast\.startDiscovery\}/,
    'overlay should still render the cast device picker modal at the end of the component',
  )
})
