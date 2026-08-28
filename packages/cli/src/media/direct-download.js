import { requestOnce } from './http-get.js'
import { getVideoMimeType } from './yt-dlp.js'
import { assertPublicHttpUrl, blockedAddressReason } from './public-url-guard.js'

// Direct HTTP(S) downloader for archive sources that are a plain link to the
// media file itself (e.g. a show/episode hosted on a file server or CDN) rather
// than a platform page yt-dlp would scrape. Streams the response straight to
// disk (never buffered), follows redirects, and validates the response is a
// video so a stray HTML page fails with a clear message instead of importing
// garbage.
//
// A job marked `requirePublicSource` came from the unauthenticated machine API,
// where the url is a stranger's, so the fetch is guarded rather than trusted:
//
//   every hop        re-checked with the same public-address guard the API door
//                    used, because a public url that 302s to 169.254.169.254 is
//                    the standard way past a door-only check
//   the socket       the address the connection actually reached is checked
//                    before a byte of the response is read, which is what
//                    closes DNS rebinding between the check and the connect
//   the content type the response must say it is a video; a `.mp4` on the end
//                    of a caller-chosen path is not evidence of anything
//   disk floor       the relay refuses when it is already at its configured
//                    minimum free-space floor, and measurable headroom is the
//                    only byte bound while writing
//
// What this does NOT stop: the TCP connection to a hop is established before
// its socket address can be read, so a redirect into private space still costs
// one completed connection and one GET line before it is dropped unread. That
// is a blind request, never a disclosure — nothing of the response reaches the
// caller, the job, or the log.

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|ts|m2ts|flv|ogv|ogg|wmv|mpg|mpeg)$/i
const VIDEO_CONTENT_TYPE = /^(video\/|application\/octet-stream|application\/mp4|binary\/octet-stream)/i
const MAX_REDIRECTS = 5

export function isDirectVideoUrl (url) {
  try {
    return VIDEO_EXT.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function extensionForContentType (contentType) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('webm')) return '.webm'
  if (ct.includes('matroska')) return '.mkv'
  if (ct.includes('quicktime')) return '.mov'
  if (ct.includes('x-msvideo')) return '.avi'
  if (ct.includes('mp2t')) return '.ts'
  return '.mp4'
}

function filenameFromDisposition (value) {
  if (!value) return null
  const star = /filename\*=(?:UTF-8'')?"?([^";]+)"?/i.exec(value)
  if (star) { try { return decodeURIComponent(star[1]) } catch { return star[1] } }
  const plain = /filename="?([^";]+)"?/i.exec(value)
  return plain ? plain[1] : null
}

function safeName (name, fallbackExt) {
  const cleaned = String(name || '').replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(-180)
  if (!cleaned) return `video${fallbackExt}`
  return VIDEO_EXT.test(cleaned) ? cleaned : `${cleaned}${fallbackExt}`
}

// The address this response actually came from. Read off the socket rather
// than re-resolved, so there is no window between the check and the connect
// for a name to change what it points at.
function assertSocketIsPublic (res, url) {
  const address = res?.socket?.remoteAddress
  // A transport that does not expose one cannot be judged; the per-hop check
  // above is what stands in that case.
  if (!address) return
  const reason = blockedAddressReason(address)
  if (reason) {
    res.destroy?.()
    throw new Error(`refusing ${url}: the connection reached ${address}, which is ${reason}`)
  }
}

async function openStream (url, { maxRedirects = MAX_REDIRECTS, timeoutMs = 0, requirePublicSource = false, lookup = null } = {}) {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Every hop, not just the first: the caller only chose the first one, and
    // the host it redirects to is chosen by whoever answered.
    if (requirePublicSource) await assertPublicHttpUrl(current, lookup ? { lookup } : {})
    const res = await requestOnce(current, {
      headers: { 'user-agent': 'PearTube-Relay', accept: '*/*' },
      timeoutMs,
      timeoutMessage: 'direct download timed out'
    })
    if (requirePublicSource) assertSocketIsPublic(res, current)
    const status = res.statusCode || 0
    if (status >= 300 && status < 400 && res.headers?.location) {
      const next = new URL(res.headers.location, current).toString()
      res.destroy?.()
      current = next
      continue
    }
    if (status < 200 || status >= 300) {
      res.destroy?.()
      throw new Error(`direct download failed with HTTP ${status}`)
    }
    return { res, finalUrl: current }
  }
  throw new Error('too many redirects during direct download')
}

function atStorageFloor(snapshot) {
  if (Number.isFinite(snapshot)) return snapshot <= 0
  if (!snapshot || typeof snapshot !== 'object') return false
  const values = [snapshot.tmp, snapshot.storage].filter((value) => Number.isFinite(value))
  return values.length > 0 && Math.min(...values) <= 0
}

function reserveAdjustedHeadroom(snapshot, reservedBytes) {
  const reserved = Number.isFinite(reservedBytes) && reservedBytes > 0 ? Math.floor(reservedBytes) : 0
  if (reserved <= 0) return snapshot
  if (Number.isFinite(snapshot)) return Math.max(0, Math.floor(snapshot) - reserved)
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  const storage = Number.isFinite(snapshot.storage) ? Math.max(0, Math.floor(snapshot.storage) - reserved) : snapshot.storage
  if (snapshot.sharedVolume === false) return { ...snapshot, storage }
  return {
    ...snapshot,
    tmp: Number.isFinite(snapshot.tmp) ? Math.max(0, Math.floor(snapshot.tmp) - reserved) : snapshot.tmp,
    storage
  }
}

// A bounded ingest's local footprint does not grow with the title, so the
// question is only whether its working set fits in the live room — asked again
// on every chunk, against the same floor-adjusted number, so free disk still
// governs even though the title no longer does.
//
// The chunk in flight is not added to the working set: that set already carries
// two whole blocks of slack for exactly this. It is compared against the room
// on its own, because a chunk larger than everything left is unwritable no
// matter how modest the window is.
function boundedRoomError(bounded, room, chunkLength, kind) {
  const need = Math.max(bounded, chunkLength)
  if (need <= room) return null
  return `${kind} needs ${need} bytes of bounded-ingest working space but only ${Math.max(0, room)} bytes of storage headroom remain`
}

// `bounded` is null unless the caller has told this download its bytes never
// all land on the volume. Null keeps every branch below byte-for-byte what it
// was: the staged file plus its eventual persisted copy, both title-sized.
function storageHeadroomError(snapshot, written, chunkLength, kind, state = null, boundedBytes = null) {
  const bounded = Number.isFinite(boundedBytes) && boundedBytes > 0 ? Math.floor(boundedBytes) : null
  const staged = written + chunkLength
  if (Number.isFinite(snapshot)) {
    const room = Math.floor(snapshot)
    if (bounded !== null) return boundedRoomError(bounded, room, chunkLength, kind)
    if (state && !Number.isFinite(state.sharedRoom)) state.sharedRoom = room
    const baseline = state && Number.isFinite(state.sharedRoom) ? state.sharedRoom : room
    if ((2 * staged) <= baseline && written + (2 * chunkLength) <= room) return null
    return `${kind} exceeded available storage headroom of ${Math.max(0, room)} bytes`
  }
  if (!snapshot || typeof snapshot !== 'object') return `${kind} cannot measure archive storage headroom`
  const tmp = Math.floor(snapshot.tmp)
  const storage = Math.floor(snapshot.storage)
  if (!Number.isFinite(tmp) || !Number.isFinite(storage)) return `${kind} cannot measure archive storage headroom`
  if (snapshot.sharedVolume !== false) {
    const room = Math.min(tmp, storage)
    if (bounded !== null) return boundedRoomError(bounded, room, chunkLength, kind)
    if (state && !Number.isFinite(state.sharedRoom)) state.sharedRoom = room
    const baseline = state && Number.isFinite(state.sharedRoom) ? state.sharedRoom : room
    if ((2 * staged) <= baseline && written + (2 * chunkLength) <= room) return null
    return `${kind} exceeded available storage headroom of ${Math.max(0, room)} bytes`
  }
  // The temp volume still has to hold the chunk in flight in either mode; only
  // the persisted side stops being title-sized.
  if (bounded !== null) {
    if (tmp < chunkLength) return `${kind} exceeded available archive temp headroom of ${Math.max(0, tmp)} bytes`
    return boundedRoomError(bounded, storage, chunkLength, kind)
  }
  if (state && !Number.isFinite(state.tmpRoom)) state.tmpRoom = tmp
  if (state && !Number.isFinite(state.storageRoom)) state.storageRoom = storage
  const tmpBaseline = state && Number.isFinite(state.tmpRoom) ? state.tmpRoom : tmp
  const storageBaseline = state && Number.isFinite(state.storageRoom) ? state.storageRoom : storage
  if (staged > tmpBaseline || tmp < chunkLength) return `${kind} exceeded available archive temp headroom of ${Math.max(0, Math.min(tmp, tmpBaseline))} bytes`
  if (staged > storageBaseline || storage < staged) return `${kind} exceeded available archive storage headroom of ${Math.max(0, Math.min(storage, storageBaseline))} bytes`
  return null
}

function pipeToFile (res, filePath, fs, { storageHeadroom = null, headroomState = null, reserveStorageBytes = null, releaseStorageBytes = null, boundedBytesFor = null, reserveBoundedBytes = null } = {}) {
  return new Promise((resolve, reject) => {
    let fd
    try { fd = fs.openSync(filePath, 'w') } catch (err) { reject(err); return }
    let done = false
    let written = 0
    const finish = (err) => {
      if (done) return
      done = true
      try { fs.closeSync(fd) } catch {}
      if (err) reject(err); else resolve()
    }
    res.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const bounded = boundedBytesFor ? boundedBytesFor(written + bytes.length) : null
      if (typeof storageHeadroom === 'function') {
        const error = storageHeadroomError(storageHeadroom(), written, bytes.length, 'direct download', headroomState, bounded)
        if (error) {
          res.destroy?.()
          finish(new Error(error))
          return
        }
      }
      // Unbounded, this job claims the persisted copy it is about to create,
      // byte for byte. Bounded, what it will keep is the working set, so it
      // claims that instead — a title-sized claim would deny a concurrent
      // archive room this job never occupies.
      let claimed = 0
      if (bounded !== null) {
        if (typeof reserveBoundedBytes === 'function') claimed = reserveBoundedBytes(bounded)
      } else if (typeof reserveStorageBytes === 'function') {
        reserveStorageBytes(bytes.length)
        claimed = bytes.length
      }
      try {
        fs.writeSync(fd, bytes)
        written += bytes.length
      } catch (err) {
        if (claimed > 0 && typeof releaseStorageBytes === 'function') releaseStorageBytes(claimed)
        res.destroy?.()
        finish(err)
      }
    })
    res.on('end', () => finish())
    res.on('error', (err) => finish(err))
  })
}

// Static helper for tests and config reasoning. `0` means unbounded by file
// size; only measurable storage headroom may become a byte bound.
export function byteCeiling (_maxBytes, _requirePublicSource, headroomBytes) {
  if (Number.isFinite(headroomBytes) && headroomBytes > 0) return Math.floor(headroomBytes)
  return 0
}

// Downloads are not capped by media file size. `storageHeadroom` reports the
// live temp-volume room and aggregate persisted-storage room. It is checked
// while streaming, so concurrent fetches cannot reserve the same bytes and
// failed huge fetches clean up their partial temp directories.
//
// `boundedLocalBytes` is how the caller says the bytes of this download do not
// all come to rest here: a number, or a function of the bytes streamed so far,
// giving the local working space the ingest behind this download needs. Set,
// the guard sizes the requirement by that working set instead of by the title,
// and the live free-disk room is still what it is measured against. Unset —
// the default, and every path with no block offload configured — nothing below
// changes.
//
// Two ways to take the bytes:
//
//   download()        writes them to a file under `outputDir` and hands back
//                     its path. The title has to fit on the volume.
//   downloadStream()  hands back a ONE-SHOT async iterable of the response's
//                     chunks and never creates a staging directory at all, so
//                     the title only has to fit through the relay, not on it.
//
// Both run exactly the same prologue and the same per-chunk guard: the floor is
// re-read on every chunk either way. Streaming relaxes the title-sized
// reservation, never the floor.
export function createDirectDownloader ({ outputDir, fs, path, timeoutMs = 0, lookup = null, storageHeadroom = null, storageReservations = null, boundedLocalBytes = null } = {}) {
  const boundedBytesFor = typeof boundedLocalBytes === 'function'
    ? (streamBytes) => Math.max(0, Math.floor(Number(boundedLocalBytes(streamBytes)) || 0))
    : (Number.isFinite(boundedLocalBytes) && boundedLocalBytes > 0
        ? () => Math.floor(boundedLocalBytes)
        : null)
  if (!outputDir) throw new Error('outputDir is required')

  // Everything both entry points do before a byte of the body is taken: the
  // floor pre-check, the reservation bookkeeping, the guarded fetch, the
  // content check and the name. `stage` is the only difference — a streaming
  // consumer gets no staging directory, which is how the temp file disappears
  // rather than merely shrinking.
  async function open (input, { stage }) {
    const url = input.url
    if (!url) throw new Error('direct download requires a url')
    const requirePublicSource = input.requirePublicSource === true
    const id = input.id || `dl_${Date.now()}`
    // Read once, before a byte is fetched: the same free-disk floor archive
    // ingestion is gated on. At or below the floor there is nothing to write
    // into, so say so instead of streaming a body onto a full volume.
    const reservation = { bytes: 0, released: false }
    const reserveBytes = (bytes) => {
      const size = Math.max(0, Math.floor(Number(bytes) || 0))
      if (size <= 0 || !storageReservations) return
      reservation.bytes += size
      storageReservations.bytes = Math.max(0, Math.floor(Number(storageReservations.bytes) || 0)) + size
    }
    const releaseBytes = (bytes) => {
      const size = Math.max(0, Math.min(reservation.bytes, Math.floor(Number(bytes) || 0)))
      if (size <= 0 || !storageReservations) return
      reservation.bytes -= size
      storageReservations.bytes = Math.max(0, Math.floor(Number(storageReservations.bytes) || 0) - size)
    }
    const releaseReservation = () => {
      if (reservation.released) return
      reservation.released = true
      releaseBytes(reservation.bytes)
      storageReservations?.invalidate?.()
    }
    const reserveBoundedBytes = (target) => {
      const claim = Math.max(0, Math.floor(target) - reservation.bytes)
      if (claim > 0) reserveBytes(claim)
      return claim
    }
    const measuredHeadroom = typeof storageHeadroom === 'function'
      ? () => reserveAdjustedHeadroom(storageHeadroom(), Math.max(0, Math.floor(Number(storageReservations?.bytes) || 0) - reservation.bytes))
      : null
    const headroomState = {}
    if (typeof measuredHeadroom === 'function') {
      const snapshot = measuredHeadroom()
      if (atStorageFloor(snapshot)) throw new Error('relay has no archive storage headroom; refusing direct download')
      const error = storageHeadroomError(snapshot, 0, 1, 'direct download', headroomState, boundedBytesFor ? boundedBytesFor(0) : null)
      if (error) throw new Error(error)
    }
    const targetDir = stage ? path.join(outputDir, id) : null
    const discard = () => {
      if (!targetDir) return
      try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
    if (targetDir) fs.mkdirSync(targetDir, { recursive: true })

    let res
    try {
      ({ res } = await openStream(url, { timeoutMs, requirePublicSource, lookup }))
    } catch (err) {
      discard()
      throw err
    }

    const contentType = res.headers?.['content-type'] || ''
    const disposition = res.headers?.['content-disposition'] || ''
    const dispositionName = filenameFromDisposition(disposition)
    // A guarded fetch takes the server's word for what this is and nothing
    // else: the path and the filename are both chosen by the caller, so
    // letting either vouch for the content would make the check decorative.
    const looksVideo = requirePublicSource
      ? VIDEO_CONTENT_TYPE.test(contentType)
      : VIDEO_CONTENT_TYPE.test(contentType) || isDirectVideoUrl(url) || VIDEO_EXT.test(dispositionName || '')
    if (!looksVideo) {
      res.destroy?.()
      discard()
      throw new Error(`URL did not return a downloadable video file (content-type: ${contentType || 'unknown'})`)
    }

    const ext = extensionForContentType(contentType)
    let urlName = ''
    try { urlName = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') } catch { urlName = '' }
    const fileName = safeName(dispositionName || urlName, ext)

    return {
      res,
      contentType,
      fileName,
      targetDir,
      discard,
      measuredHeadroom,
      headroomState,
      reserveBytes,
      releaseBytes,
      releaseReservation,
      reserveBoundedBytes
    }
  }

  // The name is the only thing left to go on once there is no file to sniff,
  // and it is the same fallback the file path used.
  function mimeTypeFor (contentType, name) {
    const clean = contentType.split(';')[0].trim()
    return clean && /^video\//i.test(clean) ? clean : getVideoMimeType(name)
  }

  function describe (input, fileName) {
    return {
      title: input.title || fileName || 'Archived video',
      sourceFileName: fileName,
      fileName,
      description: input.description || '',
      duration: undefined,
      thumbnailUrl: null,
      tags: [],
      creatorSourceId: input.creatorSourceId || null,
      creatorName: input.creatorName || null
    }
  }

  return {
    // True when the caller told this downloader its bytes do not all come to
    // rest here — i.e. block offload is configured. `downloadStream` is only
    // worth taking then, because the ingest behind it needs somewhere other
    // than this volume to put the blocks.
    bounded: boundedBytesFor !== null,

    async download (input = {}) {
      const opened = await open(input, { stage: true })
      const filePath = path.join(opened.targetDir, opened.fileName)

      try {
        await pipeToFile(opened.res, filePath, fs, {
          storageHeadroom: opened.measuredHeadroom,
          headroomState: opened.headroomState,
          reserveStorageBytes: opened.reserveBytes,
          releaseStorageBytes: opened.releaseBytes,
          boundedBytesFor,
          reserveBoundedBytes: opened.reserveBoundedBytes
        })
      } catch (err) {
        opened.discard()
        opened.releaseReservation()
        throw err
      }

      return {
        filePath,
        sourceFileName: opened.fileName,
        ...describe(input, opened.fileName),
        mimeType: mimeTypeFor(opened.contentType, filePath),
        releaseStorageReservation: opened.releaseReservation,
        cleanup () {
          opened.discard()
          opened.releaseReservation()
        }
      }
    },

    // No file, no staging directory: the body is handed over chunk by chunk and
    // the consumer decides where each one goes. `stream` is ONE-SHOT — it is
    // the HTTP response, so there is no second read of it — which is exactly
    // what makes the backend's asset writer pick its streaming ingest.
    //
    // Every guard the file path applies per chunk applies here per chunk: the
    // live floor-adjusted headroom is re-read before the chunk is handed on,
    // and the reservation is claimed before it is. Abandoning the iterable, or
    // a guard refusing mid-flight, destroys the response and gives the
    // reservation back; a completed stream keeps it until `cleanup`, because
    // the ingest behind it is still holding its working set.
    async downloadStream (input = {}) {
      const opened = await open(input, { stage: false })
      let streamed = 0

      async function *chunks () {
        let completed = false
        try {
          for await (const chunk of opened.res) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            const bounded = boundedBytesFor ? boundedBytesFor(streamed + bytes.length) : null
            if (typeof opened.measuredHeadroom === 'function') {
              const error = storageHeadroomError(opened.measuredHeadroom(), streamed, bytes.length, 'direct download', opened.headroomState, bounded)
              if (error) throw new Error(error)
            }
            if (bounded !== null) opened.reserveBoundedBytes(bounded)
            else opened.reserveBytes(bytes.length)
            streamed += bytes.length
            input.onProgress?.(streamed)
            yield bytes
          }
          completed = true
        } finally {
          opened.res.destroy?.()
          if (!completed) opened.releaseReservation()
        }
      }

      // `byteLength` is what the server SAID, not a promise: it is used for the
      // retention budget and progress percentages only. `0` when the response
      // was chunked and gave none, in which case the per-chunk free-disk guard
      // above is the only bound, exactly as it is for a length that lied.
      const declared = Number(opened.res.headers?.['content-length'])

      return {
        stream: chunks(),
        byteLength: Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : 0,
        bytesStreamed: () => streamed,
        sourceFileName: opened.fileName,
        ...describe(input, opened.fileName),
        mimeType: mimeTypeFor(opened.contentType, opened.fileName),
        releaseStorageReservation: opened.releaseReservation,
        cleanup () {
          opened.res.destroy?.()
          opened.releaseReservation()
        }
      }
    }
  }
}
