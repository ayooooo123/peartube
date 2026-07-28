import b4a from 'b4a'

import { hashCanonical } from '../publisher/canonical.js'
import { createSegmentIndexDescriptor, normalizeCoreRef } from './segment-index.js'

export const RENDITION_DESCRIPTOR_VERSION = 1
export const RENDITION_ID_DOMAIN = 'peartube.asset.rendition.v1'

function boundedString(value, name, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} must be bounded string`)
  return value
}

function unsignedRenditionDescriptor(input = {}) {
  return {
    version: RENDITION_DESCRIPTOR_VERSION,
    purpose: boundedString(input.purpose, 'purpose'),
    format: boundedString(input.format, 'format'),
    core: normalizeCoreRef(input.core, 'core'),
    segmentIndex: input.segmentIndex ? createSegmentIndexDescriptor(input.segmentIndex) : null,
  }
}

export function deriveRenditionId(input = {}) {
  return b4a.toString(hashCanonical(RENDITION_ID_DOMAIN, unsignedRenditionDescriptor(input)), 'hex')
}

// Cover art rides the manifest so it seeds and transfers with the publication
// it belongs to. Everything that picks something to PLAY has to skip it, so the
// test for "this is artwork, not media" lives with the descriptor rather than
// being re-guessed at each call site.
export const ARTWORK_RENDITION_PURPOSES = Object.freeze(new Set(['poster', 'backdrop', 'thumbnail', 'still']))

export function isArtworkRendition(rendition) {
  return ARTWORK_RENDITION_PURPOSES.has(String(rendition?.purpose || ''))
}

export function createRenditionDescriptor(input = {}) {
  const body = unsignedRenditionDescriptor(input)
  return { ...body, renditionId: deriveRenditionId(body) }
}
