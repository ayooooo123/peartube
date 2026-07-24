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

export function createMediaGraphStore(options = {}) {
  const trustedSigners = new Set((options.trustedSigners || []).map(hex))
  const claims = new Map()
  const quarantined = []
  const bySubject = new Map()
  const byIssuer = new Map()

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
      for (const subject of row.subjects) appendIndex(bySubject, subject, claimId)

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

    getQuarantinedClaims() {
      return quarantined.slice()
    },
  }
}
