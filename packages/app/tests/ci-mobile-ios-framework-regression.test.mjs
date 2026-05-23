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

test('mobile iOS framework preparation avoids bash 4-only associative arrays on macOS runners', () => {
  const workflow = readFile('.github/workflows/build-mobile.yml')
  const script = readFile('packages/app/scripts/create-xcframeworks.sh')

  assert.doesNotMatch(
    script,
    /declare -A|\$\{[A-Z_]+\[[^\]]+\]:-/,
    'GitHub macOS runners execute npm scripts with old /bin/bash; ios:prepare must not require bash 4 associative arrays',
  )
  assert.match(
    workflow,
    /Prepare iOS frameworks[\s\S]*?shell:\s+bash/,
    'keep the workflow shell explicit while the script itself stays compatible with macOS bash 3.x',
  )
})
