import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createYtDlpProvider } from '../src/add/providers/yt-dlp.js'
import { buildDownloadArgs } from '../src/media/yt-dlp.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureText = (name) => readFileSync(join(here, 'fixtures', name), 'utf8')

function recordingRun (stdout) {
  const calls = []
  const run = async (bin, args) => {
    calls.push({ bin, args })
    if (typeof stdout === 'function') return { stdout: stdout(bin, args), stderr: '' }
    return { stdout, stderr: '' }
  }
  return { run, calls }
}

async function caught (promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

test('search builds a safe ytsearch argv and normalizes flat entries', async (t) => {
  const { run, calls } = recordingRun(fixtureText('yt-dlp-search.json'))
  const provider = createYtDlpProvider({ bin: '/bin/yt-dlp', cookiesPath: '/data/cookies.txt', run })
  const results = await provider.search('funny cats', { limit: 5 })

  t.alike(calls[0].args, [
    '--dump-single-json',
    '--no-warnings',
    '--flat-playlist',
    '--cookies',
    '/data/cookies.txt',
    'ytsearch5:funny cats'
  ])
  t.is(results.length, 2)
  t.is(results[0].kind, 'item')
  t.is(results[0].contentKind, 'video')
  t.is(results[0].sourceProvider, 'youtube')
  t.is(results[0].sourceVideoId, 'vid1')
  t.is(results[0].canonicalUrl, 'https://www.youtube.com/watch?v=vid1')
  t.is(results[0].title, 'First Video')
  t.is(results[0].duration, 12)
  t.is(results[0].sourcePublishedAt, '2026-01-01')
  t.is(results[1].canonicalUrl, 'https://www.youtube.com/watch?v=vid2')
})

test('inspect builds a direct no-playlist argv and returns a single normalized item', async (t) => {
  const single = JSON.stringify({
    id: 'vid9',
    title: 'Direct Clip',
    description: 'A direct URL.',
    webpage_url: 'https://vimeo.com/9',
    duration: 99,
    upload_date: '20251225',
    uploader: 'Someone',
    extractor_key: 'Vimeo'
  })
  const { run, calls } = recordingRun(single)
  const provider = createYtDlpProvider({ bin: 'yt-dlp', run })
  const item = await provider.inspect('https://vimeo.com/9')

  t.alike(calls[0].args, ['--dump-single-json', '--no-warnings', '--no-playlist', 'https://vimeo.com/9'])
  t.is(item.sourceProvider, 'vimeo')
  t.is(item.sourceVideoId, 'vid9')
  t.is(item.canonicalUrl, 'https://vimeo.com/9')
  t.is(item.duration, 99)
  t.is(item.sourcePublishedAt, '2025-12-25')
})

test('listProfile builds a flat playlist argv and normalizes creator plus recent items', async (t) => {
  const { run, calls } = recordingRun(fixtureText('yt-dlp-channel.json'))
  const provider = createYtDlpProvider({ bin: 'yt-dlp', run })
  const profile = await provider.listProfile('https://www.youtube.com/@maker', { limit: 25 })

  t.alike(calls[0].args, [
    '--dump-single-json',
    '--no-warnings',
    '--flat-playlist',
    '--playlist-end',
    '25',
    'https://www.youtube.com/@maker'
  ])
  t.is(profile.creator.name, 'Maker')
  t.is(profile.creator.platform, 'youtube')
  t.is(profile.creator.sourceId, 'UC123')
  t.is(profile.creator.canonicalUrl, 'https://www.youtube.com/@maker')
  t.is(profile.creator.handle, '@maker')
  t.is(profile.creator.avatarUrl, 'https://img/avatar.jpg')
  t.is(profile.items.length, 2)
  t.is(profile.items[0].sourceVideoId, 'vid1')
})

test('capability matrix reports supported operations and rejects unsupported ones', async (t) => {
  const provider = createYtDlpProvider({ bin: 'yt-dlp', run: async () => ({ stdout: '{}', stderr: '' }), capabilities: { list: false } })
  const caps = provider.capabilities()
  t.is(caps.search, true)
  t.is(caps.download, true)
  t.is(caps.list, false)
  const error = await caught(provider.listProfile('https://x/y'))
  t.is(error.code, 'ERR_YTDLP_UNSUPPORTED')
})

test('download delegates to the shared command construction with archive flags', async (t) => {
  const calls = []
  const provider = createYtDlpProvider({
    bin: 'yt-dlp',
    run: async (bin, args) => {
      calls.push({ bin, args })
      return { stdout: '/tmp/out/Direct [vid9].mp4\n', stderr: '' }
    }
  })
  const result = await provider.download({
    url: 'https://vimeo.com/9',
    outputTemplate: '/tmp/out/%(title)s [%(id)s].%(ext)s',
    format: 'bv*+ba/b',
    ffmpegPath: '/opt/ffmpeg',
    cookiesPath: '/data/cookies.txt'
  })

  t.alike(calls[0].args, buildDownloadArgs({
    format: 'bv*+ba/b',
    outputTemplate: '/tmp/out/%(title)s [%(id)s].%(ext)s',
    ffmpegPath: '/opt/ffmpeg',
    cookiesPath: '/data/cookies.txt',
    sourceUrl: 'https://vimeo.com/9'
  }))
  t.is(result.filePath, '/tmp/out/Direct [vid9].mp4')
})

test('provider maps executable, output, and exit failures to typed errors', async (t) => {
  const missing = createYtDlpProvider({ bin: 'nope', run: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ERR_YTDLP_MISSING' }) } })
  t.is((await caught(missing.search('x'))).code, 'ERR_YTDLP_MISSING')

  const badJson = createYtDlpProvider({ bin: 'yt-dlp', run: async () => ({ stdout: 'not json', stderr: '' }) })
  t.is((await caught(badJson.inspect('https://x/y'))).code, 'ERR_YTDLP_INVALID_OUTPUT')

  const failed = createYtDlpProvider({ bin: 'yt-dlp', run: async () => { throw Object.assign(new Error('boom'), { code: 'ERR_YTDLP_FAILED' }) } })
  t.is((await caught(failed.inspect('https://x/y'))).code, 'ERR_YTDLP_FAILED')
})
