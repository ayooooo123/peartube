import b4a from 'b4a'

import { encodeCanonical, hashCanonical, normalizeNonNegativeInteger, sortPlain, toHex } from '../publisher/canonical.js'
import {
  createApplicationEnvelope,
  decodeApplicationEnvelope,
  encodeApplicationEnvelope,
  verifyApplicationEnvelope,
} from '../records/application-envelope.js'
import { validateProtectedPublication } from './media-validation.js'
import { createRenditionDescriptor } from './rendition.js'

export const MANIFEST_VERSION = 1
export const MANIFEST_ID_DOMAIN = 'peartube.asset.manifest.v1'
export const PUBLICATION_ID_DOMAIN = 'peartube.asset.publication.v1'
export const MANIFEST_RECORD_TYPE = 'peartube.asset.manifest.v1'

function boundedString(value, name, max = 4096, required = false) {
  if (value == null && !required) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} must be bounded string`)
  return value
}

function normalizeClaimRef(ref = {}) {
  return sortPlain({ ...ref, claimId: toHex(ref.claimId, 32, 'claimId') })
}

function normalizePublisherId(value) {
  return toHex(value, 32, 'publisherId')
}

function unsignedManifestBody(input = {}, options = {}) {
  const publisherId = normalizePublisherId(input.publisherId)
  const previousManifestId = input.previousManifestId == null ? null : toHex(input.previousManifestId, 32, 'previousManifestId')
  const renditions = input.renditions || []
  if (!Array.isArray(renditions) || renditions.length === 0 || renditions.length > 128) throw new Error('renditions must be non-empty bounded array')
  const descriptor = rendition => createRenditionDescriptor(rendition, options)
  const body = sortPlain({
    version: MANIFEST_VERSION,
    publisherId,
    sequence: normalizeNonNegativeInteger(input.sequence, 'sequence', 0),
    title: boundedString(input.title, 'title', 512, true),
    description: boundedString(input.description, 'description', 4096),
    previousManifestId,
    renditions: renditions.map(descriptor).sort((a, b) => a.renditionId.localeCompare(b.renditionId)),
    artwork: Array.isArray(input.artwork) ? input.artwork.map(descriptor).sort((a, b) => a.renditionId.localeCompare(b.renditionId)) : [],
    subtitles: Array.isArray(input.subtitles) ? input.subtitles.map(descriptor).sort((a, b) => a.renditionId.localeCompare(b.renditionId)) : [],
    claims: Array.isArray(input.claims) ? input.claims.map(normalizeClaimRef).sort((a, b) => a.claimId.localeCompare(b.claimId)) : [],
    provenance: Array.isArray(input.provenance) ? input.provenance.map(sortPlain) : [],
  })
  // Every manifest in the system is minted or re-derived here, including one
  // decoded from a peer's bytes, so this is the one place a protected
  // publication cannot be smuggled past its own rules.
  validateProtectedPublication(body, options)
  return body
}

export function deriveManifestId(input = {}, options = {}) {
  const unsignedBody = input.unsignedBody ? input.unsignedBody : unsignedManifestBody(input, options)
  return b4a.toString(hashCanonical(MANIFEST_ID_DOMAIN, unsignedBody), 'hex')
}

export function derivePublicationId({ publisherId, manifestId } = {}) {
  return b4a.toString(hashCanonical(PUBLICATION_ID_DOMAIN, {
    publisherId: normalizePublisherId(publisherId),
    manifestId: toHex(manifestId, 32, 'manifestId'),
  }), 'hex')
}

// `allowClearKeyForTests` is an argument, never a field of the manifest input,
// so no publisher-supplied body can turn it on. Production callers pass no
// options at all and therefore cannot publish a ClearKey title.
export function createPublicationManifest(input = {}, options = {}) {
  const unsignedBody = unsignedManifestBody(input, options)
  const manifestId = deriveManifestId({ unsignedBody })
  const publicationId = derivePublicationId({ publisherId: unsignedBody.publisherId, manifestId })
  const body = sortPlain({
    manifestId,
    unsignedBody,
    ...unsignedBody,
  })
  const envelope = createApplicationEnvelope({
    recordType: MANIFEST_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: input.keyPair,
    issuedAt: input.signedAt,
    expiresAt: input.expiresAt,
  })
  return { publicationId, body, envelope }
}

export function encodePublicationManifest(manifest) {
  if (!manifest?.body || !manifest?.envelope) throw new Error('publication manifest is required')
  if (!b4a.equals(manifest.envelope.body, encodeCanonical(manifest.body))) {
    throw new Error('publication manifest envelope body mismatch')
  }
  return encodeApplicationEnvelope(manifest.envelope)
}

export function decodePublicationManifest(input, options = {}) {
  const envelope = decodeApplicationEnvelope(input)
  let parsed
  try {
    parsed = JSON.parse(b4a.toString(envelope.body))
  } catch {
    throw new Error('publication manifest body is not canonical JSON')
  }
  const unsignedBody = unsignedManifestBody(parsed?.unsignedBody, options)
  const manifestId = deriveManifestId({ unsignedBody })
  const body = sortPlain({ manifestId, unsignedBody, ...unsignedBody })
  if (!b4a.equals(envelope.body, encodeCanonical(body))) {
    throw new Error('publication manifest body is noncanonical')
  }
  return {
    publicationId: derivePublicationId({ publisherId: body.publisherId, manifestId }),
    body,
    envelope,
  }
}

export async function verifyCatalogPublicationManifest(manifest, options = {}) {
  if (!manifest?.body || !manifest?.envelope) return false
  let publisherId
  let publicationId
  let manifestId
  let signer
  try {
    publisherId = toHex(options.publisherId, 32, 'publisherId')
    publicationId = toHex(options.publicationId, 32, 'publicationId')
    manifestId = toHex(options.manifestId, 32, 'manifestId')
    signer = toHex(options.signer, 32, 'signer')
  } catch {
    return false
  }
  if (manifest.body.publisherId !== publisherId ||
      manifest.publicationId !== publicationId ||
      manifest.body.manifestId !== manifestId ||
      toHex(manifest.envelope.signer, 32, 'manifest signer') !== signer) {
    return false
  }
  let canonical
  try {
    canonical = encodePublicationManifest(manifest)
    if (options.payload && !b4a.equals(canonical, options.payload)) return false
  } catch {
    return false
  }
  return verifyApplicationEnvelope(manifest.envelope, {
    recordType: MANIFEST_RECORD_TYPE,
    now: options.now,
    authorizeSigner: candidate => toHex(candidate, 32, 'candidate signer') === signer,
  })
}

export async function verifyPublicationManifest(manifest, options = {}) {
  if (!manifest?.body || !manifest?.envelope) return false
  const expectedManifestId = deriveManifestId({ unsignedBody: manifest.body.unsignedBody })
  if (manifest.body.manifestId !== expectedManifestId) return false
  const expectedPublicationId = derivePublicationId({ publisherId: manifest.body.publisherId, manifestId: expectedManifestId })
  if (manifest.publicationId !== expectedPublicationId) return false
  const signer = manifest.envelope.signer ? toHex(manifest.envelope.signer, 32, 'signer') : null
  if (signer !== manifest.body.publisherId) return false
  const verified = await verifyApplicationEnvelope(manifest.envelope, {
    ...options,
    recordType: MANIFEST_RECORD_TYPE,
  })
  return Boolean(verified && b4a.equals(manifest.envelope.body, encodeCanonical(manifest.body)))
}
