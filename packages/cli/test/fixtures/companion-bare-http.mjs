import net from 'bare-net'
import process from 'bare-process'

import { decodeSearchQuery } from '../../src/companion/contracts.js'
import { canonicalizePathAndQuery, signControlRequest } from '../../src/companion/auth.js'
import { resolveCompanionConfig } from '../../src/companion/config.js'
import { createCompanionServer } from '../../src/companion/server.js'
import { createStreamCapabilityStore } from '../../src/companion/stream-capabilities.js'

const NOW = 1_786_406_400_000
const SECRET = 'ef'.repeat(32)
const BODY = 'verified-media-bytes'
const ETAG = `"${'12'.repeat(32)}"`
const PUBLICATION_ID = 'pub-bare-1'
const RENDITION_ID = 'rend-bare-1'
const ASSET_ID = 'asset-bare-1'
const searchRequestTarget = '/api/v2/search?title=M*A*S*H%20~&kind=movie'
const canonicalSearchTarget = '/api/v2/search?kind=movie&title=M*A*S*H+%7E'
const canonicalSearchMac = 'af59194bdbdaf97c20fa751e81f34e6533bc57cdcad8ab6a4cabb75c5feaf3a1'
if (canonicalizePathAndQuery(searchRequestTarget) !== canonicalSearchTarget) {
  throw new Error('Bare companion search target canonicalization failed')
}
const canonicalHeaders = signControlRequest({
  method: 'GET',
  path: searchRequestTarget,
  timestamp: NOW,
  nonce: 'canonical-nonce-01',
  client: 'client-test',
  secret: 'ab'.repeat(32)
})
if (canonicalHeaders['X-PearTube-MAC'] !== canonicalSearchMac) {
  throw new Error('Bare companion search target MAC failed')
}
let server = null
let socket = null
const decodedSearch = decodeSearchQuery(new URLSearchParams('namespace=tmdb&identifier=348&kind=movie&limit=64'))
if (decodedSearch.selector.identifier !== '348' || decodedSearch.limit !== 64) {
  throw new Error('Bare companion search query decoding failed')
}

const streamAsset = {
  assetId: ASSET_ID,
  byteLength: BODY.length,
  mimeType: 'video/mp4',
  etag: ETAG,
  async requestRange ({ byteStart, byteEnd }) {
    return { status: 'ok', verified: true, bytes: BODY.slice(byteStart, byteEnd) }
  }
}

function check (label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`Bare companion ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

async function httpProbe (host, port, lines) {
  const received = await new Promise((resolve, reject) => {
    let text = ''
    let settled = false
    const connection = net.createConnection({ host, port })
    const settle = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connection.destroy()
      if (error) reject(error)
      else resolve(text)
    }
    const timer = setTimeout(
      () => settle(new Error(`Bare companion probe timed out after: ${text}`)),
      3_000
    )
    connection.on('connect', () => connection.write([...lines, '', ''].join('\r\n')))
    connection.on('data', (chunk) => { text += chunk.toString() })
    connection.on('error', () => settle(new Error(`Bare companion probe connection failed after: ${text}`)))
    connection.on('end', () => settle())
    connection.on('close', () => settle())
  })
  const boundary = received.indexOf('\r\n\r\n')
  if (boundary === -1) throw new Error(`Bare companion probe ended without a header terminator: ${received}`)
  const [statusLine, ...headerLines] = received.slice(0, boundary).split('\r\n')
  const headers = {}
  for (const line of headerLines) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
  }
  return { statusLine, headers, body: received.slice(boundary + 4) }
}

try {
  const config = resolveCompanionConfig({
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    client: 'client-bare-test',
    sharedSecret: SECRET
  })
  const capabilities = createStreamCapabilityStore({ now: () => NOW })
  server = createCompanionServer({ service: {}, config, clock: () => NOW, capabilities })
  const state = await server.start()
  const grant = capabilities.issue({
    clientIdentity: config.client,
    publicationId: PUBLICATION_ID,
    renditionId: RENDITION_ID,
    assetId: ASSET_ID,
    asset: streamAsset
  })
  const streamPath = `/api/v2/stream/${PUBLICATION_ID}/${RENDITION_ID}?cap=${grant.token}`
  const headers = signControlRequest({
    method: 'GET',
    path: '/api/v2/status',
    timestamp: NOW,
    nonce: 'bare-nonce-00001',
    client: config.client,
    secret: SECRET
  })
  const response = await new Promise((resolve, reject) => {
    let received = ''
    const timer = setTimeout(() => reject(new Error('Bare companion response timed out')), 3_000)
    socket = net.createConnection({ host: state.host, port: state.port })
    socket.on('connect', () => {
      socket.write([
        'GET /api/v2/status HTTP/1.1',
        'Host: companion',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        '',
        ''
      ].join('\r\n'))
    })
    socket.on('data', (chunk) => {
      received += chunk.toString()
      if (!received.includes('"status":"available"')) return
      clearTimeout(timer)
      resolve(received)
    })
    socket.on('error', reject)
  })

  if (!response.includes('HTTP/1.1 200 OK')) throw new Error(response)

  const headFull = await httpProbe(state.host, state.port, [`HEAD ${streamPath} HTTP/1.1`, 'Host: companion'])
  check('HEAD full status line', headFull.statusLine, 'HTTP/1.1 200 OK')
  check('HEAD full content-length', headFull.headers['content-length'], String(BODY.length))
  check('HEAD full accept-ranges', headFull.headers['accept-ranges'], 'bytes')
  check('HEAD full content-type', headFull.headers['content-type'], 'video/mp4')
  check('HEAD full etag', headFull.headers.etag, ETAG)
  check('HEAD full has no content-range', headFull.headers['content-range'], undefined)
  check('HEAD full empty wire body', headFull.body, '')

  const headRange = await httpProbe(state.host, state.port, [`HEAD ${streamPath} HTTP/1.1`, 'Host: companion', 'Range: bytes=2-5'])
  check('HEAD range status line', headRange.statusLine, 'HTTP/1.1 206 Partial Content')
  check('HEAD range content-length', headRange.headers['content-length'], '4')
  check('HEAD range content-range', headRange.headers['content-range'], `bytes 2-5/${BODY.length}`)
  check('HEAD range empty wire body', headRange.body, '')

  const errorGet = await httpProbe(state.host, state.port, [`GET ${streamPath} HTTP/1.1`, 'Host: companion', `Range: bytes=${BODY.length}-`])
  check('GET 416 status line', errorGet.statusLine, 'HTTP/1.1 416 Range Not Satisfiable')
  check('GET 416 content-range', errorGet.headers['content-range'], `bytes */${BODY.length}`)
  check('GET 416 content-length matches wire body', errorGet.headers['content-length'], String(errorGet.body.length))
  check('GET 416 structured error code', JSON.parse(errorGet.body).error.code, 'RANGE_NOT_SATISFIABLE')

  const errorHead = await httpProbe(state.host, state.port, [`HEAD ${streamPath} HTTP/1.1`, 'Host: companion', `Range: bytes=${BODY.length}-`])
  check('HEAD 416 status line', errorHead.statusLine, 'HTTP/1.1 416 Range Not Satisfiable')
  check('HEAD 416 mirrors GET 416 content-length', errorHead.headers['content-length'], errorGet.headers['content-length'])
  check('HEAD 416 content-range', errorHead.headers['content-range'], `bytes */${BODY.length}`)
  check('HEAD 416 accept-ranges', errorHead.headers['accept-ranges'], 'bytes')
  check('HEAD 416 content-type', errorHead.headers['content-type'], 'application/json')
  check('HEAD 416 empty wire body', errorHead.body, '')

  console.log('bare-companion-http-ok')
} finally {
  socket?.destroy()
  await server?.close()
}
