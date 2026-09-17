#!/usr/bin/env node
/* eslint-disable no-console */
// Assembles a Pear Deployment Directory for the PearTube mobile OTA.
//
// Deliberately not `pear-build`: that only emits `android-arm64` for Android, while
// PearTube ships four Android ABIs (plugins/withAndroidAbiSplits.js) and its release
// workflow builds arm64-v8a, x86 and x86_64. The updater derives its host from Bare's
// own platform/arch and resolves exactly `/by-arch/<host>/app/<productName>`, so a host
// with no directory finds nothing at all. This script therefore covers the whole Bare
// mobile host set.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import semver from 'semver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(projectRoot, '..', '..')
const requireFromApp = createRequire(path.join(projectRoot, 'package.json'))

const LOG = '[build:ota]'

// React Native bundles are architecture-agnostic within a platform, so one bundle per
// platform is fanned out over every Bare host of that platform. The host names are
// bare-pack's `mobile` preset, which is also what the Bare worker bundles are packed for.
const PLATFORM_HOSTS = {
  android: ['android-arm', 'android-arm64', 'android-ia32', 'android-x64'],
  ios: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'],
}

const ALL_HOSTS = Object.values(PLATFORM_HOSTS).flat()

// `upgrade` is a pear:// key link: z-base-32 of a 32-byte public key.
const PEAR_LINK = /^pear:\/\/[a-z0-9]{52}$/

// The OTA bundle is read from disk by native bundle selection as plain JS source, not as
// precompiled Hermes bytecode (that step only happens for the bundle baked into the
// binary), so a `--dev false` Metro bundle is exactly the right artifact.
const BUNDLE_NAME = 'app.bundle'

// Staged Metro output lives inside the output directory, so the whole build has exactly
// one thing to wipe and nothing escapes into the tree that gets staged onto the link.
const STAGE_DIR = '.stage'

function usage() {
  return `build-ota-payload.mjs - assemble a Pear Deployment Directory for the PearTube mobile OTA

Usage: node scripts/build-ota-payload.mjs [--bundles | --assemble] [options]

Writes, under the output directory:

  package.json                                    copied verbatim; the version the updater compares
  pear.json                                       copied verbatim; the updates.minver gate
  ${`by-arch/<host>/app/<productName>/${BUNDLE_NAME}`.padEnd(46)}  one Metro bundle per platform
  by-arch/<host>/app/<productName>/assets/...     the assets that bundle references

for all ${ALL_HOSTS.length} Bare mobile hosts:

  ${ALL_HOSTS.join(', ')}

Phases (default: both, in order):
  --bundles         Only run the Metro bundles, into <out>/${STAGE_DIR}/<platform>/<productName>.
                    Wipes <out> first, and refuses to run unless the Bare worker bundles
                    are current, because app/_layout.tsx require()s them into the Metro
                    bundle and a stale backend.bundle.js ships silently.
  --assemble        Only fan the staged bundles out over the hosts, copy package.json and
                    pear.json in, and print the tree. Requires a preceding --bundles run.

Options:
  --out <dir>       Output directory, relative to packages/app (default: dist).
  --skip-backend    Skip the backend-bundle freshness check in the --bundles phase. The
                    bundles must still exist. Only use this right after bundle:backend.
  -h, --help        Show this message.

Refuses to produce a payload unless package.json has "version", "productName" and a
pear:// "upgrade", and pear.json has "updates.minver".

Next step, once the tree looks right:

  cd <out> && pear stage <package.json "upgrade" link>`
}

function fail(message, ...rest) {
  console.error(`${LOG} ${message}`)
  for (const line of rest) console.error(`${LOG}   ${line}`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { out: 'dist', skipBackend: false, bundles: false, assemble: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      console.log(usage())
      process.exit(0)
    } else if (arg === '--bundles') {
      options.bundles = true
    } else if (arg === '--assemble') {
      options.assemble = true
    } else if (arg === '--skip-backend') {
      options.skipBackend = true
    } else if (arg === '--out') {
      const value = argv[++i]
      if (!value || value.startsWith('-')) fail('--out needs a directory')
      options.out = value
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length)
      if (!options.out) fail('--out needs a directory')
    } else {
      fail(`unknown argument: ${arg}`, 'run with --help for usage')
    }
  }

  // No phase named means the whole build.
  if (!options.bundles && !options.assemble) {
    options.bundles = true
    options.assemble = true
  }

  return options
}

function readJson(file, why) {
  const rel = path.relative(projectRoot, file)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    fail(`cannot read ${rel}: ${err.code === 'ENOENT' ? 'file does not exist' : err.message}`, why)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    fail(`cannot parse ${rel}: ${err.message}`)
  }
}

// The official SemVer 2.0.0 grammar, which is what the on-device parsers in
// pear-runtime-react-native's AppDelegate/MainApplication templates implement. node-semver
// is more forgiving than that (it accepts `v0.2.46`, for one), and anything the strict
// grammar rejects counts as not newer on device, so the app would silently keep booting
// the bundle shipped in its binary. Catch it here instead.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

const isSemVer = value => typeof value === 'string' && SEMVER.test(value)

// One row per field the updater and boot control need: how to recognise a usable value,
// and what goes wrong without one.
const IDENTITY_FIELDS = [
  {
    label: 'package.json "version"',
    ok: isSemVer,
    missing: 'the updater has nothing to compare',
    invalid:
      'is not SemVer 2.0.0; the version comparison on device rejects it and keeps the bundle shipped in the binary',
  },
  {
    label: 'package.json "productName"',
    ok: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value),
    missing: 'it names the directory the updater resolves at by-arch/<host>/app/<productName>',
    invalid: 'is not usable as a single directory name',
  },
  {
    label: 'package.json "upgrade"',
    ok: value => typeof value === 'string' && PEAR_LINK.test(value),
    missing:
      'the updater parses the link in its constructor, so it throws at construction even when updates are disabled',
    invalid: 'is not a pear:// key link; allocate one with `pear touch` rather than inventing it',
  },
  {
    label: 'pear.json "updates.minver"',
    ok: isSemVer,
    missing: 'nothing would keep this payload away from a native build too old to run it',
    invalid: 'is not valid SemVer',
  },
]

// Every identity field is checked together, so a human sees all of the problems at once
// instead of one per run.
function loadIdentity() {
  const pkgPath = path.join(projectRoot, 'package.json')
  const pearPath = path.join(projectRoot, 'pear.json')
  const pkg = readJson(
    pkgPath,
    'without the manifest there is no version to compare, so boot control falls back to the bundle shipped in the binary',
  )
  const pear = readJson(pearPath, 'without pear.json a payload has no minver gate and must not be staged')

  const values = [pkg.version, pkg.productName, pkg.upgrade, pear?.updates?.minver]
  const problems = IDENTITY_FIELDS.flatMap((field, index) => {
    const value = values[index]
    if (value === undefined) return [`${field.label} is missing; ${field.missing}`]
    if (!field.ok(value)) return [`${field.label} (${JSON.stringify(value)}) ${field.invalid}`]
    return []
  })

  const [version, productName, upgrade, minver] = values
  if (isSemVer(version) && isSemVer(minver) && semver.gt(minver, version)) {
    problems.push(
      `pear.json "updates.minver" (${minver}) is greater than package.json "version" (${version}); no native build could ever take this payload, because any build new enough for the gate already boots a newer bundle than this one`,
    )
  }

  if (problems.length > 0) {
    fail(`refusing to build a payload, ${problems.length} problem(s):`, ...problems)
  }

  return { pkg, pkgPath, pearPath, version, productName, upgrade, minver }
}

// The payload must cover every host Bare can report on mobile. bare-pack's `mobile`
// preset is that list, so if an upgrade of bare-pack grows it this build fails loudly
// instead of shipping a payload some device cannot resolve.
function assertHostCoverage() {
  const presetPath = path.join(projectRoot, 'node_modules/bare-pack/lib/preset/mobile.js')
  if (!fs.existsSync(presetPath)) {
    fail(
      `cannot verify host coverage: ${path.relative(projectRoot, presetPath)} is missing`,
      'install packages/app dependencies (bare-pack) before building a payload',
    )
  }

  // Absolute path, so bare-pack's `exports` map does not block the subpath.
  const preset = requireFromApp(presetPath)
  const missing = preset.hosts.filter(host => !ALL_HOSTS.includes(host))
  if (missing.length > 0) {
    fail(
      `bare-pack's mobile preset lists hosts this script does not cover: ${missing.join(', ')}`,
      'add them to PLATFORM_HOSTS, or the updater finds nothing on those devices',
    )
  }
}

// `main` is `expo-router/entry`, a package specifier rather than a file, and
// `react-native bundle` needs a real path. A local index.* wins if one ever appears.
function resolveEntryFile(pkg) {
  for (const candidate of ['index.ts', 'index.tsx', 'index.js', 'index.jsx']) {
    if (fs.existsSync(path.join(projectRoot, candidate))) return candidate
  }

  const main = pkg.main
  if (typeof main !== 'string' || main === '') {
    fail('package.json has no "main" and packages/app has no index.ts, so there is no Metro entry file')
  }
  if (main.startsWith('.') || path.isAbsolute(main)) {
    const resolved = path.resolve(projectRoot, main)
    if (!fs.existsSync(resolved)) fail(`package.json "main" (${main}) does not exist`)
    return path.relative(projectRoot, resolved)
  }

  try {
    return path.relative(projectRoot, requireFromApp.resolve(main))
  } catch (err) {
    fail(`cannot resolve package.json "main" (${main}): ${err.message}`)
  }
}

// backend.bundle.js and downloader-worker.bundle.js are require()d into the Metro bundle
// by app/_layout.tsx, so they have to be built and current *before* Metro runs; otherwise
// the payload silently ships whatever Bare worker code was lying around.
async function ensureBackendBundles(skip) {
  if (!skip) {
    console.log(`${LOG} ensuring Bare worker bundles are current (ensure-backend-bundles.js)`)
    const result = spawnSync(process.execPath, [path.join(__dirname, 'ensure-backend-bundles.js')], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    })
    if (result.status !== 0) {
      fail('the Bare worker bundle check failed; refusing to bundle a frontend around a stale backend')
    }
  }

  const manifest = await import(
    pathToFileURL(path.join(projectRoot, 'backend-bundles.manifest.mjs')).href
  ).then(mod => mod.default ?? mod.backendBundlesManifest)

  const missing = manifest.bundles
    .filter(bundle => bundle.runtime?.required !== false)
    .map(bundle => path.resolve(repoRoot, bundle.output))
    .filter(output => !fs.existsSync(output))

  if (missing.length > 0) {
    fail(
      'the Bare worker bundles app/_layout.tsx requires do not exist:',
      ...missing.map(output => path.relative(repoRoot, output)),
      'run `npm run bundle:backend --prefix packages/app` first',
    )
  }
}

// Assets travel with the bundle (iOS: assets/..., Android: drawable-*/raw resource dirs)
// so the payload is the complete Metro output, but neither platform installs them from an
// OTA: both resolve asset references against the installed binary. That is the reason an
// OTA may only change JS that stays compatible with the assets the store build shipped.
function runMetroBundle(platform, entryFile, stageDir) {
  const args = [
    requireFromApp.resolve('react-native/cli.js'),
    'bundle',
    '--platform',
    platform,
    '--dev',
    'false',
    '--entry-file',
    entryFile,
    '--bundle-output',
    path.join(stageDir, BUNDLE_NAME),
    '--assets-dest',
    stageDir,
  ]

  console.log(`${LOG} react-native bundle --platform ${platform} --dev false --entry-file ${entryFile}`)
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', EXPO_NO_METRO_WORKSPACE_ROOT: '1' },
  })

  if (result.error) fail(`react-native bundle (${platform}) could not start: ${result.error.message}`)
  if (result.status !== 0) fail(`react-native bundle (${platform}) failed with exit code ${result.status}`)
  if (!fs.existsSync(path.join(stageDir, BUNDLE_NAME))) {
    fail(`react-native bundle (${platform}) reported success but wrote no ${BUNDLE_NAME}`)
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

// Directory listing a human can actually eyeball: every level is shown, but wide
// directories (asset trees) collapse to a count so the bundle paths stay visible.
function printTree(dir, prefix = '', maxEntries = 8) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
    )

  const shown = entries.length > maxEntries ? entries.slice(0, maxEntries) : entries
  const truncated = entries.length - shown.length

  shown.forEach((entry, index) => {
    const last = truncated === 0 && index === shown.length - 1
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      console.log(`${prefix}${last ? '`-- ' : '|-- '}${entry.name}/`)
      printTree(full, `${prefix}${last ? '    ' : '|   '}`, maxEntries)
    } else {
      console.log(`${prefix}${last ? '`-- ' : '|-- '}${entry.name}  (${formatBytes(fs.statSync(full).size)})`)
    }
  })

  if (truncated > 0) {
    console.log(`${prefix}\`-- ... ${truncated} more entr${truncated === 1 ? 'y' : 'ies'}`)
  }
}

function measure(dir) {
  let files = 0
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = measure(full)
      files += nested.files
      bytes += nested.bytes
    } else {
      files++
      bytes += fs.statSync(full).size
    }
  }
  return { files, bytes }
}

async function bundlePhase(options, identity, distDir, entryFile) {
  await ensureBackendBundles(options.skipBackend)

  // Deterministic and idempotent: nothing from a previous run survives.
  fs.rmSync(distDir, { recursive: true, force: true })

  for (const platform of Object.keys(PLATFORM_HOSTS)) {
    const stageDir = path.join(distDir, STAGE_DIR, platform, identity.productName)
    fs.mkdirSync(stageDir, { recursive: true })
    runMetroBundle(platform, entryFile, stageDir)
  }
}

function assemblePhase(identity, distDir, entryFile) {
  const stageRoot = path.join(distDir, STAGE_DIR)
  const staged = Object.keys(PLATFORM_HOSTS).map(platform => ({
    platform,
    dir: path.join(stageRoot, platform, identity.productName),
  }))

  const unstaged = staged.filter(entry => !fs.existsSync(path.join(entry.dir, BUNDLE_NAME)))
  if (unstaged.length > 0) {
    fail(
      `no staged Metro bundle for: ${unstaged.map(entry => entry.platform).join(', ')}`,
      `expected ${path.relative(repoRoot, stageRoot)}/<platform>/${identity.productName}/${BUNDLE_NAME}`,
      'run the bundling phase first (`npm run bundle:ota --prefix packages/app`)',
    )
  }

  // Assembling again over an existing payload must not leave a host from a previous run
  // behind, so the fanned-out tree and the two manifests are rebuilt from scratch.
  fs.rmSync(path.join(distDir, 'by-arch'), { recursive: true, force: true })

  try {
    for (const { platform, dir } of staged) {
      for (const host of PLATFORM_HOSTS[platform]) {
        const appDir = path.join(distDir, 'by-arch', host, 'app')
        fs.mkdirSync(appDir, { recursive: true })
        fs.cpSync(dir, path.join(appDir, identity.productName), { recursive: true })
      }
    }
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true })
  }

  // Both files are mandatory at the payload root: without the manifest there is no
  // version to compare and boot control falls back to the bundle shipped in the binary,
  // and without pear.json the minver gate is gone.
  fs.copyFileSync(identity.pkgPath, path.join(distDir, 'package.json'))
  fs.copyFileSync(identity.pearPath, path.join(distDir, 'pear.json'))

  const total = measure(distDir)

  console.log('')
  console.log(`${LOG} ${path.relative(repoRoot, distDir)}/`)
  printTree(distDir)
  console.log('')
  console.log(`${LOG} productName : ${identity.productName}`)
  console.log(
    `${LOG} version     : ${identity.version}  (must exceed every installed native build and every published OTA)`,
  )
  console.log(
    `${LOG} minver      : ${identity.minver}  (pear.json gate: native builds below this never take this payload)`,
  )
  console.log(`${LOG} upgrade     : ${identity.upgrade}`)
  console.log(`${LOG} entry       : ${entryFile}`)
  console.log(`${LOG} hosts       : ${ALL_HOSTS.length} (${ALL_HOSTS.join(', ')})`)
  console.log(`${LOG} payload     : ${total.files} files, ${formatBytes(total.bytes)}`)
  console.log('')
  console.log(`${LOG} stage it with: cd ${path.relative(repoRoot, distDir)} && pear stage ${identity.upgrade}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const identity = loadIdentity()
  assertHostCoverage()

  const entryFile = resolveEntryFile(identity.pkg)
  const distDir = path.resolve(projectRoot, options.out)
  if (distDir === projectRoot || !distDir.startsWith(projectRoot + path.sep)) {
    fail(`--out (${options.out}) must be a directory inside packages/app; it gets wiped on every run`)
  }

  if (options.bundles) await bundlePhase(options, identity, distDir, entryFile)
  if (options.assemble) assemblePhase(identity, distDir, entryFile)
}

main().catch(err => {
  console.error(`${LOG} failed:`, err)
  process.exit(1)
})
