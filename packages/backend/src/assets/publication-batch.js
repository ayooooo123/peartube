import b4a from 'b4a'

import { hashCanonical, sortPlain, toHex } from '../publisher/canonical.js'

export const PUBLICATION_BATCH_VERSION = 1
export const PUBLICATION_BATCH_DIGEST_DOMAIN = 'peartube.asset.publication-batch.v1'

function publisherHex(value) {
  return toHex(value, 32, 'publisherId')
}

function boundedPositive(value, name, max = 1024) {
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < 1 || next > max) throw new Error(`${name} must be bounded positive integer`)
  return next
}

function normalizePublication(input = {}) {
  const renditions = input.renditions || []
  if (!Array.isArray(renditions) || renditions.length === 0) throw new Error('publication renditions are required')
  return sortPlain({
    kind: 'publication',
    publicationId: toHex(input.publicationId, 32, 'publicationId'),
    manifestId: toHex(input.manifestId, 32, 'manifestId'),
    renditions: renditions.map((rendition) => sortPlain(rendition)).sort((a, b) => a.renditionId.localeCompare(b.renditionId)),
  })
}

function normalizeClaim(input = {}) {
  if (typeof input.claimType !== 'string' || !input.claimType) throw new Error('claimType is required')
  return sortPlain({
    kind: 'claim',
    claimType: input.claimType,
    claimId: toHex(input.claimId, 32, 'claimId'),
    subjectRefs: Array.isArray(input.subjectRefs) ? input.subjectRefs.map(String).sort() : [],
    payload: sortPlain(input.payload || {}),
  })
}

function digestFor(body) {
  return b4a.toString(hashCanonical(PUBLICATION_BATCH_DIGEST_DOMAIN, body), 'hex')
}

function paginate(entries, pageSize) {
  const pages = []
  for (let i = 0; i < entries.length; i += pageSize) {
    const pageEntries = entries.slice(i, i + pageSize)
    pages.push({
      index: pages.length,
      entries: pageEntries,
      digest: digestFor({ page: pages.length, entries: pageEntries }),
    })
  }
  return pages
}

export function createPublicationBatch(input = {}) {
  const publisherId = publisherHex(input.publisherId)
  const sequence = Number(input.sequence || 0)
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('sequence must be non-negative safe integer')
  const pageSize = boundedPositive(input.pageSize || 64, 'pageSize')
  const entries = []
  let sealed = null
  let committed = false

  function assertOpen() {
    if (sealed) throw new Error('publication batch is sealed')
  }

  return {
    addPublication(publication) {
      assertOpen()
      const normalized = normalizePublication(publication)
      entries.push(normalized)
      return normalized
    },

    addClaim(claim) {
      assertOpen()
      const normalized = normalizeClaim(claim)
      entries.push(normalized)
      return normalized
    },

    seal() {
      if (sealed) return sealed
      const body = sortPlain({ version: PUBLICATION_BATCH_VERSION, publisherId, sequence, entries: entries.slice() })
      const pages = paginate(body.entries, pageSize)
      const digest = digestFor({ ...body, pages: pages.map(page => ({ index: page.index, digest: page.digest })) })
      sealed = {
        ...body,
        digest,
        pages,
        catalogCommit: { publisherId, sequence, batchDigest: digest, entryCount: body.entries.length },
      }
      return sealed
    },

    commit() {
      sealed = this.seal()
      committed = true
      return sealed.catalogCommit
    },

    projectReadable({ phase = 'committed' } = {}) {
      if (!sealed || !committed || phase !== 'committed') return []
      return sealed.entries.slice()
    },
  }
}
