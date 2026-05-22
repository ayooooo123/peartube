import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')

function readFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('native desktop archive uses an Xcode version compatible with generated project format', () => {
  const workflow = readFile('.github/workflows/build-desktop.yml')

  assert.match(
    workflow,
    /native-desktop-archive:[\s\S]*?runs-on:\s+macos-15/,
    'xcodegen now emits project file format 77, which Xcode 15.4 on macos-14 cannot read',
  )
  assert.match(
    workflow,
    /native-desktop-test:[\s\S]*?runs-on:\s+macos-15/,
    'native desktop test should use the same Xcode generation compatibility as archive builds',
  )
})
