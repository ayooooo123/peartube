#!/usr/bin/env node
/* eslint-disable no-console */
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
const defaultAddonsRoot = path.join(
  appRoot,
  'node_modules',
  'react-native-bare-kit',
  'android',
  'src',
  'main',
  'addons',
)

function resolveRepoPath(relativePath) {
  if (path.isAbsolute(relativePath)) return path.normalize(relativePath)
  return path.resolve(repoRoot, relativePath)
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

function visitResolutionValue(value, onValue) {
  if (typeof value === 'string') {
    onValue(value)
    return
  }

  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      visitResolutionValue(nested, onValue)
    }
  }
}

export function collectAndroidLinkedAddonNames(bundleOutputPaths) {
  const names = new Set()

  for (const bundleOutputPath of bundleOutputPaths) {
    const bundle = readWrappedBareBundle(bundleOutputPath)

    for (const imports of Object.values(bundle.resolutions)) {
      for (const value of Object.values(imports)) {
        visitResolutionValue(value, (resolution) => {
          if (!resolution.startsWith('linked:')) return

          const name = resolution.slice('linked:'.length)
          if (/^lib[^/]+\.so$/.test(name)) names.add(name)
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

export function pruneAndroidBareAddons({
  addonsRoot,
  keepNames,
  bundleOutputPaths,
  abis = [],
  dryRun = false,
}) {
  const keep = normalizeKeepNames(keepNames) || collectAndroidLinkedAddonNames(bundleOutputPaths || [])

  if (keep.size === 0) {
    throw new Error('Refusing to prune Android Bare addons with an empty linked library keep-set')
  }

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

  return {
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
  console.log(`Usage: node scripts/prune-android-bare-addons.mjs [options]

Options:
  --manifest <file>      Backend bundle manifest. Defaults to backend-bundles.manifest.mjs.
  --bundle <file>        Bare bundle output to scan. Can be passed more than once.
  --addons-root <dir>    Android Bare addon root. Defaults to react-native-bare-kit addons.
  --abi <name>           ABI directory to prune. Can be passed more than once.
  --dry-run              Print removals without deleting files.
  --help                 Show this help.
`)
}

function parseArgs(argv) {
  const options = {
    manifestPath: defaultManifestPath,
    bundleOutputPaths: [],
    addonsRoot: defaultAddonsRoot,
    abis: [],
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    switch (arg) {
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

  let bundleOutputPaths = options.bundleOutputPaths
  if (bundleOutputPaths.length === 0) {
    const manifest = await loadManifest(options.manifestPath)
    bundleOutputPaths = manifest.bundles.map((bundle) => resolveRepoPath(bundle.output))
  }

  const result = pruneAndroidBareAddons({
    addonsRoot: options.addonsRoot,
    bundleOutputPaths,
    abis: options.abis,
    dryRun: options.dryRun,
  })

  const action = options.dryRun ? 'Would remove' : 'Removed'
  console.log(`[bare-addons] Keeping ${result.keepNames.length} linked Android libraries`)
  console.log(`[bare-addons] ${action} ${result.removed.length} unreferenced Android libraries`)

  for (const entry of result.removed) {
    console.log(`[bare-addons] ${options.dryRun ? 'would remove' : 'removed'} ${entry.abi}/${entry.name}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error('[bare-addons] Failed:', err)
    process.exit(1)
  })
}
