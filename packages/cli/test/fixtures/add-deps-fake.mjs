import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createJobStore } from '../../src/add/job-store.js'
import { createExecutor } from '../../src/add/executor.js'

const CHANNEL = { channelKey: 'chan-1', writerKeyHex: 'a'.repeat(64), publicBeeKey: 'b'.repeat(64) }

// In-memory Hyperbee shim. When `file` is provided it persists across processes
// so crash/resume scenarios can be driven through separate real CLI runs.
function fakeBee (file = null) {
  const map = new Map()
  if (file && existsSync(file)) {
    try {
      for (const [k, v] of JSON.parse(readFileSync(file, 'utf8'))) map.set(k, v)
    } catch {}
  }
  const persist = () => { if (file) writeFileSync(file, JSON.stringify([...map.entries()])) }
  return {
    map,
    async get (k) { return map.has(k) ? { value: map.get(k) } : null },
    async put (k, v) { map.set(k, JSON.parse(JSON.stringify(v))); persist() },
    async del (k) { map.delete(k); persist() },
    batch () { const s = []; return { async put (k, v) { s.push([k, v]) }, async flush () { for (const [k, v] of s) map.set(k, JSON.parse(JSON.stringify(v))); persist() } } },
    async * createReadStream ({ gte, lt } = {}) { for (const k of [...map.keys()].sort()) { if (gte !== undefined && k < gte) continue; if (lt !== undefined && k >= lt) continue; yield { key: k, value: map.get(k) } } }
  }
}

export async function createDeps (context) {
  const env = context.env || {}
  const bee = fakeBee(env.PEARTUBE_FAKE_BEE_FILE || null)
  const duplicate = env.PEARTUBE_FAKE_DUPLICATE === '1'
  const pending = env.PEARTUBE_FAKE_PENDING === '1'
  return {
    openAddRuntime: async () => ({ metadataBee: bee, close: async () => {} }),
    createTmdbProvider: () => ({
      async getShow () { return { name: 'Breaking Bad', mediaId: '1396', provider: 'tmdb', artwork: [] } },
      async getSeason () { return [{ seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: '2008-01-20', artwork: [] }] },
      async getMovie () { return { title: 'The Matrix', mediaId: '603', provider: 'tmdb', year: 1999, artwork: [] } }
    }),
    createJobStore,
    createExecutor,
    buildExecutorDeps: ({ jobStore }) => ({
      jobStore,
      resolveChannel: async () => CHANNEL,
      loadChannel: async () => CHANNEL,
      duplicateCheck: {
        check: async () => duplicate
          ? { status: 'already-exists', existing: { channelKey: 'chan-1', videoId: 'existing-9', availability: 'published' } }
          : { status: 'ok', advisories: [] }
      },
      deriveImportClaimantId: (w, j) => `claim:${j}`,
      writeClaim: async () => {},
      resolveClaimWinner: async () => null,
      downloadSource: async () => {
        // The runtime-only fetchUrl reaches the downloader but must never surface.
        console.log('[diag] downloading source (should go to stderr)')
        return { artifactPath: '/tmp/a.mkv', checksum: 'sha256:v' }
      },
      uploadFromPath: async (args) => ({ videoId: args.videoId, channelKey: CHANNEL.channelKey, blobKey: 'blob-1' }),
      requestPin: async () => {},
      awaitDurable: async () => ({ verified: !pending, holders: pending ? [] : ['relay-1'] }),
      publication: {
        markDurabilityVerified: async () => {},
        project: async () => ({ channelKey: CHANNEL.channelKey, publicBeeKey: CHANNEL.publicBeeKey }),
        announce: async () => {},
        finalize: async () => {}
      }
    })
  }
}
