import test from 'brittle'

import { createPlaybackResourcePolicy } from '../src/playback/resource-policy.js'

test('playback resource policy keeps local playback while throttling network features', (t) => {
  const policy = createPlaybackResourcePolicy()
  const healthyContributor = {
    foreground: true,
    metered: false,
    charging: true,
    thermalState: 'nominal',
    userAllowsP2P: true,
    permissions: { contribute: true, archive: false },
    migrationRequired: false,
  }
  t.alike(policy.evaluate(healthyContributor), {
    localPlayback: true,
    peerDiscovery: true,
    upload: true,
    cacheFill: true,
    // An archive pledge is never implied by healthy resources.
    archiving: false,
  })
  // The retention side of the same state is an acquisition role, and
  // transition() is what reports it.
  t.is(policy.transition(healthyContributor).contributionCache, true)

  const constrained = {
    foreground: false,
    metered: true,
    charging: false,
    thermalState: 'serious',
    userAllowsP2P: false,
    permissions: { contribute: true, archive: true },
  }
  t.alike(policy.evaluate(constrained), {
    localPlayback: true,
    peerDiscovery: false,
    upload: false,
    cacheFill: false,
    archiving: false,
  })
  t.is(policy.transition(constrained).contributionCache, false)
})

test('watch-only playback downloads privately without upload or retention', (t) => {
  const policy = createPlaybackResourcePolicy()
  const watchOnly = {
    foreground: true,
    metered: false,
    charging: true,
    userAllowsP2P: true,
    permissions: { contribute: false, archive: false },
  }
  t.alike(policy.evaluate(watchOnly), {
    localPlayback: true,
    peerDiscovery: true,
    upload: false,
    cacheFill: true,
    archiving: false,
  })
  t.is(policy.transition(watchOnly).contributionCache, false)
})

test('policy transitions invalidate in-flight public acquisition without interrupting playback', (t) => {
  const policy = createPlaybackResourcePolicy()
  const contributor = {
    foreground: true,
    metered: false,
    charging: true,
    userAllowsP2P: true,
    migrationRequired: false,
    permissions: { contribute: true, archive: false },
  }
  const acquired = policy.transition(contributor)
  t.is(acquired.generation, 0)
  t.is(acquired.contributionCache, true)

  const watchOnly = policy.transition({
    ...contributor,
    permissions: { contribute: false, archive: false },
  })
  t.is(watchOnly.generation, 1, 'downgrade invalidates work admitted by the prior generation')
  t.is(watchOnly.upload, false)
  t.is(watchOnly.contributionCache, false)
  t.is(watchOnly.localPlayback, true)

  const restored = policy.transition(contributor)
  t.is(restored.generation, 2, 'restoring consent starts a fresh acquisition generation')
})

test('playback resource policy bounds requests, peers, in-flight bytes, disk, and deadlines', (t) => {
  const policy = createPlaybackResourcePolicy({ maxPeers: 4, maxRequests: 8, maxInFlightBytes: 1024, maxDiskBytes: 2048, deadlineMs: 5000 })
  t.alike(policy.limits(), { maxPeers: 4, maxRequests: 8, maxInFlightBytes: 1024, maxDiskBytes: 2048, deadlineMs: 5000 })
  t.exception(() => createPlaybackResourcePolicy({ maxPeers: -1 }), /maxPeers/)
})

test('playback resource policy keeps legacy defaults while deriving from the participation decision', (t) => {
  const policy = createPlaybackResourcePolicy()
  // Legacy state carries no participation fields: the omitted signals keep
  // their historical reading rather than suspending contribution outright, and
  // the pledge it never mentions stays unmade.
  t.alike(policy.evaluate({}), {
    localPlayback: true,
    peerDiscovery: true,
    upload: true,
    cacheFill: true,
    archiving: false,
  })
  // Unpowered legacy state loses contribution but keeps its own playback.
  t.alike(policy.evaluate({ charging: false }), {
    localPlayback: true,
    peerDiscovery: true,
    upload: false,
    cacheFill: true,
    archiving: false,
  })
  // OS background permission is never assumed, so backgrounded legacy state
  // suspends instead of pretending to seed.
  t.alike(policy.evaluate({ foreground: false }), {
    localPlayback: true,
    peerDiscovery: false,
    upload: false,
    cacheFill: false,
    archiving: false,
  })
  // An explicit archive opt-out is honoured even in the legacy shape.
  t.is(policy.evaluate({ archiveOptIn: false }).archiving, false)
  // An explicit pledge is the only thing that turns archiving on.
  t.is(policy.evaluate({ archiveOptIn: true }).archiving, true)
  // A truthy-but-not-true pledge is not a pledge.
  t.is(policy.evaluate({ archiveOptIn: 'yes' }).archiving, false)
  // Participation fields, when supplied, drive the same decision.
  t.is(policy.evaluate({ mode: 'data-saver', playbackActive: false, msSincePlaybackEnded: 0 }).upload, false)
  t.is(policy.evaluate({ uploadedBytesLast24h: 2 * 1024 * 1024 * 1024 }).upload, false)
})
