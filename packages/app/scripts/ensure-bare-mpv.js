/* eslint-disable no-console */
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const srcRoot = path.join(repoRoot, 'packages', 'bare-mpv')
const destRoot = path.join(repoRoot, 'packages', 'app', 'pear', 'node_modules', 'bare-mpv')

const filesToCopy = [
  'binding.js',
  'index.js',
  'package.json',
  'prebuilds',
]

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function copyPath(src, dest) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true })
  } else {
    fs.copyFileSync(src, dest)
  }
}

try {
  if (!fs.existsSync(srcRoot)) {
    throw new Error(`bare-mpv source not found: ${srcRoot}`)
  }

  if (fs.existsSync(destRoot)) {
    fs.rmSync(destRoot, { recursive: true, force: true })
  }

  ensureDir(destRoot)

  for (const entry of filesToCopy) {
    const src = path.join(srcRoot, entry)
    if (!fs.existsSync(src)) {
      console.warn(`[ensure-bare-mpv] Missing ${entry} in ${srcRoot}`)
      continue
    }
    const dest = path.join(destRoot, entry)
    copyPath(src, dest)
  }

  console.log('[ensure-bare-mpv] Copied bare-mpv into pear node_modules')
} catch (err) {
  console.error('[ensure-bare-mpv] Failed:', err?.message || err)
  process.exitCode = 1
}
