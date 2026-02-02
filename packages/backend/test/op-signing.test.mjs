import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import {
  getOpAuthorKey,
  verifyOpAuthor,
  createNonce,
  signOp,
  verifyOpSignature,
  verifyOp
} from '../src/channel/op-signing.js'

test('getOpAuthorKey - extracts authorKeyHex', async (t) => {
  const key = getOpAuthorKey({ authorKeyHex: 'abc123' })
  t.is(key, 'abc123')
})

test('getOpAuthorKey - extracts updatedBy', async (t) => {
  const key = getOpAuthorKey({ updatedBy: 'def456' })
  t.is(key, 'def456')
})

test('getOpAuthorKey - extracts uploadedBy', async (t) => {
  const key = getOpAuthorKey({ uploadedBy: 'ghi789' })
  t.is(key, 'ghi789')
})

test('getOpAuthorKey - extracts moderatorKeyHex', async (t) => {
  const key = getOpAuthorKey({ moderatorKeyHex: 'mod123' })
  t.is(key, 'mod123')
})

test('getOpAuthorKey - extracts writerKeyHex', async (t) => {
  const key = getOpAuthorKey({ writerKeyHex: 'writer456' })
  t.is(key, 'writer456')
})

test('getOpAuthorKey - returns null for invalid input', async (t) => {
  t.is(getOpAuthorKey(null), null)
  t.is(getOpAuthorKey(undefined), null)
  t.is(getOpAuthorKey('not an object'), null)
  t.is(getOpAuthorKey({}), null)
})

test('verifyOpAuthor - validates matching author key', async (t) => {
  const keyPair = crypto.keyPair()
  const keyHex = b4a.toString(keyPair.publicKey, 'hex')

  const op = { type: 'add-comment', authorKeyHex: keyHex }
  const node = { from: { key: keyPair.publicKey } }

  const result = verifyOpAuthor(op, node)
  t.is(result.valid, true)
  t.absent(result.reason)
})

test('verifyOpAuthor - rejects mismatched author key', async (t) => {
  const keyPair1 = crypto.keyPair()
  const keyPair2 = crypto.keyPair()
  const claimedKeyHex = b4a.toString(keyPair1.publicKey, 'hex')

  const op = { type: 'add-comment', authorKeyHex: claimedKeyHex }
  const node = { from: { key: keyPair2.publicKey } } // Different key

  const result = verifyOpAuthor(op, node)
  t.is(result.valid, false)
  t.ok(result.reason.includes('Author mismatch'))
})

test('verifyOpAuthor - allows init ops without author', async (t) => {
  const keyPair = crypto.keyPair()
  const node = { from: { key: keyPair.publicKey } }

  const result = verifyOpAuthor({ type: 'init' }, node)
  t.is(result.valid, true)
})

test('verifyOpAuthor - allows system ops without author', async (t) => {
  const keyPair = crypto.keyPair()
  const node = { from: { key: keyPair.publicKey } }

  const result = verifyOpAuthor({ type: 'system' }, node)
  t.is(result.valid, true)
})

test('verifyOpAuthor - allows ack ops without author', async (t) => {
  const keyPair = crypto.keyPair()
  const node = { from: { key: keyPair.publicKey } }

  const result = verifyOpAuthor({ type: 'ack' }, node)
  t.is(result.valid, true)
})

test('verifyOpAuthor - rejects ops with no author for other types', async (t) => {
  const keyPair = crypto.keyPair()
  const node = { from: { key: keyPair.publicKey } }

  const result = verifyOpAuthor({ type: 'add-comment' }, node)
  t.is(result.valid, false)
  t.is(result.reason, 'Operation has no author key')
})

test('verifyOpAuthor - rejects invalid operation object', async (t) => {
  const keyPair = crypto.keyPair()
  const node = { from: { key: keyPair.publicKey } }

  t.is(verifyOpAuthor(null, node).valid, false)
  t.is(verifyOpAuthor(undefined, node).valid, false)
  t.is(verifyOpAuthor('string', node).valid, false)
})

test('verifyOpAuthor - rejects node without writer key', async (t) => {
  const op = { type: 'add-comment', authorKeyHex: 'abc123' }

  t.is(verifyOpAuthor(op, null).valid, false)
  t.is(verifyOpAuthor(op, {}).valid, false)
  t.is(verifyOpAuthor(op, { from: null }).valid, false)
  t.is(verifyOpAuthor(op, { from: {} }).valid, false)
})

test('createNonce - creates unique nonces', async (t) => {
  const nonce1 = createNonce()
  const nonce2 = createNonce()

  t.ok(nonce1.length > 0)
  t.ok(nonce2.length > 0)
  t.not(nonce1, nonce2, 'Nonces should be unique')
})

test('createNonce - nonce is hex string', async (t) => {
  const nonce = createNonce()
  t.ok(/^[0-9a-f]+$/i.test(nonce), 'Nonce should be hex')
  // 8 bytes timestamp + 8 bytes random = 16 bytes = 32 hex chars
  t.is(nonce.length, 32)
})

test('signOp - signs operation with valid key', async (t) => {
  const keyPair = crypto.keyPair()
  const op = { type: 'test', data: 'hello' }

  const signed = signOp(op, keyPair.secretKey)

  t.ok(signed.signature)
  t.ok(signed.nonce)
  t.is(signed.type, 'test')
  t.is(signed.data, 'hello')
})

test('signOp - throws with invalid secret key', async (t) => {
  const op = { type: 'test' }

  try {
    signOp(op, null)
    t.fail('Should throw for null key')
  } catch (err) {
    t.ok(err.message.includes('Invalid secret key'))
  }

  try {
    signOp(op, Buffer.alloc(32)) // Wrong length
    t.fail('Should throw for wrong length key')
  } catch (err) {
    t.ok(err.message.includes('Invalid secret key'))
  }
})

test('signOp - preserves existing nonce', async (t) => {
  const keyPair = crypto.keyPair()
  const existingNonce = 'existingnonce123'
  const op = { type: 'test', nonce: existingNonce }

  const signed = signOp(op, keyPair.secretKey)
  t.is(signed.nonce, existingNonce)
})

test('verifyOpSignature - verifies valid signature', async (t) => {
  const keyPair = crypto.keyPair()
  const op = { type: 'test', data: 'hello' }

  const signed = signOp(op, keyPair.secretKey)
  const isValid = verifyOpSignature(signed, keyPair.publicKey)

  t.is(isValid, true)
})

test('verifyOpSignature - rejects tampered operation', async (t) => {
  const keyPair = crypto.keyPair()
  const op = { type: 'test', data: 'hello' }

  const signed = signOp(op, keyPair.secretKey)
  signed.data = 'tampered' // Modify after signing

  const isValid = verifyOpSignature(signed, keyPair.publicKey)
  t.is(isValid, false)
})

test('verifyOpSignature - rejects wrong public key', async (t) => {
  const keyPair1 = crypto.keyPair()
  const keyPair2 = crypto.keyPair()
  const op = { type: 'test', data: 'hello' }

  const signed = signOp(op, keyPair1.secretKey)
  const isValid = verifyOpSignature(signed, keyPair2.publicKey)

  t.is(isValid, false)
})

test('verifyOpSignature - returns false for missing signature', async (t) => {
  const keyPair = crypto.keyPair()
  t.is(verifyOpSignature({ type: 'test' }, keyPair.publicKey), false)
})

test('verifyOpSignature - returns false for missing public key', async (t) => {
  const keyPair = crypto.keyPair()
  const signed = signOp({ type: 'test' }, keyPair.secretKey)
  t.is(verifyOpSignature(signed, null), false)
})

test('verifyOp - full verification with valid author', async (t) => {
  const keyPair = crypto.keyPair()
  const keyHex = b4a.toString(keyPair.publicKey, 'hex')

  const op = { type: 'add-comment', authorKeyHex: keyHex }
  const node = { from: { key: keyPair.publicKey } }

  const result = verifyOp(op, node)
  t.is(result.valid, true)
})

test('verifyOp - full verification with signature', async (t) => {
  const keyPair = crypto.keyPair()
  const keyHex = b4a.toString(keyPair.publicKey, 'hex')

  const op = { type: 'add-comment', authorKeyHex: keyHex }
  const signed = signOp(op, keyPair.secretKey)
  const node = { from: { key: keyPair.publicKey } }

  const result = verifyOp(signed, node)
  t.is(result.valid, true)
})

test('verifyOp - rejects when signature required but missing', async (t) => {
  const keyPair = crypto.keyPair()
  const keyHex = b4a.toString(keyPair.publicKey, 'hex')

  const op = { type: 'add-comment', authorKeyHex: keyHex }
  const node = { from: { key: keyPair.publicKey } }

  const result = verifyOp(op, node, { requireSignature: true })
  t.is(result.valid, false)
  t.ok(result.reason.includes('Signature required'))
})

test('verifyOp - rejects invalid signature when present', async (t) => {
  const keyPair1 = crypto.keyPair()
  const keyPair2 = crypto.keyPair()
  const keyHex = b4a.toString(keyPair1.publicKey, 'hex')

  // Sign with different key
  const op = { type: 'add-comment', authorKeyHex: keyHex }
  const signed = signOp(op, keyPair2.secretKey)
  const node = { from: { key: keyPair1.publicKey } }

  const result = verifyOp(signed, node)
  t.is(result.valid, false)
  t.is(result.reason, 'Invalid signature')
})

test('verifyOp - rejects author mismatch before checking signature', async (t) => {
  const keyPair1 = crypto.keyPair()
  const keyPair2 = crypto.keyPair()
  const fakeKeyHex = b4a.toString(keyPair2.publicKey, 'hex')

  const op = { type: 'add-comment', authorKeyHex: fakeKeyHex }
  const node = { from: { key: keyPair1.publicKey } }

  const result = verifyOp(op, node)
  t.is(result.valid, false)
  t.ok(result.reason.includes('Author mismatch'))
})
