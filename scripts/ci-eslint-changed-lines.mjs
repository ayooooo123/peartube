#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const [, , baseSha, headSha] = process.argv

if (!baseSha || !headSha) {
  console.error('Usage: node scripts/ci-eslint-changed-lines.mjs <base-sha> <head-sha>')
  process.exit(2)
}

const repoRoot = process.cwd()

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })

  if (!allowFailure && result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exit(result.status || 1)
  }

  return result
}

function normalizeFilePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/')
}

function intersects(message, ranges) {
  if (!ranges || ranges.length === 0) return false
  if (message.line == null) return true

  const startLine = message.line
  const endLine = message.endLine || message.line

  return ranges.some(({ start, end }) => startLine <= end && endLine >= start)
}

const changedFiles = run('git', ['diff', '--name-only', baseSha, headSha]).stdout
  .split('\n')
  .map((value) => value.trim())
  .filter((value) => value && /\.(js|jsx|ts|tsx)$/.test(value))

if (changedFiles.length === 0) {
  console.log('No changed lintable files; skipping eslint.')
  process.exit(0)
}

console.log('Linting changed files:')
for (const file of changedFiles) {
  console.log(` - ${file}`)
}

const diffOutput = run('git', ['diff', '--unified=0', '--no-color', baseSha, headSha, '--', ...changedFiles]).stdout
const changedRangesByFile = new Map()
let currentFile = null

for (const line of diffOutput.split('\n')) {
  if (line.startsWith('+++ b/')) {
    currentFile = line.slice('+++ b/'.length)
    if (!changedRangesByFile.has(currentFile)) changedRangesByFile.set(currentFile, [])
    continue
  }

  if (!line.startsWith('@@') || !currentFile) continue

  const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
  if (!match) continue

  const start = Number(match[1])
  const count = match[2] ? Number(match[2]) : 1
  if (count === 0) continue

  changedRangesByFile.get(currentFile).push({
    start,
    end: start + count - 1,
  })
}

const eslintResult = run(
  'npx',
  ['eslint', ...changedFiles, '--quiet', '--format', 'json'],
  { allowFailure: true }
)

if (eslintResult.status == null) {
  console.error('eslint terminated unexpectedly')
  process.exit(1)
}

if (eslintResult.status > 1) {
  if (eslintResult.stdout) process.stdout.write(eslintResult.stdout)
  if (eslintResult.stderr) process.stderr.write(eslintResult.stderr)
  process.exit(eslintResult.status)
}

const rawResults = eslintResult.stdout.trim()
const eslintMessages = rawResults ? JSON.parse(rawResults) : []
const relevantResults = []

for (const result of eslintMessages) {
  const relativePath = normalizeFilePath(result.filePath)
  const ranges = changedRangesByFile.get(relativePath)
  const messages = (result.messages || []).filter((message) => intersects(message, ranges))

  if (messages.length > 0) {
    relevantResults.push({ relativePath, messages })
  }
}

if (relevantResults.length === 0) {
  console.log('No ESLint problems on changed lines.')
  process.exit(0)
}

let errorCount = 0
for (const { relativePath, messages } of relevantResults) {
  console.log(`\n${relativePath}`)
  for (const message of messages) {
    const severity = message.severity === 2 ? 'error' : 'warning'
    const line = message.line ?? 0
    const column = message.column ?? 0
    const rule = message.ruleId || 'eslint'
    console.log(`  ${line}:${column}  ${severity}  ${message.message}  ${rule}`)
    if (message.severity === 2) errorCount += 1
  }
}

console.log(`\n✖ ${errorCount} problem${errorCount === 1 ? '' : 's'} on changed lines`)
process.exit(errorCount > 0 ? 1 : 0)
