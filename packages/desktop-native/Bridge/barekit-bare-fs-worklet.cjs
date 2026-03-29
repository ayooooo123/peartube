const fsModule = require('bare-fs')
const fs = fsModule?.default || fsModule

BareKit.on('push', (payload, reply) => {
  if (typeof fs?.existsSync !== 'function') {
    reply(null, 'missing')
    return
  }

  const renderedPayload = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '')
  if (!renderedPayload || renderedPayload === 'ping') {
    reply(null, 'ok')
    return
  }

  reply(null, fs.existsSync(renderedPayload) ? '1' : '0')
})
