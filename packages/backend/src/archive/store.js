export function createArchiveStore(options = {}) {
  const maxObservations = Number.isSafeInteger(options.maxObservations) ? options.maxObservations : 128
  const pledges = new Map()
  const observations = new Map()

  return {
    async putPledge(envelope) {
      pledges.set(envelope.recordId, envelope)
      return envelope.recordId
    },
    getPledge(pledgeId) {
      return pledges.get(pledgeId) || null
    },
    putObservation(observation = {}) {
      const pledgeId = String(observation.pledgeId || '')
      const list = observations.get(pledgeId) || []
      list.push({ ...observation })
      while (list.length > maxObservations) list.shift()
      observations.set(pledgeId, list)
    },
    getObservations(pledgeId) {
      return (observations.get(String(pledgeId)) || []).slice()
    },
    getAvailabilityJudgement(pledgeId) {
      return {
        pledgeId: String(pledgeId),
        observations: this.getObservations(pledgeId).length,
        guaranteed: false,
      }
    },
  }
}
