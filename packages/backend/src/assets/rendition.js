import b4a from 'b4a'

import { createProtectedRendition } from '../access/protected-rendition.js'
import { hashCanonical } from '../publisher/canonical.js'
import { createSegmentIndexDescriptor, normalizeCoreRef } from './segment-index.js'

export const RENDITION_DESCRIPTOR_VERSION = 1
export const RENDITION_ID_DOMAIN = 'peartube.asset.rendition.v1'

function boundedString(value, name, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} must be bounded string`)
  return value
}

function unsignedRenditionDescriptor(input = {}, { allowClearKeyForTests = false } = {}) {
  const body = {
    version: RENDITION_DESCRIPTOR_VERSION,
    purpose: boundedString(input.purpose, 'purpose'),
    format: boundedString(input.format, 'format'),
    core: normalizeCoreRef(input.core, 'core'),
    segmentIndex: input.segmentIndex ? createSegmentIndexDescriptor(input.segmentIndex) : null,
  }
  // A public rendition carries no `encryption` KEY at all rather than an
  // explicit null: the canonical encoder preserves nulls, so adding the field
  // unconditionally would rewrite every renditionId ever derived and break
  // every manifest already signed.
  //
  // Protection is part of what a rendition IS, not an annotation on it. Built
  // here, the key id, init data, scheme, endpoint and issuer are hashed into
  // renditionId, so anyone who edits one of them is describing a different
  // rendition and the signed manifest stops matching.
  if (input.encryption != null) {
    body.encryption = createProtectedRendition(input.encryption, { allowClearKeyForTests })
  }
  return body
}

export function deriveRenditionId(input = {}, options = {}) {
  return b4a.toString(hashCanonical(RENDITION_ID_DOMAIN, unsignedRenditionDescriptor(input, options)), 'hex')
}

// Cover art rides the manifest so it seeds and transfers with the publication
// it belongs to. Everything that picks something to PLAY has to skip it, so the
// test for "this is artwork, not media" lives with the descriptor rather than
// being re-guessed at each call site.
export const ARTWORK_RENDITION_PURPOSES = Object.freeze(new Set(['poster', 'backdrop', 'thumbnail', 'still']))

export function isArtworkRendition(rendition) {
  return ARTWORK_RENDITION_PURPOSES.has(String(rendition?.purpose || ''))
}

// Ciphertext is public; only an entitled player can decode it. Whether a
// rendition needs a licence is therefore a property of the descriptor and
// nothing else, so every caller asks the same question the same way.
export function isProtectedRendition(rendition) {
  return rendition?.encryption != null
}

export function createRenditionDescriptor(input = {}, options = {}) {
  const body = unsignedRenditionDescriptor(input, options)
  return { ...body, renditionId: deriveRenditionId(body, options) }
}
