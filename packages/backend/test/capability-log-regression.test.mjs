import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const capabilityBearingSources = [
  'packages/app/app/search.tsx',
  'packages/app/backend/channel-stream-reader.mjs',
  'packages/app/backend/downloader-worker.mjs',
  'packages/app/backend/mobile-cast.mjs',
  'packages/app/backend/streaming-http-reader.mjs',
  'packages/app/backend/temp-file-reader.mjs',
  'packages/app/components/video-player/WebMseVideoBackend.web.tsx',
  'packages/app/components/video/VideoCard.web.tsx',
  'packages/app/lib/DownloadsContext.tsx',
  'packages/app/lib/VideoPlayerContext.tsx',
  'packages/app/workers/desktop/index.ts',
  'packages/backend/src/api.js',
  'packages/backend/src/storage.js',
  'packages/backend/src/transcode/temp-file-reader.mjs',
]

const rawCapabilityLog = /console\.(?:log|warn|error)\([^\n]*(?:url\.substring|url\.slice|\bblobUrl\b|\bcurrentUrl\b|\bproxyUrl\b|result\.url|URL:[^\n]*\burl\b|URL:[^\n]*\bhlsUrl\b|getVideoUrl result:[^\n]*\bresult\b)/
const rawSearchObjectLog = /console\.(?:log|warn|error)\([^\n]*(?:Searching for:[^\n]*\bquery\b|Got response:[^\n]*\bres\b|Raw results:|Processing result[^\n]*\br\b|metadata[^\n]*value:[^\n]*r\.metadata|Parsed metadata:[^\n]*\bmetadata\b|Failed to parse result:[^\n]*\br\b|Final videos array:[^\n]*\bvideos\b|handleVideoPress called with:[^\n]*\bvideo\b|missing channelKey:[^\n]*\bvideo\b)/

test('runtime diagnostics never print raw capability-bearing URLs', () => {
  for (const relativePath of capabilityBearingSources) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
    const unsafeLines = source
      .split(/\r?\n/)
      .filter((line) => rawCapabilityLog.test(line) && !line.includes('redactCapabilityUrl('))
    assert.deepEqual(unsafeLines, [], `${relativePath} logs a raw capability-bearing URL`)
  }

  const searchSource = fs.readFileSync(path.join(repoRoot, 'packages/app/app/search.tsx'), 'utf8')
  const unsafeSearchLines = searchSource.split(/\r?\n/).filter((line) => rawSearchObjectLog.test(line))
  assert.deepEqual(unsafeSearchLines, [], 'Search diagnostics dump user queries or media capability objects')
})

