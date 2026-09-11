import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { transform } from 'esbuild'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

async function loadStudioSourceOffload() {
  const studio = read('app/(tabs)/studio.tsx')
  const showStart = studio.indexOf('function showSourceOffloadStopped')
  const messageStart = studio.indexOf('function buildOffloadConfirmMessage')
  const confirmStart = studio.indexOf('async function confirmSourceOffloadWithUser')
  const freshStart = studio.indexOf('function isFreshOffloadAssessmentReady')
  const runStart = studio.indexOf('async function runStudioSourceOffload')
  const end = studio.indexOf('async function confirmDeleteStudioVideo', runStart)
  assert.ok(showStart >= 0 && messageStart > showStart && confirmStart > messageStart && freshStart > confirmStart && runStart > freshStart && end > runStart)
  const result = await transform([
    'const Platform = globalThis.__offloadPlatform',
    'const Alert = globalThis.__offloadAlert',
    'const formatBytes = globalThis.__offloadFormatBytes',
    studio.slice(showStart, messageStart),
    studio.slice(messageStart, confirmStart),
    studio.slice(confirmStart, freshStart),
    studio.slice(freshStart, runStart),
    studio.slice(runStart, end),
  ].join('\n'), { loader: 'tsx', target: 'node22' })
  return new Function(`${result.code}\nreturn runStudioSourceOffload`)()
}

async function loadDesktopListVideos() {
  const desktop = read('workers/desktop/index.ts')
  const start = desktop.indexOf('B.listVideos = async')
  const end = desktop.indexOf('\nB.getVideoUrl', start)
  assert.ok(start >= 0 && end > start, 'desktop listVideos handler should exist')
  const result = await transform(desktop.slice(start, end), { loader: 'tsx', target: 'node22' })
  const backend = {}
  const api = {
    async listVideos() {
      return [{
        id: 'video-1',
        publicationId: 'publication-1',
        immutablePublication: {
          publicationId: 'publication-1',
          manifestId: 'manifest-1',
          renditionId: 'rendition-1',
          publisherId: 'publisher-1',
        },
      }]
    },
  }
  return new Function('B', 'api', `${result.code}\nreturn B.listVideos`)(backend, api)
}

test('Studio source deletion is publication- and evidence-bound with explicit risk acknowledgement', async () => {
  const confirmations = []
  const assessments = []
  const confirmationsSent = []
  let state = {
    'video-1': {
      eligible: true,
      byteLength: 1024,
      publicationId: 'pub-old',
    },
  }
  globalThis.__offloadPlatform = { OS: 'web' }
  globalThis.__offloadAlert = { alert() {} }
  globalThis.__offloadFormatBytes = (bytes) => `${bytes} bytes`
  globalThis.window = {
    confirm(message) {
      confirmations.push(message)
      return true
    },
  }
  const runStudioSourceOffload = await loadStudioSourceOffload()
  await runStudioSourceOffload({
    item: { id: 'video-1', title: 'Demo' },
    info: state['video-1'],
    rpc: {
      async assessSourceOffload(request) {
        assessments.push(request)
        return {
          success: true,
          eligible: true,
          byteLength: 2048,
          publicationId: 'pub-fresh',
          assessmentId: 'assessment-1',
          evidenceDigest: 'digest-1',
          confirmationNonce: 'nonce-1',
          policyVersion: 7,
          limitations: ['Peers may leave'],
        }
      },
      async confirmSourceOffload(request) {
        confirmationsSent.push(request)
        return { success: true }
      },
    },
    assessedOffloadRef: { current: new Set(['pub-old']) },
    setOffloadInfo(update) {
      state = update(state)
    },
  })
  assert.deepEqual(assessments, [{ publicationId: 'pub-old' }])
  assert.match(confirmations[0], /Publication: pub-fresh/)
  assert.match(confirmations[0], /This cannot guarantee the media remains recoverable/)
  assert.match(confirmations[0], /Evidence limitations/)
  assert.deepEqual(confirmationsSent, [{
    publicationId: 'pub-fresh',
    assessmentId: 'assessment-1',
    evidenceDigest: 'digest-1',
    confirmationNonce: 'nonce-1',
    policyVersion: 7,
    confirmIrrecoverableRisk: true,
  }])
  assert.equal(state['video-1'].offloaded, true)
  assert.equal(state['video-1'].eligible, false)
  delete globalThis.window
  delete globalThis.__offloadPlatform
  delete globalThis.__offloadAlert
  delete globalThis.__offloadFormatBytes
})

test('generated application contract removes direct legacy destructive RPCs', () => {
  const generated = read('../spec/spec/hrpc/app-rpc-adapter.mjs')
  assert.match(generated, /"method": "assessSourceOffload"/)
  assert.match(generated, /"method": "confirmSourceOffload"/)
  assert.doesNotMatch(generated, /assessUploadOffload|offloadUpload/)
})

test('desktop list-video transport preserves immutable publication identifiers', async () => {
  const listVideos = await loadDesktopListVideos()
  const result = await listVideos({ channelKey: 'channel-key', publicBeeKey: 'public-bee-key' })
  assert.deepEqual(result.videos[0].publicationId, 'publication-1')
  assert.deepEqual(result.videos[0].immutablePublication, {
    publicationId: 'publication-1',
    manifestId: 'manifest-1',
    renditionId: 'rendition-1',
    publisherId: 'publisher-1',
  })
})
