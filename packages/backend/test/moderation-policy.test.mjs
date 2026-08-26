import test from 'brittle'

import { createModerationPolicyEvaluator, evaluateModerationPolicy } from '../src/moderation/policy.js'

test('moderation policy returns one shared decision with evidence trace and precedence', (t) => {
  const decision = evaluateModerationPolicy({ publicationId: 'a', publisherId: 'p', creatorIds: ['c'] }, { localBlocks: [{ targetType: 'publisher', targetId: 'p' }], feedAllows: [{ targetType: 'publication', targetId: 'a' }] })
  t.is(decision.action, 'not-downloaded')
  t.is(decision.reason, 'local-block')
  t.ok(decision.evidence.length > 0)
})

test('moderation policy distinguishes hidden, not downloaded, and not seeded', (t) => {
  t.is(evaluateModerationPolicy({ publicationId: 'a' }, { feedBlocks: [{ targetType: 'publication', targetId: 'a', action: 'hide' }] }).action, 'hidden')
  t.is(evaluateModerationPolicy({ publicationId: 'a' }, { feedBlocks: [{ targetType: 'publication', targetId: 'a', action: 'block' }] }).action, 'not-downloaded')
  t.is(evaluateModerationPolicy({ publicationId: 'a' }, { feedBlocks: [{ targetType: 'publication', targetId: 'a', action: 'not-seeded' }] }).action, 'not-seeded')
})

test('compiled moderation evaluator preserves precedence and alias matching', (t) => {
  const policy = {
    localAllows: [{ targetType: 'publication', targetId: 'publication:a', action: 'allow' }],
    feedBlocks: [
      { targetType: 'work', targetId: 'work:a', action: 'hide' },
      { targetType: 'publisher', targetId: 'publisher:a', action: 'block' },
    ],
  }
  const evaluate = createModerationPolicyEvaluator(policy)
  for (const entity of [
    { publicationId: 'publication:a', workId: 'work:a', publisherId: 'publisher:a' },
    { entityRef: 'work:a' },
    { publisherRootKey: 'publisher:a' },
    { publicationId: 'publication:other' },
  ]) t.alike(evaluate(entity), evaluateModerationPolicy(entity, policy))
})
