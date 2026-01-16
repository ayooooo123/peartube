#!/usr/bin/env node
/**
 * bare-mpv postinstall script
 * 
 * Handles:
 * 1. Checking for prebuilds for the current platform
 * 2. Initializing git submodules if building from source is needed
 * 3. Providing clear guidance when manual build is required
 */

const fs = require('fs')
const path = require('path')
const { execSync, spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const PREBUILDS_DIR = path.join(ROOT, 'prebuilds')
const VENDOR_MPV_DIR = path.join(ROOT, 'vendor', 'mpv')

// Map Node.js platform/arch to prebuild directory names
function getPrebuildTarget() {
  const platform = process.platform
  const arch = process.arch
  
  let targetPlatform
  switch (platform) {
    case 'darwin':
      targetPlatform = 'darwin'
      break
    case 'linux':
      targetPlatform = 'linux'
      break
    case 'win32':
      targetPlatform = 'win32'
      break
    default:
      return null
  }
  
  let targetArch
  switch (arch) {
    case 'arm64':
      targetArch = 'arm64'
      break
    case 'x64':
      targetArch = 'x64'
      break
    default:
      return null
  }
  
  return `${targetPlatform}-${targetArch}`
}

function hasPrebuild(target) {
  if (!target) return false
  const prebuildPath = path.join(PREBUILDS_DIR, target, 'bare-mpv.bare')
  try {
    const stats = fs.statSync(prebuildPath)
    // Check it's not just an empty placeholder
    return stats.isFile() && stats.size > 1000
  } catch {
    return false
  }
}

function hasVendorMpv() {
  const mesonBuild = path.join(VENDOR_MPV_DIR, 'meson.build')
  try {
    return fs.existsSync(mesonBuild)
  } catch {
    return false
  }
}

function isGitRepo() {
  try {
    execSync('git rev-parse --git-dir', { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function initSubmodules() {
  console.log('[bare-mpv] Initializing git submodules...')
  try {
    // Try to initialize from the monorepo root first
    const result = spawnSync('git', ['submodule', 'update', '--init', '--recursive', 'vendor/mpv'], {
      cwd: ROOT,
      stdio: 'inherit'
    })
    
    if (result.status !== 0) {
      // Try from parent directories (monorepo case)
      const monoRoot = findMonorepoRoot()
      if (monoRoot) {
        const relativePath = path.relative(monoRoot, path.join(ROOT, 'vendor', 'mpv'))
        spawnSync('git', ['submodule', 'update', '--init', '--recursive', relativePath], {
          cwd: monoRoot,
          stdio: 'inherit'
        })
      }
    }
    
    return hasVendorMpv()
  } catch (err) {
    console.error('[bare-mpv] Failed to initialize submodules:', err.message)
    return false
  }
}

function findMonorepoRoot() {
  let dir = ROOT
  for (let i = 0; i < 5; i++) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    
    const gitDir = path.join(parent, '.git')
    if (fs.existsSync(gitDir)) {
      return parent
    }
    dir = parent
  }
  return null
}

function checkBuildPrerequisites() {
  const missing = []
  
  // Check for CMake
  try {
    execSync('cmake --version', { stdio: 'ignore' })
  } catch {
    missing.push('cmake (>= 3.25)')
  }
  
  // Check for Meson
  try {
    execSync('meson --version', { stdio: 'ignore' })
  } catch {
    missing.push('meson')
  }
  
  // Check for pkg-config
  try {
    execSync('pkg-config --version', { stdio: 'ignore' })
  } catch {
    missing.push('pkg-config')
  }
  
  // Check for Ninja
  try {
    execSync('ninja --version', { stdio: 'ignore' })
  } catch {
    missing.push('ninja')
  }
  
  // Check for Python
  try {
    execSync('python3 --version', { stdio: 'ignore' })
  } catch {
    try {
      execSync('python --version', { stdio: 'ignore' })
    } catch {
      missing.push('python3')
    }
  }
  
  return missing
}

function main() {
  // Skip in CI environments that will build separately
  if (process.env.CI && process.env.SKIP_POSTINSTALL) {
    console.log('[bare-mpv] Skipping postinstall in CI')
    return
  }
  
  const target = getPrebuildTarget()
  console.log(`[bare-mpv] Platform: ${process.platform}-${process.arch} (target: ${target || 'unsupported'})`)
  
  // Check if prebuild exists
  if (hasPrebuild(target)) {
    console.log('[bare-mpv] Prebuild found, ready to use!')
    return
  }
  
  console.log('[bare-mpv] No prebuild available for this platform')
  
  // Check if this is a git repo where we can init submodules
  if (!isGitRepo()) {
    console.log('[bare-mpv] Not a git repository - cannot initialize submodules')
    console.log('[bare-mpv] You may need to build from the git source or use a platform with prebuilds')
    printBuildInstructions()
    return
  }
  
  // Check if vendor/mpv exists
  if (!hasVendorMpv()) {
    console.log('[bare-mpv] mpv submodule not initialized')
    
    if (!initSubmodules()) {
      console.error('[bare-mpv] Failed to initialize mpv submodule')
      console.log('[bare-mpv] Please run manually:')
      console.log('  git submodule update --init --recursive vendor/mpv')
      printBuildInstructions()
      return
    }
    
    console.log('[bare-mpv] mpv submodule initialized successfully')
  }
  
  // Check build prerequisites
  const missing = checkBuildPrerequisites()
  if (missing.length > 0) {
    console.log('[bare-mpv] Missing build prerequisites:')
    missing.forEach(pkg => console.log(`  - ${pkg}`))
    console.log('')
    printInstallInstructions(missing)
    console.log('')
  }
  
  printBuildInstructions()
}

function printInstallInstructions(missing) {
  console.log('[bare-mpv] Install missing prerequisites:')
  
  if (process.platform === 'darwin') {
    console.log('  brew install ' + missing.map(m => {
      if (m.includes('cmake')) return 'cmake'
      if (m.includes('python')) return 'python3'
      return m
    }).join(' '))
  } else if (process.platform === 'linux') {
    console.log('  # Debian/Ubuntu:')
    console.log('  sudo apt-get install ' + missing.map(m => {
      if (m.includes('cmake')) return 'cmake'
      if (m.includes('python')) return 'python3'
      if (m === 'ninja') return 'ninja-build'
      return m
    }).join(' '))
  } else if (process.platform === 'win32') {
    console.log('  # Using Chocolatey:')
    console.log('  choco install ' + missing.map(m => {
      if (m.includes('cmake')) return 'cmake'
      if (m.includes('python')) return 'python3'
      if (m === 'ninja') return 'ninja'
      if (m === 'pkg-config') return 'pkgconfiglite'
      return m
    }).join(' '))
    console.log('')
    console.log('  # Windows also requires MSYS2 for building mpv:')
    console.log('  # See https://www.msys2.org/')
  }
}

function printBuildInstructions() {
  console.log('[bare-mpv] To build from source:')
  console.log('  npm run build')
  console.log('')
  console.log('[bare-mpv] Or manually:')
  console.log('  npx bare-make generate')
  console.log('  npx bare-make build')
  console.log('  npx bare-make install')
}

main()
