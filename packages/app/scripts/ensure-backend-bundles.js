/* eslint-disable no-console */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const projectRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(projectRoot, '..', '..')

const bundleFiles = [
  path.join(projectRoot, 'backend.bundle.js'),
  path.join(projectRoot, 'downloader-worker.bundle.js'),
]

const sourceRoots = [
  path.join(projectRoot, 'backend'),
  path.join(repoRoot, 'packages', 'backend', 'src'),
  path.join(repoRoot, 'packages', 'bare-tls'),
  path.join(repoRoot, 'packages', 'platform', 'src'),
  path.join(repoRoot, 'packages', 'spec', 'spec'),
]

const sourceFiles = [
  path.join(projectRoot, 'package.json'),
  path.join(repoRoot, 'packages', 'backend', 'package.json'),
  path.join(repoRoot, 'packages', 'bare-tls', 'package.json'),
  path.join(repoRoot, 'packages', 'platform', 'package.json'),
  path.join(repoRoot, 'packages', 'spec', 'package.json'),
]

const watchedExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.json'])

function getNewestMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function walkNewestMtimeMs(dirPath) {
  let newest = 0
  let entries
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return newest
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, walkNewestMtimeMs(fullPath))
      continue
    }
    if (!entry.isFile()) continue
    if (!watchedExtensions.has(path.extname(entry.name))) continue
    newest = Math.max(newest, getNewestMtimeMs(fullPath))
  }

  return newest
}

function getSourceNewestMtimeMs() {
  let newest = 0

  for (const root of sourceRoots) {
    newest = Math.max(newest, walkNewestMtimeMs(root))
  }

  for (const filePath of sourceFiles) {
    newest = Math.max(newest, getNewestMtimeMs(filePath))
  }

  return newest
}

function hasAllBundles() {
  return bundleFiles.every(filePath => fs.existsSync(filePath))
}

function bundlesAreFresh(sourceNewestMtimeMs) {
  return bundleFiles.every(filePath => {
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null
    if (!stat) return false
    return stat.mtimeMs >= sourceNewestMtimeMs
  })
}

function runBundleBackend() {
  const result = spawnSync('npm', ['run', 'bundle:backend'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

const forced = process.env.PEARTUBE_FORCE_BUNDLE === '1'
const sourceNewest = getSourceNewestMtimeMs()
const missingBundles = !hasAllBundles()
const staleBundles = !missingBundles && !bundlesAreFresh(sourceNewest)

if (forced || missingBundles || staleBundles) {
  const reason = forced ? 'forced rebuild' : missingBundles ? 'missing bundles' : 'stale bundles'
  console.log(`[bundle:backend:ensure] Rebuilding (${reason})`)
  runBundleBackend()
} else {
  console.log('[bundle:backend:ensure] Bundles are up to date')
}
