import test from 'brittle'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseBoundary, receiveMultipartUpload } from '../src/multipart.js'

const BOUNDARY = '----pearboundaryXYZ'

function buildBody (fields, filePart) {
  const parts = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  if (filePart) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${filePart.field}"; filename="${filePart.filename}"\r\nContent-Type: ${filePart.contentType}\r\n\r\n`))
    parts.push(Buffer.isBuffer(filePart.data) ? filePart.data : Buffer.from(filePart.data))
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(parts)
}

// Feed a body through the parser in fixed-size slices to exercise boundary
// detection across chunk edges.
function feed (body, chunkSize) {
  const req = new EventEmitter()
  const uploadDir = mkdtempSync(join(tmpdir(), 'pt-multipart-'))
  const promise = receiveMultipartUpload(req, { boundary: BOUNDARY, uploadDir })
  queueMicrotask(async () => {
    for (let i = 0; i < body.length; i += chunkSize) {
      req.emit('data', body.subarray(i, Math.min(i + chunkSize, body.length)))
      await Promise.resolve()
    }
    req.emit('end')
  })
  return { promise, uploadDir }
}

test('parseBoundary reads the boundary from a content-type header', function (t) {
  t.is(parseBoundary('multipart/form-data; boundary=----pearboundaryXYZ'), '----pearboundaryXYZ')
  t.is(parseBoundary('multipart/form-data; boundary="quoted-123"'), 'quoted-123')
  t.is(parseBoundary('application/json'), null)
})

test('receiveMultipartUpload streams the file to disk and buffers fields', async function (t) {
  const data = Buffer.from('PEARTUBE-VIDEO-BYTES-'.repeat(500)) // ~10KB
  const body = buildBody(
    { tmdbType: 'tv', tmdbId: '95396', tmdbSeason: '1', tmdbEpisode: '2', title: 'Severance S01E02' },
    { field: 'file', filename: 'clip.mp4', contentType: 'video/mp4', data }
  )
  const { promise, uploadDir } = feed(body, 64)
  try {
    const { fields, file } = await promise
    t.is(fields.tmdbType, 'tv')
    t.is(fields.tmdbId, '95396')
    t.is(fields.title, 'Severance S01E02')
    t.ok(file, 'file part captured')
    t.is(file.field, 'file')
    t.is(file.filename, 'clip.mp4')
    t.is(file.mimeType, 'video/mp4')
    t.is(file.size, data.length)
    t.ok(existsSync(file.path), 'file written to disk')
    t.alike(readFileSync(file.path), data, 'file bytes are intact')
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})

test('receiveMultipartUpload is robust to 1-byte-at-a-time chunking', async function (t) {
  // Binary payload that itself contains CR/LF and dashes to stress the matcher.
  const data = Buffer.from([0x0d, 0x0a, 0x2d, 0x2d, 0x00, 0xff, 0x0d, 0x0a, 0x41, 0x42, 0x2d, 0x0a])
  const body = buildBody({ a: 'x' }, { field: 'file', filename: 'b.bin', contentType: 'application/octet-stream', data })
  const { promise, uploadDir } = feed(body, 1)
  try {
    const { fields, file } = await promise
    t.is(fields.a, 'x')
    t.is(file.size, data.length)
    t.alike(readFileSync(file.path), data, 'binary bytes survive byte-wise feeding')
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})

test('receiveMultipartUpload has no arbitrary file-size cap', async function (t) {
  const data = Buffer.alloc(4096, 0x61)
  const body = buildBody({}, { field: 'file', filename: 'big.mp4', contentType: 'video/mp4', data })
  const req = new EventEmitter()
  const uploadDir = mkdtempSync(join(tmpdir(), 'pt-multipart-no-cap-'))
  const promise = receiveMultipartUpload(req, { boundary: BOUNDARY, uploadDir, maxBytes: 1024 })
  queueMicrotask(() => {
    req.emit('data', body)
    req.emit('end')
  })
  try {
    const { file } = await promise
    t.is(file.size, data.length, 'legacy maxBytes is ignored; storage policy owns capacity')
    t.alike(readFileSync(file.path), data, 'file bytes are intact')
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})

test('receiveMultipartUpload stops at storage headroom and cleans up', async function (t) {
  const data = Buffer.alloc(4096, 0x61)
  const body = buildBody({}, { field: 'file', filename: 'big.mp4', contentType: 'video/mp4', data })
  const req = new EventEmitter()
  const uploadDir = mkdtempSync(join(tmpdir(), 'pt-multipart-headroom-'))
  const promise = receiveMultipartUpload(req, { boundary: BOUNDARY, uploadDir, storageHeadroom: () => 32 })
  queueMicrotask(() => {
    req.emit('data', body)
    req.emit('end')
  })
  try {
    await t.exception(promise, /storage headroom/)
    const uploads = join(uploadDir, 'uploads')
    if (existsSync(uploads)) {
      const { readdirSync } = await import('node:fs')
      t.is(readdirSync(uploads).length, 0, 'partial upload cleaned up')
    } else {
      t.pass('no upload dir left behind')
    }
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})

test('receiveMultipartUpload accepts object storage headroom snapshots', async function (t) {
  const data = Buffer.alloc(4096, 0x62)
  const body = buildBody({}, { field: 'file', filename: 'big.mp4', contentType: 'video/mp4', data })
  const uploadDir = mkdtempSync(join(tmpdir(), 'pt-multipart-object-headroom-'))
  try {
    const sharedReq = new EventEmitter()
    const shared = receiveMultipartUpload(sharedReq, {
      boundary: BOUNDARY,
      uploadDir,
      storageHeadroom: () => ({ tmp: data.length * 3, storage: data.length * 3, sharedVolume: true })
    })
    queueMicrotask(() => {
      sharedReq.emit('data', body)
      sharedReq.emit('end')
    })
    const { file: sharedFile } = await shared
    t.alike(readFileSync(sharedFile.path), data, 'shared-volume objects reserve staged bytes plus the eventual copy')

    const separateReq = new EventEmitter()
    const separate = receiveMultipartUpload(separateReq, {
      boundary: BOUNDARY,
      uploadDir,
      storageHeadroom: () => ({ tmp: data.length + 1, storage: data.length + 1, sharedVolume: false })
    })
    queueMicrotask(() => {
      separateReq.emit('data', body)
      separateReq.emit('end')
    })
    const { file: separateFile } = await separate
    t.alike(readFileSync(separateFile.path), data, 'separate-volume objects check tmp and persisted storage independently')

    let checks = 0
    const crampedReq = new EventEmitter()
    const cramped = receiveMultipartUpload(crampedReq, {
      boundary: BOUNDARY,
      uploadDir,
      storageHeadroom: () => {
        checks += 1
        return { tmp: data.length + 1, storage: data.length + 1, sharedVolume: true }
      }
    })
    queueMicrotask(async () => {
      for (let i = 0; i < body.length; i += 64) {
        crampedReq.emit('data', body.subarray(i, Math.min(i + 64, body.length)))
        await Promise.resolve()
      }
      crampedReq.emit('end')
    })
    await t.exception(cramped, /storage headroom/, 'shared-volume objects compare the staged total, not just each chunk')
    t.ok(checks > 10, 'the fixture exercised many small upload chunks')
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})

test('receiveMultipartUpload returns null file when only fields are sent', async function (t) {
  const body = buildBody({ url: 'https://example.com/x.mp4', title: 'Just a URL' }, null)
  const { promise, uploadDir } = feed(body, 32)
  try {
    const { fields, file } = await promise
    t.is(fields.url, 'https://example.com/x.mp4')
    t.is(fields.title, 'Just a URL')
    t.is(file, null, 'no file part')
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})

test('an untouched file input (empty filename) is treated as a field, not a file', async function (t) {
  const body = Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://x/y.mp4\r\n`),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n`),
    Buffer.from(`--${BOUNDARY}--\r\n`)
  ])
  const { promise, uploadDir } = feed(body, 16)
  try {
    const { fields, file } = await promise
    t.is(file, null, 'empty file input is not captured as a file')
    t.is(fields.url, 'https://x/y.mp4')
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})
