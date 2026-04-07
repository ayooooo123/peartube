/**
 * Builds the native host sidecar as a .app bundle via bare-build.
 * Native addons go into Frameworks/ inside the bundle and get codesigned
 * with the app — no Gatekeeper issues.
 *
 * Output: Resources/Generated/PearTubeHost.app
 *
 * The Swift app launches the .app's executable directly via Process().
 *
 * Usage:
 *   node scripts/build-native-sidecar.mjs
 *   PEARTUBE_SIDECAR_HOSTS=darwin-arm64 node scripts/build-native-sidecar.mjs
 */

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const entryFile = path.join(packageRoot, 'Bridge', 'native-host-sidecar.mjs')
const outputDir = path.join(packageRoot, 'Resources', 'Generated')
const appName = 'PearTubeHost'
const identifier = 'com.peartube.host-sidecar'

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
  return 'bare-build'
}

function build() {
  fs.mkdirSync(outputDir, { recursive: true })

  const hosts = getHosts()
  const bareBuild = findBareBuild()

  const args = [
    '--name', appName,
    '--identifier', identifier,
    '--out', outputDir,
  ]

  for (const host of hosts) {
    args.push('--host', host)
  }

  args.push(entryFile)

  console.log(`[build-native-sidecar] Building .app bundle for: ${hosts.join(', ')}`)
  console.log(`[build-native-sidecar] Entry: ${entryFile}`)
  console.log(`[build-native-sidecar] Output: ${outputDir}/${appName}.app`)

  const result = spawnSync(bareBuild, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    console.error('[build-native-sidecar] Build failed with exit code:', result.status)
    process.exit(result.status || 1)
  }

  // Ad-hoc codesign the .app bundle (signs all nested frameworks/addons)
  if (process.platform === 'darwin') {
    const appPath = path.join(outputDir, `${appName}.app`)
    const signResult = spawnSync('codesign', [
      '--force', '--deep', '--sign', '-', appPath,
    ], { stdio: 'inherit' })

    if (signResult.status === 0) {
      console.log('[build-native-sidecar] Ad-hoc codesigned .app bundle')
    } else {
      console.warn('[build-native-sidecar] codesign failed (non-fatal)')
    }
  }

  console.log('[build-native-sidecar] Done')
}

build()
