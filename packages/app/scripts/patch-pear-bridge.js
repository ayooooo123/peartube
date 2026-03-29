/* eslint-disable no-console */
const fs = require('fs')

const TARGET = "        const [url, protocol = 'app', type = 'app'] = req.url.split('+')\n        req.url = url === '/' ? '/index.html' : url\n"
const REPLACEMENT = "        const [url, protocol = 'app', type = 'app'] = req.url.split('+')\n        const request = { __proto__: req, url: url === '/' ? '/index.html' : url }\n"

function patchPearBridgeSource(source) {
  if (source.includes("const request = { __proto__: req, url: url === '/' ? '/index.html' : url }")) {
    return source
  }

  if (!source.includes(TARGET)) {
    throw new Error('pear-bridge request rewrite block not found')
  }

  return source
    .replace(TARGET, REPLACEMENT)
    .replace('        await this.lookup(id, protocol, type, req, res)', '        await this.lookup(id, protocol, type, request, res)')
}

function applyPearBridgePatch(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`pear-bridge file not found: ${filePath}`)
  }

  const source = fs.readFileSync(filePath, 'utf8')
  const patched = patchPearBridgeSource(source)

  if (patched !== source) {
    fs.writeFileSync(filePath, patched)
    return true
  }

  return false
}

module.exports = {
  applyPearBridgePatch,
  patchPearBridgeSource
}
