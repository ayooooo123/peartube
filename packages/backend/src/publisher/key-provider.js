import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  verifySignedEnvelope as verifySharedSignedEnvelope,
  verifyMultiSignedEnvelope as verifySharedMultiSignedEnvelope
} from '../records/index.js'
import { assertBytes, isBytes } from '../records/canonical.js'

const FORBIDDEN_DEPENDENCIES = new Set([
  'secret', 'secretKey', 'getSecret', 'exportSecret', 'sign', 'signer', 'signPreparedRecord', 'createOrImportRoot', 'deleteRoot'
])

function rejectSecretDependencies (options) {
  if (!options || typeof options !== 'object') throw new TypeError('publisher key provider options must be an object')
  for (const key of Object.keys(options)) {
    if (FORBIDDEN_DEPENDENCIES.has(key)) throw new TypeError(`publisher key provider is verification-only; secret or signing dependency ${key} is forbidden`)
  }
}

function cloneBytes (value, name, length) {
  if (!isBytes(value)) throw new TypeError(`${name} must be bytes`)
  if (length !== undefined) assertBytes(value, length, name)
  return b4a.from(value)
}

export function createPublisherKeyProvider (options = {}) {
  rejectSecretDependencies(options)
  const hashProvider = options.hash || crypto.hash
  const signatureProvider = options.verifySignature || ((signature, preimage, publicKey) => crypto.verify(preimage, signature, publicKey))
  if (typeof hashProvider !== 'function' || typeof signatureProvider !== 'function') throw new TypeError('publisher key provider requires hash and signature verification functions')

  const hash = input => {
    const output = hashProvider(cloneBytes(input, 'hash input'))
    return cloneBytes(output, 'hash output', 32)
  }
  const verifySignature = (signature, preimage, publicKey) => signatureProvider(
    cloneBytes(signature, 'signature', 64),
    cloneBytes(preimage, 'signature preimage'),
    cloneBytes(publicKey, 'publicKey', 32)
  ) === true

  const provider = {
    hash,
    verifySignature,
    verifySignedEnvelope (value, authorization) {
      return verifySharedSignedEnvelope(value, { hash, verifySignature, authorization })
    },
    verifyMultiSignedEnvelope (value, authorization) {
      return verifySharedMultiSignedEnvelope(value, { hash, verifySignature, authorization })
    }
  }
  return Object.freeze(provider)
}
