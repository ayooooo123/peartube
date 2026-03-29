import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { getSidecarAddonRoots } from './sidecar-addon-roots.mjs'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const require = createRequire(import.meta.url)

const outputBundleFile = path.join(
  packageRoot,
  'Resources',
  'Generated',
  'native-host-worklet.bundle'
)

const workletEntryRelativePath = path.join(
  'packages',
  'desktop-native',
  'Bridge',
  'native-host-worklet.js'
)

const transformedSourceRoots = [
  path.join(packageRoot, 'Bridge'),
  path.join(repoRoot, 'packages', 'app', 'backend'),
  path.join(repoRoot, 'packages', 'host', 'src'),
  path.join(repoRoot, 'packages', 'protocol', 'src'),
  path.join(repoRoot, 'packages', 'backend', 'src'),
  path.join(repoRoot, 'packages', 'spec', 'spec'),
]

const watchedRoots = [
  ...transformedSourceRoots,
  path.join(repoRoot, 'packages', 'backend', 'node_modules', 'hypercore-storage'),
  path.join(repoRoot, 'packages', 'backend', 'node_modules', 'rocksdb-native'),
  path.join(repoRoot, 'packages', 'app', 'node_modules', 'hypercore-storage'),
  path.join(repoRoot, 'packages', 'app', 'node_modules', 'rocksdb-native'),
  path.join(repoRoot, 'packages', 'bare-mpv'),
  ...getSidecarAddonRoots(repoRoot),
]

const watchedFiles = [
  path.join(packageRoot, 'package.json'),
  path.join(packageRoot, 'scripts', 'ensure-host-worklet-bundle.mjs'),
]

const watchedExtensions = new Set(['.js', '.mjs', '.cjs', '.json'])
const copyAsIsExtensions = new Set(['.json'])
const skipFilePattern = /\.test\.(?:js|mjs|cjs)$/
const relativeSpecifierPattern = /((?:from|import|require)\s*(?:\(\s*)?["'])(\.\.?\/[^"'()]+)\.(mjs|cjs)(["']\s*\)?)/g

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

  for (const root of watchedRoots) newest = Math.max(newest, walkNewestMtimeMs(root))
  for (const filePath of watchedFiles) newest = Math.max(newest, getNewestMtimeMs(filePath))

  return newest
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
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
    path.join(repoRoot, 'packages', 'app', 'node_modules'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  throw new Error('Could not locate node_modules for host worklet compilation.')
}

function getBundleHosts() {
  if (process.platform === 'darwin') {
    return ['darwin-arm64', 'darwin-x64']
  }

  return [`${process.platform}-${process.arch}`]
}

function rewriteRelativeSpecifiers(source) {
  return source.replace(relativeSpecifierPattern, (_, prefix, specifier, _ext, suffix) => {
    return `${prefix}${specifier}.js${suffix}`
  })
}

function transformSourceFile(filePath) {
  const swc = require(path.join(repoRoot, 'packages', 'app', 'node_modules', '@swc', 'core'))
  const rawSource = fs.readFileSync(filePath, 'utf8')
  const rewrittenSource = rewriteRelativeSpecifiers(rawSource)

  return swc.transformSync(rewrittenSource, {
    filename: filePath,
    sourceMaps: false,
    jsc: {
      target: 'es2019',
      parser: {
        syntax: 'ecmascript',
        dynamicImport: true,
      },
    },
    module: {
      type: 'commonjs',
      strict: false,
      importInterop: 'node',
      noInterop: false,
    },
  }).code
}

function copyOrTransformSourceTree(tempRoot) {
  for (const root of transformedSourceRoots) {
    copyOrTransformDirectory(root, tempRoot)
  }

  linkDirectory(
    path.join(repoRoot, 'packages', 'bare-mpv'),
    path.join(tempRoot, 'packages', 'bare-mpv')
  )

  linkDirectory(findNodeModulesRoot(), path.join(tempRoot, 'node_modules'))
  linkPackageNodeModules(tempRoot, 'backend')
  linkPackageNodeModules(tempRoot, 'app')
  linkPackageNodeModules(tempRoot, 'host')
  linkPackageNodeModules(tempRoot, 'protocol')

  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ private: true, type: 'commonjs' }, null, 2) + '\n'
  )
}

function copyOrTransformDirectory(sourceRoot, tempRoot) {
  const stack = [sourceRoot]

  while (stack.length > 0) {
    const currentDir = stack.pop()
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'build') continue

      const sourcePath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        stack.push(sourcePath)
        continue
      }

      if (!entry.isFile()) continue
      if (skipFilePattern.test(entry.name)) continue

      const extension = path.extname(entry.name)
      if (!watchedExtensions.has(extension)) continue

      const relativePath = path.relative(repoRoot, sourcePath)
      const outputRelativePath = extension === '.json'
        ? relativePath
        : relativePath.replace(/\.(?:mjs|cjs)$/, '.js')
      const outputPath = path.join(tempRoot, outputRelativePath)

      ensureDir(path.dirname(outputPath))

      if (copyAsIsExtensions.has(extension)) {
        fs.copyFileSync(sourcePath, outputPath)
        continue
      }

      const compiled = transformSourceFile(sourcePath)
      fs.writeFileSync(outputPath, compiled)
    }
  }
}

function linkDirectory(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath))
  fs.rmSync(targetPath, { recursive: true, force: true })
  fs.symlinkSync(sourcePath, targetPath, 'dir')
}

function linkPackageNodeModules(tempRoot, packageName) {
  const sourcePath = path.join(repoRoot, 'packages', packageName, 'node_modules')
  if (!fs.existsSync(sourcePath)) return

  linkDirectory(
    sourcePath,
    path.join(tempRoot, 'packages', packageName, 'node_modules')
  )
}

function buildBundleFromTempRoot(tempRoot) {
  const barePackBin = findBarePackBin()
  const entryFile = path.join(tempRoot, workletEntryRelativePath)

  ensureDir(path.dirname(outputBundleFile))

  const args = [
    '--out', outputBundleFile,
    '--format', 'bundle',
    '--base', tempRoot,
    '--linked',
  ]

  for (const host of getBundleHosts()) {
    args.push('--host', host)
  }

  args.push(entryFile)

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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-native-worklet-'))

  try {
    copyOrTransformSourceTree(tempRoot)
    buildBundleFromTempRoot(tempRoot)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

const forced = process.env.PEARTUBE_FORCE_NATIVE_HOST_BUNDLE === '1'
const sourceNewest = getSourceNewestMtimeMs()
const bundleMtime = getNewestMtimeMs(outputBundleFile)
const missingBundle = bundleMtime === 0
const staleBundle = !missingBundle && bundleMtime < sourceNewest

if (forced || missingBundle || staleBundle) {
  const reason = forced ? 'forced rebuild' : missingBundle ? 'missing bundle' : 'stale bundle'
  console.log(`[bundle:native-worklet:ensure] Rebuilding (${reason})`)
  rebuildBundle()
} else {
  console.log('[bundle:native-worklet:ensure] Native host worklet bundle is up to date')
}
