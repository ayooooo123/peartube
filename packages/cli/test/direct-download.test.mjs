import test from 'brittle'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

import { createDirectDownloader, isDirectVideoUrl } from '../src/media/direct-download.js'
import { createRoutingDownloader } from '../src/archive-manager.js'

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
