#!/usr/bin/env node
import { execFileSync } from 'node:child_process'

const EXTENSION_RE = /\.(js|jsx|mjs|cjs|ts|tsx)$/

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function getBaseRef() {
  const envBase = process.env.GITHUB_BASE_REF || 'main'
  try {
    runGit(['rev-parse', '--verify', `origin/${envBase}`])
    return `origin/${envBase}`
  } catch {
    return envBase
  }
}

function getChangedFiles() {
  const baseRef = getBaseRef()
  const mergeBase = runGit(['merge-base', baseRef, 'HEAD'])
  const output = runGit(['diff', '--name-only', '--diff-filter=ACMR', mergeBase, 'HEAD'])
  if (!output) return []
  return output.split('\n').filter((file) => EXTENSION_RE.test(file))
}

const changedFiles = getChangedFiles()
if (changedFiles.length === 0) {
  console.log('[lint:changed] No changed JS/TS files to lint')
  process.exit(0)
}

console.log(`[lint:changed] Linting ${changedFiles.length} changed JS/TS file(s)`) 
execFileSync(
  'npm',
  ['exec', '--', 'eslint', '--quiet', ...changedFiles],
  { stdio: 'inherit' },
)
