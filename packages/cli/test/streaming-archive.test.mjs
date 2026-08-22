import test from 'brittle'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

import { createArchivePublisher, createRoutingDownloader } from '../src/archive-manager.js'
import { createDirectDownloader } from '../src/media/direct-download.js'

// A 100 GB title cannot be staged on a 100 GiB volume, so with block offload
// configured the archive path stops staging at all: the HTTP body is handed to
// the ingest chunk by chunk and no file is ever created. These tests are about
// the ABSENCE of that file — the upload directory has to stay empty while the
// bytes go past — and about the temp-file path being untouched when offload is
// off, because without a bucket to put blocks in that path is the only correct
// one.

// Big enough to arrive in several socket reads, small enough to keep this
// machine's disk out of it.
const VIDEO = Buffer.from('STREAMING-ARCHIVE-EPISODE-BYTES-'.repeat(12500))
const SHORT = Buffer.from('SHORT-EPISODE-BYTES-'.repeat(300))
const WINDOW = 8000
const ROOM = 5_000_000

function startServer () {
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    if (req.url === '/episode.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(VIDEO.length) })
      res.end(VIDEO)
    } else if (req.url === '/short.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(SHORT.length) })
      res.end(SHORT)
    } else {
      res.writeHead(404); res.end()
    }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    hits: () => hits
  })))
}

function refusingYtDlp (t) {
  return {
    async download () {
      t.fail('yt-dlp must not be reached for a direct media link')
    }
  }
}

test('with offload configured the archive takes the body as a stream and never stages a file', async function (t) {
  const { server, base, hits } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-streaming-archive-'))
  const reservations = { bytes: 0 }
  try {
    const routing = createRoutingDownloader({
      directDownloader: createDirectDownloader({
        outputDir,
        fs: nodeFs,
        path: nodePath,
        storageHeadroom: () => ROOM,
        storageReservations: reservations,
        // Set only when block offload is configured, which is exactly when the
        // ingest behind this download has somewhere other than this volume to
        // put the blocks.
        boundedLocalBytes: WINDOW
      }),
      ytDlpDownloader: refusingYtDlp(t)
    })

    const downloaded = await routing.download({ id: 'arch_stream', url: `${base}/episode.mp4` })

    t.absent(downloaded.filePath, 'the download reports no file path, because there is no file')
    t.is(typeof downloaded.stream?.[Symbol.asyncIterator], 'function', 'it reports a consumable async iterable instead')
    t.is(downloaded.byteLength, VIDEO.length, 'and the length the server declared, for the retention budget')
    t.is(readdirSync(outputDir).length, 0, 'nothing has been created in the upload directory')

    const chunks = []
    let checkedMidStream = false
    for await (const chunk of downloaded.stream) {
      chunks.push(chunk)
      if (!checkedMidStream) {
        checkedMidStream = true
        t.is(readdirSync(outputDir).length, 0, 'and nothing is created while the body is going past')
      }
    }

    t.ok(chunks.length > 1, 'the body arrived as several chunks, so re-chunking is the ingest\'s problem')
    t.alike(Buffer.concat(chunks), VIDEO, 'and every byte arrived intact')
    t.is(downloaded.bytesStreamed(), VIDEO.length, 'byte accounting matches what was handed over')
    t.is(readdirSync(outputDir).length, 0, 'the upload directory is still empty after a complete archive')
    t.is(hits(), 1, 'the body was fetched exactly once')

    // The claim is the ingest's working set, not the title: a title-sized claim
    // would deny a concurrent archive room this job never occupies.
    t.is(reservations.bytes, WINDOW, 'the reservation is the working set, not the title')
    downloaded.cleanup()
    t.is(reservations.bytes, 0, 'released on cleanup')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('with offload off the archive keeps the temp-file path exactly as it was', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-streaming-archive-off-'))
  const reservations = { bytes: 0 }
  try {
    const routing = createRoutingDownloader({
      directDownloader: createDirectDownloader({
        outputDir,
        fs: nodeFs,
        path: nodePath,
        storageHeadroom: () => ROOM,
        storageReservations: reservations
        // boundedLocalBytes omitted: no offload, so the blocks have nowhere to
        // go but this volume and the title has to land here.
      }),
      ytDlpDownloader: refusingYtDlp(t)
    })

    const downloaded = await routing.download({ id: 'arch_file', url: `${base}/episode.mp4` })

    t.absent(downloaded.stream, 'no stream is offered')
    t.is(downloaded.filePath, join(outputDir, 'arch_file', 'episode.mp4'), 'the title is staged under the upload directory')
    t.alike(readFileSync(downloaded.filePath), VIDEO, 'byte-exact on disk')
    t.is(reservations.bytes, VIDEO.length, 'and the whole title is claimed, as it always was')
    downloaded.cleanup()
    t.absent(existsSync(join(outputDir, 'arch_file')), 'cleanup removes the staging directory')
    t.is(reservations.bytes, 0, 'and releases the reservation')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('the free-disk floor still stops a streaming archive mid-flight and leaves nothing behind', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-streaming-archive-floor-'))
  const reservations = { bytes: 0 }
  try {
    // At the floor, a configured window buys nothing: there is no room to work
    // in at all.
    const atFloor = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageHeadroom: () => 0,
      boundedLocalBytes: WINDOW
    })
    await t.exception(
      atFloor.downloadStream({ id: 'arch_floor', url: `${base}/short.mp4` }),
      /relay has no archive storage headroom/,
      'a streaming archive refuses at the floor like any other'
    )
    t.is(readdirSync(outputDir).length, 0, 'before creating anything')

    // And the floor is live, re-read on every chunk: a volume that fills under
    // the download stops it where it stands even though the window never grew.
    let checks = 0
    const collapsing = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageReservations: reservations,
      storageHeadroom: () => {
        checks += 1
        return checks === 1 ? ROOM : WINDOW - 1
      },
      boundedLocalBytes: WINDOW
    })
    const downloaded = await collapsing.downloadStream({ id: 'arch_collapse', url: `${base}/short.mp4` })
    await t.exception(
      (async () => { for await (const chunk of downloaded.stream) void chunk })(),
      new RegExp(`direct download needs ${WINDOW} bytes of bounded-ingest working space but only ${WINDOW - 1} bytes of storage headroom remain`),
      'free disk falling under the window stops a streaming archive by name'
    )
    t.ok(checks > 1, 'the floor was re-read after the pre-check, not trusted once')
    t.is(readdirSync(outputDir).length, 0, 'no partial state is left behind, because none was ever created')
    t.is(reservations.bytes, 0, 'and the reservation is given back when the stream dies')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('importVideo streams a one-shot body and never stats a file for it', async function (t) {
  const calls = []
  const claimed = []
  const statted = []
  const uploadManager = {
    async uploadFromStream (channel, source, options) {
      calls.push({ method: 'uploadFromStream', channel, source, options })
      return { success: true, videoId: 'v_stream', metadata: { size: options.byteLength } }
    },
    async uploadFromPath (channel, filePath, options, fs) {
      calls.push({ method: 'uploadFromPath', channel, filePath, options, fs })
      return { success: true, videoId: 'v_path', metadata: { size: 1 } }
    }
  }
  const fs = {
    statSync (filePath) {
      statted.push(filePath)
      return { size: 4242 }
    }
  }
  const publisher = createArchivePublisher({
    identityManager: {},
    uploadManager,
    api: {},
    runtime: {},
    fs,
    canPublish: (retentionClass, requestedBytes) => {
      claimed.push(requestedBytes)
      return true
    }
  })
  const channel = { blobs: {}, blobsKeyHex: '22'.repeat(32) }
  const source = (async function *() { yield Buffer.from('one-shot') })()

  const streamed = await publisher.importVideo({
    retentionClass: 'archive-pin',
    channel,
    stream: source,
    byteLength: 90_000,
    title: 'Oversized Title',
    mimeType: 'video/mp4'
  })

  t.is(streamed.videoId, 'v_stream', 'the streaming entry point published the title')
  t.is(calls.length, 1, 'exactly one upload call')
  t.is(calls[0].method, 'uploadFromStream', 'and it was the streaming one')
  t.is(calls[0].source, source, 'the very same one-shot iterable was handed through, untouched')
  t.is(calls[0].options.byteLength, 90_000, 'with the declared length for progress')
  t.is(calls[0].options.title, 'Oversized Title', 'and the same metadata the file path carries')
  t.alike(statted, [], 'nothing was stat\'ed: there is no file to stat')
  t.alike(claimed, [90_000], 'the retention budget is charged the declared length')

  const staged = await publisher.importVideo({
    retentionClass: 'archive-pin',
    channel,
    filePath: '/tmp/does-not-need-to-exist.mp4',
    title: 'Ordinary Title',
    mimeType: 'video/mp4'
  })

  t.is(staged.videoId, 'v_path', 'a file path still takes the temp-file path')
  t.is(calls[1].method, 'uploadFromPath', 'unchanged')
  t.is(calls[1].filePath, '/tmp/does-not-need-to-exist.mp4', 'with the staged file')
  t.is(calls[1].fs, fs, 'and the fs module it has always been given')
  t.alike(statted, ['/tmp/does-not-need-to-exist.mp4'], 'which is the only path that stats the file')
  t.alike(claimed, [90_000, 4242], 'and charges the retention budget its real size')
})
