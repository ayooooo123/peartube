import { createRequire } from 'node:module'
import crypto from 'hypercore-crypto'

const require = createRequire(import.meta.url)

function fail(message, error) {
  console.error(`FAIL: ${message}`)
  if (error) console.error(error?.stack || error)
  process.exit(1)
}

async function main() {
  let IdentityKey

  try {
    IdentityKey = require('keet-identity-key')
    console.log('PASS: Imported keet-identity-key in plain Node.js')
  } catch (error) {
    fail('Import error - need manual derivation fallback', error)
  }

  try {
    const mnemonic = IdentityKey.generateMnemonic()
    if (typeof mnemonic !== 'string' || mnemonic.length === 0) {
      fail('generateMnemonic() did not return a non-empty string')
    }
    console.log('PASS: Generated mnemonic')

    const identity = await IdentityKey.from({ mnemonic })
    const identityPublicKey = identity?.identityPublicKey

    if (!identityPublicKey || identityPublicKey.byteLength !== 32) {
      fail('identityPublicKey is not 32 bytes')
    }
    console.log('PASS: Derived identityPublicKey is 32 bytes')

    // Use static bootstrap with mnemonic + device public key (correct API usage)
    const deviceKeyPair = crypto.keyPair()
    const proof = await IdentityKey.bootstrap({ mnemonic }, deviceKeyPair.publicKey)
    if (!proof || !Buffer.isBuffer(proof) || proof.byteLength === 0) {
      fail('IdentityKey.bootstrap() did not return a proof buffer')
    }
    console.log('PASS: IdentityKey.bootstrap() produced a proof buffer')

    // verify with expectedDevice option
    const verification = IdentityKey.verify(proof, null, { expectedDevice: deviceKeyPair.publicKey })
    if (!verification) {
      fail('IdentityKey.verify(proof, null, { expectedDevice }) returned null')
    }

    console.log('PASS: verify(proof, null, { expectedDevice }) succeeded')
    console.log('PASS: keet-identity-key Node.js compatibility spike passed')
    process.exit(0)
  } catch (error) {
    const stack = String(error?.stack || error || '')
    if (stack.includes('sodium')) {
      fail('sodium-universal incompatible', error)
    }

    fail('keet-identity-key compatibility checks failed', error)
  }
}

await main()
