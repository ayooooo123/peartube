import test from 'brittle'

import { createPlaybackResourcePolicy } from '../src/playback/resource-policy.js'

test('playback resource policy keeps local playback while throttling network features', (t) => {
  const policy = createPlaybackResourcePolicy()
  t.alike(policy.evaluate({ foreground: true, metered: false, charging: true, thermalState: 'nominal', userAllowsP2P: true }), {
    localPlayback: true,
    peerDiscovery: true,
    upload: true,
    cacheFill: true,
    archiving: true,
  })
  t.alike(policy.evaluate({ foreground: false, metered: true, charging: false, thermalState: 'serious', userAllowsP2P: false }), {
    localPlayback: true,
    peerDiscovery: false,
    upload: false,
    cacheFill: false,
    archiving: false,
  })
})

test('playback resource policy bounds requests, peers, in-flight bytes, disk, and deadlines', (t) => {
  const policy = createPlaybackResourcePolicy({ maxPeers: 4, maxRequests: 8, maxInFlightBytes: 1024, maxDiskBytes: 2048, deadlineMs: 5000 })
  t.alike(policy.limits(), { maxPeers: 4, maxRequests: 8, maxInFlightBytes: 1024, maxDiskBytes: 2048, deadlineMs: 5000 })
  t.exception(() => createPlaybackResourcePolicy({ maxPeers: -1 }), /maxPeers/)
})
