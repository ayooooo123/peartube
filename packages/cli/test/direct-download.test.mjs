import test from 'brittle'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

import { createDirectDownloader, isDirectVideoUrl, byteCeiling } from '../src/media/direct-download.js'
import { createRoutingDownloader } from '../src/archive-manager.js'
import { DEFAULT_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES } from '../src/constants.js'

const VIDEO = Buffer.from('DIRECT-DOWNLOAD-EPISODE-BYTES-'.repeat(200))

function startServer () {
  const server = createServer((req, res) => {
    if (req.url === '/episode.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(VIDEO.length) })
      res.end(VIDEO)
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

test('a download stops at its byte ceiling instead of filling the disk', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-direct-cap-'))
  const dl = createDirectDownloader({ outputDir, fs: nodeFs, path: nodePath, maxBytes: 64 })
  try {
    await t.exception(
      dl.download({ id: 'arch_cap', url: `${base}/episode.mp4` }),
      /64 byte ceiling/,
      'a body past the ceiling fails rather than streaming forever'
    )
    t.absent(existsSync(join(outputDir, 'arch_cap')), 'the partial download is removed')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

// The ceiling that failed the first real auto-seed: a 7,044,201,146-byte movie
// against a hardcoded 5 GiB cap no operator could raise. A guarded fetch cannot
// be driven end to end from a loopback test server by design (the socket check
// refuses it), so the ceiling policy itself is asserted directly.
test('the guarded ceiling is the operator ceiling, not a hardcoded 5 GiB', function (t) {
  const FIVE_GIB = 5 * 1024 * 1024 * 1024
  const REAL_MOVIE = 7_044_201_146

  t.ok(DEFAULT_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES > FIVE_GIB, 'the default clears the old cap')
  t.ok(
    byteCeiling(DEFAULT_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES, true, null) > REAL_MOVIE,
    'and clears the 7 GB movie that failed'
  )
  t.is(
    byteCeiling(20 * FIVE_GIB, true, null),
    20 * FIVE_GIB,
    'an operator raising it past 5 GiB is honoured, which is the whole defect'
  )
  t.is(byteCeiling(64, true, null), 64, "an operator's lower ceiling still wins")
  t.is(byteCeiling(0, true, null), DEFAULT_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES, 'a guarded fetch is never unbounded by omission')
  t.is(byteCeiling(0, false, null), 0, 'a console download with no ceiling is unchanged')
  t.is(byteCeiling(DEFAULT_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES, true, 4096), 4096, 'disk headroom lowers it')
  t.is(byteCeiling(0, false, 4096), 4096, 'and bounds an otherwise unbounded console download')
})

test('the storage gate lowers the ceiling and refuses at the free-disk floor', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-direct-headroom-'))
  let hits = 0
  server.on('request', () => { hits += 1 })
  try {
    const cramped = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      maxBytes: DEFAULT_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES,
      storageHeadroom: () => 32
    })
    await t.exception(
      cramped.download({ id: 'arch_room', url: `${base}/episode.mp4` }),
      /32 byte ceiling/,
      'remaining disk headroom lowers a much larger configured ceiling'
    )

    const atFloor = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      maxBytes: DEFAULT_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES,
      storageHeadroom: () => 0
    })
    const before = hits
    await t.exception(
      atFloor.download({ id: 'arch_floor', url: `${base}/episode.mp4` }),
      /free disk floor/,
      'at the floor it refuses by name'
    )
    t.is(hits, before, 'and refuses before fetching a byte')
    t.absent(existsSync(join(outputDir, 'arch_floor')), 'with no temp dir left behind')

    const unmeasured = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      maxBytes: DEFAULT_ARCHIVE_MAX_DIRECT_DOWNLOAD_BYTES,
      storageHeadroom: () => null
    })
    const ok = await unmeasured.download({ id: 'arch_unmeasured', url: `${base}/episode.mp4` })
    t.alike(readFileSync(ok.filePath), VIDEO, 'an unmeasurable disk leaves the configured ceiling alone')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})
