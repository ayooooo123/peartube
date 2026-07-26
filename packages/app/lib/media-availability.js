/**
 * One presentation contract for the four availability states.
 *
 * Availability is a local, expiring observation of peer reachability. It is
 * never a durability guarantee, an SLA, or a claim about the wider network, so
 * every string here has to survive a title becoming unplayable a second later.
 */

export const AVAILABILITY_STATES = Object.freeze({
  awaitingReplication: 'awaiting-replication',
  limited: 'limited',
  healthy: 'healthy',
  unavailable: 'unavailable',
})

const PRESENTATION = Object.freeze({
  [AVAILABILITY_STATES.healthy]: Object.freeze({
    label: 'Available now',
    detail: 'Peers are currently sharing every part of this title.',
    playable: true,
  }),
  [AVAILABILITY_STATES.limited]: Object.freeze({
    label: 'Limited availability',
    detail: 'Every required part is reachable right now, but fewer than two peers prove a complete copy. Playback may stop.',
    playable: true,
  }),
  [AVAILABILITY_STATES.awaitingReplication]: Object.freeze({
    label: 'Awaiting replication',
    detail: 'No peer has been checked for this title yet.',
    playable: false,
  }),
  [AVAILABILITY_STATES.unavailable]: Object.freeze({
    label: 'Unavailable',
    detail: 'No peer currently serves the required ranges.',
    playable: false,
  }),
})

const OFFLINE = Object.freeze({
  label: 'Downloaded',
  detail: 'A complete copy is on this device and plays without peers.',
  playable: true,
})

function positiveInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * Evidence expires on the device holding it, not on the backend that produced
 * it. A response that was healthy when it was assembled is unavailable once
 * `expiresAt` passes with no newer assessment.
 */
export function isAvailabilityExpired(availability, now = Date.now()) {
  const expiresAt = positiveInteger(availability?.expiresAt)
  const observedAt = positiveInteger(availability?.observedAt)
  if (expiresAt === 0 || expiresAt <= observedAt) return false
  return now > expiresAt
}

export function effectiveAvailabilityState(availability, now = Date.now()) {
  const state = String(availability?.state || AVAILABILITY_STATES.awaitingReplication)
  if (!Object.hasOwn(PRESENTATION, state)) return AVAILABILITY_STATES.awaitingReplication
  if (state === AVAILABILITY_STATES.awaitingReplication || state === AVAILABILITY_STATES.unavailable) return state
  return isAvailabilityExpired(availability, now) ? AVAILABILITY_STATES.unavailable : state
}

/**
 * The single description every surface renders: cards, detail screens, Other
 * Sources, and player errors all read from this so a viewer never sees two
 * answers for one title.
 */
export function describeAvailability(availability, now = Date.now()) {
  const state = effectiveAvailabilityState(availability, now)
  const offlinePlayable = availability?.offlinePlayable === true
  const presentation = offlinePlayable ? OFFLINE : PRESENTATION[state]
  return {
    state,
    label: presentation.label,
    detail: presentation.detail,
    playable: presentation.playable,
    offlinePlayable,
    expired: isAvailabilityExpired(availability, now),
    // A retention pledge says someone promised to keep a copy, never that a
    // peer can serve it now. It is reported, never promoted.
    archivePledged: availability?.archivePledged === true,
    independentPeerCount: positiveInteger(availability?.independentPeerCount),
    completePeerCount: positiveInteger(availability?.completePeerCount),
    observedAt: positiveInteger(availability?.observedAt),
    expiresAt: positiveInteger(availability?.expiresAt),
    reasonCodes: Array.isArray(availability?.reasonCodes) ? availability.reasonCodes : [],
  }
}

export function isAvailabilityPlayable(availability, now = Date.now()) {
  return describeAvailability(availability, now).playable
}
