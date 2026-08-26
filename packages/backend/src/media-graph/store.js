import b4a from 'b4a'

import { createWindowedIngestBudget, normalizeBudgetLimit } from '../bounded-ingest-budget.js'

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
  const allowedSigners = Array.from(trustedSigners)
  const authorizeSigner = typeof options.authorizeSigner === 'function' ? options.authorizeSigner : null
  const resolvePublisherId = typeof options.resolvePublisherId === 'function'
    ? options.resolvePublisherId
    : null
  const maxClaims = normalizeBudgetLimit(options.maxClaims, 10_000)
  const maxQuarantinedClaims = normalizeBudgetLimit(options.maxQuarantinedClaims, 256)
  const maxClaimsPerPublisher = normalizeBudgetLimit(options.maxClaimsPerPublisher, maxClaims)
  const maxClaimsPerAgent = normalizeBudgetLimit(options.maxClaimsPerAgent, Math.min(maxClaims, 1000))
  const maxClaimsPerCollection = normalizeBudgetLimit(options.maxClaimsPerCollection, Math.min(maxClaims, 1000))
  const maxClaimsPerSubject = normalizeBudgetLimit(options.maxClaimsPerSubject, 256)
  const maxClaimsPerPublisherPerWindow = normalizeBudgetLimit(options.maxClaimsPerPublisherPerWindow, 1024)
  const maxClaimsPerAgentPerWindow = normalizeBudgetLimit(options.maxClaimsPerAgentPerWindow, 256)
  const maxClaimsPerCollectionPerWindow = normalizeBudgetLimit(options.maxClaimsPerCollectionPerWindow, 256)
  const maxMetadataClaimsPerSubjectPerWindow = normalizeBudgetLimit(options.maxMetadataClaimsPerSubjectPerWindow, 16)
  const maxRetractionsPerPublisherPerWindow = normalizeBudgetLimit(options.maxRetractionsPerPublisherPerWindow, 64)
  const maxMetadataBytes = normalizeBudgetLimit(options.maxMetadataBytes, 8192)
  const maxRetractionTargets = normalizeBudgetLimit(options.maxRetractionTargets, 64)
  const maxCollectionSlots = normalizeBudgetLimit(options.maxCollectionSlots, 1000)
  const acceptClaim = typeof options.acceptClaim === 'function' ? options.acceptClaim : () => true
  const budget = createWindowedIngestBudget({
    now: options.now,
    windowMs: options.budgetWindowMs,
    maxTrackedKeys: options.maxBudgetKeys,
  })
  const claims = new Map()
  const quarantined = []
  let oldestQuarantine = 0
  const bySubject = new Map()
  const byIssuer = new Map()
  const byPredicate = new Map()
  const byExternalRef = new Map()
  const byPublication = new Map()
  const byCollection = new Map()
  const byAgent = new Map()
  const sequenceByIssuer = new Map()

  function materialize(claimId) {
    return claims.get(claimId) || null
  }

  function rowsFor(ids = []) {
    return ids.map(materialize).filter(Boolean)
  }

  function quarantine(entry) {
    if (quarantined.length < maxQuarantinedClaims) {
      quarantined.push(entry)
      return
    }
    quarantined[oldestQuarantine] = entry
    oldestQuarantine = (oldestQuarantine + 1) % maxQuarantinedClaims
  }

  function quarantinedSnapshot() {
    if (quarantined.length < maxQuarantinedClaims || oldestQuarantine === 0) return quarantined.slice()
    return quarantined.slice(oldestQuarantine).concat(quarantined.slice(0, oldestQuarantine))
  }

  function agentId(body) {
    return body.claimType === 'ContributionClaim' ? body.payload.agentRef?.entityId || null : null
  }

  function collectionId(body) {
    if (body.claimType !== 'CollectionMembershipClaim' && body.claimType !== 'CollectionStructureClaim') return null
    return body.payload.collectionRef?.entityId || null
  }

  function totalProjectionError(body, issuer) {
    if (claims.size >= maxClaims) return 'GRAPH_CAPACITY_EXCEEDED'
    if ((byIssuer.get(issuer)?.length || 0) >= maxClaimsPerPublisher) return 'PUBLISHER_PROJECTION_BUDGET_EXCEEDED'
    for (const subject of body.subjectRefs) {
      if ((bySubject.get(subject.entityId)?.length || 0) >= maxClaimsPerSubject) return 'SUBJECT_PROJECTION_BUDGET_EXCEEDED'
    }
    const agent = agentId(body)
    if (agent && (byAgent.get(agent)?.length || 0) >= maxClaimsPerAgent) return 'AGENT_PROJECTION_BUDGET_EXCEEDED'
    const collection = collectionId(body)
    if (collection && (byCollection.get(collection)?.length || 0) >= maxClaimsPerCollection) {
      return 'COLLECTION_PROJECTION_BUDGET_EXCEEDED'
    }
    return null
  }

  function hardLimitError(body, envelope) {
    if (body.claimType === 'EntityMetadataClaim' && b4a.byteLength(envelope.body) > maxMetadataBytes) {
      return 'METADATA_TOO_LARGE'
    }
    if (body.claimType === 'RetractionClaim' && body.payload.targetClaimIds.length > maxRetractionTargets) {
      return 'RETRACTION_TARGET_LIMIT_EXCEEDED'
    }
    if (body.claimType === 'CollectionStructureClaim' && Number(body.payload.expectedSlots || 0) > maxCollectionSlots) {
      return 'COLLECTION_SIZE_LIMIT_EXCEEDED'
    }
    return null
  }

  function reserveClaim(body, issuer) {
    const requirements = []
    if (body.claimType === 'EntityMetadataClaim') {
      for (const subject of body.subjectRefs) {
        requirements.push({
          scope: 'metadata-subject',
          key: subject.entityId,
          limit: maxMetadataClaimsPerSubjectPerWindow,
          errorCode: 'METADATA_WINDOW_BUDGET_EXCEEDED',
        })
      }
    }
    if (body.claimType === 'RetractionClaim') {
      requirements.push({
        scope: 'retraction-publisher',
        key: issuer,
        limit: maxRetractionsPerPublisherPerWindow,
        errorCode: 'RETRACTION_WINDOW_BUDGET_EXCEEDED',
      })
    }
    requirements.push({
      scope: 'claim-publisher',
      key: issuer,
      limit: maxClaimsPerPublisherPerWindow,
      errorCode: 'PUBLISHER_WINDOW_BUDGET_EXCEEDED',
    })
    const agent = agentId(body)
    if (agent) {
      requirements.push({
        scope: 'claim-agent',
        key: agent,
        limit: maxClaimsPerAgentPerWindow,
        errorCode: 'AGENT_WINDOW_BUDGET_EXCEEDED',
      })
    }
    const collection = collectionId(body)
    if (collection) {
      requirements.push({
        scope: 'claim-collection',
        key: collection,
        limit: maxClaimsPerCollectionPerWindow,
        errorCode: 'COLLECTION_WINDOW_BUDGET_EXCEEDED',
      })
    }
    return budget.reserve(requirements)
  }

  function issuerSequenceFork(issuer, sequence, claimId) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return false
    const sequences = sequenceByIssuer.get(issuer)
    const existing = sequences?.get(sequence)
    return Boolean(existing && existing !== claimId)
  }

  function rememberIssuerSequence(issuer, sequence, claimId) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return
    let sequences = sequenceByIssuer.get(issuer)
    if (!sequences) {
      sequences = new Map()
      sequenceByIssuer.set(issuer, sequences)
    }
    sequences.set(sequence, claimId)
  }

  return {
    trustedSigners,

    async ingestClaim(envelope) {
      let claimId
      try {
        claimId = hex(envelope.recordId)
      } catch (error) {
        quarantine({ status: 'invalid-envelope', error: error?.message || String(error) })
        return { status: 'quarantined' }
      }
      if (claims.has(claimId)) return { status: 'duplicate', claimId }

      let body = null
      try {
        body = decodeClaimBody(envelope.body)
      } catch (error) {
        quarantine({ status: 'invalid-body', claimId, envelope, error: error?.message || String(error) })
        return { status: 'quarantined' }
      }

      const targetClaims = body.claimType === 'RetractionClaim'
        ? body.payload.targetClaimIds.map(targetClaimId => claims.get(targetClaimId)).filter(Boolean)
        : undefined
      const ok = await verifyMediaClaim(envelope, {
        ...(authorizeSigner ? { authorizeSigner } : { allowedSigners }),
        targetClaims,
      })
      if (!ok) {
        quarantine({ status: 'invalid-signature-or-policy', claimId, envelope, body })
        return { status: 'quarantined' }
      }

      const issuer = signerHex(envelope)
      let publisherId = issuer
      if (resolvePublisherId) {
        try {
          const resolved = await resolvePublisherId(body, { claimId, issuer, envelope })
          if (typeof resolved !== 'string' || !/^[0-9a-f]{64}$/i.test(resolved)) {
            return { status: 'rejected', errorCode: 'INVALID_PUBLISHER_PROVENANCE', claimId }
          }
          publisherId = resolved.toLowerCase()
        } catch {
          return { status: 'rejected', errorCode: 'INVALID_PUBLISHER_PROVENANCE', claimId }
        }
      }
      if (issuerSequenceFork(issuer, body.issuerSequence, claimId)) {
        return { status: 'rejected', errorCode: 'ISSUER_SEQUENCE_FORK', claimId }
      }
      const hardError = hardLimitError(body, envelope)
      if (hardError) return { status: 'rejected', errorCode: hardError, claimId }
      if (!await acceptClaim(body, { claimId, issuer })) {
        return { status: 'rejected', errorCode: 'LOCAL_POLICY_REJECTED', claimId }
      }
      const projectionError = totalProjectionError(body, issuer)
      if (projectionError) return { status: 'rejected', errorCode: projectionError, claimId }
      const reservation = reserveClaim(body, issuer)
      if (!reservation.accepted) {
        return {
          status: 'rejected',
          errorCode: reservation.errorCode,
          resetAt: reservation.resetAt,
          claimId,
        }
      }

      const row = {
        claimId,
        envelope,
        body,
        issuer,
        publisherId,
        subjects: body.subjectRefs.map(ref => ref.entityId).sort(),
        revoked: false,
      }
      claims.set(claimId, row)
      rememberIssuerSequence(issuer, body.issuerSequence, claimId)
      appendIndex(byIssuer, issuer, claimId)
      appendIndex(byPredicate, body.claimType, claimId)
      for (const subject of row.subjects) appendIndex(bySubject, subject, claimId)
      indexPayload(row, { byExternalRef, byPublication, byCollection })
      const agent = agentId(body)
      if (agent) appendIndex(byAgent, agent, claimId)

      if (body.claimType === 'RetractionClaim') {
        for (const targetClaimId of body.payload.targetClaimIds) {
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
      return quarantinedSnapshot()
    },
  }
}
