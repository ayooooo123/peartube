import test from 'brittle'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseArgv } from '../src/argv.js'
import { createArchiveJobStore, enqueueArchiveJob, createArchiveManager, createArchivePublisher, createYtDlpDownloader } from '../src/archive-manager.js'
import { buildCatalogChannels, createArchiveConsole } from '../src/archive-console.js'
import { renderArchiveTui, renderArchiveWebHome, renderModerationTargetDetail } from '../src/archive-ui.js'

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
  t.ok(compose.includes('PEARTUBE_NODE_ROLES: public-index,relay-cache'), 'root relay compose declares public relay/cache roles')
  t.ok(compose.includes('PEARTUBE_MODERATION_MODE: report-and-alert'), 'root relay compose declares moderation mode')
  t.ok(compose.includes('PEARTUBE_ARCHIVE_UI_ENABLED: "true"'), 'compose enables archive UI by default')
  t.ok(compose.includes('PEARTUBE_ARCHIVE_FFMPEG_PATH: /usr/local/bin/ffmpeg'), 'compose configures ffmpeg for yt-dlp archive merging')
  t.ok(compose.includes('PEARTUBE_ARCHIVE_YT_DLP_EXTRA_ARGS: "--plugin-dirs /usr/local/share/yt-dlp-plugins --extractor-args youtube:player_client=default,-android_vr,mweb;youtubepot-bgutilcli:cli_path=/usr/local/bin/bgutil-pot"'), 'compose configures the packaged POT plugin directory and CLI provider for archive retries')
  t.ok(compose.includes('PEARTUBE_ARCHIVE_YT_DLP_RETRY_EXTRA_ARGS'), 'compose configures fallback yt-dlp client args for bot-check retries')
  t.ok(compose.includes('PEARTUBE_ARCHIVE_COOKIES_PATH'), 'compose documents optional YouTube cookies path for bot checks')
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


test('archive manager uses source video title and thumbnail without channel suffix in preview cards', async (t) => {
  const metaDb = new Map()
  const store = createArchiveJobStore({ metaDb: {
    async get(key) { return metaDb.has(key) ? { value: metaDb.get(key) } : null },
    async put(key, value) { metaDb.set(key, value) }
  } })
  const imports = []
  const seeded = []
  const manager = createArchiveManager({
    store,
    downloader: {
      async download() {
        return {
          filePath: '/tmp/source.mp4',
          title: 'Original Source Video Title',
          description: 'Source description',
          mimeType: 'video/mp4',
          duration: 123,
          thumbnailUrl: 'https://source.example/thumb.jpg'
        }
      }
    },
    publisher: {
      async ensureAnonymousChannel() {
        return { channelKey: 'drive-key', publicBeeKey: 'public-bee', channel: { blobs: true } }
      },
      async importVideo(input) {
        imports.push(input)
        return {
          videoId: 'video-1',
          metadata: {
            blobId: '0:4:0:4096',
            blobsCoreKey: 'aa'.repeat(32),
            thumbnailUrl: input.thumbnailUrl,
            duration: input.duration,
            mimeType: input.mimeType,
            uploadedAt: 1700000000000
          }
        }
      },
      async publishChannel() {},
      async seedChannel(input) { seeded.push(input) }
    }
  })

  const job = await manager.enqueue({
    url: 'https://rumble.com/example.html',
    channelName: 'America First Full Episodes',
    title: 'America First Full Episodes'
  })
  const result = await manager.runJob(job.id)

  t.is(imports[0].title, 'Original Source Video Title')
  t.is(imports[0].thumbnailUrl, 'https://source.example/thumb.jpg')
  t.is(result.title, 'Original Source Video Title')
  t.is(result.previewVideo.title, 'Original Source Video Title')
  t.is(result.previewVideo.thumbnailUrl, 'https://source.example/thumb.jpg')
  t.absent(result.previewVideo.title.includes('Rumble archive'), 'title has no archive suffix')
  t.absent(result.previewVideo.title.includes('America First Full Episodes'), 'title is not replaced by channel name')
  t.is(seeded[0].previewVideos[0].title, 'Original Source Video Title')
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

test('archive WebUI renders relay posture banner', async (t) => {
  const web = renderArchiveWebHome({
    relayStatus: {
      roles: ['public-index', 'relay-cache', 'archiver'],
      posture: {
        storesPublicMetadata: true,
        storesMediaCache: true,
        storesArchivePublisherContent: true,
        storesDecryptionKeys: false,
        nonKnowledgeRelay: false
      }
    },
    status: { peers: 3, feedEntries: 7, seeding: { videos: 11 } },
    jobs: []
  })

  t.ok(web.includes('roles: public-index,relay-cache,archiver'), 'WebUI shows configured roles')
  t.ok(web.includes('stores public metadata; stores public media cache; stores archive publisher content; stores no keys'), 'WebUI shows honest posture')
  t.ok(web.includes('Public index stores public metadata'), 'WebUI does not imply public index is non-knowledge')
})

test('archive UI renders active operator alerts', async (t) => {
  const model = {
    relayStatus: {
      alerts: {
        latest: [
          {
            id: 'alert-q',
            severity: 'critical',
            category: 'moderation',
            targetType: 'channelKey',
            target: 'chan-q',
            summary: 'Quarantine applied to channelKey:chan-q',
            suggestedActions: ['review', 'block']
          }
        ]
      }
    },
    status: { peers: 3, feedEntries: 7, seeding: { videos: 11 } },
    jobs: []
  }

  const tui = renderArchiveTui(model)
  const web = renderArchiveWebHome(model)

  t.ok(tui.includes('Alerts:'), 'TUI has an alert section')
  t.ok(tui.includes('critical moderation channelKey:chan-q Quarantine applied to channelKey:chan-q'), 'TUI shows alert severity and target')
  t.ok(web.includes('<section class="alerts">'), 'WebUI has an alert section')
  t.ok(web.includes('Quarantine applied to channelKey:chan-q'), 'WebUI shows alert summary')
  t.ok(web.includes('review, block'), 'WebUI shows suggested actions')
})

test('archive UI renders moderation review queue controls', async (t) => {
  const model = {
    relayStatus: {
      reviewQueue: [
        {
          id: 'channel:chan-q',
          targetType: 'channelKey',
          target: 'chan-q',
          state: 'quarantined',
          action: 'quarantine',
          channelKey: 'chan-q',
          ownerKey: 'owner-q',
          publicBeeKey: 'bee-q',
          source: 'discovered',
          retentionClass: 'discovery',
          bytes: 2048,
          videoCount: 2
        }
      ]
    },
    status: { peers: 3, feedEntries: 7, seeding: { videos: 11 } },
    jobs: []
  }

  const tui = renderArchiveTui(model)
  const web = renderArchiveWebHome(model)

  t.ok(tui.includes('Review Queue:'), 'TUI has review queue section')
  t.ok(tui.includes('quarantined channelKey:chan-q owner=owner-q bytes=2048 videos=2'), 'TUI shows target cache context')
  t.ok(web.includes('<section class="review">'), 'WebUI has review queue section')
  t.ok(web.includes('channelKey:chan-q'), 'WebUI shows target')
  t.ok(web.includes('/moderation/target?targetType=channelKey&amp;target=chan-q'), 'WebUI links review targets to detail pages')
  t.ok(web.includes('/moderation/audit.json'), 'WebUI links to audit export')
  t.ok(web.includes('<form class="report-form" method="post" action="/moderation/report">'), 'WebUI exposes local report form')
  t.ok(web.includes('name="comment"'), 'WebUI accepts report comments')
  t.ok(web.includes('name="action" value="block"'), 'WebUI exposes one-click block')
  t.ok(web.includes('name="action" value="watch"'), 'WebUI exposes one-click watch')
  t.ok(web.includes('name="action" value="quarantine"'), 'WebUI exposes one-click quarantine')
})

test('archive UI renders moderation target detail with cache and blob refs', async (t) => {
  const html = renderModerationTargetDetail({
    detail: {
      targetType: 'channelKey',
      target: 'chan-q',
      matchedChannels: 1,
      cacheStatus: {
        bytes: 2048,
        videoCount: 1,
        retentionClasses: ['discovery'],
        sources: ['discovered']
      },
      channels: [
        {
          channelKey: 'chan-q',
          publicBeeKey: 'bee-q',
          ownerKey: 'owner-q',
          source: 'discovered',
          retentionClass: 'discovery',
          bytes: 2048,
          videoCount: 1,
          moderation: { state: 'quarantined', action: 'quarantine' },
          previewVideos: [
            {
              id: 'video-1',
              title: 'Preview Video',
              blobId: '0:4:0:2048',
              blobsCoreKey: 'aa'.repeat(32),
              thumbnailBlobId: '4:1:2048:512',
              thumbnailBlobsCoreKey: 'bb'.repeat(32)
            }
          ],
          unavailableVideos: [
            {
              id: 'video-2',
              blobId: '0:2:0:1024',
              blobsCoreKey: 'cc'.repeat(32),
              reason: 'timeout'
            }
          ]
        }
      ]
    }
  })

  t.ok(html.includes('<h1>channelKey:chan-q</h1>'), 'detail page names target')
  t.ok(html.includes('bytes=2048 videos=1'), 'detail page shows cache status')
  t.ok(html.includes('publicBeeKey'), 'detail page includes channel refs')
  t.ok(html.includes('Preview Video'), 'detail page includes preview video metadata')
  t.ok(html.includes('aa'.repeat(32)), 'detail page includes video blob core')
  t.ok(html.includes('4:1:2048:512'), 'detail page includes thumbnail blob ref')
  t.ok(html.includes('timeout'), 'detail page includes unavailable refs')
})

test('archive console moderation action endpoint persists operator action', async (t) => {
  const actions = []
  let handler = null
  const server = {
    listen(_port, _host, cb) { cb() },
    close(cb) { cb() }
  }
  const service = {
    runtime: {
      ctx: {
        metaDb: {
          async get() { return null },
          async put() {}
        }
      }
    },
    getStatus() {
      return { runtime: {}, reviewQueue: [] }
    },
    async addModerationRule(rule) {
      actions.push(rule)
      return { id: 'mod_1', ...rule }
    }
  }
  const consoleUi = await createArchiveConsole({
    service,
    downloader: {},
    publisher: {},
    serverFactory(fn) {
      handler = fn
      return server
    }
  })

  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/moderation/action'
  const response = await new Promise((resolve) => {
    const res = {
      statusCode: null,
      headers: null,
      body: '',
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode
        this.headers = headers
      },
      end(body = '') {
        this.body += String(body)
        resolve(this)
      }
    }
    handler(req, res)
    req.emit('data', 'action=block&targetType=channelKey&target=chan-q&reason=operator-review')
    req.emit('end')
  })

  t.alike(actions, [{
    action: 'block',
    targetType: 'channelKey',
    target: 'chan-q',
    reason: 'operator-review'
  }])
  t.is(response.statusCode, 303)
  t.is(response.headers.location, '/')
  await consoleUi.close()
})

test('archive console moderation report endpoint persists local reports', async (t) => {
  const reports = []
  let handler = null
  const server = {
    listen(_port, _host, cb) { cb() },
    close(cb) { cb() }
  }
  const service = {
    runtime: {
      ctx: {
        metaDb: {
          async get() { return null },
          async put() {}
        }
      }
    },
    getStatus() {
      return { runtime: {}, reviewQueue: [] }
    },
    async submitModerationReport(report) {
      reports.push(report)
      return { id: 'report_1', ...report }
    }
  }
  const consoleUi = await createArchiveConsole({
    service,
    downloader: {},
    publisher: {},
    serverFactory(fn) {
      handler = fn
      return server
    }
  })

  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/moderation/report'
  const response = await new Promise((resolve) => {
    const res = {
      statusCode: null,
      headers: null,
      body: '',
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode
        this.headers = headers
      },
      end(body = '') {
        this.body += String(body)
        resolve(this)
      }
    }
    handler(req, res)
    req.emit('data', 'targetType=channel&target=chan-r&reason=spam&comment=unexpected+preview')
    req.emit('end')
  })

  t.alike(reports, [{
    targetType: 'channel',
    target: 'chan-r',
    reason: 'spam',
    comment: 'unexpected preview',
    reporter: 'local'
  }])
  t.is(response.statusCode, 303)
  t.is(response.headers.location, '/')
  await consoleUi.close()
})

test('archive console exposes moderation target detail and audit export', async (t) => {
  let handler = null
  const server = {
    listen(_port, _host, cb) { cb() },
    close(cb) { cb() }
  }
  const service = {
    runtime: {
      ctx: {
        metaDb: {
          async get() { return null },
          async put() {}
        }
      }
    },
    getStatus() {
      return { runtime: {}, reviewQueue: [] }
    },
    getModerationTargetDetail({ targetType, target }) {
      return {
        targetType,
        target,
        matchedChannels: 1,
        cacheStatus: { bytes: 12, videoCount: 1, retentionClasses: ['discovery'], sources: ['discovered'] },
        channels: [{
          channelKey: target,
          publicBeeKey: 'bee-q',
          ownerKey: 'owner-q',
          previewVideos: [{ id: 'video-1', blobId: '0:1:0:12', blobsCoreKey: 'aa'.repeat(32) }],
          unavailableVideos: []
        }]
      }
    },
    getModerationAudit() {
      return {
        schema: 'peartube.relayModerationAudit',
        version: 1,
        rules: [{ id: 'mod_1', action: 'block', targetType: 'channelKey', target: 'chan-q' }],
        alerts: [{ id: 'alert_1', category: 'moderation', target: 'chan-q' }],
        reviewQueue: [{ id: 'channel:chan-q', target: 'chan-q' }]
      }
    }
  }
  const consoleUi = await createArchiveConsole({
    service,
    downloader: {},
    publisher: {},
    serverFactory(fn) {
      handler = fn
      return server
    }
  })

  async function request(method, url) {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    return new Promise((resolve) => {
      const res = {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(statusCode, headers = {}) {
          this.statusCode = statusCode
          this.headers = headers
        },
        end(body = '') {
          this.body += String(body)
          resolve(this)
        }
      }
      handler(req, res)
      req.emit('end')
    })
  }

  const detail = await request('GET', '/moderation/target?targetType=channelKey&target=chan-q')
  const audit = await request('GET', '/moderation/audit.json')

  t.is(detail.statusCode, 200)
  t.ok(detail.body.includes('<h1>channelKey:chan-q</h1>'))
  t.is(audit.statusCode, 200)
  t.is(audit.headers['content-type'], 'application/json; charset=utf-8')
  t.alike(JSON.parse(audit.body).rules[0], { id: 'mod_1', action: 'block', targetType: 'channelKey', target: 'chan-q' })
  await consoleUi.close()
})

test('simple relay catalog omits blocked or quarantined review targets from feed snapshots', async (t) => {
  const channelKey = 'c'.repeat(64)
  const publicBeeKey = 'b'.repeat(64)
  const previewVideos = [{
    id: 'video-1',
    blobId: '0:1:0:99',
    blobsCoreKey: 'a'.repeat(64),
    availability: 'playable',
    byteAvailability: 'playable',
    mimeType: 'video/mp4'
  }]

  const projected = await buildCatalogChannels({
    channels: [{
      channelKey,
      publicBeeKey,
      source: 'discovered',
      moderation: { state: 'blocked' },
      previewVideos
    }],
    store: { async getCompletedVideoPreviewsByChannel() { return new Map() } },
    publicFeed: {
      getFeed() {
        return [{
          driveKey: channelKey,
          publicBeeKey,
          source: 'peer',
          previewVideos
        }]
      }
    }
  })

  t.alike(projected, [])
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


test('archive publisher opens separate relay-owned channels for source identities', async (t) => {
  const created = []
  const uploadOptions = []
  const channels = new Map()
  const identityManager = {
    getActiveIdentity() { return { publicKey: 'relay', driveKey: 'relay-drive' } },
    async createIdentity(name) {
      created.push({ name })
      const driveKey = `drive-${created.length}`
      channels.set(driveKey, { blobs: true, publicBeeKey: `bee-${created.length}` })
      return { publicKey: `pub-${created.length}`, driveKey }
    },
    async getChannelForIdentity(identity) {
      return channels.get(identity.driveKey)
    },
    async getActiveChannel() {
      return { blobs: true, publicBeeKey: 'relay-bee' }
    }
  }
  const publisher = createArchivePublisher({
    identityManager,
    uploadManager: {
      async uploadFromPath(_channel, _filePath, options) {
        uploadOptions.push(options)
        return { success: true, videoId: `video-${uploadOptions.length}` }
      }
    },
    api: { async submitToFeed() {} },
    runtime: {},
    fs: {}
  })

  const oneA = await publisher.ensureAnonymousChannel({
    channelName: 'Creator One',
    sourceIdentity: { platform: 'youtube', sourceId: 'youtube:channel:UC1', creatorName: 'Creator One', creatorHandle: null }
  })
  const two = await publisher.ensureAnonymousChannel({
    channelName: 'Creator Two',
    sourceIdentity: { platform: 'youtube', sourceId: 'youtube:channel:UC2', creatorName: 'Creator Two', creatorHandle: null }
  })
  const oneB = await publisher.ensureAnonymousChannel({
    channelName: 'Creator One',
    sourceIdentity: { platform: 'youtube', sourceId: 'youtube:channel:UC1', creatorName: 'Creator One', creatorHandle: null }
  })

  await publisher.importVideo({
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

  t.alike(created.map((entry) => entry.name), ['Creator One', 'Creator Two'])
  t.is(oneA.channelKey, 'drive-1')
  t.is(two.channelKey, 'drive-2')
  t.is(oneB.channelKey, 'drive-1')
  t.is(uploadOptions[0].creatorSourceId, 'youtube:channel:UC1')
  t.is(uploadOptions[0].sourceVideoId, 'one')
})
