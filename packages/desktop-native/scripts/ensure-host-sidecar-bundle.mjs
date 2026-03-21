import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')

const entryFile = path.join(packageRoot, 'Bridge', 'native-host-sidecar.mjs')
const bundleFile = path.join(packageRoot, 'Resources', 'Generated', 'native-host-sidecar.bundle')

const sourceRoots = [
  path.join(packageRoot, 'Bridge'),
  path.join(repoRoot, 'packages', 'app', 'backend'),
  path.join(repoRoot, 'packages', 'host', 'src'),
  path.join(repoRoot, 'packages', 'protocol', 'src'),
  path.join(repoRoot, 'packages', 'backend', 'src'),
  path.join(repoRoot, 'packages', 'spec', 'spec'),
]

const sourceFiles = [
  path.join(packageRoot, 'package.json'),
  path.join(repoRoot, 'packages', 'app', 'package.json'),
  path.join(repoRoot, 'packages', 'host', 'package.json'),
  path.join(repoRoot, 'packages', 'protocol', 'package.json'),
  path.join(repoRoot, 'packages', 'backend', 'package.json'),
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
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'build') continue
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

  for (const root of sourceRoots) newest = Math.max(newest, walkNewestMtimeMs(root))
  for (const filePath of sourceFiles) newest = Math.max(newest, getNewestMtimeMs(filePath))

  return newest
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
  if (process.platform === 'darwin') {
    return ['darwin-arm64', 'darwin-x64']
  }

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

const forced = process.env.PEARTUBE_FORCE_NATIVE_HOST_BUNDLE === '1'
const sourceNewest = getSourceNewestMtimeMs()
const bundleMtime = getNewestMtimeMs(bundleFile)
const missingBundle = bundleMtime === 0
const staleBundle = !missingBundle && bundleMtime < sourceNewest

if (forced || missingBundle || staleBundle) {
  const reason = forced ? 'forced rebuild' : missingBundle ? 'missing bundle' : 'stale bundle'
  console.log(`[bundle:native-sidecar:ensure] Rebuilding (${reason})`)
  runBarePack()
} else {
  console.log('[bundle:native-sidecar:ensure] Native host sidecar bundle is up to date')
}
