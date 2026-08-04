import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMPOSE = fileURLToPath(new URL('../../../../docker-compose.local-relay.yml', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../tests/fixtures/smoke-320x568-3s.mp4', import.meta.url))
const MIRROR = process.env.PEARTUBE_MIRROR_DIR || join(homedir(), 'peartube-local-videos')
const ARCHIVE_UI = process.env.PEARTUBE_ARCHIVE_UI || 'http://localhost:8174'

/**
 * Seed the local relay with the fixture and bring it up. The compose mounts the host dir
 * named by PEARTUBE_MIRROR_DIR into /mirror (interpolated in docker-compose.local-relay.yml).
 * Returns when the archive UI is live.
 */
export async function ensureContent() {
  mkdirSync(MIRROR, { recursive: true })
  copyFileSync(FIXTURE, join(MIRROR, basename(FIXTURE)))
  execFileSync('docker', ['compose', '-f', COMPOSE, 'up', '-d'], {
    stdio: 'inherit',
    env: { ...process.env, PEARTUBE_MIRROR_DIR: MIRROR },
  })
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(ARCHIVE_UI, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return { mirror: MIRROR, archiveUi: ARCHIVE_UI }
    } catch {}
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error(`relay archive UI not reachable at ${ARCHIVE_UI} after 120s`)
}
