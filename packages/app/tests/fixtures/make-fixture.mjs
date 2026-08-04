// Generates a tiny deterministic H.264 mp4 for relay seeding. Run once; commit the output.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const out = fileURLToPath(new URL('./smoke-320x568-3s.mp4', import.meta.url))
execFileSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=15:duration=3',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
], { stdio: 'inherit' })
console.log('wrote', out)
