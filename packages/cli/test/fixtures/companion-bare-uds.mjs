import fs from 'bare-fs'
import net from 'bare-net'
import process from 'bare-process'

import { decodeSearchQuery } from '../../src/companion/contracts.js'
import { signControlRequest } from '../../src/companion/auth.js'
import { resolveCompanionConfig } from '../../src/companion/config.js'
import { createCompanionServer } from '../../src/companion/server.js'

const NOW = 1_786_406_400_000
const SECRET = 'ef'.repeat(32)
const storagePath = `/tmp/peartube-bare-companion-${process.pid}`
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
