import test from 'brittle'

import { assessArchiveConfidence } from '../src/archive/confidence.js'

test('archive confidence excludes viewers anonymous holders stale proofs and same-device sybils', (t) => {
  const result = assessArchiveConfidence({
    localPhysicalDeviceId: 'physical-a',
    viewerFullCopies: 50,
    publisherDeviceCopies: [
      { deviceId: 'same-process', physicalDeviceId: 'physical-a', connected: true, fullCopy: true, publisherControlled: true },
      { deviceId: 'same-physical-sybil', physicalDeviceId: 'physical-a', connected: true, fullCopy: true, publisherControlled: true },
      { deviceId: 'viewer', physicalDeviceId: 'physical-v', connected: true, fullCopy: true, publisherControlled: false },
    ],
    archivistChallenges: [
      { archivistId: 'ordinary-volunteer', connected: true, recent: true, passed: true, intentional: false },
      { archivistId: 'stale-archivist', connected: true, recent: false, passed: true, intentional: true },
      { archivistId: 'failed-archivist', connected: true, recent: true, passed: false, intentional: true },
    ],
  })
  t.is(result.eligible, false)
  t.alike(result.durablePublisherDevices, [])
  t.alike(result.durableArchivists, [])
  t.ok(result.limitations.includes('viewer-copies-are-transient-and-excluded'))
})

test('archive confidence accepts a distinct connected publisher-controlled full copy', (t) => {
  const result = assessArchiveConfidence({
    localPhysicalDeviceId: 'physical-a',
    publisherDeviceCopies: [
      { deviceId: 'phone', physicalDeviceId: 'physical-b', connected: true, fullCopy: true, publisherControlled: true },
    ],
  })
  t.is(result.eligible, true)
  t.alike(result.reasons, ['publisher-device-confirmed'])
})

test('archive confidence accepts only recent intentional archivist possession proof', (t) => {
  const result = assessArchiveConfidence({
    archivistChallenges: [
      { archivistId: 'archive-a', physicalDeviceId: 'host-a', connected: true, recent: true, passed: true, intentional: true },
    ],
  })
  t.is(result.eligible, true)
  t.alike(result.reasons, ['intentional-archivist-challenge-confirmed'])
})

test('active playback blocks otherwise durable offload', (t) => {
  const result = assessArchiveConfidence({
    activePlayback: true,
    publisherDeviceCopies: [
      { deviceId: 'phone', connected: true, fullCopy: true, publisherControlled: true },
    ],
  })
  t.is(result.eligible, false)
  t.is(result.limitations[0], 'playback-active')
})
