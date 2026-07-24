import b4a from 'b4a'

import { encodeCanonical, hashCanonical, normalizeNonNegativeInteger, sortPlain, toHex } from '../publisher/canonical.js'
import { createSignedEnvelope, verifySignedEnvelope } from '../records/signed-envelope.js'
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

function unsignedManifestBody(input = {}) {
  const publisherId = normalizePublisherId(input.publisherId)
  const previousManifestId = input.previousManifestId == null ? null : toHex(input.previousManifestId, 32, 'previousManifestId')
  const renditions = input.renditions || []
  if (!Array.isArray(renditions) || renditions.length === 0 || renditions.length > 128) throw new Error('renditions must be non-empty bounded array')
  return sortPlain({
    version: MANIFEST_VERSION,
    publisherId,
    sequence: normalizeNonNegativeInteger(input.sequence, 'sequence', 0),
    title: boundedString(input.title, 'title', 512, true),
    description: boundedString(input.description, 'description', 4096),
    previousManifestId,
    renditions: renditions.map(createRenditionDescriptor).sort((a, b) => a.renditionId.localeCompare(b.renditionId)),
    artwork: Array.isArray(input.artwork) ? input.artwork.map(createRenditionDescriptor).sort((a, b) => a.renditionId.localeCompare(b.renditionId)) : [],
    subtitles: Array.isArray(input.subtitles) ? input.subtitles.map(createRenditionDescriptor).sort((a, b) => a.renditionId.localeCompare(b.renditionId)) : [],
    claims: Array.isArray(input.claims) ? input.claims.map(normalizeClaimRef).sort((a, b) => a.claimId.localeCompare(b.claimId)) : [],
    provenance: Array.isArray(input.provenance) ? input.provenance.map(sortPlain) : [],
  })
}

export function deriveManifestId(input = {}) {
  const unsignedBody = input.unsignedBody ? input.unsignedBody : unsignedManifestBody(input)
  return b4a.toString(hashCanonical(MANIFEST_ID_DOMAIN, unsignedBody), 'hex')
}

export function derivePublicationId({ publisherId, manifestId } = {}) {
  return b4a.toString(hashCanonical(PUBLICATION_ID_DOMAIN, {
    publisherId: normalizePublisherId(publisherId),
    manifestId: toHex(manifestId, 32, 'manifestId'),
  }), 'hex')
}

export function createPublicationManifest(input = {}) {
  const unsignedBody = unsignedManifestBody(input)
  const manifestId = deriveManifestId({ unsignedBody })
  const publicationId = derivePublicationId({ publisherId: unsignedBody.publisherId, manifestId })
  const body = sortPlain({
    manifestId,
    unsignedBody,
    ...unsignedBody,
  })
  const envelope = createSignedEnvelope({
    recordType: MANIFEST_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: input.keyPair,
    issuedAt: input.signedAt,
    expiresAt: input.expiresAt,
  })
  return { publicationId, body, envelope }
}

export async function verifyPublicationManifest(manifest, options = {}) {
  if (!manifest?.body || !manifest?.envelope) return false
  const expectedManifestId = deriveManifestId({ unsignedBody: manifest.body.unsignedBody })
  if (manifest.body.manifestId !== expectedManifestId) return false
  const expectedPublicationId = derivePublicationId({ publisherId: manifest.body.publisherId, manifestId: expectedManifestId })
  if (manifest.publicationId !== expectedPublicationId) return false
  const signer = manifest.envelope.signer ? toHex(manifest.envelope.signer, 32, 'signer') : null
  if (signer !== manifest.body.publisherId) return false
  const verified = await verifySignedEnvelope(manifest.envelope, {
    ...options,
    recordType: MANIFEST_RECORD_TYPE,
  })
  return Boolean(verified && b4a.equals(manifest.envelope.body, encodeCanonical(manifest.body)))
}
