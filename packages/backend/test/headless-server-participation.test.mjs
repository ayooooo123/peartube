import test from 'brittle'

import {
  PARTICIPATION_HARD_LIMITS,
  evaluateParticipation,
} from '../src/playback/resource-policy.js'

const GIB = 1024 * 1024 * 1024

// A headless relay as it really reports itself: it can measure its disk and
// nothing else. No battery exists to read, no thermal throttle is exposed to
// it, its link is not metered, nothing is watching it, and it is not waiting
// for anyone to press play.
function headlessServer(overrides = {}) {
  return {
    hostKind: 'server',
    mode: 'balanced',
    userAllowsP2P: true,
    freeDiskBytes: 400 * GIB,
    totalDiskBytes: 1000 * GIB,
    archiveOptIn: true,
    ...overrides,
  }
}

// The same absent signals on a viewer's device, which is a different fact: a
// phone has a battery and a thermal envelope, so silence there means unread.
function silentDevice(overrides = {}) {
  return {
    mode: 'balanced',
    userAllowsP2P: true,
    freeDiskBytes: 400 * GIB,
    totalDiskBytes: 1000 * GIB,
    archiveOptIn: true,
    ...overrides,
  }
}

test('a headless server may take archive custody without device signals', t => {
  const decision = evaluateParticipation(headlessServer())
  t.is(decision.archiveEligible, true, 'a relay that opted in can promise durable storage')
  t.is(decision.upload, true, 'a relay serves without waiting for a playback window')
  t.is(decision.state, 'eligible')
  t.alike(decision.reasonCodes, [], 'signals a server does not have are not reported as constraints')
})

test('the same silence on a viewer device still fails closed', t => {
  const decision = evaluateParticipation(silentDevice())
  t.is(decision.archiveEligible, false, 'an unread signal is not a not-applicable one')
  t.ok(decision.reasonCodes.includes('NETWORK_SIGNAL_UNKNOWN'))
  t.ok(decision.reasonCodes.includes('THERMAL_SIGNAL_UNKNOWN'))
  t.ok(decision.reasonCodes.includes('POWER_SIGNAL_UNKNOWN'))
})

test('a server still answers to the signals it can actually read', t => {
  const full = evaluateParticipation(headlessServer({
    freeDiskBytes: 1 * GIB,
    totalDiskBytes: 1000 * GIB,
  }))
  t.is(full.archiveEligible, false, 'disk is a real constraint on a server')
  t.ok(full.reasonCodes.includes('DISK_BELOW_FLOOR'))

  const unmeasured = evaluateParticipation(headlessServer({
    freeDiskBytes: undefined,
    totalDiskBytes: undefined,
  }))
  t.is(unmeasured.archiveEligible, false, 'a host that has a disk must report it')
  t.ok(unmeasured.reasonCodes.includes('DISK_SIGNAL_UNKNOWN'))
})

test('an explicitly reported bad signal still stops a server', t => {
  const metered = evaluateParticipation(headlessServer({ metered: true }))
  t.is(metered.archiveEligible, false, 'an operator reporting a metered uplink is believed')
  t.ok(metered.reasonCodes.includes('NETWORK_METERED'))

  const hot = evaluateParticipation(headlessServer({ thermalState: 'critical' }))
  t.is(hot.archiveEligible, false)
  t.ok(hot.reasonCodes.includes('THERMAL_PRESSURE'))

  const flat = evaluateParticipation(headlessServer({
    batteryPercent: PARTICIPATION_HARD_LIMITS.minBatteryPercent - 1,
  }))
  t.is(flat.archiveEligible, false, 'a server on a UPS that reports a flat battery is believed')
  t.ok(flat.reasonCodes.includes('BATTERY_BELOW_FLOOR'))
})

test('permission and the operator quota still bind a server', t => {
  const declined = evaluateParticipation(headlessServer({ userAllowsP2P: false }))
  t.is(declined.archiveEligible, false)
  t.is(declined.upload, false)
  t.ok(declined.reasonCodes.includes('USER_DECLINED_P2P'))

  const exhausted = evaluateParticipation(headlessServer({
    uploadCeilingBytesPer24h: 10 * GIB,
    uploadedBytesLast24h: 10 * GIB,
  }))
  t.is(exhausted.upload, false, 'the operator ceiling is a real ceiling')
  t.ok(exhausted.reasonCodes.includes('UPLOAD_QUOTA_EXHAUSTED'))
  t.is(exhausted.archiveEligible, true,
    'custody already promised is storage, not upload quota')
})

test('a server never reports the lifecycle constraints it cannot have', t => {
  const decision = evaluateParticipation(headlessServer({
    backgroundPermitted: false,
    backgroundMsThisSession: 24 * 60 * 60 * 1000,
    backgroundMsLast24h: 24 * 60 * 60 * 1000,
  }))
  t.is(decision.upload, true, 'a viewer-device background budget cannot suspend a relay')
  t.is(decision.backgroundEligible, true)
  t.absent(decision.reasonCodes.includes('BACKGROUND_NOT_PERMITTED'))
  t.absent(decision.reasonCodes.includes('BACKGROUND_SESSION_BUDGET_EXHAUSTED'))
  t.absent(decision.reasonCodes.includes('OUTSIDE_PLAYBACK_WINDOW'))
})

test('a full disk stops a server writing without silencing what it holds', t => {
  const decision = evaluateParticipation(headlessServer({
    freeDiskBytes: 1 * GIB,
    totalDiskBytes: 1000 * GIB,
  }))
  t.ok(decision.reasonCodes.includes('DISK_BELOW_FLOOR'))
  t.is(decision.archiveEligible, false, 'no new custody on a full volume')
  t.is(decision.archiving, false)
  t.is(decision.cacheFill, false, 'and it stops pulling new bytes down')
  t.is(decision.upload, true,
    'but serving a block it already holds is a read, and freeing nothing by refusing')
})

test('a viewer device still treats a full disk as one constraint', t => {
  const decision = evaluateParticipation({
    mode: 'balanced',
    userAllowsP2P: true,
    playbackActive: true,
    foreground: true,
    backgroundPermitted: true,
    metered: false,
    thermalState: 'nominal',
    charging: true,
    freeDiskBytes: 1 * GIB,
    totalDiskBytes: 1000 * GIB,
  })
  t.ok(decision.reasonCodes.includes('DISK_BELOW_FLOOR'))
  t.is(decision.upload, false,
    'a phone uploads the bytes it cached while watching, so the disk governs both')
})

test('a server keeps the absolute disk floor and drops the phone percentage', t => {
  // 4 TB array, 300 GB free: over the 2 GiB machine floor, under a tenth of the
  // volume. Filling this disk is the whole point of the box.
  const big = { freeDiskBytes: 300 * GIB, totalDiskBytes: 4000 * GIB }
  t.is(evaluateParticipation(headlessServer(big)).archiveEligible, true,
    'an archive host may use the storage its operator bought to donate')

  const device = evaluateParticipation({
    mode: 'balanced',
    userAllowsP2P: true,
    playbackActive: true,
    foreground: true,
    backgroundPermitted: true,
    metered: false,
    thermalState: 'nominal',
    charging: true,
    archiveOptIn: true,
    ...big,
  })
  t.is(device.archiveEligible, false, 'a personal machine still keeps a tenth of itself free')
  t.ok(device.reasonCodes.includes('DISK_BELOW_FLOOR'))

  t.is(evaluateParticipation(headlessServer({ freeDiskBytes: 1 * GIB, totalDiskBytes: 4000 * GIB })).archiveEligible,
    false, 'the floor that protects the machine itself still binds a server')
})

test('archive custody still requires the opt-in on a server', t => {
  const decision = evaluateParticipation(headlessServer({ archiveOptIn: false }))
  t.is(decision.archiveEligible, false, 'being a relay is not itself a pledge')
  t.is(decision.upload, true, 'and refusing pledges does not stop it serving')
})
