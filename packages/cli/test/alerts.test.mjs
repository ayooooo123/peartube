import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AlertStore } from '../src/alerts.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('AlertStore persists active alerts and dedupes repeated unacknowledged events', async (t) => {
  const dir = makeTempDir('peartube-relay-alerts-')
  const alertsPath = join(dir, 'relay-alerts.json')
  let now = 1000

  try {
    const store = await AlertStore.open({
      storagePath: dir,
      alertsPath,
      nowFn: () => now
    })

    const first = await store.addAlert({
      severity: 'warning',
      category: 'moderation',
      targetType: 'channelKey',
      target: 'chan-block',
      summary: 'Blocklisted channel appeared in public feed gossip',
      suggestedActions: ['review', 'keep-blocked']
    })

    now = 2000
    const repeated = await store.addAlert({
      severity: 'warning',
      category: 'moderation',
      targetType: 'channelKey',
      target: 'chan-block',
      summary: 'Blocklisted channel appeared in public feed gossip',
      suggestedActions: ['review', 'keep-blocked']
    })

    t.is(repeated.id, first.id, 'unacknowledged duplicate updates the existing alert')
    t.is(repeated.occurrences, 2)
    t.is(repeated.lastSeenAt, 2000)
    t.alike(store.getSummary(), {
      info: 0,
      warning: 1,
      critical: 0,
      unacknowledged: 1
    })

    now = 3000
    const acknowledged = await store.acknowledgeAlert(first.id)
    t.is(acknowledged.acknowledgedAt, 3000)
    t.alike(store.getSummary(), {
      info: 0,
      warning: 0,
      critical: 0,
      unacknowledged: 0
    })

    now = 4000
    const afterAck = await store.addAlert({
      severity: 'warning',
      category: 'moderation',
      targetType: 'channelKey',
      target: 'chan-block',
      summary: 'Blocklisted channel appeared in public feed gossip'
    })
    t.absent(afterAck.id === first.id, 'new occurrence after acknowledgement creates a fresh active alert')
    t.is(store.getAlerts().length, 1)
    t.is(store.getAlerts({ includeAcknowledged: true }).length, 2)

    const reloaded = await AlertStore.open({
      storagePath: dir,
      alertsPath,
      nowFn: () => now
    })
    t.is(reloaded.getAlerts().length, 1)
    t.is(reloaded.getAlerts({ includeAcknowledged: true }).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AlertStore ensureAlert keeps acknowledged posture alerts quiet on restart', async (t) => {
  const dir = makeTempDir('peartube-relay-posture-alerts-')
  let now = 10_000

  try {
    const store = await AlertStore.open({
      storagePath: dir,
      nowFn: () => now
    })

    const posture = await store.ensureAlert({
      severity: 'info',
      category: 'posture',
      targetType: 'role',
      target: 'public-index',
      summary: 'Public index stores public metadata for discovery'
    })

    now = 11_000
    await store.acknowledgeAlert(posture.id)

    now = 12_000
    const restarted = await store.ensureAlert({
      severity: 'info',
      category: 'posture',
      targetType: 'role',
      target: 'public-index',
      summary: 'Public index stores public metadata for discovery'
    })

    t.is(restarted.id, posture.id)
    t.is(restarted.acknowledgedAt, 11_000)
    t.alike(store.getSummary(), {
      info: 0,
      warning: 0,
      critical: 0,
      unacknowledged: 0
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
