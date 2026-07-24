import test from 'brittle'

import { evaluateModerationPolicy } from '../src/moderation/policy.js'

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
