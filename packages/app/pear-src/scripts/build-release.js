#!/usr/bin/env node
/**
 * PearTube Release Builder
 *
 * Distribution methods:
 * - Desktop: Pear P2P distribution (pear stage/seed/release)
 * - iOS/Android: Expo/React Native builds
 *
 * Usage:
 *   node scripts/build-release.js <command> [options]
 */

import { spawn } from 'child_process'
import { mkdir, access, readFile, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pearDir = resolve(__dirname, '..')
const rootDir = resolve(__dirname, '../..')
const releasesDir = resolve(rootDir, 'releases')

async function run(cmd, args, cwd = pearDir) {
  return new Promise((resolve, reject) => {
    console.log(`\n> ${cmd} ${args.join(' ')}`)
    const proc = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: true,
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Command failed with code ${code}`))
    })
    proc.on('error', reject)
  })
}

async function ensureDir(dir) {
  try {
    await access(dir)
  } catch {
    await mkdir(dir, { recursive: true })
  }
}

async function getPackageInfo() {
  const pkgPath = join(pearDir, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
  return {
    name: pkg.pear?.name || pkg.name || 'PearTube',
    version: pkg.version || '0.1.0',
    identifier: 'com.peartube.app',
  }
}

/**
 * Stage the Pear app for P2P distribution
 */
async function stageDesktop() {
  const { name, version } = await getPackageInfo()

  console.log(`\n========================================`)
  console.log(`Staging ${name} v${version} for Pear P2P distribution`)
  console.log(`========================================\n`)

  await run('pear', ['stage', '.'], pearDir)

  console.log(`\n✓ Staging complete!`)
  console.log(`\nTo distribute, run: pear seed <your-pear-link>`)
  console.log(`Users can install with: pear run <your-pear-link>`)
}

/**
 * Seed the Pear app for distribution
 */
async function seedDesktop(link) {
  console.log(`\n========================================`)
  console.log(`Seeding Pear app: ${link}`)
  console.log(`========================================\n`)

  await run('pear', ['seed', link], pearDir)
}

/**
 * Release a new version of the Pear app
 */
async function releaseDesktop() {
  const { name, version } = await getPackageInfo()

  console.log(`\n========================================`)
  console.log(`Releasing ${name} v${version}`)
  console.log(`========================================\n`)

  await run('pear', ['release'], pearDir)

  console.log(`\n✓ Release complete!`)
}

/**
 * Build iOS app using Expo
 */
async function buildIOS(options = {}) {
  const { device = false, simulator = true } = options
  const { name, version } = await getPackageInfo()

  console.log(`\n========================================`)
  console.log(`Building ${name} v${version} for iOS`)
  console.log(`========================================\n`)

  // Build backend bundle first
  await run('npm', ['run', 'bundle:backend'], rootDir)

  if (simulator) {
    console.log('\nBuilding for iOS Simulator...')
    await run('npx', ['expo', 'run:ios'], rootDir)
  } else if (device) {
    console.log('\nBuilding for iOS Device...')
    await run('npx', ['expo', 'run:ios', '--device'], rootDir)
  }

  console.log(`\n✓ iOS build complete!`)
}

/**
 * Build Android app using Expo
 */
async function buildAndroid(options = {}) {
  const { apk = false, aab = false, device = false } = options
  const { name, version } = await getPackageInfo()

  console.log(`\n========================================`)
  console.log(`Building ${name} v${version} for Android`)
  console.log(`========================================\n`)

  // Build backend bundle first
  await run('npm', ['run', 'bundle:backend'], rootDir)

  if (apk) {
    console.log('\nBuilding APK...')
    await run('npx', ['expo', 'run:android', '--variant', 'release'], rootDir)
  } else if (aab) {
    console.log('\nBuilding AAB for Play Store...')
    // For AAB, use EAS Build or direct Gradle
    await run('cd', ['android', '&&', './gradlew', 'bundleRelease'], rootDir)
  } else {
    console.log('\nBuilding for Android (debug)...')
    await run('npx', ['expo', 'run:android'], rootDir)
  }

  console.log(`\n✓ Android build complete!`)
}

/**
 * Build for EAS (Expo Application Services) - cloud builds
 */
async function buildEAS(platform, profile = 'preview') {
  const { name, version } = await getPackageInfo()

  console.log(`\n========================================`)
  console.log(`Building ${name} v${version} with EAS (${platform})`)
  console.log(`========================================\n`)

  const args = ['eas', 'build', '--platform', platform, '--profile', profile]

  await run('npx', args, rootDir)

  console.log(`\n✓ EAS build submitted!`)
}

// Parse arguments
const args = process.argv.slice(2)
const command = args[0]
const flags = args.slice(1)

const hasFlag = (flag) => flags.includes(flag)
const getFlag = (flag) => {
  const idx = flags.indexOf(flag)
  return idx >= 0 && flags[idx + 1] ? flags[idx + 1] : null
}

// Run command
async function main() {
  switch (command) {
    case 'stage':
      await stageDesktop()
      break

    case 'seed':
      const link = flags[0]
      if (!link) {
        console.error('Error: Please provide a pear:// link to seed')
        process.exit(1)
      }
      await seedDesktop(link)
      break

    case 'release':
      await releaseDesktop()
      break

    case 'ios':
      await buildIOS({
        device: hasFlag('--device'),
        simulator: !hasFlag('--device'),
      })
      break

    case 'android':
      await buildAndroid({
        apk: hasFlag('--apk'),
        aab: hasFlag('--aab'),
        device: hasFlag('--device'),
      })
      break

    case 'eas':
      const platform = flags[0] || 'all'
      const profile = getFlag('--profile') || 'preview'
      await buildEAS(platform, profile)
      break

    default:
      console.log(`
PearTube Release Builder

Commands:

  Desktop (Pear P2P Distribution):
    stage               Stage app for P2P distribution
    seed <link>         Seed app for peers to download
    release             Create a new production release

  iOS:
    ios                 Build for iOS Simulator
    ios --device        Build for iOS device

  Android:
    android             Build for Android (debug)
    android --apk       Build release APK
    android --aab       Build AAB for Play Store

  Cloud Builds (EAS):
    eas ios             Build iOS with EAS
    eas android         Build Android with EAS
    eas all             Build both platforms with EAS

    Options:
      --profile <name>  EAS profile (development, preview, production)

Examples:
  node scripts/build-release.js stage
  node scripts/build-release.js ios --device
  node scripts/build-release.js android --apk
  node scripts/build-release.js eas all --profile production

Distribution Flow:
  1. Desktop: stage → seed → share pear:// link
  2. iOS: Build with Expo or EAS → Submit to App Store
  3. Android: Build APK/AAB → Distribute or submit to Play Store
`)
  }
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
