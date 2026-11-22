#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ios = dirname(fileURLToPath(import.meta.url))
const root = dirname(ios)
const platform = process.argv[2] || 'iphonesimulator'
if (!['iphoneos', 'iphonesimulator'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`)
const target = platform === 'iphoneos' ? 'aarch64-apple-ios' : 'aarch64-apple-ios-sim'
const out = join(ios, 'build', platform)
const run = (program, args, options = {}) => execFileSync(program, args, { cwd: root, stdio: 'inherit', ...options })
mkdirSync(out, { recursive: true })
run('cargo', ['build', '--manifest-path', 'ios/native/Cargo.toml', '--target', target, '--release'], {
  env: { ...process.env, CARGO_TARGET_DIR: join(ios, 'build/cargo'), IPHONEOS_DEPLOYMENT_TARGET: '17.0' }
})
cpSync(join(ios, 'build/cargo', target, 'release/libpeartube_ios.a'), join(out, 'libpeartube_ios.a'))
console.log(`Prepared the P2P backend and shared Rust player for ${target}`)
