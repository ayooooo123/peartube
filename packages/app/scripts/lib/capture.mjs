import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const INTERVAL_MS = 1000
const MAX_PNG = 64 * 1024 * 1024

// A single screenshot. Emulator screenrecord is unreliable (stops early, malformed moov),
// so we sample stills instead — reliable on every platform and exactly what the eyes want.
function shoot(platform, target, outPng) {
  if (platform === 'android') {
    // exec-out (not shell) is binary-safe — no CRLF mangling of the PNG bytes.
    const png = execFileSync('adb', ['-s', target, 'exec-out', 'screencap', '-p'], { maxBuffer: MAX_PNG })
    writeFileSync(outPng, png)
  } else if (platform === 'ios') {
    execFileSync('xcrun', ['simctl', 'io', target, 'screenshot', outPng], { stdio: 'ignore' })
  } else if (platform === 'desktop') {
    execFileSync('screencapture', ['-x', outPng], { stdio: 'ignore' })
  } else {
    throw new Error(`unknown platform ${platform}`)
  }
}

/**
 * Periodically screenshot the target into framesDir until stop().
 * Runs on a timer; the caller must yield (await) so the timer fires — e.g. `await` the
 * Maestro run or a record-only sleep. stop() returns the captured frame paths, in order.
 */
export function startCapture(platform, target, framesDir) {
  const frames = []
  let i = 0
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    const out = join(framesDir, `${String(i).padStart(3, '0')}.png`)
    try { shoot(platform, target, out); frames.push(out); i++ } catch { /* transient shot; skip */ }
    busy = false
  }
  tick() // one immediately
  const timer = setInterval(tick, INTERVAL_MS)
  return {
    stop() {
      clearInterval(timer)
      tick() // final frame
      return frames.slice()
    },
  }
}
