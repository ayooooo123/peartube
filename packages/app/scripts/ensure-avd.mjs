#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { arch, platform as osPlatform } from 'node:os'

const AVD = process.env.PEARTUBE_AVD || 'peartube-arm64'
const SIM = process.env.PEARTUBE_SIM || 'iPhone 16'

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()

const EMULATOR = /^emulator-/ // emulator serials look like emulator-5554; physical devices never do

/** Serials of currently-booted *emulators* only — physical/wireless devices are excluded. */
export function bootedEmulators() {
  return sh('adb', ['devices']).split('\n').slice(1)
    .map(l => l.split('\t'))
    .filter(([serial, state]) => state === 'device' && EMULATOR.test(serial || ''))
    .map(([serial]) => serial)
}

/**
 * Ensure an Android *emulator* is running; return its serial. This flow is emulator-only:
 * a physical device is never auto-selected, and an explicit non-emulator --attach is refused
 * unless PEARTUBE_ALLOW_DEVICE=1 is set.
 */
export async function ensureAndroid(attach) {
  if (attach) {
    if (!EMULATOR.test(attach) && process.env.PEARTUBE_ALLOW_DEVICE !== '1') {
      throw new Error(`refusing to target non-emulator device "${attach}" — this flow is emulator-only; ` +
        `set PEARTUBE_ALLOW_DEVICE=1 to override`)
    }
    return attach
  }
  const [already] = bootedEmulators()
  if (already) return already
  // Apple Silicon → arm64-v8a native; else x86_64. AVD must be pre-created (see README).
  const abi = osPlatform() === 'darwin' && arch() === 'arm64' ? 'arm64-v8a' : 'x86_64'
  console.error(`[ensure-avd] no emulator running; booting AVD ${AVD} (${abi})`)
  const before = new Set(bootedEmulators())
  spawn('emulator', ['-avd', AVD, '-gpu', 'host', '-no-boot-anim', '-no-audio', '-no-snapshot-save'],
    { detached: true, stdio: 'ignore' }).unref()
  // Wait for a (new) emulator to reach boot completion — addressed by serial so a connected
  // physical device can never be mistaken for the target.
  for (let i = 0; i < 150; i++) {
    const cand = bootedEmulators().find(s => !before.has(s)) || bootedEmulators()[0]
    if (cand) {
      try { if (sh('adb', ['-s', cand, 'shell', 'getprop', 'sys.boot_completed']) === '1') return cand } catch {}
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error(`emulator ${AVD} did not reach boot completion in time`)
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
