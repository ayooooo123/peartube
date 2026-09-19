#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Prune the Bare addons `bare-link` produced but our bundles never load.
 *
 * `bare-link` walks the whole dependency graph of packages/app and links every
 * package marked `"addon": true`, per host. It has no filter option, so
 * react-native-bare-kit hands us every addon reachable from node_modules —
 * image codecs we never decode, and several versions of the same addon pulled
 * in by nested dependencies. The packed bare bundles record exactly which
 * addons they resolve, in `linked:` specifiers, so those headers are the
 * authority on what has to ship.
 *
 * Android keeps per-ABI `lib<name>.<version>.so` files; Apple keeps
 * `<name>.<version>.xcframework` directories. Both are pruned after the link
 * step and before the platform packages them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const Bundle = require('bare-bundle')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')
const defaultManifestPath = path.join(appRoot, 'backend-bundles.manifest.mjs')

const bareKitRoot = path.join(appRoot, 'node_modules', 'react-native-bare-kit')

export const PLATFORMS = ['android', 'ios']

/**
 * Condition keys a bare bundle can branch a resolution on. Anything outside
 * this set (a bare specifier, `default`, `require`) is traversed for every
 * platform; a key inside it only counts for its own platform.
 */
const CONDITION_KEYS = new Set(['android', 'ios', 'darwin', 'linux', 'win32'])

const platformDefaults = {
  android: {
    addonsRoot: path.join(bareKitRoot, 'android', 'src', 'main', 'addons'),
    label: 'Android shared libraries',
  },
  ios: {
    addonsRoot: path.join(bareKitRoot, 'ios', 'addons'),
    label: 'iOS XCFrameworks',
  },
}

function resolveRepoPath(relativePath) {
  if (path.isAbsolute(relativePath)) return path.normalize(relativePath)
  return path.resolve(repoRoot, relativePath)
}

function assertPlatform(platform) {
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`Unknown platform '${platform}'. Expected one of: ${PLATFORMS.join(', ')}`)
  }
  return platform
}

function normalizeKeepNames(keepNames) {
  if (keepNames instanceof Set) return new Set(keepNames)
  if (Array.isArray(keepNames)) return new Set(keepNames)
  return null
}

function readWrappedBareBundle(outputPath) {
  const source = fs.readFileSync(outputPath, 'utf8').trim()
  const prefix = 'module.exports = '
  if (!source.startsWith(prefix)) {
    throw new Error(`Unexpected bare bundle wrapper in ${outputPath}`)
  }

  let encoded = source.slice(prefix.length).trim()
  if (encoded.endsWith(';')) encoded = encoded.slice(0, -1).trim()

  return Bundle.from(JSON.parse(encoded))
}

function visitResolutionValue(value, platform, onValue) {
  if (typeof value === 'string') {
    onValue(value)
    return
  }

  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (CONDITION_KEYS.has(key) && key !== platform) continue
      visitResolutionValue(nested, platform, onValue)
    }
  }
}

/**
 * `linked:libbare-fs.4.7.1.so` -> `libbare-fs.4.7.1.so`
 * `linked:bare-fs.4.7.1.framework/bare-fs.4.7.1` -> `bare-fs.4.7.1.xcframework`
 */
function linkedArtifactName(resolution, platform) {
  if (!resolution.startsWith('linked:')) return null
  const linked = resolution.slice('linked:'.length)

  if (platform === 'android') {
    return /^lib[^/]+\.so$/.test(linked) ? linked : null
  }

  const [bundleName] = linked.split('/')
  if (!bundleName.endsWith('.framework')) return null
  return `${bundleName.slice(0, -'.framework'.length)}.xcframework`
}

export function collectLinkedAddonNames(bundleOutputPaths, platform) {
  assertPlatform(platform)
  const names = new Set()

  for (const bundleOutputPath of bundleOutputPaths) {
    const bundle = readWrappedBareBundle(bundleOutputPath)

    for (const imports of Object.values(bundle.resolutions)) {
      for (const value of Object.values(imports)) {
        visitResolutionValue(value, platform, (resolution) => {
          const name = linkedArtifactName(resolution, platform)
          if (name) names.add(name)
        })
      }
    }
  }

  return names
}

function listAbiDirectories(addonsRoot, abis) {
  if (abis && abis.length > 0) {
    return abis
      .map((abi) => ({ abi, dir: path.join(addonsRoot, abi) }))
      .filter(({ dir }) => fs.existsSync(dir) && fs.statSync(dir).isDirectory())
  }

  return fs.readdirSync(addonsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ abi: entry.name, dir: path.join(addonsRoot, entry.name) }))
}

function pruneAndroid({ addonsRoot, keep, abis, dryRun }) {
  const removed = []
  const kept = []

  for (const { abi, dir } of listAbiDirectories(addonsRoot, abis)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.so')) continue

      const filePath = path.join(dir, entry.name)
      if (keep.has(entry.name)) {
        kept.push({ abi, name: entry.name, path: filePath })
        continue
      }

      removed.push({ abi, name: entry.name, path: filePath })
      if (!dryRun) fs.rmSync(filePath)
    }
  }

  return { kept, removed }
}

function pruneApple({ addonsRoot, keep, dryRun }) {
  const removed = []
  const kept = []

  for (const entry of fs.readdirSync(addonsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.xcframework')) continue

    const frameworkPath = path.join(addonsRoot, entry.name)
    if (keep.has(entry.name)) {
      kept.push({ name: entry.name, path: frameworkPath })
      continue
    }

    removed.push({ name: entry.name, path: frameworkPath })
    if (!dryRun) fs.rmSync(frameworkPath, { recursive: true, force: true })
  }

  return { kept, removed }
}

export function pruneBareAddons({
  platform,
  addonsRoot,
  keepNames,
  bundleOutputPaths,
  abis = [],
  dryRun = false,
}) {
  assertPlatform(platform)

  const keep = normalizeKeepNames(keepNames)
    || collectLinkedAddonNames(bundleOutputPaths || [], platform)

  if (keep.size === 0) {
    throw new Error(`Refusing to prune ${platform} Bare addons with an empty linked keep-set`)
  }

  const root = addonsRoot || platformDefaults[platform].addonsRoot
  if (!fs.existsSync(root)) {
    throw new Error(`Bare addon root does not exist: ${root}`)
  }

  const { kept, removed } = platform === 'android'
    ? pruneAndroid({ addonsRoot: root, keep, abis, dryRun })
    : pruneApple({ addonsRoot: root, keep, dryRun })

  return {
    platform,
    addonsRoot: root,
    keepNames: [...keep].sort(),
    kept,
    removed,
    dryRun,
  }
}

async function loadManifest(manifestPath) {
  const mod = await import(pathToFileURL(manifestPath).href)
  return mod.default || mod.backendBundlesManifest
}

function printHelp() {
  console.log(`Usage: node scripts/prune-bare-addons.mjs --platform <android|ios> [options]

Options:
  --platform <name>      Target platform. Required.
  --manifest <file>      Backend bundle manifest. Defaults to backend-bundles.manifest.mjs.
  --bundle <file>        Bare bundle output to scan. Can be passed more than once.
  --addons-root <dir>    Bare addon root. Defaults to the react-native-bare-kit addons for the platform.
  --abi <name>           Android ABI directory to prune. Can be passed more than once.
  --list                 Print the linked keep-set, one name per line, and exit.
  --dry-run              Print removals without deleting anything.
  --help                 Show this help.
`)
}

function parseArgs(argv) {
  const options = {
    platform: null,
    manifestPath: defaultManifestPath,
    bundleOutputPaths: [],
    addonsRoot: null,
    abis: [],
    list: false,
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    switch (arg) {
      case '--platform':
        options.platform = assertPlatform(argv[++i])
        break
      case '--manifest':
        options.manifestPath = path.resolve(argv[++i])
        break
      case '--bundle':
        options.bundleOutputPaths.push(path.resolve(argv[++i]))
        break
      case '--addons-root':
        options.addonsRoot = path.resolve(argv[++i])
        break
      case '--abi':
        options.abis.push(argv[++i])
        break
      case '--list':
        options.list = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    printHelp()
    return
  }

  if (!options.platform) {
    printHelp()
    throw new Error('--platform is required')
  }

  let bundleOutputPaths = options.bundleOutputPaths
  if (bundleOutputPaths.length === 0) {
    const manifest = await loadManifest(options.manifestPath)
    bundleOutputPaths = manifest.bundles.map((bundle) => resolveRepoPath(bundle.output))
  }

  for (const bundlePath of bundleOutputPaths) {
    if (fs.existsSync(bundlePath)) continue
    throw new Error(
      `Missing bare bundle ${bundlePath}. Run \`npm run bundle:backend\` before pruning addons.`,
    )
  }

  if (options.list) {
    for (const name of [...collectLinkedAddonNames(bundleOutputPaths, options.platform)].sort()) {
      console.log(name)
    }
    return
  }

  const result = pruneBareAddons({
    platform: options.platform,
    addonsRoot: options.addonsRoot,
    bundleOutputPaths,
    abis: options.abis,
    dryRun: options.dryRun,
  })

  const action = options.dryRun ? 'Would remove' : 'Removed'
  const { label } = platformDefaults[result.platform]
  console.log(`[bare-addons] Keeping ${result.keepNames.length} linked ${label}`)
  console.log(`[bare-addons] ${action} ${result.removed.length} unreferenced ${label}`)

  for (const entry of result.removed) {
    const name = entry.abi ? `${entry.abi}/${entry.name}` : entry.name
    console.log(`[bare-addons] ${options.dryRun ? 'would remove' : 'removed'} ${name}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error('[bare-addons] Failed:', err.message || err)
    process.exit(1)
  })
}
