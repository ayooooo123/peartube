#!/usr/bin/env node
/* eslint-disable no-console */
// Overlay a custom-engine libbare-kit.so onto the installed react-native-bare-kit
// before an Android build, so the APK ships a smaller JS engine (QuickJS via
// libqjs, etc.) instead of the default V8. No-op when no override is provided,
// so normal V8 builds are completely unaffected.
//
// Source of the override .so:
//   1) --dir <path>                  (CLI)
//   2) $PEARTUBE_BARE_KIT_ENGINE_DIR  (env)
//   3) packages/app/bare-kit-engine/<engine>  (default; engine via --engine/$PEARTUBE_BARE_ENGINE, default "libqjs")
//
// The dir must contain <abi>/libbare-kit.so for one or more of:
//   arm64-v8a  armeabi-v7a  x86  x86_64
//
// These .so are produced reproducibly by .github/workflows/build-bare-kit-engine.yml.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(APP_DIR, '..', '..')
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']

function arg(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}

function resolveOverrideDir() {
  const explicit = arg('--dir') || process.env.PEARTUBE_BARE_KIT_ENGINE_DIR
  if (explicit) return path.resolve(explicit)
  const engine = arg('--engine') || process.env.PEARTUBE_BARE_ENGINE || 'libqjs'
  return path.join(APP_DIR, 'bare-kit-engine', engine)
}

// react-native-bare-kit may be hoisted to the repo root or live under packages/app.
function resolveBareKitJniRoot() {
  const candidates = [
    path.join(APP_DIR, 'node_modules/react-native-bare-kit'),
    path.join(REPO_ROOT, 'node_modules/react-native-bare-kit'),
  ]
  for (const base of candidates) {
    const jni = path.join(base, 'android/libs/bare-kit/jni')
    if (fs.existsSync(jni)) return jni
  }
  return null
}

function mb(n) {
  return (n / 1048576).toFixed(2) + ' MB'
}

// Find <abi>/libbare-kit.so under root, tolerating an extra nesting level that
// CI artifact downloads sometimes add (e.g. out/<abi>/libbare-kit.so).
function findEngineSo(root, abi) {
  const direct = path.join(root, abi, 'libbare-kit.so')
  if (fs.existsSync(direct)) return direct
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name === 'libbare-kit.so' && path.basename(dir) === abi) return full
    }
  }
  return null
}

function main() {
  const overrideDir = resolveOverrideDir()
  if (!fs.existsSync(overrideDir)) {
    console.log(`[bare-kit-engine] no override at ${overrideDir} — keeping default V8 engine`)
    return
  }

  const jniRoot = resolveBareKitJniRoot()
  if (!jniRoot) {
    console.error('[bare-kit-engine] react-native-bare-kit not installed — run npm install first')
    process.exit(1)
  }

  let applied = 0
  for (const abi of ABIS) {
    const src = findEngineSo(overrideDir, abi)
    if (!src) continue
    const destDir = path.join(jniRoot, abi)
    const dest = path.join(destDir, 'libbare-kit.so')
    fs.mkdirSync(destDir, { recursive: true })
    const before = fs.existsSync(dest) ? fs.statSync(dest).size : 0
    fs.copyFileSync(src, dest)
    const after = fs.statSync(dest).size
    console.log(`[bare-kit-engine] ${abi}: ${mb(before)} (V8) -> ${mb(after)} (override)`)
    applied++
  }

  if (applied === 0) {
    console.error(`[bare-kit-engine] override dir ${overrideDir} has no <abi>/libbare-kit.so`)
    process.exit(1)
  }
  console.log(`[bare-kit-engine] applied custom engine to ${applied} ABI(s) from ${overrideDir}`)
}

main()
