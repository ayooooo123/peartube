import test from 'node:test'
import assert from 'node:assert/strict'

let redactCapabilityUrl
try {
  ;({ redactCapabilityUrl } = await import('../src/capability-url.js'))
} catch {}

test('capability URLs redact proxy path credentials and sensitive query values', () => {
  assert.equal(typeof redactCapabilityUrl, 'function', 'capability URL redactor must exist')

  assert.equal(
    redactCapabilityUrl('http://192.168.1.8:4141/cast/cast-secret/index.m3u8?token=blob-secret&type=video'),
    'http://192.168.1.8:4141/cast/***/index.m3u8?token=***&type=video',
  )
})

test('relative Cast request URLs remain useful without exposing credentials', () => {
  assert.equal(typeof redactCapabilityUrl, 'function', 'capability URL redactor must exist')

  assert.equal(
    redactCapabilityUrl('/cast/cast-secret/segment-1.ts?authorization=bearer-secret&quality=720p'),
    '/cast/***/segment-1.ts?authorization=***&quality=720p',
  )
})

test('redaction covers encoded secret and signature parameter names', () => {
  assert.equal(typeof redactCapabilityUrl, 'function', 'capability URL redactor must exist')

  const redacted = redactCapabilityUrl('/media?id=42&access_token=abc%20123&signature=deadbeef')
  assert.equal(redacted, '/media?id=42&access_token=***&signature=***')
  assert.doesNotMatch(redacted, /abc|123|deadbeef/)
})
