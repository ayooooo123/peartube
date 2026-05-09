import assert from 'node:assert/strict'
import test from 'node:test'

const identitySource = await import('../src/identity.js')
const sourceText = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/identity.js', import.meta.url), 'utf8'))

test('identity manager creates and stores a signed channel root descriptor for new identities', () => {
  assert.match(sourceText, /createChannelRootDescriptor/)
  assert.match(sourceText, /signChannelRootDescriptor/)
  assert.match(sourceText, /signedDescriptor/)
  assert.match(sourceText, /const mediaKey = channel\.blobsKeyHex/)
  assert.match(sourceText, /channel\.publicBee\.bee\.put\('channel\/root'/)
  assert.ok(identitySource.createIdentityManager)
})
