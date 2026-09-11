import Hyperblobs from 'hyperblobs'

function reportBlobRequestFailure(res, error, responseClosed) {
  // This error belongs to this request's stream/setup promise, not to a
  // process-wide rejection. Only its own cancelled teardown is expected.
  if (responseClosed && error?.code === 'REQUEST_CANCELLED') return
  console.error('[Storage] Blob request failed:', error)
  if (!res.destroyed) res.destroy(error)
}

function prepareBlobResponse(info, res) {
  const options = { start: 0, length: info.blob.byteLength, timeout: 0 }
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', info.type)
  if (info.range && options.length > 0) {
    const end = info.range.end === -1
      ? info.blob.byteLength - 1
      : Math.min(info.range.end, info.blob.byteLength - 1)
    options.start = info.range.start
    options.length = end - options.start + 1
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${options.start}-${end}/${info.blob.byteLength}`)
  }
  res.setHeader('Content-Length', String(options.length))
  return options
}

async function serveBlobRequest(blobServer, info, res) {
  let core = null
  let stream = null
  let responseClosed = Boolean(res.destroyed || res.writableEnded)
  if (responseClosed) return

  const cancel = () => {
    responseClosed = true
    stream?.destroy()
  }
  const cleanup = () => {
    res.off?.('close', cancel)
    res.off?.('error', cancel)
  }
  const failed = error => reportBlobRequestFailure(res, error, responseClosed)
  res.once('close', cancel)
  res.once('error', cancel)

  try {
    core = await blobServer._getCore(info.key, info, true)
    if (responseClosed) return
    if (!core) {
      res.statusCode = 404
      res.end()
      return
    }

    const options = prepareBlobResponse(info, res)
    if (info.head || options.length === 0) {
      // bare-http1 otherwise replaces an unflushed HEAD Content-Length with 0.
      if (info.head) res.flushHeaders()
      res.end()
      return
    }

    // Hyperblobs observes seek/open/read rejections and owns a child session.
    // hypercore-byte-stream's async _open can otherwise reject outside its
    // stream callback when a response aborts during a pending seek.
    stream = new Hyperblobs(core).createReadStream(info.blob, options)
    stream.once('error', failed)
    stream.once('close', cleanup)
    if (responseClosed) stream.destroy()
    else stream.pipe(res)
  } catch (error) {
    failed(error)
  } finally {
    try { await core?.close() } catch (error) { failed(error) }
    if (!stream) cleanup()
  }
}

export function createBlobRequestHandler(blobServer) {
  return function (info, res) {
    return serveBlobRequest(blobServer, info, res)
  }
}
