import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

// The @peartube/cast-device HRPC schema names the protocol field
// `castProtocol` (required) while the app and cast stack use `protocol`.
// Sending a device keyed `protocol` makes compact-encoding throw, which
// silently dropped deviceFound events and crashed castGetDevices responses —
// so every device that crosses the RPC boundary must be mapped on the way
// out (toWireCastDevice) and normalized on the way in (normalizeCastDevice).
// FCast support depends on this: without it the protocol never round-trips
// and every device degrades to chromecast.

test('mobile backend maps devices onto the wire shape (castProtocol)', () => {
  const source = readAppFile('backend/mobile-cast.mjs')
  assert.match(source, /function toWireCastDevice\(/)
  assert.match(source, /castProtocol: device\.protocol \|\| 'chromecast'/)
  assert.match(source, /eventCastDeviceFound\?\.\(\{ device: toWireCastDevice\(device\) \}\)/)
  assert.match(source, /devices\.map\(toWireCastDevice\)/)
  assert.match(source, /r\.castProtocol \|\| r\.protocol \|\| 'chromecast'/, 'manual add should read the wire field first')
  assert.doesNotMatch(source, /device: \{[^}]*protocol: device\.protocol/, 'no raw protocol-keyed device may cross the RPC boundary')
})

test('desktop worker maps devices onto the wire shape (castProtocol)', () => {
  const source = readAppFile('workers/desktop/index.ts')
  assert.match(source, /function toWireCastDevice\(/)
  assert.match(source, /castProtocol: d\.protocol \|\| 'chromecast'/)
  assert.match(source, /eventCastDeviceFound\?\.\(\{ device: toWireCastDevice\(d\) \}\)/)
  assert.match(source, /getDevices\(\)\.map\(toWireCastDevice\)/)
  assert.match(source, /r\.castProtocol \|\| r\.protocol \|\| 'chromecast'/)
})

test('useCast normalizes inbound devices from either field name', () => {
  const source = readAppFile('lib/cast/useCast.shared.ts')
  assert.match(source, /function normalizeCastDevice\(/)
  assert.match(source, /raw\.protocol \|\| raw\.castProtocol \|\| 'chromecast'/)
  assert.match(source, /normalizeCastDevice\(data\?\.device \?\? data\)/, 'deviceFound events should be normalized')
  assert.match(source, /result\.devices\.map\(normalizeCastDevice\)/, 'castGetDevices results should be normalized')
  assert.match(source, /protocol: 'chromecast' \| 'fcast'/, 'CastDevice type should include fcast')
})

test('platform RPC wrappers send castProtocol for manual devices', () => {
  for (const file of ['rpc.native.ts', 'rpc.web.ts']) {
    const source = readRepoFile(path.join('packages/platform/src', file))
    assert.match(
      source,
      /castAddManualDevice\(\{ \.\.\.req, castProtocol: req\.protocol \}\)/,
      `${file} should map protocol onto the castProtocol wire field`,
    )
  }
})

test('desktop worker proxies non-chromecast (fcast) sources onto the LAN', () => {
  const source = readAppFile('workers/desktop/index.ts')
  assert.match(
    source,
    /\} else \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*try \{ await ensureCastProxyServer\(\); const pu = await createCastProxyUrl\(deviceHost, requestedUrl\)/,
    'non-chromecast castPlay should route through the cast proxy',
  )
})

test('device picker offers the FCast protocol for manual devices', () => {
  const source = readAppFile('components/cast/DevicePickerModal.tsx')
  assert.match(source, /useState<'chromecast' \| 'fcast'>\('chromecast'\)/)
  assert.match(source, /\['chromecast', 'fcast'\] as const/)
  assert.match(source, /manualProtocol === 'fcast' \? 46899 : 8009/)
})
