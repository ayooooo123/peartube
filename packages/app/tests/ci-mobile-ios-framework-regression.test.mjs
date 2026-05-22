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

test('mobile iOS framework preparation uses bash for associative arrays on macOS runners', () => {
  const workflow = readFile('.github/workflows/build-mobile.yml')
  const script = readFile('packages/app/scripts/create-xcframeworks.sh')

  assert.match(script, /declare -A SKIP_FRAMEWORKS/)
  assert.match(script, /declare -A SKIP_FAMILIES/)
  assert.match(
    workflow,
    /Prepare iOS frameworks[\s\S]*?shell:\s+bash/,
    'macOS runners default to old bash for script shebangs; invoke npm run ios:prepare under GitHub Actions bash',
  )
})
