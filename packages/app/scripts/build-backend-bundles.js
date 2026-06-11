/* eslint-disable no-console */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
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
    fs.rmSync(outputPath, { force: true })
  } catch { /* best effort */ }
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

// The bare-pack output ships verbatim inside the Hermes bundle (see
// app/_layout.tsx), so every byte of unminified backend JS lands 1:1 in the
// APK/IPA. Minify each module inside the serialized bare-bundle in place.
function minifyBundleOutput(bundle) {
  const Bundle = require('bare-bundle')
  const bundleId = require('bare-bundle-id')
  const esbuild = require('esbuild')

  const outputPath = resolveRepoPath(bundle.output)
  const wrapped = fs.readFileSync(outputPath, 'utf8')
  const prefix = 'module.exports = '
  if (!wrapped.startsWith(prefix)) {
    throw new Error(`Unexpected bundle wrapper in ${bundle.output}; expected bare-pack bundle.cjs format`)
  }

  const parsed = Bundle.from(JSON.parse(wrapped.slice(prefix.length)))
  const sizeBefore = wrapped.length

  for (const [key, data, mode] of parsed) {
    if (!/\.(js|mjs|cjs)$/.test(key)) continue
    const source = data.toString('utf8')
    // keepNames protects constructor.name/fn.name checks used across the
    // hypercore stack.
    const { code } = esbuild.transformSync(source, {
      minify: true,
      target: 'es2022',
      keepNames: true,
    })
    parsed.write(key, code, { mode })
  }

  parsed.id = bundleId(parsed).toString('hex')

  const output = `${prefix}${JSON.stringify(parsed.toBuffer().toString('utf8'))}\n`
  fs.writeFileSync(outputPath, output)

  const savedPct = Math.round((1 - output.length / sizeBefore) * 100)
  console.log(`[bundle:backend] ${bundle.id}: minified ${sizeBefore} -> ${output.length} bytes (-${savedPct}%)`)
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

// bare-pack relies on bare-module-lexer to discover require() calls; a lexer
// regression once silently dropped modules required from inside
// `module.exports = { ... }` literals (bare-module-lexer 1.5.1), shipping a
// worklet bundle without bare-rpc — the backend then never started on device.
// Re-scan the packed output with an independent regex and fail the build if
// any literal require() in a bundled CJS file has no resolution entry.
async function verifyBundleRequireCoverage(bundle) {
  const { createRequire } = await import('node:module')
  const requireFromApp = createRequire(path.join(projectRoot, 'package.json'))
  const Bundle = requireFromApp('bare-bundle')

  const outputPath = resolveRepoPath(bundle.output)
  const packed = Bundle.from(Buffer.from(requireFromApp(outputPath)))

  const problems = []
  for (const key of packed.keys()) {
    if (!/\.(js|cjs)$/.test(key)) continue

    const source = stripComments(packed.read(key).toString())
    const resolutions = packed.resolutions[key] || {}
    const requirePattern = /(?:^|[^.\w$])require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g

    let match
    while ((match = requirePattern.exec(source))) {
      const specifier = match[1]
      if (specifier.startsWith('bare:') || specifier.startsWith('node:')) continue
      if (!(specifier in resolutions)) problems.push(`${key} -> ${specifier}`)
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `[bundle:backend] ${bundle.id}: packed bundle is missing resolutions for ` +
      `${problems.length} require() call(s) — the module lexer likely failed to ` +
      `see them and bare-pack dropped the modules:\n  ${problems.join('\n  ')}`
    )
  }

  console.log(`[bundle:backend] ${bundle.id}: require() coverage verified`)
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

  for (const bundle of bundles) {
    runBarePack(bundle)
    // Verify bare-pack's lexer didn't drop modules before rewriting the
    // bundle, so coverage is checked against the untouched pack output.
    await verifyBundleRequireCoverage(bundle)
    if (bundle.minify !== false) minifyBundleOutput(bundle)
  }
}

main().catch(err => {
  console.error('[bundle:backend] Failed:', err)
  process.exit(1)
})
