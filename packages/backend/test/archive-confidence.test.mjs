import test from 'brittle'

import { assessArchiveConfidence } from '../src/archive/confidence.js'

test('archive confidence rejects transient viewers and same-device sybils for source offload', (t) => {
  t.is(assessArchiveConfidence({ viewerFullCopies: 9 }).eligible, false)
  t.is(assessArchiveConfidence({ ownDeviceCopies: [{ deviceId: 'same', sameDevice: true }] }).eligible, false)
  t.is(assessArchiveConfidence({ ownDeviceCopies: [{ deviceId: 'phone', sameDevice: false }] }).eligible, true)
  t.is(assessArchiveConfidence({ archivistChallenges: [{ archivistId: 'a', recent: true, passed: true }] }).eligible, true)
})
