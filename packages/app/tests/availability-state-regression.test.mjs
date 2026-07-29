import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AVAILABILITY_STATES,
  describeAvailability,
  effectiveAvailabilityState,
  isAvailabilityExpired,
  isAvailabilityPlayable,
} from '../lib/media-availability.js'
import { isMediaSourcePlayable, normalizeMediaSource, selectMediaSource } from '../lib/media-source-selection.js'

// Availability expires against the device clock, so fixtures anchor to it.
const NOW = Date.now()
const TTL = 60_000

function availability(state, overrides = {}) {
  return {
    state,
    renditionId: 'rendition-1',
    observedAt: NOW,
    expiresAt: NOW + TTL,
    requiredRangeCount: 1,
    reachableRangeCount: state === 'healthy' || state === 'limited' ? 1 : 0,
    independentPeerCount: state === 'healthy' ? 2 : state === 'limited' ? 1 : 0,
    completePeerCount: state === 'healthy' ? 2 : 0,
    offlinePlayable: false,
    archivePledged: false,
    reasonCodes: [],
    ...overrides,
  }
}

function source(overrides = {}) {
  return {
    publicationId: 'pub-1',
    renditionId: 'rendition-1',
    publisherId: 'publisher-1',
    rejectionReasonCodes: [],
    formatSupported: true,
    ...overrides,
  }
}

test('every availability state renders one honest label', () => {
  const rendered = Object.values(AVAILABILITY_STATES).map(state => describeAvailability(availability(state), NOW))
  assert.deepEqual(rendered.map(item => item.state), [
    'awaiting-replication',
    'limited',
    'healthy',
    'unavailable',
  ])
  // Awaiting replication is playable: nobody has asked a peer yet, and asking
  // is what Play does. Only a decided no keeps the button down.
  assert.deepEqual(rendered.map(item => item.playable), [true, true, true, false])
  for (const item of rendered) {
    assert.ok(item.label.length > 0)
    assert.ok(item.detail.length > 0)
    assert.doesNotMatch(
      `${item.label} ${item.detail}`,
      /guarantee|always available|uptime|SLA|permanent|forever|backed up/i,
      'availability copy must not promise durability the network cannot deliver'
    )
  }
})

test('an unknown state degrades to awaiting replication rather than inventing availability', () => {
  assert.equal(effectiveAvailabilityState({ state: 'excellent' }, NOW), AVAILABILITY_STATES.awaitingReplication)
  assert.equal(effectiveAvailabilityState(null, NOW), AVAILABILITY_STATES.awaitingReplication)
  // Missing evidence degrades to awaiting replication, which Play may attempt.
  assert.equal(isAvailabilityPlayable(undefined, NOW), true)
})

test('healthy evidence expires on the device that holds it', () => {
  const healthy = availability('healthy')
  assert.equal(isAvailabilityExpired(healthy, NOW + TTL), false, 'valid through its final millisecond')
  assert.equal(effectiveAvailabilityState(healthy, NOW + TTL), AVAILABILITY_STATES.healthy)

  const stale = describeAvailability(healthy, NOW + TTL + 1)
  assert.equal(stale.state, AVAILABILITY_STATES.unavailable)
  assert.equal(stale.playable, false)
  assert.equal(stale.expired, true)
})

test('a local copy reads as downloaded, never as network health', () => {
  const offline = describeAvailability(
    availability('unavailable', { offlinePlayable: true, independentPeerCount: 0 }),
    NOW
  )
  assert.equal(offline.state, AVAILABILITY_STATES.unavailable, 'the network answer is unchanged')
  assert.equal(offline.offlinePlayable, true)
  assert.equal(offline.playable, true, 'a complete local copy plays without peers')
  assert.equal(offline.independentPeerCount, 0)
})

test('an archive pledge is reported but never promoted to availability', () => {
  const pledged = describeAvailability(
    availability('awaiting-replication', { archivePledged: true, reasonCodes: ['ARCHIVE_PLEDGE_ONLY'] }),
    NOW
  )
  assert.equal(pledged.state, AVAILABILITY_STATES.awaitingReplication)
  assert.equal(pledged.playable, true, 'a pledge is not a refusal; Play still checks')
  assert.equal(pledged.archivePledged, true)
})

test('source playability follows the assessed availability, not a publisher claim', () => {
  assert.equal(isMediaSourcePlayable(source({ availability: availability('healthy') })), true)
  assert.equal(isMediaSourcePlayable(source({ availability: availability('limited') })), true)
  assert.equal(isMediaSourcePlayable(source({ availability: availability('awaiting-replication') })), true)
  assert.equal(isMediaSourcePlayable(source({ availability: availability('unavailable') })), false)
  assert.equal(
    isMediaSourcePlayable(source({ availabilityState: 'available', availability: availability('unavailable') })),
    false,
    'a stale legacy status cannot override assessed unreachability'
  )
})

test('normalization keeps the assessed object and stops coercing it into a status string', () => {
  const normalized = normalizeMediaSource(source({ availability: availability('healthy') }))
  assert.equal(normalized.availability.state, 'healthy')
  assert.equal(normalized.availabilityStatus, null, 'the four-state object is not a legacy status string')
  assert.equal(normalized.playable, true)
})

test('selection prefers reachable sources and refuses unreachable ones', () => {
  const selection = selectMediaSource({
    localEntityId: 'work:movie:1',
    sources: [
      source({ publicationId: 'pub-unavailable', renditionId: 'r-1', availability: availability('unavailable') }),
      source({ publicationId: 'pub-limited', renditionId: 'r-2', availability: availability('limited') }),
      source({ publicationId: 'pub-healthy', renditionId: 'r-3', availability: availability('healthy') }),
    ],
  })
  assert.equal(selection.selectedSource.publicationId, 'pub-healthy')

  const none = selectMediaSource({
    localEntityId: 'work:movie:2',
    sources: [source({ publicationId: 'pub-gone', renditionId: 'r-4', availability: availability('unavailable') })],
  })
  assert.equal(none.selectedSource, null, 'no reachable source means no selection, not a hopeful guess')
  assert.equal(none.unavailableReason, 'no-playable-source')
})
