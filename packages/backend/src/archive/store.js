import b4a from 'b4a'

export function createArchiveStore(options = {}) {
  const maxObservations = Number.isSafeInteger(options.maxObservations) ? options.maxObservations : 128
  const pledges = new Map()
  const observations = new Map()
  const diagnostics = options.diagnostics
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  function normalizePledgeId(value) {
    return typeof value === 'string' ? value : b4a.toString(b4a.from(value || []), 'hex')
  }

  function observe(method, input) {
    try {
      diagnostics?.[method]?.(input)
    } catch {
      // Diagnostics must never change persisted archive records.
    }
  }

  function observeArchiveStatus(observation, pledgeId) {
    const common = {
      pledgeId,
      observedAt: observation.observedAt ?? now(),
    }
    if (observation.status === 'challenge-passed') {
      observe('recordChallengeOutcome', { ...common, outcome: 'passed' })
    } else if (observation.status === 'challenge-failed') {
      observe('recordChallengeOutcome', { ...common, outcome: 'failed', failureCode: observation.failureCode })
    } else if (observation.status === 'challenge-expired') {
      observe('recordChallengeOutcome', { ...common, outcome: 'expired' })
    } else if (observation.status === 'pledge-healthy') {
      observe('recordPledgeHealth', { ...common, health: 'healthy', active: true })
    } else if (observation.status === 'pledge-failed') {
      observe('recordPledgeHealth', { ...common, health: 'failed', active: true })
    } else if (observation.status === 'pledge-expired') {
      observe('recordPledgeHealth', { ...common, health: 'expired', active: false })
    }
  }

  return {
    async putPledge(envelope) {
      const pledgeId = normalizePledgeId(envelope.recordId)
      pledges.set(pledgeId, envelope)
      observe('recordPledgeHealth', {
        pledgeId,
        health: 'unknown',
        active: true,
        observedAt: now(),
      })
      return pledgeId
    },
    getPledge(pledgeId) {
      return pledges.get(normalizePledgeId(pledgeId)) || null
    },
    putObservation(observation = {}) {
      const pledgeId = normalizePledgeId(observation.pledgeId)
      const list = observations.get(pledgeId) || []
      list.push({ ...observation })
      while (list.length > maxObservations) list.shift()
      observations.set(pledgeId, list)
      observeArchiveStatus(observation, pledgeId)
    },
    getObservations(pledgeId) {
      return (observations.get(normalizePledgeId(pledgeId)) || []).slice()
    },
    getAvailabilityJudgement(pledgeId) {
      return {
        pledgeId: normalizePledgeId(pledgeId),
        observations: this.getObservations(pledgeId).length,
        guaranteed: false,
      }
    },
  }
}
