import test from 'brittle'

import { enforceModerationDecision } from '../src/moderation/manager.js'

test('moderation enforcement prevents downloads and seeding with the same decision shape', (t) => {
  const blocked = enforceModerationDecision({ action: 'not-downloaded', evidence: [{ source: 'local' }] }, 'download')
  t.is(blocked.allowed, false)
  t.is(blocked.reason, 'not-downloaded')
  const seeded = enforceModerationDecision({ action: 'not-seeded', evidence: [{ source: 'feed' }] }, 'seed')
  t.is(seeded.allowed, false)
  t.is(seeded.reason, 'not-seeded')
  t.is(enforceModerationDecision({ action: 'hidden' }, 'download').allowed, true)
})
