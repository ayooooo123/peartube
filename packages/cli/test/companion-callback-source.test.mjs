import test from 'brittle'
import http from 'node:http'
import b4a from 'b4a'
import { createCompanionCallbackSourceReader } from '../src/runtime.js'

test('companion-callback source reader streams ranges across 4MB chunks and resumes short 206 bodies', async (t) => {
  const secret = '39981b1834979c4c471a3fe11d4a7f346710e0db0fa05b4e3b0e51deb3f55c87'
  const fullPayload = Buffer.alloc(10 * 1024 * 1024) // 10MB
  for (let i = 0; i < fullPayload.length; i++) {
    fullPayload[i] = i & 0xff
  }

  let attemptCount = 0
  let attempt3RangeStart = null
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-length': String(fullPayload.length),
        'content-type': 'video/mp4',
        etag: '"test-etag-v1"'
      })
      res.end()
      return
    }

    if (req.method === 'GET') {
      const range = req.headers.range || ''
      const match = range.match(/bytes=(\d+)-(\d+)/)
      if (!match) {
        res.writeHead(400)
        res.end()
        return
      }

      const start = Number(match[1])
      const end = Number(match[2])
      attemptCount++
      if (attemptCount === 3) {
        attempt3RangeStart = start
      }
      // On attempt 2 (which is the start of chunk 2: 4MB-8MB), simulate a short 206 response
      if (attemptCount === 2) {
        const partialLength = 1024 * 1024 // send only 1MB instead of 4MB
        res.writeHead(206, {
          'content-range': `bytes ${start}-${start + partialLength - 1}/${fullPayload.length}`,
          'content-length': String(partialLength),
          'content-type': 'video/mp4'
        })
        res.write(fullPayload.subarray(start, start + partialLength))
        res.end() // connection ends early!
        return
      }

      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${fullPayload.length}`,
        'content-length': String(end - start + 1),
        'content-type': 'video/mp4'
      })
      res.end(fullPayload.subarray(start, end + 1))
      return
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`

  t.teardown(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  const reader = createCompanionCallbackSourceReader({
    origin,
    client: 'mediastorm',
    secret,
    token: 'test-token-abcdef1234567890',
    length: fullPayload.length,
    contentType: 'video/mp4'
  })

  t.ok(reader, 'reader was instantiated')

  const desc = await reader.describe()
  t.is(desc.byteLength, fullPayload.length, 'describe reports correct length')

  const chunks = []
  for await (const chunk of reader.open({ offset: 0, length: fullPayload.length })) {
    chunks.push(chunk)
  }

  const result = Buffer.concat(chunks)
  t.is(result.length, fullPayload.length, 'received full 10MB payload')
  t.alike(result, fullPayload, 'payload matches byte-for-byte even after short 206 retry')
  t.ok(attemptCount >= 3, 'retried after the short 206 body')
  t.is(attempt3RangeStart, 4 * 1024 * 1024 + 1024 * 1024, 'attempt 3 resumed exactly at 5MB offset after 1MB short read')
})

test('companion-callback source reader retries 503 responses and marks final error as recoverable SOURCE_RANGE_SHORT', async (t) => {
  const secret = '39981b1834979c4c471a3fe11d4a7f346710e0db0fa05b4e3b0e51deb3f55c87'

  let attempts503 = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-length': '1000',
        'content-type': 'video/mp4',
        etag: '"test-v1"'
      })
      res.end()
      return
    }

    // Always 503 (upstream address re-resolving or throttling)
    attempts503++
    res.writeHead(503, { 'retry-after': '1' })
    res.end('source range temporarily unavailable')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`

  t.teardown(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  const reader = createCompanionCallbackSourceReader({
    origin,
    client: 'mediastorm',
    secret,
    token: 'test-token-503',
    length: 1000,
    contentType: 'video/mp4'
  })

  let caught = null
  try {
    const stream = reader.open({ offset: 0, length: 1000 })
    for await (const _chunk of stream) {}
  } catch (err) {
    caught = err
  }
  t.ok(caught, '503 threw error')
  t.is(attempts503, 4, 'attempted 4 retries on 503 before final failure')
  t.is(caught.code, 'SOURCE_RANGE_SHORT', '503 mapped to SOURCE_RANGE_SHORT')
  t.is(caught.recoverable, true, '503 marked as recoverable')
})

test('companion-callback source reader handles zero readLength cleanly', async (t) => {
  const reader = createCompanionCallbackSourceReader({
    origin: 'http://127.0.0.1:9999',
    client: 'mediastorm',
    secret: '39981b1834979c4c471a3fe11d4a7f346710e0db0fa05b4e3b0e51deb3f55c87',
    token: 'test-token-empty',
    length: 1000,
    contentType: 'video/mp4'
  })

  const chunks = []
  for await (const chunk of reader.open({ offset: 1000, length: 0 })) {
    chunks.push(chunk)
  }
  t.is(chunks.length, 0, 'zero length yielded no chunks and did not throw')
})

test('companion-callback source reader guards against oversized 206 body on stream path', async (t) => {
  const secret = '39981b1834979c4c471a3fe11d4a7f346710e0db0fa05b4e3b0e51deb3f55c87'

  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-length': '1000',
        'content-type': 'video/mp4',
        etag: '"test-v1"'
      })
      res.end()
      return
    }

    // Return an oversized 206 response (200 bytes for a 100-byte range request)
    res.writeHead(206, {
      'content-range': 'bytes 0-99/1000',
      'content-length': '200',
      'content-type': 'video/mp4'
    })
    res.end(Buffer.alloc(200, 0x55))
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`

  t.teardown(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  const reader = createCompanionCallbackSourceReader({
    origin,
    client: 'mediastorm',
    secret,
    token: 'test-token-overrun-stream',
    length: 1000,
    contentType: 'video/mp4'
  })

  let caught = null
  const yielded = []
  try {
    for await (const chunk of reader.open({ offset: 0, length: 100 })) {
      yielded.push(chunk)
    }
  } catch (err) {
    caught = err
  }

  t.ok(caught, 'oversized body threw error')
  t.is(caught.code, 'SOURCE_RANGE_SHORT', 'overrun maps to SOURCE_RANGE_SHORT')
  t.is(yielded.length, 0, 'no chunks were yielded to consumer on overrun')
})

test('companion-callback source reader guards against oversized 206 body on arrayBuffer fallback', async (t) => {
  const secret = '39981b1834979c4c471a3fe11d4a7f346710e0db0fa05b4e3b0e51deb3f55c87'
  let arrayBufferCalled = false

  const mockFetch = async (url, options) => {
    if (options.method === 'HEAD') {
      return {
        status: 200,
        headers: new Headers({
          'content-length': '1000',
          'content-type': 'video/mp4',
          etag: '"test-v1"'
        }),
        body: null
      }
    }

    return {
      status: 206,
      headers: new Headers({
        'content-range': 'bytes 0-99/1000',
        'content-length': '200',
        'content-type': 'video/mp4'
      }),
      body: null,
      arrayBuffer: async () => {
        arrayBufferCalled = true
        return new Uint8Array(200).fill(0xaa).buffer
      }
    }
  }

  const reader = createCompanionCallbackSourceReader({
    origin: 'http://127.0.0.1:9876',
    client: 'mediastorm',
    secret,
    token: 'test-token-overrun-arraybuffer',
    length: 1000,
    contentType: 'video/mp4',
    fetch: mockFetch
  })

  let caught = null
  const yielded = []
  try {
    for await (const chunk of reader.open({ offset: 0, length: 100 })) {
      yielded.push(chunk)
    }
  } catch (err) {
    caught = err
  }

  t.ok(caught, 'oversized body threw error on arrayBuffer fallback')
  t.ok(arrayBufferCalled, 'arrayBuffer fallback was genuinely invoked')
  t.is(caught.code, 'SOURCE_RANGE_SHORT', 'overrun maps to SOURCE_RANGE_SHORT')
  t.is(yielded.length, 0, 'no chunks were yielded to consumer on arrayBuffer overrun')
})

test('companion-callback source reader buffers stream chunks and prevents partial delivery on split overrun', async (t) => {
  const secret = '39981b1834979c4c471a3fe11d4a7f346710e0db0fa05b4e3b0e51deb3f55c87'

  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-length': '1000',
        'content-type': 'video/mp4',
        etag: '"test-v1"'
      })
      res.end()
      return
    }

    // Return a split 206 response (chunk 1: 60 bytes, chunk 2: 50 bytes = 110 bytes for 100-byte range)
    res.writeHead(206, {
      'content-range': 'bytes 0-99/1000',
      'content-length': '110',
      'content-type': 'video/mp4'
    })
    res.write(Buffer.alloc(60, 0x11))
    setTimeout(() => {
      res.write(Buffer.alloc(50, 0x22))
      res.end()
    }, 20)
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`

  t.teardown(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  const reader = createCompanionCallbackSourceReader({
    origin,
    client: 'mediastorm',
    secret,
    token: 'test-token-split-overrun',
    length: 1000,
    contentType: 'video/mp4'
  })

  let caught = null
  const yielded = []
  try {
    for await (const chunk of reader.open({ offset: 0, length: 100 })) {
      yielded.push(chunk)
    }
  } catch (err) {
    caught = err
  }

  t.ok(caught, 'split oversized body threw error')
  t.is(caught.code, 'SOURCE_RANGE_SHORT', 'overrun maps to SOURCE_RANGE_SHORT')
  t.is(yielded.length, 0, 'zero chunks yielded from split overrun attempt')
})
