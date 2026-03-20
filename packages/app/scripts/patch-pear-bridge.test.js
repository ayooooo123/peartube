const assert = require('assert/strict')

const { patchPearBridgeSource } = require('./patch-pear-bridge')

const original = `
    this.server = http.createServer(async (req, res) => {
      try {
        const xPear = req.headers['x-pear']
        const isDevtools = req.url.includes('+app+map')
        const [url, protocol = 'app', type = 'app'] = req.url.split('+')
        req.url = url === '/' ? '/index.html' : url
        await this.lookup(id, protocol, type, req, res)
      } catch (err) {}
    })
`

const patched = patchPearBridgeSource(original)

assert.ok(patched.includes("const request = { __proto__: req, url: url === '/' ? '/index.html' : url }"))
assert.ok(!patched.includes("req.url = url === '/' ? '/index.html' : url"))
assert.ok(patched.includes('await this.lookup(id, protocol, type, request, res)'))
assert.equal(patchPearBridgeSource(patched), patched)

console.log('PASS: patch-pear-bridge rewrites request handling compatibly')
