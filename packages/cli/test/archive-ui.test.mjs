import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseArgv } from '../src/argv.js'
import { createArchiveJobStore, enqueueArchiveJob, createArchiveManager, createYtDlpDownloader } from '../src/archive-manager.js'
import { renderArchiveTui, renderArchiveWebHome } from '../src/archive-ui.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('archive UI commands and flags are exposed by the relay CLI', async (t) => {
  const bin = readFileSync(join(__dirname, '..', 'bin.js'), 'utf8')
  const compose = readFileSync(join(__dirname, '..', '..', '..', 'docker-compose.relay.yml'), 'utf8')

  t.is(parseArgv(['ui', '--host', '0.0.0.0', '--port', '8174']).command, 'ui')
  t.alike(parseArgv(['ui', '--host', '0.0.0.0', '--port', '8174']).flags, { host: '0.0.0.0', port: '8174' })
  t.is(parseArgv(['archive', '--url', 'https://www.youtube.com/watch?v=abc', '--channel-name', 'Anon']).command, 'archive')
  t.ok(bin.includes('ui       Run the relay archive WebUI'), 'help exposes the container WebUI')
  t.ok(bin.includes('archive  Queue or run anonymous YouTube archive jobs'), 'help exposes archive job management')
  t.absent(readFileSync(join(__dirname, '..', 'src', 'archive-manager.js'), 'utf8').includes('node:child_process'), 'archive manager uses runtime subprocess shim')
  t.absent(readFileSync(join(__dirname, '..', 'src', 'archive-manager.js'), 'utf8').includes('node:crypto'), 'archive manager uses Bare-compatible crypto')
  t.absent(readFileSync(join(__dirname, '..', 'src', 'archive-console.js'), 'utf8').includes('node:http'), 'archive console uses runtime HTTP shim')
  t.ok(compose.includes('8174:8174'), 'root relay compose exposes the local archive UI port')
  t.ok(compose.includes('PEARTUBE_ARCHIVE_UI_ENABLED: "true"'), 'compose enables archive UI by default')
})

test('archive manager stores anonymous channel/job state without raw URLs in public status', async (t) => {
  const writes = []
  const db = new Map()
  const metaDb = {
    async get(key) { return db.has(key) ? { value: db.get(key) } : null },
    async put(key, value) { db.set(key, value); writes.push([key, value]) }
  }
  const store = createArchiveJobStore({ metaDb })

  const job = await enqueueArchiveJob(store, {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    channelName: 'mirror drop',
    publish: true,
    anonymous: true
  })

  t.ok(job.id.startsWith('arch_'), 'job receives a stable archive id')
  t.is(job.status, 'queued')
  t.is(job.channelName, 'mirror drop')
  t.is(job.publish, true)
  t.is(job.anonymous, true)
  t.absent(Object.keys(job).includes('url'), 'public job metadata never includes the source URL')
  t.ok(writes.some(([key]) => key === 'relay-archive-jobs'), 'jobs persist in relay storage')

  const loaded = await store.listJobs()
  t.is(loaded.length, 1)
  t.absent(Object.keys(loaded[0]).includes('url'), 'stored public job listing still omits the URL')
})

test('archive manager downloads, imports, publishes, and seeds videos through injected runtime adapters', async (t) => {
  const metaDb = new Map()
  const store = createArchiveJobStore({ metaDb: {
    async get(key) { return metaDb.has(key) ? { value: metaDb.get(key) } : null },
    async put(key, value) { metaDb.set(key, value) }
  } })
  const calls = []
  const manager = createArchiveManager({
    store,
    downloader: {
      async download(input) {
        calls.push(['download', input.url])
        return { filePath: '/tmp/video.mp4', title: 'Downloaded title', description: 'Downloaded description', mimeType: 'video/mp4' }
      }
    },
    publisher: {
      async ensureAnonymousChannel(input) {
        calls.push(['channel', input.channelName])
        return { channelKey: 'drive-key', publicBeeKey: 'public-bee', channel: { blobs: true } }
      },
      async importVideo(input) {
        calls.push(['import', input.filePath, input.title])
        return { videoId: 'video-1' }
      },
      async publishChannel(input) {
        calls.push(['publish', input.channelKey])
        return { success: true }
      },
      async seedChannel(input) {
        calls.push(['seed', input.channelKey, input.publicBeeKey])
      }
    }
  })

  const job = await manager.enqueue({ url: 'https://youtu.be/example', channelName: 'Anon Archive' })
  const result = await manager.runNext()

  t.is(result.status, 'completed')
  t.is(result.videoId, 'video-1')
  t.is(result.channelKey, 'drive-key')
  t.alike(calls, [
    ['download', 'https://youtu.be/example'],
    ['channel', 'Anon Archive'],
    ['import', '/tmp/video.mp4', 'Downloaded title'],
    ['publish', 'drive-key'],
    ['seed', 'drive-key', 'public-bee']
  ])

  const [publicJob] = await store.listJobs()
  t.is(publicJob.id, job.id)
  t.is(publicJob.status, 'completed')
  t.absent(Object.keys(publicJob).includes('url'), 'completed public job view omits original URL')
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
  t.ok(web.includes('<form method="post" action="/archive">'), 'WebUI exposes archive job form')
  t.ok(web.includes('name="url"'), 'WebUI accepts video or channel URL')
  t.ok(web.includes('name="channelName"'), 'WebUI accepts anonymous channel name')
  t.ok(web.includes('Queued video'), 'WebUI renders archive queue')
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
