import fs from 'bare-fs'
import net from 'bare-net'
import process from 'bare-process'

import { decodeSearchQuery } from '../../src/companion/contracts.js'
import { canonicalizePathAndQuery, signControlRequest } from '../../src/companion/auth.js'
import { resolveCompanionConfig } from '../../src/companion/config.js'
import { createCompanionServer } from '../../src/companion/server.js'

const NOW = 1_786_406_400_000
const SECRET = 'ef'.repeat(32)
const storagePath = `/tmp/peartube-bare-companion-${process.pid}`
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
  client: 'mediastorm-test',
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

try {
  fs.mkdirSync(storagePath, { mode: 0o700 })
  const config = resolveCompanionConfig({
    enabled: true,
    client: 'mediastorm-bare-test',
    sharedSecret: SECRET
  }, { storagePath })
  server = createCompanionServer({ service: {}, config, clock: () => NOW })
  const state = await server.start()
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
    socket = net.createConnection({ path: state.socketPath })
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
  console.log('bare-companion-uds-ok')
} finally {
  socket?.destroy()
  await server?.close()
  fs.rmSync(storagePath, { recursive: true, force: true })
}
