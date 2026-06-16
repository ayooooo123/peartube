import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSourceModerationCandidate, matchModerationRule } from '../src/moderation.js'
import { ModerationRuleStore } from '../src/moderation-store.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('ModerationRuleStore persists local rules and removes by id', async (t) => {
  const dir = makeTempDir('peartube-relay-moderation-store-')
  const moderationPath = join(dir, 'db', 'relay-moderation.json')

  try {
    const store = await ModerationRuleStore.open({
      storagePath: dir,
      moderationPath,
      nowFn: () => 1234
    })

    const added = await store.addRule({
      targetType: 'channel',
      target: 'chan-1',
      action: 'block',
      reason: 'spam'
    })

    t.ok(added.id.startsWith('mod_'))
    t.alike(added, {
      id: added.id,
      targetType: 'channelKey',
      target: 'chan-1',
      action: 'block',
      source: 'local',
      reason: 'spam',
      createdAt: 1234
    })

    const reloaded = await ModerationRuleStore.open({ storagePath: dir, moderationPath })
    t.alike(reloaded.getRules(), [added])

    const removed = await reloaded.removeRule(added.id)
    t.is(removed.id, added.id)
    t.alike(reloaded.getRules(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ModerationRuleStore replaces duplicate local target/action rules', async (t) => {
  const dir = makeTempDir('peartube-relay-moderation-dedupe-')
  const moderationPath = join(dir, 'db', 'relay-moderation.json')

  try {
    const store = await ModerationRuleStore.open({
      storagePath: dir,
      moderationPath,
      nowFn: () => 2000
    })

    const first = await store.addRule({
      targetType: 'ownerKey',
      target: 'owner-1',
      action: 'watch',
      reason: 'first'
    })
    const second = await store.addRule({
      targetType: 'owner',
      target: 'owner-1',
      action: 'watch',
      reason: 'second'
    })

    t.is(second.id, first.id)
    t.alike(store.getRules(), [{
      id: first.id,
      targetType: 'ownerKey',
      target: 'owner-1',
      action: 'watch',
      source: 'local',
      reason: 'second',
      createdAt: 2000
    }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('source moderation matches archive source URL and domain aliases', async (t) => {
  const candidate = buildSourceModerationCandidate({
    url: 'https://www.video.example/watch?v=blocked',
    sourceId: 'youtube:video:blocked'
  })

  t.is(matchModerationRule(candidate, [
    { targetType: 'source', target: 'https://www.video.example/watch?v=blocked', action: 'block' }
  ])?.action, 'block')

  t.is(matchModerationRule(candidate, [
    { targetType: 'source', target: 'www.video.example', action: 'quarantine' }
  ])?.action, 'quarantine')

  t.is(matchModerationRule(candidate, [
    { targetType: 'source', target: 'video.example', action: 'watch' }
  ])?.action, 'watch')

  t.is(matchModerationRule(candidate, [
    { targetType: 'source', target: 'youtube:video:blocked', action: 'allow' }
  ])?.action, 'allow')

  const subdomainCandidate = buildSourceModerationCandidate({ url: 'https://media.video.example/watch?v=blocked' })
  t.is(matchModerationRule(subdomainCandidate, [
    { targetType: 'source', target: 'video.example', action: 'block' }
  ])?.action, 'block')
})
