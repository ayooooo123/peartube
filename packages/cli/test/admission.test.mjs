import test from 'brittle'

import { evaluateCandidate } from '../src/admission.js'

test('private mode accepts configured channels', async (t) => {
  const decision = evaluateCandidate({
    candidate: { channelKey: 'chan-1', ownerKey: null, source: 'config' },
    config: {
      mode: 'private',
      policy: 'allowlist',
      admission: { channels: ['chan-1'], owners: [] },
      discovery: { enabled: false, maxChannels: 0, maxChannelsPerOwner: 0 }
    },
    acceptedChannels: new Set(),
    ownerCounts: new Map()
  })

  t.is(decision.accepted, true)
  t.is(decision.retentionClass, 'private')
  t.is(decision.reason, 'channel-allowlist')
})

test('private mode rejects discovered channels without matching rules', async (t) => {
  const decision = evaluateCandidate({
    candidate: { channelKey: 'chan-2', ownerKey: 'owner-2', source: 'discovered' },
    config: {
      mode: 'private',
      policy: 'allowlist',
      admission: { channels: ['chan-1'], owners: ['owner-1'] },
      discovery: { enabled: false, maxChannels: 0, maxChannelsPerOwner: 0 }
    },
    acceptedChannels: new Set(),
    ownerCounts: new Map()
  })

  t.is(decision.accepted, false)
  t.is(decision.reason, 'not-allowlisted')
})

test('public allowlist mode accepts owner matches', async (t) => {
  const decision = evaluateCandidate({
    candidate: { channelKey: 'chan-3', ownerKey: 'owner-3', source: 'discovered' },
    config: {
      mode: 'public',
      policy: 'allowlist',
      admission: { channels: [], owners: ['owner-3'] },
      discovery: { enabled: false, maxChannels: 0, maxChannelsPerOwner: 0 }
    },
    acceptedChannels: new Set(),
    ownerCounts: new Map()
  })

  t.is(decision.accepted, true)
  t.is(decision.retentionClass, 'allowlist')
  t.is(decision.reason, 'owner-allowlist')
})

test('public discovery mode accepts discovered channels within limits', async (t) => {
  const decision = evaluateCandidate({
    candidate: { channelKey: 'chan-4', ownerKey: 'owner-4', source: 'discovered' },
    config: {
      mode: 'public',
      policy: 'discovery',
      admission: { channels: [], owners: [] },
      discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
    },
    acceptedChannels: new Set(['chan-1']),
    ownerCounts: new Map([['owner-4', 1]])
  })

  t.is(decision.accepted, true)
  t.is(decision.retentionClass, 'discovery')
  t.is(decision.reason, 'discovery')
})

test('public discovery mode rejects channels after owner limit', async (t) => {
  const decision = evaluateCandidate({
    candidate: { channelKey: 'chan-5', ownerKey: 'owner-5', source: 'discovered' },
    config: {
      mode: 'public',
      policy: 'discovery',
      admission: { channels: [], owners: [] },
      discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 1 }
    },
    acceptedChannels: new Set(['chan-1']),
    ownerCounts: new Map([['owner-5', 1]])
  })

  t.is(decision.accepted, false)
  t.is(decision.reason, 'owner-limit')
})
