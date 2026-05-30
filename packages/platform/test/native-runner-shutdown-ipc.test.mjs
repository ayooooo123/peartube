import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const platformRoot = path.resolve(__dirname, '..')

function readPlatformFile(relativePath) {
  return fs.readFileSync(path.join(platformRoot, relativePath), 'utf8')
}

test('native runner writes shutdown IPC frames as buffers for BareKit', () => {
  const source = readPlatformFile('src/runner.native.ts')

  assert.match(
    source,
    /ipc\.write\(Buffer\.from\(encodeJsonFrame\(\{ type: 'shutdown' \}\)\)\)/,
    'BareKit IPC expects typed buffer data; writing the framed shutdown string redboxes on native',
  )
})
