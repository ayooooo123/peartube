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

test('moderation block rule rejects before allowlist admission', async (t) => {
  const decision = evaluateCandidate({
    candidate: { channelKey: 'chan-1', ownerKey: null, source: 'config' },
    config: {
      mode: 'private',
      policy: 'allowlist',
      admission: { channels: ['chan-1'], owners: [] },
      moderation: {
        rules: [{ targetType: 'channelKey', target: 'chan-1', action: 'block', source: 'local' }]
      },
      discovery: { enabled: false, maxChannels: 0, maxChannelsPerOwner: 0 }
    },
    acceptedChannels: new Set(),
    ownerCounts: new Map()
  })

  t.is(decision.accepted, false)
  t.is(decision.retentionClass, null)
  t.is(decision.reason, 'moderation-blocked')
  t.alike(decision.moderation, { targetType: 'channelKey', target: 'chan-1', action: 'block', source: 'local' })
})

test('moderation quarantine rule rejects with quarantine reason', async (t) => {
  const decision = evaluateCandidate({
    candidate: { channelKey: 'chan-q', ownerKey: 'owner-q', source: 'discovered' },
    config: {
      mode: 'public',
      policy: 'discovery',
      admission: { channels: [], owners: [] },
      moderation: {
        rules: [{ targetType: 'ownerKey', target: 'owner-q', action: 'quarantine', source: 'local' }]
      },
      discovery: { enabled: true, maxChannels: 0, maxChannelsPerOwner: 0 }
    },
    acceptedChannels: new Set(),
    ownerCounts: new Map()
  })

  t.is(decision.accepted, false)
  t.is(decision.reason, 'moderation-quarantined')
  t.is(decision.moderation.targetType, 'ownerKey')
  t.is(decision.moderation.target, 'owner-q')
})

test('moderation allow rule accepts curated public candidates', async (t) => {
  const decision = evaluateCandidate({
    candidate: { channelKey: 'chan-allow', ownerKey: 'owner-allow', source: 'discovered' },
    config: {
      mode: 'public',
      policy: 'allowlist',
      admission: { channels: [], owners: [] },
      moderation: {
        rules: [{ targetType: 'channelKey', target: 'chan-allow', action: 'allow', source: 'local' }]
      },
      discovery: { enabled: false, maxChannels: 0, maxChannelsPerOwner: 0 }
    },
    acceptedChannels: new Set(),
    ownerCounts: new Map()
  })

  t.is(decision.accepted, true)
  t.is(decision.retentionClass, 'allowlist')
  t.is(decision.reason, 'moderation-allow')
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
