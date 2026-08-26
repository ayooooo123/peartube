import { createRequire } from 'module'
import brittle from 'brittle'
import assert from 'node:assert/strict'
import sodium from 'sodium-universal'
// NOTE: IdentityKey.bootstrap uses Keet's SLIP-48 type 5338 internally.
// PearTube's deriveIdentity uses type 5340, so keys differ.
// We compare against IdentityKey.from() which matches bootstrap's derivation.

const require = createRequire(import.meta.url)
const IdentityKey = require('keet-identity-key')

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
    passed++
  } catch (err) {
    console.error(`FAIL: ${name} — ${err.message}`)
    failed++
  }
}

function makeKeyPair() {
  const publicKey = Buffer.alloc(32)
  const secretKey = Buffer.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

// Shared state across tests
let proof = null
const device1 = makeKeyPair()

await test('bootstrap creates a valid proof Buffer', async () => {
  proof = await IdentityKey.bootstrap({ mnemonic: MNEMONIC }, device1.publicKey)
  assert(Buffer.isBuffer(proof), 'proof should be a Buffer')
  assert(proof.length > 0, 'proof should not be empty')
})

await test('verify returns correct identityPublicKey', async () => {
  assert(proof !== null, 'proof must exist from previous test')
  const result = IdentityKey.verify(proof, null)
  assert(result !== null, 'verify should return a result')
  assert(Buffer.isBuffer(result.identityPublicKey), 'identityPublicKey should be a Buffer')
  assert.equal(result.identityPublicKey.length, 32, 'identityPublicKey should be 32 bytes')

  // Compare against Keet's own derivation (type 5338) which bootstrap uses internally
  const keetIdentity = await IdentityKey.from({ mnemonic: MNEMONIC })
  assert(result.identityPublicKey.equals(keetIdentity.identityPublicKey), 'identityPublicKey should match Keet-derived identity from bootstrap')
})

await test('tampered proof fails verification', async () => {
  assert(proof !== null, 'proof must exist from previous test')
  const tampered = Buffer.from(proof)
  tampered[10] ^= 0xff
  const result = IdentityKey.verify(tampered, null)
  assert(result === null, 'tampered proof should fail verification')
})

await test('chained attestation extends the proof chain', async () => {
  assert(proof !== null, 'proof must exist from previous test')
  const device2 = makeKeyPair()
  const chainedProof = IdentityKey.attestDevice(device2.publicKey, device1, proof)
  assert(Buffer.isBuffer(chainedProof), 'chained proof should be a Buffer')

  const result = IdentityKey.verify(chainedProof, null)
  assert(result !== null, 'chained proof should verify')
  assert(result.devicePublicKey.equals(device2.publicKey), 'devicePublicKey should be device2')
})

console.log(`\n${passed} passed, ${failed} failed`)
// Reported through brittle rather than an exit code: this file shares its
// process with every other test file in the directory.
brittle(`device attestation proofs`, t => {
  t.is(failed, 0, `${failed} of ${passed + failed} assertions failed`)
})
