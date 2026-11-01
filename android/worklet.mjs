// Builds the Android app's P2P worklet, as desktop/build.rs does for the Mac
// app: packs worklet/worker.js with bare-pack for android-arm64, links every
// native addon the bundle loads with bare-link, and puts them next to
// bare-kit's own libraries (built by worklet/bare-kit.sh) for the APK.
//
//   node android/worklet.mjs <assets dir> <jniLibs dir> <scratch dir> [qjs|v8]
//
// The engine defaults to QuickJS; the TV receiver passes v8 (see worklet/bare-kit.sh).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const worklet = path.join(root, 'worklet')
const [assets, jniLibs, scratch] = process.argv.slice(2, 5).map(dir => path.resolve(dir))
const engine = process.argv[5] || 'qjs'
const host = 'android-arm64'
const abi = 'arm64-v8a'

const target = engine === 'v8' ? 'arm64-v8a-v8' : abi
const kit = path.join(worklet, 'vendor/bare-kit', engine === 'v8' ? 'android-v8' : 'android', abi)
if (!fs.existsSync(path.join(kit, 'libbare-kit.so'))) {
  throw new Error(`bare-kit is not built for ${target}: run sh worklet/bare-kit.sh ${target}`)
}

for (const dir of [assets, jniLibs, scratch]) fs.rmSync(dir, { recursive: true, force: true })
const libs = path.join(jniLibs, abi)
fs.mkdirSync(assets, { recursive: true })
fs.mkdirSync(libs, { recursive: true })

// Pack and link one entry graph with the same builtin overrides.
const bundle = path.join(assets, 'worker.bundle')
execFileSync(process.execPath, [path.join(worklet, 'build.mjs'), host, bundle, scratch],
  { cwd: root, stdio: 'inherit' })

const linked = path.join(scratch, abi)
for (const name of fs.existsSync(linked) ? fs.readdirSync(linked) : []) {
  fs.copyFileSync(path.join(linked, name), path.join(libs, name))
}
for (const name of ['libbare-kit.so', 'libc++_shared.so']) {
  fs.copyFileSync(path.join(kit, name), path.join(libs, name))
}
