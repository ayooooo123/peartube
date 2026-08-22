import test from 'brittle'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

import { createDirectDownloader } from '../src/media/direct-download.js'
import { createRelayBlockOffload } from '../src/archive/block-offload.js'

// The relay refused two real archives — "direct download exceeded available
// storage headroom of 12269785088 bytes" — because the download guard reserved
// the whole title twice over: once staged, once persisted. With block offload
// the persisted side is a window in a bucket, so the title stopped being the
// requirement. These tests hold that line in both directions: relaxed for a
// configured window, untouched without one, and never relaxed for the
// free-disk floor, which is subtracted from every number below before the
// guard ever sees it.

// 6000 bytes of title. The room below is 10000: too little for the 12000 the
// unbounded guard reserves (staged copy + persisted copy), ample for a bounded
// ingest whose whole local footprint is one 8000-byte working set.
const VIDEO = Buffer.from('OFFLOAD-BOUNDED-DOWNLOAD-BYTES'.repeat(200))
const WINDOW = 8000
const ROOM = 10000

function startServer () {
  const server = createServer((req, res) => {
    if (req.url === '/episode.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(VIDEO.length) })
      res.end(VIDEO)
    } else {
      res.writeHead(404); res.end()
    }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })))
}

test('a title over headroom is refused without offload and accepted with it', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-offload-headroom-'))
  let hits = 0
  server.on('request', () => { hits += 1 })
  try {
    // The unbounded guard reserves the staged copy and the persisted copy, so
    // 6000 bytes of title want 12000 bytes of room and 10000 is a refusal.
    const unbounded = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageHeadroom: () => ROOM
    })
    await t.exception(
      unbounded.download({ id: 'arch_unbounded', url: `${base}/episode.mp4` }),
      new RegExp(`direct download exceeded available storage headroom of ${ROOM} bytes`),
      'without offload the title is still measured against itself, with the same message and the same number'
    )
    t.absent(existsSync(join(outputDir, 'arch_unbounded')), 'and the partial download is removed')

    // Same title, same room, one window configured.
    const reservations = { bytes: 0 }
    const bounded = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageReservations: reservations,
      storageHeadroom: () => ROOM,
      boundedLocalBytes: WINDOW
    })
    const ok = await bounded.download({ id: 'arch_bounded', url: `${base}/episode.mp4` })
    t.alike(readFileSync(ok.filePath), VIDEO, 'with offload the same title is accepted and arrives byte-exact')
    t.is(reservations.bytes, WINDOW, 'and it claims its working set, not the title, against concurrent archives')
    ok.cleanup()
    t.is(reservations.bytes, 0, 'released on cleanup')

    // The window itself is the thing that has to fit.
    const before = hits
    const tooWide = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageHeadroom: () => ROOM,
      boundedLocalBytes: ROOM + 1
    })
    await t.exception(
      tooWide.download({ id: 'arch_window', url: `${base}/episode.mp4` }),
      new RegExp(`direct download needs ${ROOM + 1} bytes of bounded-ingest working space but only ${ROOM} bytes of storage headroom remain`),
      'a window that cannot fit is refused by name'
    )
    t.is(hits, before, 'and refused before a byte is fetched')
    t.absent(existsSync(join(outputDir, 'arch_window')), 'with no temp directory left behind')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('the free-disk floor is not relaxed by offload', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-offload-floor-'))
  let hits = 0
  server.on('request', () => { hits += 1 })
  try {
    // headroomBytes() is already freeBytes - minFreeBytes, so nothing left
    // means the floor is reached. A configured window does not buy past it.
    const atFloor = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageHeadroom: () => 0,
      boundedLocalBytes: WINDOW
    })
    await t.exception(
      atFloor.download({ id: 'arch_floor', url: `${base}/episode.mp4` }),
      /relay has no archive storage headroom/,
      'at the floor an offloading relay refuses like any other'
    )
    t.is(hits, 0, 'before fetching a byte')

    // And the floor is live, not a reading taken once: a volume that fills
    // under the download stops it mid-stream even though the window never grew.
    let checks = 0
    const collapsing = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageHeadroom: () => {
        checks += 1
        return checks === 1 ? ROOM : WINDOW - 1
      },
      boundedLocalBytes: WINDOW
    })
    await t.exception(
      collapsing.download({ id: 'arch_collapse', url: `${base}/episode.mp4` }),
      new RegExp(`direct download needs ${WINDOW} bytes of bounded-ingest working space but only ${WINDOW - 1} bytes of storage headroom remain`),
      'free disk falling under the window stops a bounded download where it stands'
    )
    t.absent(existsSync(join(outputDir, 'arch_collapse')), 'and the partial download is removed')
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('offload bounds temp and persisted volumes separately', async function (t) {
  const { server, base } = await startServer()
  const outputDir = mkdtempSync(join(tmpdir(), 'pt-offload-volumes-'))
  try {
    const shared = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageHeadroom: () => ({ tmp: ROOM, storage: ROOM, sharedVolume: true }),
      boundedLocalBytes: WINDOW
    })
    const ok = await shared.download({ id: 'arch_shared', url: `${base}/episode.mp4` })
    t.alike(readFileSync(ok.filePath), VIDEO, 'one volume holding both: the window is the requirement')

    // Separate volumes: the persisted side is what the bucket relieves, so a
    // storage volume under the window is still a refusal.
    const separate = createDirectDownloader({
      outputDir,
      fs: nodeFs,
      path: nodePath,
      storageHeadroom: () => ({ tmp: ROOM * 4, storage: WINDOW - 1, sharedVolume: false }),
      boundedLocalBytes: WINDOW
    })
    await t.exception(
      separate.download({ id: 'arch_separate', url: `${base}/episode.mp4` }),
      new RegExp(`direct download needs ${WINDOW} bytes of bounded-ingest working space but only ${WINDOW - 1} bytes of storage headroom remain`),
      'a persisted volume smaller than the window is refused'
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    server.close()
  }
})

test('the relay hands the download its real offload working set', async function (t) {
  const offload = await createRelayBlockOffload({
    config: {
      archive: {
        s3: {
          offload: true,
          endpoint: 'https://s3.example.com',
          bucket: 'peartube-archive',
          accessKeyId: 'AKIA-TEST',
          secretAccessKey: 'secret',
          offloadWindowBytes: 8 * 1024 * 1024
        }
      }
    },
    fetchImpl: async () => { throw new Error('no request should be made') },
    createSigner: () => ({})
  })
  t.ok(offload, 'offload is configured')
  // 256 KiB blocks, two of them in flight: the backend's own bound.
  const idle = offload.localWorkingBytes(0)
  t.is(idle, (8 * 1024 * 1024) + (2 * 256 * 1024), 'an idle bounded ingest needs the window plus the two blocks in flight')
  // The number a 40 GiB title adds is merkle bookkeeping, not the title.
  const huge = offload.localWorkingBytes(40 * 1024 * 1024 * 1024)
  t.is(huge - idle, 20 * 1024 * 1024, 'a 40 GiB title adds 20 MiB of tree, not 40 GiB of video')
  t.absent(await createRelayBlockOffload({ config: { archive: { s3: { offload: false } } } }), 'and an unconfigured relay has no working set to hand out')
})
