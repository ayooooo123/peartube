/* eslint-disable no-console */
const path = require('path')
const { pathToFileURL } = require('url')
const { spawnSync } = require('child_process')

const projectRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(projectRoot, '..', '..')
const manifestPath = path.join(projectRoot, 'backend-bundles.manifest.mjs')

function resolveRepoPath(relativePath) {
  if (path.isAbsolute(relativePath)) return path.normalize(relativePath)
  return path.resolve(repoRoot, relativePath)
}

function toProjectRelative(relativePath) {
  return path.relative(projectRoot, resolveRepoPath(relativePath)) || '.'
}

async function loadManifest() {
  const manifestUrl = pathToFileURL(manifestPath).href
  const mod = await import(manifestUrl)
  return mod.default || mod.backendBundlesManifest
}

function removeOutput(bundle) {
  try {
    const outputPath = resolveRepoPath(bundle.output)
    require('fs').rmSync(outputPath, { force: true })
  } catch {}
}

function runBarePack(bundle) {
  removeOutput(bundle)
  const pack = bundle.pack || {}
  const command = pack.command || 'bare-pack'
  const args = [
    ...(pack.flags || []),
    '--out',
    toProjectRelative(bundle.output),
    toProjectRelative(bundle.entry),
  ]

  console.log(`[bundle:backend] ${bundle.id}: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

async function main() {
  const only = process.argv.slice(2)
  const manifest = await loadManifest()
  const bundles = only.length > 0
    ? manifest.bundles.filter(bundle => only.includes(bundle.id))
    : manifest.bundles

  if (bundles.length === 0) {
    throw new Error(`No backend bundles matched: ${only.join(', ')}`)
  }

  for (const bundle of bundles) runBarePack(bundle)
}

main().catch(err => {
  console.error('[bundle:backend] Failed:', err)
  process.exit(1)
})
