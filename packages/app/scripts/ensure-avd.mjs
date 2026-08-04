#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { arch, platform as osPlatform } from 'node:os'

const AVD = process.env.PEARTUBE_AVD || 'peartube-arm64'
const SIM = process.env.PEARTUBE_SIM || 'iPhone 16'

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()

export function bootedAndroid() {
  const out = sh('adb', ['devices']).split('\n').slice(1).map(l => l.split('\t'))
  const dev = out.find(([, s]) => s === 'device')
  return dev ? dev[0] : null
}

/** Ensure an Android emulator is running; return its serial. */
export async function ensureAndroid(attach) {
  if (attach) return attach
  const already = bootedAndroid()
  if (already) return already
  // Apple Silicon → arm64-v8a native; else x86_64. AVD must be pre-created (see README).
  const abi = osPlatform() === 'darwin' && arch() === 'arm64' ? 'arm64-v8a' : 'x86_64'
  console.error(`[ensure-avd] booting AVD ${AVD} (${abi})`)
  spawn('emulator', ['-avd', AVD, '-gpu', 'host', '-no-boot-anim', '-no-audio', '-no-snapshot-save'],
    { detached: true, stdio: 'ignore' }).unref()
  execFileSync('adb', ['wait-for-device'], { stdio: 'inherit' })
  for (let i = 0; i < 120; i++) {
    try { if (sh('adb', ['shell', 'getprop', 'sys.boot_completed']) === '1') break } catch {}
    await new Promise(r => setTimeout(r, 2000))
  }
  return bootedAndroid()
}

/** Ensure the iOS simulator is booted; return its udid. */
export function ensureIos(attach) {
  if (attach) return attach
  const list = JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', '--json']))
  let udid = null, booted = false
  for (const runtime of Object.values(list.devices)) {
    for (const d of runtime) if (d.name === SIM) { udid = d.udid; booted = d.state === 'Booted' }
  }
  if (!udid) throw new Error(`iOS simulator "${SIM}" not found — create it in Xcode or set PEARTUBE_SIM`)
  if (!booted) execFileSync('xcrun', ['simctl', 'boot', udid], { stdio: 'inherit' })
  execFileSync('open', ['-a', 'Simulator'], { stdio: 'ignore' })
  return udid
}
