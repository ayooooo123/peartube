import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')

test('native desktop release packages the runnable .app instead of the xcarchive container', () => {
  const workflowPath = path.join(repoRoot, '.github', 'workflows', 'release-desktop.yml')
  const source = fs.readFileSync(workflowPath, 'utf8')

  assert.match(source, /PearTubeDesktop\.xcarchive\/Products\/Applications\/PearTubeDesktop\.app/)
  assert.match(source, /--keepParent\s+\\\s*\n\s*build\/PearTubeDesktop\.app\s+\\\s*\n\s*build\/PearTube-native-desktop-/)
  assert.doesNotMatch(source, /--keepParent\s+\\\s*\n\s*build\/PearTubeDesktop\.xcarchive\s+\\\s*\n\s*build\/PearTube-native-desktop-/)
})

test('native desktop AVPlayer URL preparation waits for backend playback readiness before returning', () => {
  const source = fs.readFileSync(path.join(packageRoot, 'Sources', 'Services', 'HostBridgeService.swift'), 'utf8')
  const match = source.match(/func prepareAVPlayerURL\(for video: NativeVideo\) async -> URL\? \{([\s\S]*?)\n  \}/)

  assert.ok(match, 'prepareAVPlayerURL function should exist')
  const body = match[1]
  assert.match(body, /startPlaybackStatsPolling\(for: video\)/)
  assert.match(body, /await waitForAVPlayerReadiness\(for: video\)/)
  assert.match(body, /return url/)
  assert.ok(
    body.indexOf('await waitForAVPlayerReadiness(for: video)') < body.lastIndexOf('return url'),
    'readiness wait should happen before returning the URL to AVPlayer'
  )
})
