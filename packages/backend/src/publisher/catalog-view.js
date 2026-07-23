import {
  getCatalogPublications,
} from './catalog.js'
import {
  hashCanonical,
} from './canonical.js'

export const CATALOG_VIEW_HEAD_DOMAIN = 'peartube.publisher.catalog.view-head.v1'

function collectWriterHeads(authorizationState = {}) {
  const heads = {}
  for (const [writerKey, writer] of Object.entries(authorizationState.writers || {})) {
    heads[writerKey] = writer.lastAcceptedSequence || 0
  }
  return Object.fromEntries(Object.entries(heads).sort(([left], [right]) => left.localeCompare(right)))
}

export function materializeCatalogView(state) {
  const publications = getCatalogPublications(state)
  const writerHeads = collectWriterHeads(state.authorizationState)
  const viewBody = {
    publisherId: state.publisherId,
    policyEpoch: state.authorizationState?.policyEpoch || 0,
    writerHeads,
    publications,
  }
  return {
    version: 1,
    publisherId: state.publisherId,
    policyEpoch: viewBody.policyEpoch,
    writerHeads,
    publications,
    viewHeadDigest: hashCanonical(CATALOG_VIEW_HEAD_DOMAIN, viewBody),
  }
}
