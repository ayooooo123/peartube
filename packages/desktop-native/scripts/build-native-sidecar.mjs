/**
 * Builds the native host sidecar as a standalone bare-native binary.
 * Replaces the bare-pack bundle + bare-runtime interpreter approach with
 * a single compiled executable that embeds the Bare runtime.
 *
 * Output: Resources/Generated/peartube-host-sidecar (standalone Mach-O binary)
 *
 * Usage:
 *   node scripts/build-native-sidecar.mjs
 *   PEARTUBE_SIDECAR_HOSTS=darwin-arm64,darwin-x64 node scripts/build-native-sidecar.mjs
 */

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const entryFile = path.join(packageRoot, 'Bridge', 'native-host-sidecar.mjs')
const outputDir = path.join(packageRoot, 'Resources', 'Generated')
const outputName = 'peartube-host-sidecar'

function getHosts() {
  if (process.env.PEARTUBE_SIDECAR_HOSTS) {
    return process.env.PEARTUBE_SIDECAR_HOSTS.split(',').map(h => h.trim())
  }
  if (process.platform === 'darwin') {
    return ['darwin-arm64', 'darwin-x64']
  }
  return [`${process.platform}-${process.arch}`]
}

function findBareBuild() {
  const candidates = [
    path.join(repoRoot, 'node_modules', '.bin', 'bare-build'),
    path.join(packageRoot, 'node_modules', '.bin', 'bare-build'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return 'bare-build' // hope it's in PATH
}

function build() {
  fs.mkdirSync(outputDir, { recursive: true })

  const hosts = getHosts()
  const bareBuild = findBareBuild()

  const args = [
    '--standalone',
    '--name', outputName,
    '--out', outputDir,
  ]

  for (const host of hosts) {
    args.push('--host', host)
  }

  args.push(entryFile)

  console.log(`[build-native-sidecar] Building standalone sidecar for: ${hosts.join(', ')}`)
  console.log(`[build-native-sidecar] Entry: ${entryFile}`)
  console.log(`[build-native-sidecar] Output: ${outputDir}/${outputName}`)

  const result = spawnSync(bareBuild, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    console.error('[build-native-sidecar] Build failed with exit code:', result.status)
    process.exit(result.status || 1)
  }

  // Ad-hoc codesign so macOS Gatekeeper allows execution
  if (process.platform === 'darwin') {
    const outputPath = path.join(outputDir, outputName)
    const signResult = spawnSync('codesign', ['--force', '--sign', '-', outputPath], {
      stdio: 'inherit',
    })
    if (signResult.status === 0) {
      console.log('[build-native-sidecar] Ad-hoc codesigned')
    } else {
      console.warn('[build-native-sidecar] codesign failed (non-fatal)')
    }
  }

  console.log('[build-native-sidecar] Done')
}

build()
