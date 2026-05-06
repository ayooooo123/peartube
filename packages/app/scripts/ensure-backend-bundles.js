/* eslint-disable no-console */
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { spawnSync } = require('child_process')

const projectRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(projectRoot, '..', '..')
const manifestPath = path.join(projectRoot, 'backend-bundles.manifest.mjs')

function resolveRepoPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Manifest paths must be non-empty strings')
  }
  if (path.isAbsolute(relativePath)) return path.normalize(relativePath)
  return path.resolve(repoRoot, relativePath)
}

function loadManifest() {
  const manifestUrl = pathToFileURL(manifestPath).href
  return import(manifestUrl).then(mod => mod.default || mod.backendBundlesManifest)
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.bundles) || manifest.bundles.length === 0) {
    throw new Error('Backend bundle manifest must declare at least one bundle')
  }

  const ids = new Set()
  const cacheIds = new Set()
  for (const bundle of manifest.bundles) {
    if (!bundle || typeof bundle !== 'object') throw new Error('Manifest bundle entries must be objects')
    for (const key of ['id', 'cacheId', 'entry', 'output']) {
      if (typeof bundle[key] !== 'string' || bundle[key].length === 0) {
        throw new Error(`Manifest bundle is missing ${key}`)
      }
    }
    if (ids.has(bundle.id)) throw new Error(`Duplicate manifest bundle id: ${bundle.id}`)
    if (cacheIds.has(bundle.cacheId)) throw new Error(`Duplicate manifest bundle cacheId: ${bundle.cacheId}`)
    ids.add(bundle.id)
    cacheIds.add(bundle.cacheId)

    if (!Array.isArray(bundle.sourceRoots)) throw new Error(`Manifest bundle ${bundle.id} must declare sourceRoots`)
    if (!Array.isArray(bundle.sourceFiles)) throw new Error(`Manifest bundle ${bundle.id} must declare sourceFiles`)
    if (!bundle.pack || !Array.isArray(bundle.pack.flags)) throw new Error(`Manifest bundle ${bundle.id} must declare pack flags`)
    if (!bundle.runtime || typeof bundle.runtime !== 'object') throw new Error(`Manifest bundle ${bundle.id} must declare runtime metadata`)
  }
}

function getWatchedExtensions(manifest) {
  return new Set(manifest.watch?.extensions || ['.js', '.mjs', '.cjs', '.ts', '.json'])
}

function getIgnoredDirectories(manifest) {
  return new Set(manifest.watch?.ignoredDirectories || ['node_modules', '.git'])
}

function getNewestMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function walkNewestMtimeMs(dirPath, watchedExtensions, ignoredDirectories) {
  let newest = 0
  let entries
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return newest
  }

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, walkNewestMtimeMs(fullPath, watchedExtensions, ignoredDirectories))
      continue
    }
    if (!entry.isFile()) continue
    if (!watchedExtensions.has(path.extname(entry.name))) continue
    newest = Math.max(newest, getNewestMtimeMs(fullPath))
  }

  return newest
}

function getBundleSourceNewestMtimeMs(bundle, manifest) {
  let newest = getNewestMtimeMs(manifestPath)
  const watchedExtensions = getWatchedExtensions(manifest)
  const ignoredDirectories = getIgnoredDirectories(manifest)

  for (const root of bundle.sourceRoots) {
    newest = Math.max(newest, walkNewestMtimeMs(resolveRepoPath(root), watchedExtensions, ignoredDirectories))
  }

  for (const filePath of bundle.sourceFiles) {
    newest = Math.max(newest, getNewestMtimeMs(resolveRepoPath(filePath)))
  }

  return newest
}

function bundleExists(bundle) {
  return fs.existsSync(resolveRepoPath(bundle.output))
}

function bundleIsFresh(bundle, sourceNewestMtimeMs) {
  const outputPath = resolveRepoPath(bundle.output)
  const stat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null
  if (!stat) return false
  return stat.mtimeMs >= sourceNewestMtimeMs
}

function runSchema() {
  const result = spawnSync('npm', ['run', 'schema'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
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

function runPrepareMobileBackend() {
  runSchema()
  runBundleBackend()
}

async function main() {
  const manifest = await loadManifest()
  validateManifest(manifest)

  const forced = process.env.PEARTUBE_FORCE_BUNDLE === '1'
  const missingBundles = manifest.bundles.filter(bundle => !bundleExists(bundle))
  const staleBundles = missingBundles.length > 0
    ? []
    : manifest.bundles.filter(bundle => !bundleIsFresh(bundle, getBundleSourceNewestMtimeMs(bundle, manifest)))

  if (forced || missingBundles.length > 0 || staleBundles.length > 0) {
    const reason = forced
      ? 'forced rebuild'
      : missingBundles.length > 0
        ? `missing bundles: ${missingBundles.map(bundle => bundle.id).join(', ')}`
        : `stale bundles: ${staleBundles.map(bundle => bundle.id).join(', ')}`
    console.log(`[bundle:backend:ensure] Rebuilding (${reason})`)
    runPrepareMobileBackend()
  } else {
    console.log('[bundle:backend:ensure] Bundles are up to date')
  }
}

main().catch(err => {
  console.error('[bundle:backend:ensure] Failed:', err)
  process.exit(1)
})
