import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseArgv } from '../src/argv.js'
import { createArchivePublisher, createYtDlpDownloader } from '../src/archive-manager.js'
import { renderArchiveTui, renderArchiveWebHome } from '../src/archive-ui.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('archive UI commands and flags are exposed by the relay CLI', async (t) => {
  const bin = readFileSync(join(__dirname, '..', 'bin.js'), 'utf8')
  const compose = readFileSync(join(__dirname, '..', '..', '..', 'docker-compose.relay.yml'), 'utf8')

  t.is(parseArgv(['ui', '--host', '0.0.0.0', '--port', '8174']).command, 'ui')
  t.alike(parseArgv(['ui', '--host', '0.0.0.0', '--port', '8174']).flags, { host: '0.0.0.0', port: '8174' })
  t.exception(() => parseArgv(['ui', '--api-open']), /Unknown argument --api-open/, 'the retired open-access switch is rejected')
  t.is(parseArgv(['archive', '--url', 'https://www.youtube.com/watch?v=abc', '--channel-name', 'Anon']).command, 'archive')
  t.ok(bin.includes('ui       Run the relay archive WebUI'), 'help exposes the container WebUI')
  t.ok(bin.includes('archive  Queue or run anonymous YouTube archive jobs'), 'help exposes archive job management')
  t.absent(readFileSync(join(__dirname, '..', 'src', 'archive-manager.js'), 'utf8').includes('node:child_process'), 'archive manager uses runtime subprocess shim')
  t.absent(readFileSync(join(__dirname, '..', 'src', 'archive-manager.js'), 'utf8').includes('node:crypto'), 'archive manager uses Bare-compatible crypto')
  t.absent(readFileSync(join(__dirname, '..', 'src', 'archive-console.js'), 'utf8').includes('node:http'), 'archive console uses runtime HTTP shim')
  t.ok(compose.includes('8174:8174'), 'root relay compose exposes the local archive UI port')
  t.ok(compose.includes('PEARTUBE_ARCHIVE_UI_ENABLED: "true"'), 'compose enables archive UI by default')
  t.ok(compose.includes('PEARTUBE_ARCHIVE_FFMPEG_PATH: /usr/local/bin/ffmpeg'), 'compose configures ffmpeg for yt-dlp archive merging')
  t.ok(compose.includes('PEARTUBE_ARCHIVE_YT_DLP_EXTRA_ARGS: "--plugin-dirs /usr/local/share/yt-dlp-plugins --extractor-args youtube:player_client=default,-android_vr,mweb;youtubepot-bgutilcli:cli_path=/usr/local/bin/bgutil-pot"'), 'compose configures the packaged POT plugin directory and CLI provider for archive retries')
  t.ok(compose.includes('PEARTUBE_ARCHIVE_YT_DLP_RETRY_EXTRA_ARGS'), 'compose configures fallback yt-dlp client args for bot-check retries')
  t.ok(compose.includes('PEARTUBE_ARCHIVE_COOKIES_PATH'), 'compose documents optional YouTube cookies path for bot checks')
})

test('archive TUI and WebUI render queue, archive form, and publish actions', async (t) => {
  const model = {
    status: { peers: 3, feedEntries: 7, seeding: { videos: 11 } },
    jobs: [{ id: 'arch_1', status: 'queued', channelName: 'Anon', title: 'Queued video' }]
  }

  const tui = renderArchiveTui(model)
  const web = renderArchiveWebHome(model)

  t.ok(tui.includes('PearTube Relay Archive Console'), 'TUI has relay archive heading')
  t.ok(tui.includes('Anonymous channel'), 'TUI calls out anonymous channels')
  t.ok(tui.includes('Publish to network'), 'TUI shows publish action')
  t.ok(web.includes('action="/archive"') && web.includes('enctype="multipart/form-data"'), 'WebUI exposes archive job form that accepts uploads')
  t.ok(web.includes('name="url"'), 'WebUI accepts video or channel URL')
  t.ok(web.includes('type="file"') && web.includes('name="file"'), 'WebUI accepts a video file upload')
  t.ok(web.includes('name="channelName"'), 'WebUI accepts anonymous channel name')
  t.ok(web.includes('Queued video'), 'WebUI renders archive queue')
})

test('archive WebUI only links playback for a verified v2 candidate reference', (t) => {
  const verified = 'V'.repeat(43)
  const web = renderArchiveWebHome({
    library: [
      { title: 'Verified title', candidateRef: verified, status: { label: 'Saved' } },
      { title: 'Metadata only', candidateRef: 'publication-id-is-not-a-capability', status: { label: 'Listed' } }
    ]
  })
  t.ok(web.includes(`href="/play/${verified}"`))
  t.absent(web.includes('/play/publication-id-is-not-a-capability'), 'publication ids never regain direct stream access')
  t.absent(web.includes('Simple relay catalog'), 'the duplicate JSON projection is not advertised')
})


test('yt-dlp downloader extracts the actual after_move filepath and verifies it exists', async (t) => {
  const calls = []
  const createdDirs = []
  const existing = new Set(['/archive/tmp/arch_1/example.mp4'])
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    fs: {
      mkdirSync(dir) { createdDirs.push(dir) },
      rmSync() {},
      existsSync(path) { return existing.has(path) }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn(binary, args) {
      calls.push({ binary, args })
      return {
        stdout: { on(event, cb) { if (event === 'data') cb('filepath\n/archive/tmp/arch_1/example.mp4\n') } },
        stderr: { on() {} },
        on(event, cb) { if (event === 'close') cb(0) }
      }
    }
  })

  const result = await downloader.download({ id: 'arch_1', url: 'https://www.youtube.com/watch?v=abc' })

  t.is(result.filePath, '/archive/tmp/arch_1/example.mp4')
  t.alike(createdDirs, ['/archive/tmp/arch_1'])
  t.ok(calls[0].args.includes('after_move:filepath'), 'keeps yt-dlp after_move filepath print')
})

test('yt-dlp downloader clamps one file to aggregate archive headroom', async (t) => {
  const calls = []
  const reservations = { bytes: 100 }
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    storageHeadroom: () => ({ tmp: 1_000, storage: 1_000, sharedVolume: true }),
    storageReservations: reservations,
    fs: {
      mkdirSync() {},
      rmSync() {},
      existsSync() { return true }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn(binary, args) {
      calls.push({ binary, args })
      return {
        stdout: { on(event, cb) { if (event === 'data') cb('filepath\n/archive/tmp/arch_cap/example.mp4\n') } },
        stderr: { on() {} },
        on(event, cb) { if (event === 'close') cb(0) }
      }
    }
  })

  const result = await downloader.download({ id: 'arch_cap', url: 'https://www.youtube.com/watch?v=abc' })
  const maxIndex = calls[0].args.indexOf('--max-filesize')
  t.ok(maxIndex >= 0, 'yt-dlp receives a hard file-size bound')
  t.is(calls[0].args[maxIndex + 1], '225', 'shared-volume staging leaves room for video, audio, merge, and persistence')
  t.is(reservations.bytes, 325, 'yt-dlp reserves its eventual persisted copy beside existing work')
  result.cleanup()
  t.is(reservations.bytes, 100, 'cleanup releases only yt-dlp ownership')
})

test('yt-dlp downloader terminates and cleans up when live headroom is exhausted', async (t) => {
  let headroomChecks = 0
  let cached = false
  let invalidations = 0
  let killed = false
  const removed = []
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    storageHeadroom: () => {
      headroomChecks += 1
      if (headroomChecks === 1) {
        cached = true
        return { tmp: 1_000, storage: 1_000, sharedVolume: true }
      }
      return cached
        ? { tmp: 1_000, storage: 1_000, sharedVolume: true }
        : { tmp: 0, storage: 1_000, sharedVolume: true }
    },
    onStorageChanged() {
      invalidations += 1
      cached = false
    },
    fs: {
      mkdirSync() {},
      rmSync(path) { removed.push(path) },
      existsSync() { return true }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn() {
      cached = true
      const handlers = { close: [], error: [] }
      return {
        stdout: { on(event, cb) { if (event === 'data') cb('filepath\n/archive/tmp/arch_live/example.mp4\n') } },
        stderr: { on() {} },
        on(event, cb) { handlers[event]?.push(cb) },
        kill() {
          killed = true
          for (const close of handlers.close) close(1)
        }
      }
    }
  })

  await t.exception(
    downloader.download({ id: 'arch_live', url: 'https://www.youtube.com/watch?v=abc' }),
    /storage headroom/,
    'live aggregate exhaustion aborts the subprocess'
  )
  t.ok(killed, 'the running yt-dlp process is terminated')
  t.ok(invalidations > 0, 'the monitor invalidates cached headroom without a reservation ledger')
  t.ok(removed.includes('/archive/tmp/arch_live'), 'the partial target directory is removed')
})


test('yt-dlp downloader reads source title duration channel and thumbnail URL from info json', async (t) => {
  const infoPath = '/archive/tmp/arch_meta/example.info.json'
  const existing = new Set(['/archive/tmp/arch_meta/example.mp4', infoPath])
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    fs: {
      mkdirSync() {},
      rmSync() {},
      existsSync(path) { return existing.has(path) },
      readFileSync(path) {
        t.is(path, infoPath)
        return JSON.stringify({
          title: 'Real Source Title',
          description: 'Real source description',
          duration: 456,
          thumbnail: 'https://source.example/thumb.jpg',
          uploader: 'Real Channel'
        })
      }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn() {
      return {
        stdout: { on(event, cb) { if (event === 'data') cb('filepath\n/archive/tmp/arch_meta/example.mp4\n') } },
        stderr: { on() {} },
        on(event, cb) { if (event === 'close') cb(0) }
      }
    }
  })

  const result = await downloader.download({ id: 'arch_meta', url: 'https://rumble.com/example.html' })

  t.is(result.title, 'Real Source Title')
  t.is(result.description, 'Real source description')
  t.is(result.duration, 456)
  t.is(result.thumbnailUrl, 'https://source.example/thumb.jpg')
  t.is(result.creatorName, 'Real Channel')
})

test('yt-dlp downloader fails with useful context when reported output file is missing', async (t) => {
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    fs: {
      mkdirSync() {},
      rmSync() {},
      existsSync() { return false }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn() {
      return {
        stdout: { on(event, cb) { if (event === 'data') cb('filepath\n/archive/tmp/arch_2/missing.mp4\n') } },
        stderr: { on() {} },
        on(event, cb) { if (event === 'close') cb(0) }
      }
    }
  })

  await t.exception(
    () => downloader.download({ id: 'arch_2', url: 'https://youtu.be/abc' }),
    /yt-dlp reported output file does not exist: \/archive\/tmp\/arch_2\/missing\.mp4/
  )
})

test('yt-dlp downloader removes deprecated no-call-home and passes cookies/js runtime options', async (t) => {
  const calls = []
  const existing = new Set(['/archive/tmp/arch_auth/example.mp4'])
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    cookiesPath: '/var/lib/peartube-relay/youtube-cookies.txt',
    jsRuntime: 'deno:/usr/local/bin/deno',
    fs: {
      mkdirSync() {},
      rmSync() {},
      existsSync(path) { return existing.has(path) }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn(binary, args) {
      calls.push({ binary, args })
      return {
        stdout: { on(event, cb) { if (event === 'data') cb('filepath\n/archive/tmp/arch_auth/example.mp4\n') } },
        stderr: { on() {} },
        on(event, cb) { if (event === 'close') cb(0) }
      }
    }
  })

  await downloader.download({ id: 'arch_auth', url: 'https://www.youtube.com/watch?v=ABbqy1VGeck' })

  const args = calls[0].args
  t.absent(args.includes('--no-call-home'), 'deprecated yt-dlp no-call-home flag is not passed')
  t.ok(args.includes('--cookies'), 'cookies option is passed when configured')
  t.is(args[args.indexOf('--cookies') + 1], '/var/lib/peartube-relay/youtube-cookies.txt')
  t.ok(args.includes('--js-runtimes'), 'JS runtime option is passed when configured')
  t.is(args[args.indexOf('--js-runtimes') + 1], 'deno:/usr/local/bin/deno')
})

test('yt-dlp WebUI downloader preserves original best format and passes ffmpeg location', async (t) => {
  const calls = []
  const existing = new Set(['/archive/tmp/arch_ffmpeg/example.mp4'])
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    ffmpegPath: '/usr/local/bin/ffmpeg',
    fs: {
      mkdirSync() {},
      rmSync() {},
      existsSync(path) { return existing.has(path) }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn(binary, args) {
      calls.push({ binary, args })
      return {
        stdout: { on(event, cb) { if (event === 'data') cb('filepath\n/archive/tmp/arch_ffmpeg/example.mp4\n') } },
        stderr: { on() {} },
        on(event, cb) { if (event === 'close') cb(0) }
      }
    }
  })

  await downloader.download({ id: 'arch_ffmpeg', url: 'https://www.youtube.com/watch?v=ABbqy1VGeck' })

  const args = calls[0].args
  t.is(args[args.indexOf('-f') + 1], 'bv*+ba/b', 'WebUI archive defaults to original-preserving best video+audio with best fallback')
  t.absent(args.includes('--merge-output-format'), 'archive downloader does not force remuxing to mp4 by default')
  t.ok(args.includes('--ffmpeg-location'), 'ffmpeg location is passed when configured')
  t.is(args[args.indexOf('--ffmpeg-location') + 1], '/usr/local/bin/ffmpeg')
})

test('yt-dlp downloader appends configured extra args before the URL', async (t) => {
  const calls = []
  const existing = new Set(['/archive/tmp/arch_extra/example.mp4'])
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    ytDlpExtraArgs: ['--extractor-args', 'youtube:player_client=mweb', '--force-ipv4'],
    fs: {
      mkdirSync() {},
      rmSync() {},
      existsSync(path) { return existing.has(path) }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn(binary, args) {
      calls.push({ binary, args })
      return {
        stdout: { on(event, cb) { if (event === 'data') cb('filepath\n/archive/tmp/arch_extra/example.mp4\n') } },
        stderr: { on() {} },
        on(event, cb) { if (event === 'close') cb(0) }
      }
    }
  })

  await downloader.download({ id: 'arch_extra', url: 'https://www.youtube.com/watch?v=ABbqy1VGeck' })

  const args = calls[0].args
  const urlIndex = args.indexOf('https://www.youtube.com/watch?v=ABbqy1VGeck')
  t.ok(urlIndex > 0, 'source URL remains the final positional argument')
  t.is(args[urlIndex - 3], '--extractor-args')
  t.is(args[urlIndex - 2], 'youtube:player_client=mweb')
  t.is(args[urlIndex - 1], '--force-ipv4')
})

test('yt-dlp downloader retries bot-check failures with configured fallback args', async (t) => {
  const calls = []
  const removed = []
  const existing = new Set(['/archive/tmp/arch_retry/example.mp4'])
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    ytDlpExtraArgs: ['--extractor-args', 'youtube:player_client=default,-android_vr,mweb'],
    ytDlpRetryExtraArgs: [['--extractor-args', 'youtube:player_client=web_safari']],
    fs: {
      mkdirSync() {},
      rmSync(dir) { removed.push(dir) },
      existsSync(path) { return existing.has(path) }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn(binary, args) {
      calls.push({ binary, args })
      const callNumber = calls.length
      return {
        stdout: { on(event, cb) { if (event === 'data' && callNumber === 2) cb('filepath\n/archive/tmp/arch_retry/example.mp4\n') } },
        stderr: { on(event, cb) { if (event === 'data' && callNumber === 1) cb('ERROR: [youtube] 6ZVnOQ8DmFI: Sign in to confirm you’re not a bot') } },
        on(event, cb) { if (event === 'close') cb(callNumber === 1 ? 1 : 0) }
      }
    }
  })

  const result = await downloader.download({ id: 'arch_retry', url: 'https://www.youtube.com/watch?v=6ZVnOQ8DmFI' })

  t.is(result.filePath, '/archive/tmp/arch_retry/example.mp4')
  t.is(calls.length, 2, 'bot-check failure triggers a retry')
  t.ok(calls[0].args.includes('youtube:player_client=default,-android_vr,mweb'), 'first attempt uses primary client args')
  t.ok(calls[1].args.includes('youtube:player_client=web_safari'), 'second attempt uses retry client args')
  t.alike(removed, ['/archive/tmp/arch_retry'], 'partial failed output dir is cleared before retry')
})

test('yt-dlp downloader can retry through a UI-provided Invidious instance', async (t) => {
  const calls = []
  const existing = new Set(['/archive/tmp/arch_inv/example.mp4'])
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    ytDlpExtraArgs: ['--extractor-args', 'youtube:player_client=default,-android_vr,mweb'],
    fs: {
      mkdirSync() {},
      rmSync() {},
      existsSync(path) { return existing.has(path) }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn(binary, args) {
      calls.push({ binary, args })
      const callNumber = calls.length
      return {
        stdout: { on(event, cb) { if (event === 'data' && callNumber === 2) cb('filepath\n/archive/tmp/arch_inv/example.mp4\n') } },
        stderr: { on(event, cb) { if (event === 'data' && callNumber === 1) cb('ERROR: [youtube] 6ZVnOQ8DmFI: HTTP Error 403: Forbidden') } },
        on(event, cb) { if (event === 'close') cb(callNumber === 1 ? 1 : 0) }
      }
    }
  })

  await downloader.download({
    id: 'arch_inv',
    url: 'https://www.youtube.com/shorts/6ZVnOQ8DmFI',
    invidiousInstance: 'https://inv.thepixora.com/'
  })

  t.is(calls.length, 2, '403 failure triggers Invidious fallback when configured')
  t.is(calls[1].args.at(-1), 'https://inv.thepixora.com/latest_version?id=6ZVnOQ8DmFI&itag=18&local=true')
  t.absent(calls[1].args.includes('--extractor-args'), 'direct Invidious media fallback does not reuse YouTube extractor args')
})

test('yt-dlp downloader falls back from Invidious direct media to watch page', async (t) => {
  const calls = []
  const existing = new Set(['/archive/tmp/arch_inv_watch/example.mp4'])
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    fs: {
      mkdirSync() {},
      rmSync() {},
      existsSync(path) { return existing.has(path) }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn(binary, args) {
      calls.push({ binary, args })
      const callNumber = calls.length
      return {
        stdout: { on(event, cb) { if (event === 'data' && callNumber === 3) cb('filepath\n/archive/tmp/arch_inv_watch/example.mp4\n') } },
        stderr: { on(event, cb) {
          if (event !== 'data') return
          if (callNumber === 1) cb('ERROR: [youtube] 6ZVnOQ8DmFI: Sign in to confirm you’re not a bot')
          if (callNumber === 2) cb('ERROR: [generic] Unable to download webpage: HTTP Error 400: Bad Request')
        } },
        on(event, cb) { if (event === 'close') cb(callNumber === 3 ? 0 : 1) }
      }
    }
  })

  await downloader.download({
    id: 'arch_inv_watch',
    url: 'https://youtu.be/6ZVnOQ8DmFI',
    invidiousInstance: 'inv.thepixora.com'
  })

  t.is(calls.length, 3, 'direct media failure retries the Invidious watch page')
  t.is(calls[1].args.at(-1), 'https://inv.thepixora.com/latest_version?id=6ZVnOQ8DmFI&itag=18&local=true')
  t.is(calls[2].args.at(-1), 'https://inv.thepixora.com/watch?v=6ZVnOQ8DmFI')
})

test('yt-dlp downloader rejects bogus direct Invidious output and continues fallback attempts', async (t) => {
  const calls = []
  const existing = new Set(['/archive/tmp/arch_inv_bogus/example.mp4'])
  const downloader = createYtDlpDownloader({
    outputDir: '/archive/tmp',
    fs: {
      mkdirSync() {},
      rmSync() {},
      existsSync(path) { return existing.has(path) }
    },
    path: {
      join(...parts) { return parts.join('/').replace(/\/+/g, '/') }
    },
    spawnFn(binary, args) {
      calls.push({ binary, args })
      const callNumber = calls.length
      return {
        stdout: { on(event, cb) {
          if (event !== 'data') return
          if (callNumber === 2) cb('filepath\n/archive/tmp/arch_inv_bogus/latest_version [latest_version？id=6ZVnOQ8DmFI&itag=18&local=true].unknown_video\n')
          if (callNumber === 3) cb('filepath\n/archive/tmp/arch_inv_bogus/example.mp4\n')
        } },
        stderr: { on(event, cb) {
          if (event === 'data' && callNumber === 1) cb('ERROR: [youtube] 6ZVnOQ8DmFI: HTTP Error 403: Forbidden')
        } },
        on(event, cb) { if (event === 'close') cb(callNumber === 1 ? 1 : 0) }
      }
    }
  })

  const result = await downloader.download({
    id: 'arch_inv_bogus',
    url: 'https://www.youtube.com/watch?v=6ZVnOQ8DmFI',
    invidiousInstance: 'https://invidious.projectsegfau.lt/'
  })

  t.is(result.filePath, '/archive/tmp/arch_inv_bogus/example.mp4')
  t.is(calls.length, 3, 'bogus .unknown_video direct media result retries the watch page')
  t.is(calls[1].args.at(-1), 'https://invidious.projectsegfau.lt/latest_version?id=6ZVnOQ8DmFI&itag=18&local=true')
  t.is(calls[2].args.at(-1), 'https://invidious.projectsegfau.lt/watch?v=6ZVnOQ8DmFI')
})


test('archive publisher opens separate deterministic channels per source identity', async (t) => {
  const created = []
  const uploadOptions = []
  const stubChannel = (name) => ({
    writable: true,
    blobs: true,
    _meta: {},
    async getMetadata () { return this._meta },
    async updateMetadata (patch) { this._meta = { ...this._meta, ...patch } },
    async ensureLocalBlobDrive () {},
    publicBeeKey: `bee-${name}`
  })
  const createChannelFn = async (_ctx, opts) => {
    created.push(opts.writerKeyName)
    return { channel: stubChannel(opts.writerKeyName), channelKeyHex: `ck-${created.length}` }
  }
  const publisher = createArchivePublisher({
    identityManager: {
      getActiveIdentity () { return { publicKey: 'relay-publisher', driveKey: 'relay-drive' } },
      async getActiveChannel () { return { blobs: true, publicBeeKey: 'relay-bee' } },
      async signChannelRootDescriptorForOwnedChannel () { return { ok: true } }
    },
    uploadManager: {
      async uploadFromPath (_channel, _filePath, options) {
        uploadOptions.push(options)
        return { success: true, videoId: `video-${uploadOptions.length}` }
      }
    },
    api: {},
    runtime: { ctx: {} },
    fs: {},
    createChannelFn,
    canPublish: retentionClass => retentionClass === 'archive-pin',
  })

  const oneA = await publisher.ensureAnonymousChannel({
    channelName: 'Creator One',
    sourceIdentity: { platform: 'youtube', sourceId: 'youtube:channel:UC1', creatorName: 'Creator One', creatorHandle: null },
    retentionClass: 'archive-pin',
  })
  const two = await publisher.ensureAnonymousChannel({
    channelName: 'Creator Two',
    sourceIdentity: { platform: 'youtube', sourceId: 'youtube:channel:UC2', creatorName: 'Creator Two', creatorHandle: null },
    retentionClass: 'archive-pin',
  })
  const oneB = await publisher.ensureAnonymousChannel({
    channelName: 'Creator One',
    sourceIdentity: { platform: 'youtube', sourceId: 'youtube:channel:UC1', creatorName: 'Creator One', creatorHandle: null },
    retentionClass: 'archive-pin',
  })

  await publisher.importVideo({
    retentionClass: 'archive-pin',
    channel: oneA.channel,
    filePath: '/tmp/one.mp4',
    title: 'One',
    description: '',
    mimeType: 'video/mp4',
    sourceType: 'yt-dlp',
    sourceUrl: 'https://www.youtube.com/watch?v=one',
    sourceVideoId: 'one',
    creatorSourceId: 'youtube:channel:UC1',
    creatorName: 'Creator One'
  })

  t.alike(created, ['peartube-archive-writer:youtube:channel:UC1', 'peartube-archive-writer:youtube:channel:UC2'], 'one deterministic channel per source id')
  t.is(oneA.channelKey, 'ck-1')
  t.is(two.channelKey, 'ck-2')
  t.is(oneB.channelKey, 'ck-1', 'the same source id reuses its channel')
  t.is(uploadOptions[0].creatorSourceId, 'youtube:channel:UC1')
  t.is(uploadOptions[0].sourceVideoId, 'one')
})


test('archive WebUI renders a season/episode picker for TV Discover cards', async (t) => {
  const html = renderArchiveWebHome({
    discover: {
      type: 'tv',
      query: 'severance',
      items: [{
        type: 'tv',
        tmdbId: 95396,
        title: 'Severance',
        year: 2022,
        posterPath: '/severance.jpg',
        networkStatus: 'missing'
      }]
    }
  })

  // TV cards expose season/episode <select>s (populated client-side) instead of
  // fixed hidden fields — discover results are show-level.
  t.ok(html.includes('name="tmdbSeason" class="js-season" data-tmdbid="95396"'), 'season select bound to the show')
  t.ok(html.includes('name="tmdbEpisode" class="js-episode"'), 'episode select present')
  // sourceVideoId is left blank so the server rebuilds it from the chosen
  // season/episode (see the console "builds episode-aware TMDB source ids" test).
  t.ok(html.includes('name="sourceVideoId" value=""'), 'tv source id deferred to server')
  t.ok(html.includes('/discover/seasons.json'), 'picker script fetches seasons')
  t.ok(html.includes('TV'), 'card labels the TV type')
})

test('an archive submission with no file and no URL is visibly ignored, not silently accepted', async (t) => {
  // Regression: both POST handlers redirected 303 back to the page when the
  // form carried neither a file nor a source URL. Nothing was enqueued and
  // nothing was said, so the operator saw what looked like an accepted upload
  // and waited for a job that never existed.
  const console = readFileSync(join(__dirname, '..', 'src', 'archive-console.js'), 'utf8')

  t.ok(console.includes('EMPTY_SUBMISSION_NOTICE'), 'the empty submission has a message')
  t.is(
    console.match(/\$\{EMPTY_SUBMISSION_QUERY\}/g)?.length,
    2,
    'both /discover/archive and /archive report an empty submission'
  )
  t.ok(
    console.includes("logger?.archive?.warn?.('Archive submission ignored: no file and no source URL')"),
    'an ignored submission is logged rather than dropped in silence'
  )

  const withNotice = renderArchiveWebHome({ notice: 'Nothing was archived: attach a video file or paste a source URL first.' })
  t.ok(withNotice.includes('class="notice"'), 'the notice renders as a banner')
  t.ok(withNotice.includes('Nothing was archived'), 'the banner carries the reason')
  t.ok(withNotice.includes('role="status"'), 'the banner is announced to assistive tech')

  const withoutNotice = renderArchiveWebHome({})
  t.absent(withoutNotice.includes('class="notice"'), 'a normal page shows no banner')
})

test('the read-only S3 panel reports block offload state without inventing bucket inventory', async (t) => {
  const enabled = renderArchiveWebHome({
    s3: {
      configured: true,
      endpoint: 'https://s3.us-west-002.backblazeb2.com',
      bucket: 'peartube-relay',
      region: 'us-west-002',
      prefix: 'relay-a',
      offload: {
        enabled: true,
        windowBytes: 2 * 1024 ** 3,
        restored: 5,
        residentBytes: 64 * 1024 ** 2
      }
    }
  })

  t.ok(enabled.includes('S3 block store'), 'the panel names the storage used by the seed path')
  t.ok(enabled.includes('Block offload: <span class="status-line on">enabled</span>'), 'the panel calls out that offload is on')
  t.ok(enabled.includes('Resident window: 2.0 GB'), 'the panel shows the resident window')
  t.ok(enabled.includes('Restored on read: 5 block(s)'), 'the panel shows current restore activity')
  t.ok(enabled.includes('Held on this volume: 64 MB'), 'the panel shows measured local residency')
  t.absent(enabled.includes('Written to the store'), 'temporary writes are not presented as durable inventory')
  t.absent(enabled.includes('Offloaded:'), 'restart-scoped counters are not presented as durable inventory')

  const disabled = renderArchiveWebHome({ s3: { configured: true, endpoint: 'https://s3.example.com', bucket: 'b', region: 'r', prefix: '' } })
  t.ok(disabled.includes('Block offload: <span class="status-line ">disabled</span>'), 'a relay with no offload says so')
  t.ok(disabled.includes("Media block data stays on this relay's volume."), 'and says where the block data is instead')
  t.absent(disabled.includes('Resident window'), 'no window is reported when nothing is offloaded')
})
