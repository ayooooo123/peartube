import b4a from 'b4a'

import { hashCanonical } from '../publisher/canonical.js'

function trustFor(row, policy = {}) {
  return Number(policy[row.issuer] || 0)
}

function localClusterId(members) {
  return `local:${b4a.toString(hashCanonical('peartube.media-graph.local-cluster.v1', { members: members.slice().sort() }), 'hex')}`
}

function collectMembers(store, rootEntityId) {
  const members = new Set([rootEntityId])
  let changed = true
  while (changed) {
    changed = false
    for (const row of store.getClaims()) {
      if (row.revoked || row.body.claimType !== 'EquivalentEntityClaim') continue
      const refs = row.body.subjectRefs.map(ref => ref.entityId)
      if (refs.some(ref => members.has(ref))) {
        for (const ref of refs) {
          if (!members.has(ref)) {
            members.add(ref)
            changed = true
          }
        }
      }
    }
  }
  return Array.from(members).sort()
}

export function resolveMediaEntity(store, entityId, options = {}) {
  const trust = options.trust || {}
  const members = collectMembers(store, entityId)
  const claims = members.flatMap(member => store.getClaimsBySubject(member))
    .filter(row => !row.revoked)
    .sort((a, b) => a.claimId.localeCompare(b.claimId))

  const metadataClaims = claims
    .filter(row => row.body.claimType === 'EntityMetadataClaim')
    .sort((a, b) => {
      const confidence = Number(b.body.confidence || 0) - Number(a.body.confidence || 0)
      if (confidence) return confidence
      const trusted = trustFor(b, trust) - trustFor(a, trust)
      if (trusted) return trusted
      return a.claimId.localeCompare(b.claimId)
    })

  const metadata = metadataClaims[0]?.body.payload || {}
  return {
    entityId,
    localClusterId: localClusterId(members),
    members,
    metadata,
    claims,
    conflicts: metadataClaims.slice(1),
  }
}

// Consumer projections deliberately reuse the graph resolver.  The returned
// kind is a local presentation hint, never an assertion about global identity.
export function resolveConsumerMediaEntity(store, entityId, options = {}) {
  const resolved = resolveMediaEntity(store, entityId, options)
  return {
    ...resolved,
    entityKind: options.entityKind || resolved.claims[0]?.body?.subjectRefs?.[0]?.entityKind || 'unknown',
  }
}
