import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSidecarAddonRoots } from './sidecar-addon-roots.mjs'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')

const bundleFile = path.join(packageRoot, 'Resources', 'Generated', 'native-host-worklet.bundle')
const frameworkOutputDir = path.join(packageRoot, 'Vendor', 'BareAddons')
const scriptMtime = fs.statSync(new URL(import.meta.url)).mtimeMs
const addonSourceRoots = getSidecarAddonRoots(repoRoot)

function getNewestMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function getRootsNewestMtimeMs(rootPaths) {
  let newest = 0

  for (const rootPath of rootPaths) {
    newest = Math.max(newest, walkNewestMtimeMs(rootPath))
  }

  return newest
}

function walkNewestMtimeMs(dirPath) {
  let newest = 0
  let entries = []

  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return newest
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, walkNewestMtimeMs(fullPath))
      continue
    }
    if (entry.isFile()) {
      newest = Math.max(newest, getNewestMtimeMs(fullPath))
    }
  }

  return newest
}

function findBareLinkBin() {
  const candidates = [
    path.join(repoRoot, 'packages', 'app', 'node_modules', '.bin', 'bare-link'),
    path.join(repoRoot, 'node_modules', '.bin', 'bare-link'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  throw new Error('Could not locate bare-link. Install app dependencies first.')
}

function getBundleHeader(buffer) {
  const newlineIndex = buffer.indexOf(0x0a)
  if (newlineIndex == -1) throw new Error(`Invalid bundle header for ${bundleFile}`)

  const headerLength = Number.parseInt(buffer.toString('utf8', 0, newlineIndex), 10)
  if (!Number.isFinite(headerLength) || headerLength <= 0) {
    throw new Error(`Invalid bundle header length for ${bundleFile}`)
  }

  const headerStart = newlineIndex + 1
  const headerEnd = headerStart + headerLength
  const rawHeader = buffer.toString('utf8', headerStart, headerEnd)
  const jsonEnd = rawHeader.lastIndexOf('}')
  if (jsonEnd === -1) throw new Error(`Could not parse bundle header for ${bundleFile}`)

  return JSON.parse(rawHeader.slice(0, jsonEnd + 1))
}

function toAbsoluteBundlePath(bundlePath) {
  if (typeof bundlePath !== 'string' || !bundlePath.startsWith('/')) return null
  return path.join(repoRoot, bundlePath.slice(1))
}

function collectLinkedAddonPackages(header) {
  const packages = new Map()

  for (const imports of Object.values(header?.resolutions || {})) {
    if (!imports || typeof imports !== 'object') continue

    const hasLinkedResolution = Object.values(imports).some(
      (value) => typeof value === 'string' && value.startsWith('linked:')
    )
    if (!hasLinkedResolution) continue

    const packageManifestPath = toAbsoluteBundlePath(imports['#package'])
    if (!packageManifestPath || !fs.existsSync(packageManifestPath)) continue

    const packageDir = path.dirname(packageManifestPath)
    if (packages.has(packageDir)) continue

    try {
      const manifest = JSON.parse(fs.readFileSync(packageManifestPath, 'utf8'))
      packages.set(packageDir, manifest.name || path.basename(packageDir))
    } catch {
      packages.set(packageDir, path.basename(packageDir))
    }
  }

  return [...packages.entries()].sort((left, right) => left[1].localeCompare(right[1]))
}

function getFrameworkTargets() {
  if (process.platform === 'darwin') {
    return ['darwin-arm64', 'darwin-x64']
  }

  return [`${process.platform}-${process.arch}`]
}

function ensureFrameworks() {
  const buffer = fs.readFileSync(bundleFile)
  const header = getBundleHeader(buffer)
  const addonPackages = collectLinkedAddonPackages(header)

  if (addonPackages.length === 0) {
    fs.rmSync(frameworkOutputDir, { recursive: true, force: true })
    fs.mkdirSync(frameworkOutputDir, { recursive: true })
    console.log('[bundle:native-worklet:addons] No linked addons detected')
    return
  }

  fs.rmSync(frameworkOutputDir, { recursive: true, force: true })
  fs.mkdirSync(frameworkOutputDir, { recursive: true })

  const bareLinkBin = findBareLinkBin()
  const targets = getFrameworkTargets()

  for (const [packageDir, packageName] of addonPackages) {
    const args = []

    for (const target of targets) {
      args.push('--target', target)
    }

    args.push('--out', frameworkOutputDir, packageDir)

    console.log(`[bundle:native-worklet:addons] Linking ${packageName}`)
    const result = spawnSync(bareLinkBin, args, {
      cwd: packageRoot,
      stdio: 'inherit',
      env: process.env,
    })

    if (result.status !== 0) {
      process.exit(result.status || 1)
    }
  }
}

const forced = process.env.PEARTUBE_FORCE_NATIVE_HOST_BUNDLE === '1'
const bundleMtime = Math.max(getNewestMtimeMs(bundleFile), scriptMtime, getRootsNewestMtimeMs(addonSourceRoots))
const frameworksMtime = walkNewestMtimeMs(frameworkOutputDir)
const missingFrameworks = frameworksMtime === 0
const staleFrameworks = !missingFrameworks && frameworksMtime < bundleMtime

if (forced || missingFrameworks || staleFrameworks) {
  const reason = forced ? 'forced rebuild' : missingFrameworks ? 'missing frameworks' : 'stale frameworks'
  console.log(`[bundle:native-worklet:addons] Rebuilding (${reason})`)
  ensureFrameworks()
} else {
  console.log('[bundle:native-worklet:addons] Linked addon frameworks are up to date')
}
