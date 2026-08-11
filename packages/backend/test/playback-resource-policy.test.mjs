import test from 'brittle'

import { createPlaybackResourcePolicy } from '../src/playback/resource-policy.js'

test('playback resource policy keeps local playback while throttling network features', (t) => {
  const policy = createPlaybackResourcePolicy()
  t.alike(policy.evaluate({
    foreground: true,
    metered: false,
    charging: true,
    thermalState: 'nominal',
    userAllowsP2P: true,
    permissions: { contribute: true, archive: false },
    migrationRequired: false,
  }), {
    localPlayback: true,
    peerDiscovery: true,
    upload: true,
    cacheFill: true,
    contributionCache: true,
    archiving: false,
  })
  t.alike(policy.evaluate({
    foreground: false,
    metered: true,
    charging: false,
    thermalState: 'serious',
    userAllowsP2P: false,
    permissions: { contribute: true, archive: true },
  }), {
    localPlayback: true,
    peerDiscovery: false,
    upload: false,
    cacheFill: false,
    contributionCache: false,
    archiving: false,
  })
})

test('watch-only playback downloads privately without upload or retention', (t) => {
  const policy = createPlaybackResourcePolicy()
  t.alike(policy.evaluate({
    foreground: true,
    metered: false,
    charging: true,
    userAllowsP2P: true,
    permissions: { contribute: false, archive: false },
  }), {
    localPlayback: true,
    peerDiscovery: true,
    upload: false,
    cacheFill: true,
    contributionCache: false,
    archiving: false,
  })
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
