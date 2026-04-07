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
  path.join(repoRoot, 'packages', 'backend'),
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
  const realNmPath = path.join(repoRoot, 'packages', packageName, 'node_modules')
  const targetNmPath = path.join(tempRoot, 'packages', packageName, 'node_modules')

  // Skip if target already exists and is usable
  try {
    if (fs.existsSync(targetNmPath)) {
      fs.readdirSync(targetNmPath)
      return
    }
  } catch {
    // broken symlink — remove it
    try { fs.unlinkSync(targetNmPath) } catch {}
  }

  // Check the real node_modules is usable
  let realNmUsable = false
  try {
    if (fs.existsSync(realNmPath)) {
      fs.readdirSync(realNmPath)
      realNmUsable = true
    }
  } catch {}

  if (!realNmUsable) {
    // Fall back to app node_modules
    if (fs.existsSync(appNodeModulesPath)) {
      linkDirectory(appNodeModulesPath, targetNmPath)
    }
    return
  }

  // Instead of symlinking the entire node_modules (which contains file:
  // relative symlinks that escape the temp root), create the directory
  // and symlink each entry individually. For @peartube/* packages, point
  // to the temp root's staged copies instead of the real filesystem.
  fs.mkdirSync(targetNmPath, { recursive: true })

  for (const entry of fs.readdirSync(realNmPath, { withFileTypes: true })) {
    const entrySource = path.join(realNmPath, entry.name)
    const entryTarget = path.join(targetNmPath, entry.name)

    if (entry.name === '@peartube') {
      // Recreate the @peartube scope with links pointing into the temp root
      fs.mkdirSync(entryTarget, { recursive: true })
      for (const scopeEntry of fs.readdirSync(entrySource, { withFileTypes: true })) {
        const stagedPkg = path.join(tempRoot, 'packages', scopeEntry.name)
        const scopeTarget = path.join(entryTarget, scopeEntry.name)
        if (fs.existsSync(stagedPkg)) {
          linkDirectory(stagedPkg, scopeTarget)
        } else {
          // Not staged — link to the real resolved path
          try {
            const realPath = fs.realpathSync(path.join(entrySource, scopeEntry.name))
            linkDirectory(realPath, scopeTarget)
          } catch {}
        }
      }
    } else {
      linkDirectory(entrySource, entryTarget)
    }
  }
}

function stagePackageJson(tempRoot, packageName) {
  const source = path.join(repoRoot, 'packages', packageName, 'package.json')
  if (!fs.existsSync(source)) return
  const targetDir = path.join(tempRoot, 'packages', packageName)
  fs.mkdirSync(targetDir, { recursive: true })
  const target = path.join(targetDir, 'package.json')
  if (!fs.existsSync(target)) {
    fs.copyFileSync(source, target)
  }
}

function createTempBundleRoot() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-native-sidecar-'))

  for (const sourcePath of sourceRoots) {
    stageDirectory(tempRoot, sourcePath)
  }

  // Stage package.json files so bare-pack can resolve file: dependencies
  stagePackageJson(tempRoot, 'backend')
  stagePackageJson(tempRoot, 'host')
  stagePackageJson(tempRoot, 'protocol')
  stagePackageJson(tempRoot, 'spec')
  stagePackageJson(tempRoot, 'app')

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
