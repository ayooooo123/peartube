import test from 'brittle'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

import { createDirectDownloader, isDirectVideoUrl, byteCeiling } from '../src/media/direct-download.js'
import { createRoutingDownloader } from '../src/archive-manager.js'

const VIDEO = Buffer.from('DIRECT-DOWNLOAD-EPISODE-BYTES-'.repeat(200))

function startServer () {
  const server = createServer((req, res) => {
    if (req.url === '/episode.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(VIDEO.length) })
      res.end(VIDEO)
    } else if (req.url === '/chunked.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(VIDEO.length) })
      let offset = 0
      const pump = () => {
        if (offset >= VIDEO.length) {
          res.end()
          return
        }
        const next = Math.min(offset + 64, VIDEO.length)
        res.write(VIDEO.subarray(offset, next))
        offset = next
        setImmediate(pump)
      }
      pump()
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: '/episode.mp4' })
      res.end()
    } else if (req.url === '/stream') {
      // No extension, video content-type, filename via disposition.
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-disposition': 'attachment; filename="show-s01e02.mp4"' })
      res.end(VIDEO)
    } else if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>not a video</html>')
    } else {
      res.writeHead(404); res.end()
    }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })))
}

test('isDirectVideoUrl detects media file links', function (t) {
  t.ok(isDirectVideoUrl('https://cdn.example.com/path/episode.mp4'))
  t.ok(isDirectVideoUrl('https://x/y/clip.mkv?token=abc'))
  t.absent(isDirectVideoUrl('https://youtube.com/watch?v=abc'))
  t.absent(isDirectVideoUrl('not a url'))
})

test('direct downloader streams a video URL to disk', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-direct-'))
  const dl = createDirectDownloader({ outputDir, fs: nodeFs, path: nodePath })
  try {
    const result = await dl.download({ id: 'arch_1', url: `${base}/episode.mp4`, title: 'Show S01E02' })
    t.ok(existsSync(result.filePath), 'file written')
    t.alike(readFileSync(result.filePath), VIDEO, 'bytes intact')
    t.is(result.mimeType, 'video/mp4')
    t.is(result.title, 'Show S01E02')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('direct downloader follows redirects', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-direct-rd-'))
  const dl = createDirectDownloader({ outputDir, fs: nodeFs, path: nodePath })
  try {
    const result = await dl.download({ id: 'arch_2', url: `${base}/redirect` })
    t.alike(readFileSync(result.filePath), VIDEO, 'followed 302 to the file')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('direct downloader names the file from content-disposition when the URL has no extension', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-direct-cd-'))
  const dl = createDirectDownloader({ outputDir, fs: nodeFs, path: nodePath })
  try {
    const result = await dl.download({ id: 'arch_3', url: `${base}/stream` })
    t.ok(result.filePath.endsWith('show-s01e02.mp4'), 'used disposition filename')
    t.alike(readFileSync(result.filePath), VIDEO)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('direct downloader rejects a non-video response and cleans up', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-direct-html-'))
  const dl = createDirectDownloader({ outputDir, fs: nodeFs, path: nodePath })
  try {
    await t.exception(dl.download({ id: 'arch_4', url: `${base}/page` }), /downloadable video/)
    t.absent(existsSync(join(outputDir, 'arch_4')), 'partial dir removed')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('routing downloader uses yt-dlp only for creator imports', async function (t) {
  const directDownloader = { download: async () => ({ via: 'direct' }) }
  const ytDlpDownloader = { download: async () => ({ via: 'ytdlp' }) }
  const router = createRoutingDownloader({ directDownloader, ytDlpDownloader })

  // Creator imports (carry a creatorSourceId) scrape a platform via yt-dlp —
  // even a YouTube page, and even the same page without the creator marker
  // would go direct.
  t.is((await router.download({ url: 'https://www.youtube.com/@chan', creatorSourceId: 'youtube:channel:UC1' })).via, 'ytdlp', 'creator import -> yt-dlp')
  t.is((await router.download({ url: 'https://host/ep', tmdbType: 'tv' })).via, 'direct', 'show import -> direct')
  t.is((await router.download({ url: 'https://host/movie', tmdbType: 'movie' })).via, 'direct', 'movie import -> direct')
  t.is((await router.download({ url: 'https://cdn/clip.mp4' })).via, 'direct', 'single-video direct url -> direct')
  t.is((await router.download({ url: 'https://www.youtube.com/watch?v=x' })).via, 'direct', 'non-creator page -> direct (yt-dlp is creators-only)')
})

// A job carrying `requirePublicSource` came from the unauthenticated machine
// API, where the url is a stranger's. Every check below is off for a console
// download and on for that one.
test('a guarded download refuses a target that is not a public address', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-direct-guard-'))
  const dl = createDirectDownloader({ outputDir, fs: nodeFs, path: nodePath })
  try {
    // The same url the console fetches happily: the test server is on
    // loopback, which is exactly what a url seed must never reach.
    await t.exception(
      dl.download({ id: 'arch_g1', url: `${base}/episode.mp4`, requirePublicSource: true }),
      /loopback/,
      'a loopback target is refused'
    )
    t.absent(existsSync(join(outputDir, 'arch_g1')), 'nothing was staged')

    // The redirect case is the same check on a later pass of the same loop, so
    // a hop into loopback cannot slip past a door-only guard either.
    await t.exception(
      dl.download({ id: 'arch_g2', url: `${base}/redirect`, requirePublicSource: true }),
      /loopback/,
      'every hop is checked, not just the first'
    )

    const unguarded = await dl.download({ id: 'arch_g3', url: `${base}/episode.mp4` })
    t.alike(readFileSync(unguarded.filePath), VIDEO, 'a console download is unchanged by any of it')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('direct downloader has no arbitrary per-file byte ceiling', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-direct-no-cap-'))
  const dl = createDirectDownloader({ outputDir, fs: nodeFs, path: nodePath, maxBytes: 64 })
  try {
    const result = await dl.download({ id: 'arch_no_cap', url: `${base}/episode.mp4` })
    t.alike(readFileSync(result.filePath), VIDEO, 'bytes are limited by storage, not an archive file-size cap')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('guarded downloads do not gain a fallback media-size ceiling', function (t) {
  t.is(byteCeiling(0, true, null), 0, 'a guarded fetch with unmeasured storage is not capped by a media-size default')
  t.is(byteCeiling(64, true, null), 0, 'legacy per-file ceilings are ignored')
  t.is(byteCeiling(0, false, null), 0, 'a console download with unmeasured storage is unchanged')
  t.is(byteCeiling(0, true, 4096), 4096, 'storage headroom still bounds writes when measurable')
  t.is(byteCeiling(64, true, 4096), 4096, 'storage headroom is the only byte limit')
})

test('the storage gate bounds writes and refuses at the aggregate limit', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-direct-headroom-'))
  let hits = 0
  server.on('request', () => { hits += 1 })
  try {
    const cramped = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      maxBytes: 128 * 1024 * 1024 * 1024,
      storageHeadroom: () => 32
    })
    await t.exception(
      cramped.download({ id: 'arch_room', url: `${base}/episode.mp4` }),
      /storage headroom/,
      'remaining disk headroom, not a media-size ceiling, stops the write'
    )
    t.absent(existsSync(join(outputDir, 'arch_room')), 'the partial download is removed')

    const atFloor = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      maxBytes: 128 * 1024 * 1024 * 1024,
      storageHeadroom: () => 0
    })
    const before = hits
    await t.exception(
      atFloor.download({ id: 'arch_floor', url: `${base}/episode.mp4` }),
      /archive storage headroom/,
      'at the aggregate limit it refuses by name'
    )
    t.is(hits, before, 'and refuses before fetching a byte')
    t.absent(existsSync(join(outputDir, 'arch_floor')), 'with no temp dir left behind')

    const unmeasured = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      maxBytes: 128 * 1024 * 1024 * 1024,
      storageHeadroom: () => null
    })
    await t.exception(
      unmeasured.download({ id: 'arch_unmeasured', url: `${base}/episode.mp4` }),
      /cannot measure archive storage headroom/,
      'a configured storage guard fails closed when the disk cannot be measured'
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('direct downloader accepts object storage headroom snapshots', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-direct-object-headroom-'))
  try {
    const shared = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageHeadroom: () => ({ tmp: VIDEO.length * 3, storage: VIDEO.length * 3, sharedVolume: true })
    })
    const ok = await shared.download({ id: 'arch_object_shared', url: `${base}/episode.mp4` })
    t.alike(readFileSync(ok.filePath), VIDEO, 'shared-volume objects reserve staged bytes plus the eventual copy')

    const separate = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageHeadroom: () => ({ tmp: VIDEO.length + 1, storage: VIDEO.length + 1, sharedVolume: false })
    })
    const separateOk = await separate.download({ id: 'arch_object_separate', url: `${base}/episode.mp4` })
    t.alike(readFileSync(separateOk.filePath), VIDEO, 'separate-volume objects check tmp and persisted storage independently')
    let checks = 0
    const chunkedCramped = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageHeadroom: () => {
        checks += 1
        return { tmp: VIDEO.length + 1, storage: VIDEO.length + 1, sharedVolume: true }
      }
    })
    await t.exception(
      chunkedCramped.download({ id: 'arch_object_chunked', url: `${base}/chunked.mp4` }),
      /storage headroom/,
      'shared-volume objects compare the staged total, not just each chunk'
    )
    t.ok(checks > 10, 'the fixture exercised many small response chunks plus the initial guard')

    const reservations = { bytes: 0 }
    const reserving = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageReservations: reservations,
      storageHeadroom: () => ({ tmp: VIDEO.length * 3, storage: VIDEO.length * 3, sharedVolume: true })
    })
    const reserved = await reserving.download({ id: 'arch_object_reserved', url: `${base}/episode.mp4` })
    t.is(reservations.bytes, VIDEO.length, 'direct downloads reserve their eventual persisted copy while staged')
    reserved.cleanup()
    t.is(reservations.bytes, 0, 'direct cleanup releases the staged copy reservation')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('direct downloader releases storage reservations after write failure', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-direct-write-fail-'))
  const reservations = { bytes: 0 }
  let writes = 0
  const failingFs = {
    ...nodeFs,
    writeSync (...args) {
      writes += 1
      if (writes > 1) throw new Error('simulated disk failure')
      return nodeFs.writeSync(...args)
    }
  }
  const dl = createDirectDownloader({
    outputDir,
    fs: failingFs,
    path: nodePath,
    storageReservations: reservations,
    storageHeadroom: () => ({ tmp: VIDEO.length * 3, storage: VIDEO.length * 3, sharedVolume: true })
  })
  try {
    await t.exception(
      dl.download({ id: 'arch_write_fail', url: `${base}/chunked.mp4` }),
      /simulated disk failure/,
      'write failure aborts the direct download'
    )
    t.is(reservations.bytes, 0, 'all staged-copy reservation bytes are released on failure')
    t.absent(existsSync(join(outputDir, 'arch_write_fail')), 'failed direct temp directory is removed')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})
