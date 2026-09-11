import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'peartube-architecture-rules-'))
const fixtures = [
  ['duplicate-protocol-literals', 'packages/app/lib', 'const options = { protocolVersion: 7 }', 'const options = { protocolVersion: PROTOCOL_VERSION }'],
  ['parallel-app-search', 'packages/app/lib', 'searchMediaCatalog({ query: "movie" })', 'provider.search({ selector: { title: "movie" } })'],
  ['duplicate-acquisition-entrypoints', 'packages/cli/src/add', 'createExecutor({})', 'provider.requestAcquisition(request)'],
  ['clock-random-in-replicated-apply', 'packages/backend/src/publisher', 'function apply(nodes) { return Date.now() }', 'function apply(nodes) { return nodes[0].value.timestamp }'],
  ['unflushed-storage-read', 'packages/backend/src/assets', 'async function read() { try { return await rx.getBlock(0) } finally { rx.tryFlush() } }', 'async function read() { const result = rx.getBlock(0); rx.tryFlush(); return await result }'],
  ['writer-key-as-authority', 'packages/backend/src/publisher', 'const writable = catalog.writable || catalog.localWriterKey != null', 'const writable = catalog.writable'],
]
const expected = new Set()
let fileCount = 0
async function fixture(path, content, ruleId = null) {
  const absolute = join(directory, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
  if (ruleId) expected.add(`${ruleId}:${resolve(absolute)}`)
  fileCount++
}
try {
  await cp(join(root, 'rules'), join(directory, 'rules'), { recursive: true })
  await writeFile(join(directory, 'sgconfig.yml'), await readFile(join(root, 'sgconfig.yml')))
  for (const [ruleId, target, invalid, valid] of fixtures) {
    for (const extension of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx']) {
      const suffix = extension === 'tsx' || extension === 'jsx' ? '\nconst view = <View />\n' : '\n'
      await fixture(`${target}/${ruleId}-invalid.${extension}`, invalid + suffix, ruleId)
      await fixture(`${target}/${ruleId}-valid.${extension}`, valid + suffix)
    }
  }
  await fixture('packages/host/src/contracts.d.ts', 'export declare const PROTOCOL_VERSION: 7\n')
  await fixture('packages/host/src/duplicate-invalid.d.ts', 'export interface Startup { protocolVersion: 7 }\n', 'duplicate-protocol-literals')
  const scan = spawnSync(process.env.AST_GREP_BIN || 'ast-grep', ['scan', '--json=compact'], {
    cwd: directory, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  })
  if (scan.error) throw scan.error
  assert.ok(scan.status === 0 || scan.status === 1, scan.stderr)
  const findings = JSON.parse(scan.stdout)
  const observed = new Set(findings.map(finding => `${finding.ruleId}:${resolve(directory, finding.file)}`))
  const missing = [...expected].filter(key => !observed.has(key))
  const unexpected = [...observed].filter(key => !expected.has(key))
  assert.deepEqual({ missing, unexpected }, { missing: [], unexpected: [] }, 'actual file scanning must enforce every guard without rejecting valid fixtures')
  console.log(`${fileCount} real-file AST fixtures passed: six guards across JS/MJS/CJS/JSX/TS/TSX, plus declaration inclusion/exclusion`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
