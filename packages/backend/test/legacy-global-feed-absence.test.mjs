import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../../..')
const productionRoots = [
  'packages/backend/src',
  'packages/cli/src',
  'packages/app',
  'packages/core/src',
  'packages/spec',
  'packages/host/src',
  'packages/platform/src',
]
const forbidden = [
  /peartube-network/,
  /peartube-public-feed-v1/,
  /PublicFeedManager/,
  /canonical-feed/,
  /public-feed/,
  /relayMirrorKey/,
  /relay-blind-peer/,
  /blind-peering-client/,
  /relay-links/,
  /get-public-feed/,
  /get-canonical-feed/,
  /get-relay-links/,
  /feedTopicHex/,
  /store\.replicate\(conn\)/,
]
const allowed = new Set([
  'packages/backend/src/migrations/publication-v1.js',
])
const ignoredDirectories = new Set([
  '.expo',
  'build',
  'desktop-build',
  'dist',
  'node_modules',
])

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name) || entry.name === '.git' || entry.name === 'tests' || entry.name === 'test') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(js|mjs|cjs|ts|tsx|json|schema)$/.test(entry.name)) out.push(full)
  }
  return out
}

test('production source has no legacy global feed data plane identifiers', (t) => {
  const failures = []
  for (const base of productionRoots) {
    for (const file of walk(path.join(root, base))) {
      const rel = path.relative(root, file)
      if (allowed.has(rel)) continue
      const text = fs.readFileSync(file, 'utf8')
      for (const pattern of forbidden) {
        if (pattern.test(text)) failures.push(`${rel}: ${pattern}`)
      }
    }
  }
  t.alike(failures, [])
})
