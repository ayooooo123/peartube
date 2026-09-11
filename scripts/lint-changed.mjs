#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const EXTENSION_RE = /\.(js|jsx|mjs|cjs|ts|tsx)$/

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function getBaseRef() {
  const envBase = process.env.GITHUB_BASE_REF || 'main'
  const remoteRef = `origin/${envBase}`
  try {
    runGit(['rev-parse', '--verify', remoteRef])
    return remoteRef
  } catch {
    try {
      execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', `${envBase}:refs/remotes/${remoteRef}`], { stdio: 'ignore' })
      return remoteRef
    } catch {
      return envBase
    }
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
for (const [command, args] of [
  ['oxlint', ['-c', '.oxlintrc.json', ...changedFiles]],
  ['eslint', ['--quiet', ...changedFiles]],
]) {
  const executable = `./node_modules/.bin/${command}`
  const installed = existsSync(executable)
  execFileSync(installed ? executable : 'npx', installed ? args : ['--no-install', command, ...args], { stdio: 'inherit' })
}
