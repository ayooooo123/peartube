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

test('Studio source deletion is publication- and evidence-bound with explicit risk acknowledgement', () => {
  const studio = read('app/(tabs)/studio.tsx')
  assert.match(studio, /const assess = rpc\?\.assessSourceOffload[\s\S]*await assess\(\{ publicationId \}\)/)
  assert.match(studio, /const handleOffloadVideo[\s\S]*await rpc\?\.assessSourceOffload\(\{ publicationId: info\.publicationId \}\)[\s\S]*Confirm source offload/)
  assert.match(studio, /confirmSourceOffload\(\{[\s\S]*publicationId: fresh\.publicationId[\s\S]*assessmentId: fresh\.assessmentId[\s\S]*evidenceDigest: fresh\.evidenceDigest[\s\S]*confirmationNonce: fresh\.confirmationNonce[\s\S]*policyVersion: fresh\.policyVersion/)
  assert.match(studio, /policyVersion: fresh\.policyVersion[\s\S]*confirmIrrecoverableRisk: true/)
  assert.match(studio, /This cannot guarantee the media remains recoverable/)
  assert.match(studio, /Evidence limitations/)
  assert.match(studio, /Publication: \$\{fresh\.publicationId\}/)
  assert.doesNotMatch(studio, /assessUploadOffload|offloadUpload/)
})

test('generated application contract removes direct legacy destructive RPCs', () => {
  const generated = read('../spec/spec/hrpc/app-rpc-adapter.mjs')
  assert.match(generated, /"method": "assessSourceOffload"/)
  assert.match(generated, /"method": "confirmSourceOffload"/)
  assert.doesNotMatch(generated, /assessUploadOffload|offloadUpload/)
})

test('Studio list-video transports preserve immutable publication identifiers', () => {
  const mobile = read('../backend/src/mobile-handlers.js')
  const desktop = read('workers/desktop/index.ts')
  for (const source of [mobile, desktop]) {
    assert.match(source, /publicationId:\s*v\?\.publicationId/)
    assert.match(source, /immutablePublication:\s*v\?\.immutablePublication/)
  }
})
