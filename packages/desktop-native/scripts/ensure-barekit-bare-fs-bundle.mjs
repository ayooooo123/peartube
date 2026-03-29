import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')

const entryFile = path.join(packageRoot, 'Bridge', 'barekit-bare-fs-worklet.cjs')
const bundleFile = path.join(packageRoot, 'Resources', 'Generated', 'barekit-bare-fs.bundle')

function getNewestMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function findBarePackBin() {
  const candidates = [
    path.join(repoRoot, 'packages', 'app', 'node_modules', '.bin', 'bare-pack'),
    path.join(repoRoot, 'node_modules', '.bin', 'bare-pack'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  throw new Error('Could not locate bare-pack. Install app dependencies first.')
}

function getBundleTargets() {
  if (process.platform === 'darwin') return ['darwin-arm64', 'darwin-x64']
  return [`${process.platform}-${process.arch}`]
}

function runBarePack() {
  fs.mkdirSync(path.dirname(bundleFile), { recursive: true })

  const barePackBin = findBarePackBin()
  const args = [
    '--out', bundleFile,
    '--format', 'bundle',
    '--base', repoRoot,
    '--linked',
  ]

  for (const target of getBundleTargets()) {
    args.push('--target', target)
  }

  args.push(entryFile)

  const result = spawnSync(barePackBin, args, {
    cwd: packageRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

const sourceNewest = Math.max(
  getNewestMtimeMs(entryFile),
  getNewestMtimeMs(path.join(packageRoot, 'package.json'))
)
const bundleMtime = getNewestMtimeMs(bundleFile)
const forced = process.env.PEARTUBE_FORCE_NATIVE_HOST_BUNDLE === '1'
const missingBundle = bundleMtime == 0
const staleBundle = !missingBundle && bundleMtime < sourceNewest

if (forced || missingBundle || staleBundle) {
  const reason = forced ? 'forced rebuild' : missingBundle ? 'missing bundle' : 'stale bundle'
  console.log(`[bundle:barekit-bare-fs:ensure] Rebuilding (${reason})`)
  runBarePack()
} else {
  console.log('[bundle:barekit-bare-fs:ensure] BareKit bare-fs bundle is up to date')
}
