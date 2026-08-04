import { execFileSync, execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

const FRAMES = 6
const LONG_EDGE = 1568

export function evenTimestamps(duration, n = FRAMES) {
  const end = Math.max(duration - 0.1, 0)
  return Array.from({ length: n }, (_, i) => Math.min(duration * (i + 0.5) / n, end))
}

export function ffmpegGrabArgs(video, t, outJpg) {
  return [
    '-v', 'error', '-nostdin', '-y', '-ss', String(t), '-i', video,
    '-frames:v', '1', '-q:v', '2',
    '-vf', `scale='min(${LONG_EDGE},iw)':'min(${LONG_EDGE},ih)':force_original_aspect_ratio=decrease`,
    outJpg,
  ]
}

export function probeDuration(video) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration',
    '-of', 'csv=p=0', video,
  ], { encoding: 'utf8' }).trim()
  const d = Number(out)
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe read no duration from ${video}`)
  return d
}

/** Sample frames to a temp dir; returns { dir, frames: [{ t, path }] }. */
export async function sampleFrames(video, { n = FRAMES } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'app-eyes-'))
  const ts = evenTimestamps(probeDuration(video), n)
  const frames = []
  for (let i = 0; i < ts.length; i++) {
    const out = join(dir, `${String(i).padStart(2, '0')}.jpg`)
    await pExecFile('ffmpeg', ffmpegGrabArgs(video, ts[i], out))
    frames.push({ t: ts[i], path: out })
  }
  return { dir, frames }
}
