import b4a from 'b4a'

import { decodeClaimBody, verifyMediaClaim } from './claims.js'

function hex(value) {
  return b4a.toString(b4a.from(value), 'hex')
}

function appendIndex(map, key, claimId) {
  const list = map.get(key) || []
  if (!list.includes(claimId)) list.push(claimId)
  map.set(key, list)
}

function signerHex(envelope) {
  return envelope?.signer ? hex(envelope.signer) : null
}

function externalRefKey(ref = {}) {
  if (!ref?.namespace || !ref?.identifier) return null
  return `${String(ref.namespace).toLowerCase()}:${String(ref.identifier).trim()}`
}

function indexPayload(row, indexes) {
  const { byExternalRef, byPublication, byCollection } = indexes
  const payload = row.body.payload || {}
  const externalKey = externalRefKey(payload.externalRef)
  if (externalKey) appendIndex(byExternalRef, externalKey, row.claimId)
  if (typeof payload.publicationId === 'string' && payload.publicationId.length) {
    appendIndex(byPublication, payload.publicationId, row.claimId)
  }
  if (payload.collectionRef?.entityId) appendIndex(byCollection, payload.collectionRef.entityId, row.claimId)
}

function normalizeScanLimit(limit = 100) {
  const next = Number(limit)
  if (!Number.isSafeInteger(next) || next < 1 || next > 1000) throw new Error('limit must be between 1 and 1000')
  return next
}

export function createMediaGraphStore(options = {}) {
  const trustedSigners = new Set((options.trustedSigners || []).map(hex))
  const claims = new Map()
  const quarantined = []
  const bySubject = new Map()
  const byIssuer = new Map()
  const byPredicate = new Map()
  const byExternalRef = new Map()
  const byPublication = new Map()
  const byCollection = new Map()

  function materialize(claimId) {
    return claims.get(claimId) || null
  }

  function rowsFor(ids = []) {
    return ids.map(materialize).filter(Boolean)
  }

  return {
    trustedSigners,

    async ingestClaim(envelope) {
      const claimId = hex(envelope.recordId)
      if (claims.has(claimId)) return { status: 'duplicate', claimId }

      let body = null
      try {
        body = decodeClaimBody(envelope.body)
      } catch (error) {
        quarantined.push({ status: 'invalid-body', claimId, envelope, error: error?.message || String(error) })
        return { status: 'quarantined' }
      }

      const allowedSigners = Array.from(trustedSigners)
      const targetClaims = Array.from(claims.values())
      const ok = await verifyMediaClaim(envelope, { allowedSigners, targetClaims })
      if (!ok) {
        quarantined.push({ status: 'invalid-signature-or-policy', claimId, envelope, body })
        return { status: 'quarantined' }
      }

      const issuer = signerHex(envelope)
      const row = {
        claimId,
        envelope,
        body,
        issuer,
        subjects: body.subjectRefs.map(ref => ref.entityId).sort(),
        revoked: false,
      }
      claims.set(claimId, row)
      appendIndex(byIssuer, issuer, claimId)
      appendIndex(byPredicate, body.claimType, claimId)
      for (const subject of row.subjects) appendIndex(bySubject, subject, claimId)
      indexPayload(row, { byExternalRef, byPublication, byCollection })

      if (body.claimType === 'RetractionClaim') {
        for (const targetClaimId of body.payload.targetClaimIds || []) {
          const target = claims.get(targetClaimId)
          if (target && target.issuer === issuer) target.revoked = true
        }
      }

      return { status: 'accepted', claimId }
    },

    getClaim(claimId) {
      return materialize(claimId)
    },

    getClaims() {
      return Array.from(claims.values()).sort((a, b) => a.claimId.localeCompare(b.claimId))
    },

    getClaimsBySubject(entityId) {
      return rowsFor(bySubject.get(entityId) || [])
    },

    getClaimsByIssuer(issuer) {
      return rowsFor(byIssuer.get(issuer) || [])
    },

    getClaimsByPredicate(predicate) {
      return rowsFor(byPredicate.get(predicate) || [])
    },

    getClaimsByExternalRef(refKey) {
      return rowsFor(byExternalRef.get(refKey) || [])
    },

    getClaimsByPublication(publicationId) {
      return rowsFor(byPublication.get(publicationId) || [])
    },

    getClaimsByCollection(collectionId) {
      return rowsFor(byCollection.get(collectionId) || [])
    },

    scanClaims({ limit = 100, cursor = null } = {}) {
      const boundedLimit = normalizeScanLimit(limit)
      const rows = this.getClaims()
      const start = cursor ? rows.findIndex(row => row.claimId === cursor) + 1 : 0
      const offset = Math.max(0, start)
      const page = rows.slice(offset, offset + boundedLimit)
      const next = offset + boundedLimit < rows.length ? page.at(-1)?.claimId || null : null
      return { rows: page, cursor: next }
    },

    getQuarantinedClaims() {
      return quarantined.slice()
    },
  }
}
