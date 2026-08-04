import { spawn, execFileSync } from 'node:child_process'

/**
 * Start capturing the target's screen to outMp4. Returns a handle with stop().
 * Runs in the background so Maestro (or nothing, for --record-only) drives concurrently.
 */
export function startCapture(platform, target, outMp4) {
  if (platform === 'android') {
    const remote = '/sdcard/app-test-rec.mp4'
    const p = spawn('adb', ['-s', target, 'shell', 'screenrecord', '--bit-rate', '4000000', remote],
      { stdio: 'ignore' })
    return {
      stop() {
        try { execFileSync('adb', ['-s', target, 'shell', 'pkill', '-INT', 'screenrecord']) } catch {}
        try { p.kill('SIGINT') } catch {}
        execFileSync('sleep', ['1']) // let the encoder flush before pulling
        execFileSync('adb', ['-s', target, 'pull', remote, outMp4], { stdio: 'inherit' })
        try { execFileSync('adb', ['-s', target, 'shell', 'rm', remote]) } catch {}
      },
    }
  }
  if (platform === 'ios') {
    const p = spawn('xcrun', ['simctl', 'io', target, 'recordVideo', '--codec=h264', '--force', outMp4],
      { stdio: 'ignore' })
    return { stop() { try { p.kill('SIGINT') } catch {} ; execFileSync('sleep', ['1']) } }
  }
  if (platform === 'desktop') {
    // macOS whole-screen video capture until SIGINT. v1 LIMITATION: records the ENTIRE screen,
    // not just the Electrobun window — macOS has no scriptable single-window video capture.
    // Documented in README-app-test.md; window targeting is deferred.
    const p = spawn('screencapture', ['-v', outMp4], { stdio: 'ignore' })
    return { stop() { try { p.kill('SIGINT') } catch {} ; execFileSync('sleep', ['1']) } }
  }
  throw new Error(`unknown platform ${platform}`)
}
