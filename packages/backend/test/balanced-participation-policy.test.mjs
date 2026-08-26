import test from 'brittle'

import {
  DEFAULT_PARTICIPATION_MODE,
  MAX_PARTICIPATION_REASON_CODES,
  PARTICIPATION_HARD_LIMITS,
  PARTICIPATION_LIMITS,
  PARTICIPATION_MODES,
  PARTICIPATION_REASON_CODES,
  createPlaybackResourcePolicy,
  evaluateParticipation,
} from '../src/playback/resource-policy.js'

const GIB = 1024 * 1024 * 1024
const MINUTE_MS = 60 * 1000

// A device that satisfies every gate while playback is running, with bytes
// actually leaving the box. Individual tests override exactly the signal under
// test.
function healthyDevice(overrides = {}) {
  return {
    mode: 'balanced',
    userAllowsP2P: true,
    playbackActive: true,
    msSincePlaybackEnded: 0,
    foreground: true,
    backgroundPermitted: true,
    metered: false,
    thermalState: 'nominal',
    batteryPercent: 80,
    charging: false,
    freeDiskBytes: 200 * GIB,
    totalDiskBytes: 500 * GIB,
    uploadedBytesLast24h: 0,
    // Measured outbound traffic, not an assumption drawn from playback.
    recentOutboundBytes: 512 * 1024,
    backgroundMsThisSession: 0,
    backgroundMsLast24h: 0,
    archiveOptIn: false,
    ...overrides,
  }
}

test('balanced is the default mode and carries the published ceilings', (t) => {
  t.alike(PARTICIPATION_MODES, ['data-saver', 'balanced', 'help-more'])
  t.is(DEFAULT_PARTICIPATION_MODE, 'balanced')
  t.alike(PARTICIPATION_LIMITS.balanced, {
    cacheCeilingBytes: 20 * GIB,
    uploadCeilingBytesPer24h: 1 * GIB,
    outboundBytesPerSecond: 625000,
    postPlaybackGraceMs: 10 * MINUTE_MS,
    backgroundSessionMs: 15 * MINUTE_MS,
    backgroundPer24hMs: 60 * MINUTE_MS,
  })
  t.is(PARTICIPATION_LIMITS.balanced.outboundBytesPerSecond * 8, 5000000, '5 Mbit/s outbound')
  t.alike(PARTICIPATION_HARD_LIMITS, {
    minBatteryPercent: 50,
    minFreeDiskBytes: 2 * GIB,
    minFreeDiskFraction: 0.1,
  })
  t.is(MAX_PARTICIPATION_REASON_CODES, 8)

  // A state with no participation fields at all still resolves to Balanced.
  const bare = evaluateParticipation({})
  t.is(bare.mode, 'balanced')
  t.is(bare.cacheCeilingBytes, 20 * GIB)
  t.is(bare.uploadCeilingBytesPer24h, 1 * GIB)
})

test('participation state machine walks playback, grace, and expiry', (t) => {
  const playing = evaluateParticipation(healthyDevice())
  t.is(playing.state, 'uploading')
  t.is(playing.uploading, true)
  t.is(playing.uploadEligible, true)
  t.is(playing.upload, true)
  t.is(playing.peerDiscovery, true)
  t.is(playing.cacheFill, true)
  t.is(playing.localPlayback, true)
  t.alike(playing.reasonCodes, [])

  // Contribution outlives playback: bytes still moving inside the grace window
  // are still uploading.
  const graceUploading = evaluateParticipation(healthyDevice({ playbackActive: false, msSincePlaybackEnded: 5 * MINUTE_MS }))
  t.is(graceUploading.state, 'uploading')
  t.is(graceUploading.uploading, true)

  const midGrace = evaluateParticipation(healthyDevice({
    playbackActive: false,
    msSincePlaybackEnded: 5 * MINUTE_MS,
    recentOutboundBytes: 0,
  }))
  t.is(midGrace.state, 'eligible')
  t.is(midGrace.uploading, false)
  t.is(midGrace.uploadEligible, true)
  t.alike(midGrace.reasonCodes, [])

  const graceBoundary = evaluateParticipation(healthyDevice({
    playbackActive: false,
    msSincePlaybackEnded: 10 * MINUTE_MS,
    recentOutboundBytes: 0,
  }))
  t.is(graceBoundary.state, 'eligible', 'the grace window is inclusive of its last millisecond')
  t.is(graceBoundary.uploadEligible, true)

  const expired = evaluateParticipation(healthyDevice({ playbackActive: false, msSincePlaybackEnded: 10 * MINUTE_MS + 1 }))
  t.is(expired.state, 'suspended')
  t.is(expired.uploadEligible, false)
  t.is(expired.upload, false)
  t.alike(expired.reasonCodes, ['OUTSIDE_PLAYBACK_WINDOW'])
  t.is(expired.localPlayback, true, 'local playback survives every suspension')

  const unknownElapsed = evaluateParticipation(healthyDevice({ playbackActive: false, msSincePlaybackEnded: undefined }))
  t.is(unknownElapsed.state, 'suspended', 'unknown elapsed time is not a licence to keep uploading')
  t.alike(unknownElapsed.reasonCodes, ['OUTSIDE_PLAYBACK_WINDOW'])
})

test('foreground and background transitions respect OS permission and budgets', (t) => {
  const backgrounded = evaluateParticipation(healthyDevice({ foreground: false }))
  t.is(backgrounded.state, 'uploading')
  t.is(backgrounded.backgroundEligible, true)
  t.is(backgrounded.backgroundRemainingSessionMs, 15 * MINUTE_MS)
  t.is(backgrounded.backgroundRemainingDailyMs, 60 * MINUTE_MS)
  t.alike(backgrounded.reasonCodes, [])

  const noPermission = evaluateParticipation(healthyDevice({ foreground: false, backgroundPermitted: false }))
  t.is(noPermission.state, 'suspended', 'backgrounding that cannot legally run work suspends')
  t.is(noPermission.uploading, false)
  t.is(noPermission.peerDiscovery, false)
  t.is(noPermission.cacheFill, false)
  t.is(noPermission.backgroundEligible, false)
  t.alike(noPermission.reasonCodes, ['BACKGROUND_NOT_PERMITTED'])

  const unknownPermission = evaluateParticipation(healthyDevice({ foreground: false, backgroundPermitted: undefined }))
  t.is(unknownPermission.state, 'suspended', 'OS background permission is never assumed')
  t.alike(unknownPermission.reasonCodes, ['BACKGROUND_NOT_PERMITTED'])

  // Foreground work is unaffected by a missing background permission, and the
  // background constraint is not reported as a reason for it.
  const foregroundNoPermission = evaluateParticipation(healthyDevice({ backgroundPermitted: false }))
  t.is(foregroundNoPermission.state, 'uploading')
  t.is(foregroundNoPermission.backgroundEligible, false, 'lifecycle can see that backgrounding would suspend')
  t.alike(foregroundNoPermission.reasonCodes, [])

  const sessionSpent = evaluateParticipation(healthyDevice({ foreground: false, backgroundMsThisSession: 15 * MINUTE_MS }))
  t.is(sessionSpent.state, 'suspended')
  t.is(sessionSpent.backgroundRemainingSessionMs, 0)
  t.is(sessionSpent.backgroundRemainingDailyMs, 60 * MINUTE_MS)
  t.alike(sessionSpent.reasonCodes, ['BACKGROUND_SESSION_BUDGET_EXHAUSTED'])

  const dailySpent = evaluateParticipation(healthyDevice({
    foreground: false,
    backgroundMsThisSession: 3 * MINUTE_MS,
    backgroundMsLast24h: 60 * MINUTE_MS,
  }))
  t.is(dailySpent.state, 'suspended')
  t.is(dailySpent.backgroundRemainingSessionMs, 12 * MINUTE_MS)
  t.is(dailySpent.backgroundRemainingDailyMs, 0)
  t.alike(dailySpent.reasonCodes, ['BACKGROUND_DAILY_BUDGET_EXHAUSTED'])

  const bothSpent = evaluateParticipation(healthyDevice({
    foreground: false,
    backgroundMsThisSession: 20 * MINUTE_MS,
    backgroundMsLast24h: 90 * MINUTE_MS,
  }))
  t.alike(bothSpent.reasonCodes, ['BACKGROUND_SESSION_BUDGET_EXHAUSTED', 'BACKGROUND_DAILY_BUDGET_EXHAUSTED'])
  t.is(bothSpent.backgroundRemainingSessionMs, 0, 'remaining budgets never go negative')
  t.is(bothSpent.backgroundRemainingDailyMs, 0)

  // A new session resets the session budget without touching the daily one.
  const newSession = evaluateParticipation(healthyDevice({
    foreground: false,
    backgroundMsThisSession: 0,
    backgroundMsLast24h: 30 * MINUTE_MS,
  }))
  t.is(newSession.state, 'uploading')
  t.is(newSession.backgroundRemainingSessionMs, 15 * MINUTE_MS)
  t.is(newSession.backgroundRemainingDailyMs, 30 * MINUTE_MS)
})

test('metered networks suspend contribution and unmetered restores it', (t) => {
  const metered = evaluateParticipation(healthyDevice({ metered: true }))
  t.is(metered.state, 'suspended')
  t.is(metered.peerDiscovery, false)
  t.is(metered.cacheFill, false)
  t.alike(metered.reasonCodes, ['NETWORK_METERED'])

  const unmetered = evaluateParticipation(healthyDevice({ metered: false }))
  t.is(unmetered.state, 'uploading')
  t.alike(unmetered.reasonCodes, [])

  // A signal the device cannot read is not a green light for unsupervised
  // work, but it is also not a reason to stop serving a peer while the viewer
  // is watching: acceptance promises upload during playback outright and names
  // the unmetered condition as a requirement for background work.
  const unknown = evaluateParticipation(healthyDevice({ metered: undefined }))
  t.is(unknown.state, 'uploading', 'an unreadable network cost still serves the watching viewer')
  t.is(unknown.backgroundEligible, false, 'but it never buys unsupervised background work')
  t.alike(unknown.reasonCodes, ['NETWORK_SIGNAL_UNKNOWN'])

  const notABoolean = evaluateParticipation(healthyDevice({ metered: 'unmetered' }))
  t.is(notABoolean.state, 'uploading', 'only the categorical boolean from the OS counts as read')
  t.is(notABoolean.backgroundEligible, false)
  t.alike(notABoolean.reasonCodes, ['NETWORK_SIGNAL_UNKNOWN'])

  const unknownInBackground = evaluateParticipation(healthyDevice({
    metered: undefined,
    foreground: false,
    backgroundPermitted: true,
  }))
  t.is(unknownInBackground.state, 'suspended', 'backgrounded, an unreadable signal stops everything')
})

test('battery floor is 50 percent unless the device is on external power', (t) => {
  const drained = evaluateParticipation(healthyDevice({ batteryPercent: 49, charging: false }))
  t.is(drained.state, 'suspended')
  t.alike(drained.reasonCodes, ['BATTERY_BELOW_FLOOR'])
  t.is(drained.peerDiscovery, true, 'the viewer can still find peers for their own playback')
  t.is(drained.cacheFill, true)

  const atFloor = evaluateParticipation(healthyDevice({ batteryPercent: 50, charging: false }))
  t.is(atFloor.state, 'uploading', 'the floor itself is permitted')
  t.alike(atFloor.reasonCodes, [])

  const drainedButCharging = evaluateParticipation(healthyDevice({ batteryPercent: 3, charging: true }))
  t.is(drainedButCharging.state, 'uploading', 'external power clears the battery floor')
  t.alike(drainedButCharging.reasonCodes, [])

  const healthyOnBattery = evaluateParticipation(healthyDevice({ batteryPercent: 96, charging: false }))
  t.is(healthyOnBattery.state, 'uploading')

  const unknownPower = evaluateParticipation(healthyDevice({ batteryPercent: undefined, charging: undefined }))
  t.is(unknownPower.state, 'uploading', 'battery health is never inferred, and never blocks the watching viewer')
  t.is(unknownPower.backgroundEligible, false, 'unreadable power keeps background work off')
  t.alike(unknownPower.reasonCodes, ['POWER_SIGNAL_UNKNOWN'])

  const unknownBatteryOnBattery = evaluateParticipation(healthyDevice({ batteryPercent: 'high', charging: false }))
  t.is(unknownBatteryOnBattery.state, 'uploading')
  t.is(unknownBatteryOnBattery.backgroundEligible, false)
  t.alike(unknownBatteryOnBattery.reasonCodes, ['POWER_SIGNAL_UNKNOWN'])
})

test('thermal categories come from the OS and an unreadable one stops background work', (t) => {
  for (const thermalState of ['nominal', 'fair']) {
    const cool = evaluateParticipation(healthyDevice({ thermalState }))
    t.is(cool.state, 'uploading', `${thermalState} contributes`)
    t.alike(cool.reasonCodes, [])
  }

  for (const thermalState of ['serious', 'critical']) {
    const hot = evaluateParticipation(healthyDevice({ thermalState }))
    t.is(hot.state, 'suspended', `${thermalState} suspends`)
    t.is(hot.peerDiscovery, false)
    t.alike(hot.reasonCodes, ['THERMAL_PRESSURE'])
  }

  for (const thermalState of [undefined, null, 'unknown', 'warm', 42]) {
    const unknown = evaluateParticipation(healthyDevice({ thermalState }))
    t.is(unknown.state, 'uploading', `${String(thermalState)} still serves the watching viewer`)
    t.is(unknown.backgroundEligible, false, `${String(thermalState)} keeps background work off`)
    t.alike(unknown.reasonCodes, ['THERMAL_SIGNAL_UNKNOWN'])
  }
})

test('free disk floor is the greater of 2 GiB and 10 percent', (t) => {
  // Large disk: the proportional floor binds (10% of 500 GiB = 50 GiB).
  const proportionalShort = evaluateParticipation(healthyDevice({ freeDiskBytes: 50 * GIB - 1, totalDiskBytes: 500 * GIB }))
  t.is(proportionalShort.state, 'suspended')
  t.alike(proportionalShort.reasonCodes, ['DISK_BELOW_FLOOR'])
  t.is(proportionalShort.cacheFill, false)
  t.is(proportionalShort.peerDiscovery, true, 'playback keeps its peers while the cache stops growing')

  const proportionalMet = evaluateParticipation(healthyDevice({ freeDiskBytes: 50 * GIB, totalDiskBytes: 500 * GIB }))
  t.is(proportionalMet.state, 'uploading')
  t.alike(proportionalMet.reasonCodes, [])

  // Small disk: the absolute floor binds (10% of 8 GiB is below 2 GiB).
  const absoluteShort = evaluateParticipation(healthyDevice({ freeDiskBytes: 2 * GIB - 1, totalDiskBytes: 8 * GIB }))
  t.is(absoluteShort.state, 'suspended')
  t.alike(absoluteShort.reasonCodes, ['DISK_BELOW_FLOOR'])

  const absoluteMet = evaluateParticipation(healthyDevice({ freeDiskBytes: 2 * GIB, totalDiskBytes: 8 * GIB }))
  t.is(absoluteMet.state, 'uploading', 'a small disk only owes the absolute floor')

  const unknownDisk = evaluateParticipation(healthyDevice({ freeDiskBytes: undefined }))
  t.is(unknownDisk.state, 'uploading', 'an unreadable disk still serves the watching viewer')
  t.is(unknownDisk.backgroundEligible, false)
  t.alike(unknownDisk.reasonCodes, ['DISK_SIGNAL_UNKNOWN'])

  const unknownTotal = evaluateParticipation(healthyDevice({ totalDiskBytes: undefined }))
  t.is(unknownTotal.state, 'uploading', 'the proportional floor cannot be computed without a total')
  t.is(unknownTotal.backgroundEligible, false, 'so background work stays off')
  t.alike(unknownTotal.reasonCodes, ['DISK_SIGNAL_UNKNOWN'])
})

test('rolling upload quota exhausts and resets', (t) => {
  const belowCeiling = evaluateParticipation(healthyDevice({ uploadedBytesLast24h: 1 * GIB - 1 }))
  t.is(belowCeiling.state, 'uploading')
  t.is(belowCeiling.uploadedBytesLast24h, 1 * GIB - 1)
  t.alike(belowCeiling.reasonCodes, [])

  const atCeiling = evaluateParticipation(healthyDevice({ uploadedBytesLast24h: 1 * GIB }))
  t.is(atCeiling.state, 'suspended')
  t.is(atCeiling.uploadCeilingBytesPer24h, 1 * GIB)
  t.alike(atCeiling.reasonCodes, ['UPLOAD_QUOTA_EXHAUSTED'])
  t.is(atCeiling.peerDiscovery, true, 'the viewer keeps downloading after giving their gigabyte')

  const overCeiling = evaluateParticipation(healthyDevice({ uploadedBytesLast24h: 4 * GIB }))
  t.is(overCeiling.state, 'suspended')
  t.alike(overCeiling.reasonCodes, ['UPLOAD_QUOTA_EXHAUSTED'])

  // The rolling window ages out: the same device with a drained counter resumes.
  const afterRollOff = evaluateParticipation(healthyDevice({ uploadedBytesLast24h: 128 * 1024 * 1024 }))
  t.is(afterRollOff.state, 'uploading')
  t.alike(afterRollOff.reasonCodes, [])

  // An explicit viewer ceiling wins over the mode preset, in both directions.
  const narrowed = evaluateParticipation(healthyDevice({
    uploadCeilingBytesPer24h: 100 * 1024 * 1024,
    uploadedBytesLast24h: 100 * 1024 * 1024,
  }))
  t.is(narrowed.uploadCeilingBytesPer24h, 100 * 1024 * 1024)
  t.is(narrowed.state, 'suspended')
  t.alike(narrowed.reasonCodes, ['UPLOAD_QUOTA_EXHAUSTED'])

  const widened = evaluateParticipation(healthyDevice({
    cacheCeilingBytes: 40 * GIB,
    uploadCeilingBytesPer24h: 4 * GIB,
    uploadedBytesLast24h: 2 * GIB,
  }))
  t.is(widened.cacheCeilingBytes, 40 * GIB)
  t.is(widened.uploadCeilingBytesPer24h, 4 * GIB)
  t.is(widened.state, 'uploading')

  const garbageCeiling = evaluateParticipation(healthyDevice({ uploadCeilingBytesPer24h: -5, cacheCeilingBytes: 'lots' }))
  t.is(garbageCeiling.uploadCeilingBytesPer24h, 1 * GIB, 'an unusable override falls back to the mode preset')
  t.is(garbageCeiling.cacheCeilingBytes, 20 * GIB)
})

test('data saver contributes only while the viewer is actually playing', (t) => {
  t.alike(PARTICIPATION_LIMITS['data-saver'].postPlaybackGraceMs, 0)
  t.alike(PARTICIPATION_LIMITS['data-saver'].backgroundSessionMs, 0)
  t.alike(PARTICIPATION_LIMITS['data-saver'].backgroundPer24hMs, 0)
  t.ok(PARTICIPATION_LIMITS['data-saver'].cacheCeilingBytes < PARTICIPATION_LIMITS.balanced.cacheCeilingBytes)

  const playing = evaluateParticipation(healthyDevice({ mode: 'data-saver' }))
  t.is(playing.state, 'uploading')
  t.is(playing.postPlaybackGraceMs, 0)
  t.is(playing.cacheCeilingBytes, PARTICIPATION_LIMITS['data-saver'].cacheCeilingBytes)
  t.alike(playing.reasonCodes, [])

  const justEnded = evaluateParticipation(healthyDevice({ mode: 'data-saver', playbackActive: false, msSincePlaybackEnded: 0 }))
  t.is(justEnded.state, 'suspended', 'there is no post-play grace in data saver')
  t.alike(justEnded.reasonCodes, ['OUTSIDE_PLAYBACK_WINDOW'])

  const backgrounded = evaluateParticipation(healthyDevice({ mode: 'data-saver', foreground: false }))
  t.is(backgrounded.state, 'suspended', 'data saver never contributes in the background')
  t.is(backgrounded.backgroundEligible, false)
  t.is(backgrounded.backgroundRemainingSessionMs, 0)
  t.is(backgrounded.backgroundRemainingDailyMs, 0)
  t.alike(backgrounded.reasonCodes, ['MODE_BACKGROUND_DISABLED'])
})

test('help more widens ceilings and relaxes no OS or hard gate', (t) => {
  const helpMore = PARTICIPATION_LIMITS['help-more']
  const balanced = PARTICIPATION_LIMITS.balanced
  t.ok(helpMore.cacheCeilingBytes > balanced.cacheCeilingBytes)
  t.ok(helpMore.uploadCeilingBytesPer24h > balanced.uploadCeilingBytesPer24h)
  t.ok(helpMore.outboundBytesPerSecond > balanced.outboundBytesPerSecond)
  t.ok(helpMore.postPlaybackGraceMs > balanced.postPlaybackGraceMs)
  t.ok(helpMore.backgroundSessionMs > balanced.backgroundSessionMs)
  t.ok(helpMore.backgroundPer24hMs > balanced.backgroundPer24hMs)

  const generous = evaluateParticipation(healthyDevice({ mode: 'help-more', uploadedBytesLast24h: 2 * GIB }))
  t.is(generous.state, 'uploading', 'help more keeps going past the balanced upload ceiling')
  t.is(generous.cacheCeilingBytes, helpMore.cacheCeilingBytes)
  t.is(generous.outboundBytesPerSecond, helpMore.outboundBytesPerSecond)

  // Every hard and OS gate still suspends Help More.
  const blockers = [
    [{ userAllowsP2P: false }, 'USER_DECLINED_P2P'],
    [{ metered: true }, 'NETWORK_METERED'],
    [{ thermalState: 'serious' }, 'THERMAL_PRESSURE'],
    [{ thermalState: undefined, foreground: false, backgroundPermitted: true }, 'THERMAL_SIGNAL_UNKNOWN'],
    [{ batteryPercent: 20, charging: false }, 'BATTERY_BELOW_FLOOR'],
    [{ freeDiskBytes: 1 * GIB, totalDiskBytes: 8 * GIB }, 'DISK_BELOW_FLOOR'],
    [{ foreground: false, backgroundPermitted: false }, 'BACKGROUND_NOT_PERMITTED'],
    [{ playbackActive: false, msSincePlaybackEnded: 31 * MINUTE_MS }, 'OUTSIDE_PLAYBACK_WINDOW'],
    [{ uploadedBytesLast24h: 5 * GIB }, 'UPLOAD_QUOTA_EXHAUSTED'],
  ]
  for (const [override, code] of blockers) {
    const blocked = evaluateParticipation(healthyDevice({ mode: 'help-more', ...override }))
    t.is(blocked.state, 'suspended', `help more is suspended by ${code}`)
    t.ok(blocked.reasonCodes.includes(code), `help more reports ${code}`)
  }

  // Help More cannot move a hard limit: the floors are mode-independent.
  t.is(PARTICIPATION_HARD_LIMITS.minBatteryPercent, 50)
  t.is(PARTICIPATION_HARD_LIMITS.minFreeDiskBytes, 2 * GIB)
  t.is(PARTICIPATION_HARD_LIMITS.minFreeDiskFraction, 0.1)
})

test('no participation mode ever creates an archive pledge', (t) => {
  for (const mode of PARTICIPATION_MODES) {
    const unpledged = evaluateParticipation(healthyDevice({ mode }))
    t.is(unpledged.archiving, false, `${mode} does not archive without an opt-in`)
    const explicitlyOff = evaluateParticipation(healthyDevice({ mode, archiveOptIn: false }))
    t.is(explicitlyOff.archiving, false)
  }

  const pledged = evaluateParticipation(healthyDevice({ archiveOptIn: true }))
  t.is(pledged.archiving, true, 'an explicit pledge archives while every gate passes')

  const pledgedButHot = evaluateParticipation(healthyDevice({ archiveOptIn: true, thermalState: 'critical' }))
  t.is(pledgedButHot.archiving, false, 'a pledge never outranks a device gate')

  const pledgedButOutsideWindow = evaluateParticipation(healthyDevice({
    archiveOptIn: true,
    playbackActive: false,
    msSincePlaybackEnded: 11 * MINUTE_MS,
  }))
  t.is(pledgedButOutsideWindow.archiving, false)
})

test('reason codes are canonical, deduplicated, and bounded', (t) => {
  t.is(new Set(PARTICIPATION_REASON_CODES).size, PARTICIPATION_REASON_CODES.length)

  const everythingWrong = evaluateParticipation({
    mode: 'turbo',
    userAllowsP2P: false,
    playbackActive: false,
    msSincePlaybackEnded: 60 * MINUTE_MS,
    foreground: false,
    backgroundPermitted: false,
    metered: true,
    thermalState: 'critical',
    batteryPercent: 2,
    charging: false,
    freeDiskBytes: 0,
    totalDiskBytes: 500 * GIB,
    uploadedBytesLast24h: 100 * GIB,
    backgroundMsThisSession: 99 * MINUTE_MS,
    backgroundMsLast24h: 99 * MINUTE_MS,
  })
  t.is(everythingWrong.mode, 'data-saver', 'an unrecognised mode falls back to the most constrained one')
  t.is(everythingWrong.state, 'suspended')
  t.is(everythingWrong.reasonCodes.length, MAX_PARTICIPATION_REASON_CODES, 'the report is bounded')
  t.alike(everythingWrong.reasonCodes, [
    'USER_DECLINED_P2P',
    'NETWORK_METERED',
    'THERMAL_PRESSURE',
    'BATTERY_BELOW_FLOOR',
    'DISK_BELOW_FLOOR',
    'MODE_BACKGROUND_DISABLED',
    'UPLOAD_QUOTA_EXHAUSTED',
    'OUTSIDE_PLAYBACK_WINDOW',
  ], 'codes come back in canonical order')

  const codes = evaluateParticipation({}).reasonCodes
  for (const code of codes) t.ok(PARTICIPATION_REASON_CODES.includes(code), `${code} is a declared code`)
  t.is(new Set(codes).size, codes.length)
})

test('the decision is pure and tolerates missing or hostile input', (t) => {
  const state = healthyDevice()
  const snapshot = JSON.stringify(state)
  const first = evaluateParticipation(state)
  const second = evaluateParticipation(state)
  t.alike(first, second, 'the same state always yields the same decision')
  t.is(JSON.stringify(state), snapshot, 'the input is never mutated')

  t.alike(Object.keys(first), [
    'mode',
    'state',
    'localPlayback',
    'peerDiscovery',
    'upload',
    'cacheFill',
    'archiving',
    'archiveEligible',
    'uploadEligible',
    'uploading',
    'backgroundEligible',
    'cacheCeilingBytes',
    'uploadCeilingBytesPer24h',
    'uploadedBytesLast24h',
    'outboundBytesPerSecond',
    'postPlaybackGraceMs',
    'backgroundRemainingSessionMs',
    'backgroundRemainingDailyMs',
    'reasonCodes',
  ])

  for (const hostile of [undefined, null, {}, { mode: null }, { mode: 7 }, { foreground: 'yes' }]) {
    const decision = evaluateParticipation(hostile)
    t.is(decision.localPlayback, true)
    t.is(decision.state, 'suspended', 'a state we cannot read contributes nothing')
    t.ok(Number.isSafeInteger(decision.backgroundRemainingSessionMs))
    t.ok(Number.isSafeInteger(decision.backgroundRemainingDailyMs))
    t.ok(Number.isSafeInteger(decision.uploadedBytesLast24h))
  }

  const fractional = evaluateParticipation(healthyDevice({
    uploadedBytesLast24h: 1024.9,
    backgroundMsThisSession: 10.7,
    backgroundMsLast24h: 20.2,
  }))
  t.is(fractional.uploadedBytesLast24h, 1024)
  t.is(fractional.backgroundRemainingSessionMs, 15 * MINUTE_MS - 10)
  t.is(fractional.backgroundRemainingDailyMs, 60 * MINUTE_MS - 20)
})

test('the five-key playback policy is derived from the one decision', (t) => {
  const policy = createPlaybackResourcePolicy()
  const state = healthyDevice({ archiveOptIn: true })
  const participation = evaluateParticipation(state)
  t.alike(policy.evaluate(state), {
    localPlayback: participation.localPlayback,
    peerDiscovery: participation.peerDiscovery,
    upload: participation.upload,
    cacheFill: participation.cacheFill,
    archiving: participation.archiving,
  }, 'the five keys are a projection of evaluateParticipation')

  t.alike(policy.evaluate(healthyDevice({ metered: true })), {
    localPlayback: true,
    peerDiscovery: false,
    upload: false,
    cacheFill: false,
    archiving: false,
  })
})

test('actively uploading means bytes moved, not that a video is playing', (t) => {
  const idleButPlaying = evaluateParticipation(healthyDevice({ recentOutboundBytes: 0 }))
  t.is(idleButPlaying.state, 'eligible', 'a player nobody is pulling from is eligible, not uploading')
  t.is(idleButPlaying.uploading, false)
  t.is(idleButPlaying.uploadEligible, true, 'the transport is still allowed to serve')
  t.is(idleButPlaying.upload, true)
  t.alike(idleButPlaying.reasonCodes, [], 'sending nothing is not a constraint')

  const sending = evaluateParticipation(healthyDevice({ recentOutboundBytes: 1 }))
  t.is(sending.state, 'uploading', 'one measured byte is the difference')
  t.is(sending.uploading, true)

  // Bytes that were never eligible to leave do not promote a suspended device.
  const suspendedButSending = evaluateParticipation(healthyDevice({ metered: true, recentOutboundBytes: 8 * 1024 * 1024 }))
  t.is(suspendedButSending.state, 'suspended')
  t.is(suspendedButSending.uploading, false)

  // An unreadable or nonsensical count is zero, never "probably uploading".
  for (const recentOutboundBytes of [undefined, null, -1, 'lots', Number.NaN, 0.4]) {
    const unreadable = evaluateParticipation(healthyDevice({ recentOutboundBytes }))
    t.is(unreadable.uploading, false, `${String(recentOutboundBytes)} is not evidence of upload`)
    t.is(unreadable.state, 'eligible')
  }
})

test('archive eligibility is a device question, not a playback question', (t) => {
  // A dedicated archivist plays nothing, ever, and has long since left any
  // grace window. It can still hold a pledge.
  const archivist = healthyDevice({
    archiveOptIn: true,
    playbackActive: false,
    msSincePlaybackEnded: undefined,
    recentOutboundBytes: 0,
  })
  const decision = evaluateParticipation(archivist)
  t.is(decision.archiveEligible, true, 'an archivist outside every playback window still qualifies')
  t.is(decision.state, 'suspended')
  t.is(decision.archiving, false, 'the viewer-facing projection still follows the upload window')
  t.alike(decision.reasonCodes, ['OUTSIDE_PLAYBACK_WINDOW'])

  // The rolling upload quota is a serving budget, not a storage one.
  const quotaSpent = evaluateParticipation(healthyDevice({ archiveOptIn: true, uploadedBytesLast24h: 4 * GIB }))
  t.is(quotaSpent.archiveEligible, true)

  // The pledge itself is never assumed.
  t.is(evaluateParticipation(healthyDevice({ archiveOptIn: false })).archiveEligible, false)
  t.is(evaluateParticipation(healthyDevice({ archiveOptIn: undefined })).archiveEligible, false)
  t.is(evaluateParticipation(healthyDevice({ archiveOptIn: 'yes' })).archiveEligible, false)

  // Every device and hard gate still refuses the pledge, unknown included.
  const gates = [
    [{ userAllowsP2P: false }, 'the viewer declined p2p'],
    [{ metered: true }, 'a metered network'],
    [{ metered: undefined }, 'an unknown network'],
    [{ thermalState: 'critical' }, 'thermal pressure'],
    [{ thermalState: undefined }, 'an unknown thermal state'],
    [{ batteryPercent: 20, charging: false }, 'a drained battery'],
    [{ batteryPercent: undefined, charging: undefined }, 'an unknown power state'],
    [{ freeDiskBytes: 1 * GIB, totalDiskBytes: 8 * GIB }, 'a starved disk'],
    [{ freeDiskBytes: undefined }, 'an unknown disk'],
  ]
  for (const [override, label] of gates) {
    const blocked = evaluateParticipation(healthyDevice({ archiveOptIn: true, ...override }))
    t.is(blocked.archiveEligible, false, `${label} refuses the pledge`)
  }
})

test('foreground is categorical: only an explicit true is foreground', (t) => {
  // Data Saver disables background work entirely, so the lifecycle reading is
  // the only thing that decides this device's fate.
  const inForeground = evaluateParticipation(healthyDevice({ mode: 'data-saver', foreground: true }))
  t.is(inForeground.state, 'uploading')
  t.alike(inForeground.reasonCodes, [])

  for (const foreground of [undefined, null, 'true', 1, {}]) {
    const unknown = evaluateParticipation(healthyDevice({ mode: 'data-saver', foreground }))
    t.is(unknown.state, 'suspended', `${String(foreground)} is not a foreground signal`)
    t.alike(unknown.reasonCodes, ['MODE_BACKGROUND_DISABLED'])
  }

  // The same rule in Balanced: an unreadable lifecycle answers to the
  // background gates rather than skipping them.
  const unknownWithoutPermission = evaluateParticipation(healthyDevice({ foreground: undefined, backgroundPermitted: false }))
  t.is(unknownWithoutPermission.state, 'suspended')
  t.alike(unknownWithoutPermission.reasonCodes, ['BACKGROUND_NOT_PERMITTED'])

  const unknownWithPermission = evaluateParticipation(healthyDevice({ foreground: undefined }))
  t.is(unknownWithPermission.state, 'uploading', 'permitted background work still runs')
  t.is(unknownWithPermission.backgroundEligible, true)
})
