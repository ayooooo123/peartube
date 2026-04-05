import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSidecarAddonRoots } from './sidecar-addon-roots.mjs'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')

const bundleFile = path.join(packageRoot, 'Resources', 'Generated', 'native-host-sidecar.bundle')
const entryFileRelativePath = path.join(
  'packages',
  'desktop-native',
  'Bridge',
  'native-host-sidecar.mjs'
)
const appNodeModulesPath = path.join(repoRoot, 'packages', 'app', 'node_modules')

const sourceRoots = [
  path.join(packageRoot, 'Bridge'),
  path.join(repoRoot, 'packages', 'app', 'backend'),
  path.join(repoRoot, 'packages', 'host'),
  path.join(repoRoot, 'packages', 'protocol', 'src'),
  path.join(repoRoot, 'packages', 'backend', 'src'),
  path.join(repoRoot, 'packages', 'spec', 'spec'),
  path.join(repoRoot, 'packages', 'bare-mpv'),
  ...getSidecarAddonRoots(repoRoot),
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

function findNodeModulesRoot() {
  const candidates = [
    path.join(repoRoot, 'node_modules'),
    appNodeModulesPath,
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  throw new Error('Could not locate node_modules for host sidecar compilation.')
}

function getBundleHosts() {
  if (process.platform === 'darwin') {
    return ['darwin-arm64', 'darwin-x64']
  }

  return [`${process.platform}-${process.arch}`]
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function linkDirectory(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath))
  fs.rmSync(targetPath, { recursive: true, force: true })
  fs.symlinkSync(sourcePath, targetPath, 'dir')
}

function stageDirectory(tempRoot, sourcePath) {
  if (!fs.existsSync(sourcePath)) return
  const relativePath = path.relative(repoRoot, sourcePath)
  linkDirectory(sourcePath, path.join(tempRoot, relativePath))
}

function linkPackageNodeModules(tempRoot, packageName) {
  const sourcePath = path.join(repoRoot, 'packages', packageName, 'node_modules')
  const fallbackSourcePath = appNodeModulesPath
  const resolvedSourcePath = fs.existsSync(sourcePath)
    ? sourcePath
    : fs.existsSync(fallbackSourcePath)
      ? fallbackSourcePath
      : null
  if (!resolvedSourcePath) return

  linkDirectory(
    resolvedSourcePath,
    path.join(tempRoot, 'packages', packageName, 'node_modules')
  )
}

function createTempBundleRoot() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-native-sidecar-'))

  for (const sourcePath of sourceRoots) {
    stageDirectory(tempRoot, sourcePath)
  }

  linkDirectory(findNodeModulesRoot(), path.join(tempRoot, 'node_modules'))
  linkPackageNodeModules(tempRoot, 'backend')
  linkPackageNodeModules(tempRoot, 'app')
  linkPackageNodeModules(tempRoot, 'host')
  linkPackageNodeModules(tempRoot, 'protocol')

  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n'
  )

  return tempRoot
}

function runBarePack(tempRoot) {
  fs.mkdirSync(path.dirname(bundleFile), { recursive: true })

  const barePackBin = findBarePackBin()
  const stagedEntryFile = path.join(tempRoot, entryFileRelativePath)
  const args = [
    '--out', bundleFile,
    '--format', 'bundle',
    '--base', tempRoot,
    '--linked',
  ]

  for (const host of getBundleHosts()) {
    args.push('--host', host)
  }

  args.push(stagedEntryFile)

  const result = spawnSync(barePackBin, args, {
    cwd: tempRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

function rebuildBundle() {
  const tempRoot = createTempBundleRoot()

  try {
    runBarePack(tempRoot)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
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
  rebuildBundle()
} else {
  console.log('[bundle:native-sidecar:ensure] Native host sidecar bundle is up to date')
}
