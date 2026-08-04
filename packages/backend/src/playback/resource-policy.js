const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024
const MINUTE_MS = 60 * 1000

/**
 * Participation modes offered to viewers. Balanced is what a fresh install
 * selects; the other two are the deliberate "less" and "more" choices.
 */
export const PARTICIPATION_MODES = Object.freeze(['data-saver', 'balanced', 'help-more'])

export const DEFAULT_PARTICIPATION_MODE = 'balanced'

/**
 * A mode string we do not recognise never widens anything: it falls back to the
 * most constrained mode and is reported through MODE_UNRECOGNIZED.
 */
const MOST_CONSTRAINED_PARTICIPATION_MODE = 'data-saver'

/**
 * User-facing ceilings per mode. These are the only values a mode may move.
 * Data Saver contributes exclusively while the viewer is actually playing: its
 * post-playback grace and background budgets are zero. Help More widens the
 * user-facing ceilings and nothing else.
 */
export const PARTICIPATION_LIMITS = Object.freeze({
  'data-saver': Object.freeze({
    cacheCeilingBytes: 4 * GIB,
    uploadCeilingBytesPer24h: 256 * MIB,
    outboundBytesPerSecond: 250000,
    postPlaybackGraceMs: 0,
    backgroundSessionMs: 0,
    backgroundPer24hMs: 0,
  }),
  balanced: Object.freeze({
    cacheCeilingBytes: 20 * GIB,
    uploadCeilingBytesPer24h: 1 * GIB,
    outboundBytesPerSecond: 625000,
    postPlaybackGraceMs: 10 * MINUTE_MS,
    backgroundSessionMs: 15 * MINUTE_MS,
    backgroundPer24hMs: 60 * MINUTE_MS,
  }),
  'help-more': Object.freeze({
    cacheCeilingBytes: 100 * GIB,
    uploadCeilingBytesPer24h: 5 * GIB,
    outboundBytesPerSecond: 1250000,
    postPlaybackGraceMs: 30 * MINUTE_MS,
    backgroundSessionMs: 60 * MINUTE_MS,
    backgroundPer24hMs: 240 * MINUTE_MS,
  }),
})

/**
 * Device floors that no mode and no user preference may relax. The free-disk
 * floor is the greater of the absolute and the proportional value.
 */
export const PARTICIPATION_HARD_LIMITS = Object.freeze({
  minBatteryPercent: 50,
  minFreeDiskBytes: 2 * GIB,
  minFreeDiskFraction: 0.1,
})

/**
 * Canonical order for every constraint the decision can report. Reported codes
 * are deduplicated, sorted by this order, and capped at
 * MAX_PARTICIPATION_REASON_CODES entries.
 */
export const PARTICIPATION_REASON_CODES = Object.freeze([
  'USER_DECLINED_P2P',
  'NETWORK_METERED',
  'NETWORK_SIGNAL_UNKNOWN',
  'THERMAL_PRESSURE',
  'THERMAL_SIGNAL_UNKNOWN',
  'BATTERY_BELOW_FLOOR',
  'POWER_SIGNAL_UNKNOWN',
  'DISK_BELOW_FLOOR',
  'DISK_SIGNAL_UNKNOWN',
  'BACKGROUND_NOT_PERMITTED',
  'BACKGROUND_SESSION_BUDGET_EXHAUSTED',
  'BACKGROUND_DAILY_BUDGET_EXHAUSTED',
  'MODE_BACKGROUND_DISABLED',
  'UPLOAD_QUOTA_EXHAUSTED',
  'OUTSIDE_PLAYBACK_WINDOW',
  'MODE_UNRECOGNIZED',
])

export const MAX_PARTICIPATION_REASON_CODES = 8

const REASON_RANK = new Map(PARTICIPATION_REASON_CODES.map((code, index) => [code, index]))

/** OS thermal categories that permit contribution. */
const PERMISSIVE_THERMAL_STATES = new Set(['nominal', 'fair'])

/** OS thermal categories that block contribution outright. */
const BLOCKING_THERMAL_STATES = new Set(['serious', 'critical'])

/**
 * The legacy five-key evaluate() predates categorical device signals. Callers
 * that omit a signal keep their historical behaviour, so the adapter fills the
 * gaps here instead of letting evaluateParticipation see an unknown signal.
 * New code MUST call evaluateParticipation with real OS signals, where an
 * unknown signal is always treated as constrained.
 */
const LEGACY_SIGNAL_DEFAULTS = Object.freeze({
  thermalState: 'nominal',
  metered: false,
  // The smallest disk that still clears the free-disk floor.
  freeDiskBytes: PARTICIPATION_HARD_LIMITS.minFreeDiskBytes,
  totalDiskBytes: PARTICIPATION_HARD_LIMITS.minFreeDiskBytes,
  // Legacy callers never reported OS background permission, and permission is
  // never assumed: backgrounded legacy state contributes nothing.
  backgroundPermitted: false,
  playbackActive: true,
  // The five-key shape only ever reported backgrounding explicitly; an omitted
  // lifecycle kept its historical foreground reading.
  foreground: true,
})

function boundedInteger(value, name, fallback) {
  const next = value == null ? fallback : Number(value)
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${name} must be a non-negative integer`)
  return next
}

function nonNegativeCount(value) {
  const next = Number(value)
  if (!Number.isFinite(next) || next < 0) return null
  return Math.floor(next)
}

function finitePercent(value) {
  const next = Number(value)
  if (!Number.isFinite(next)) return null
  return next
}

/**
 * A ceiling the viewer set explicitly in Developer Settings outranks the mode
 * preset. Only the two user-facing byte ceilings can be overridden this way,
 * and only when the override is a usable non-negative integer.
 */
function effectiveCeiling(value, modeDefault) {
  const next = nonNegativeCount(value)
  return next === null ? modeDefault : next
}

function resolveMode(value) {
  if (value == null) return { mode: DEFAULT_PARTICIPATION_MODE, unrecognized: false }
  if (PARTICIPATION_MODES.includes(value)) return { mode: value, unrecognized: false }
  return { mode: MOST_CONSTRAINED_PARTICIPATION_MODE, unrecognized: true }
}

function orderReasonCodes(codes) {
  return [...new Set(codes)]
    .filter(code => REASON_RANK.has(code))
    .sort((left, right) => REASON_RANK.get(left) - REASON_RANK.get(right))
    .slice(0, MAX_PARTICIPATION_REASON_CODES)
}

// How much of a volume must stay free before this host takes on anything more.
// The absolute minimum protects the machine itself. The percentage on top of it
// is a courtesy to the person using the device — a phone that reports 90% full
// feels full — and a dedicated archive host is not a phone: filling its volume
// is its job, and reserving a tenth of a 4 TB array would cost 400 GB of the
// storage the operator bought to donate.
function freeDiskFloor(totalDiskBytes, server) {
  if (server) return PARTICIPATION_HARD_LIMITS.minFreeDiskBytes
  return Math.max(
    PARTICIPATION_HARD_LIMITS.minFreeDiskBytes,
    Math.ceil(totalDiskBytes * PARTICIPATION_HARD_LIMITS.minFreeDiskFraction),
  )
}

/**
 * The single participation decision. Pure: no clock, no I/O, no module state.
 * Elapsed time arrives as msSincePlaybackEnded and the background counters,
 * measured outbound traffic arrives as recentOutboundBytes, and every
 * categorical signal is taken verbatim from the OS — an absent or unrecognised
 * signal is constrained, never permissive.
 *
 * `hostKind` names what kind of machine this is, because the constraint set is
 * genuinely different. A `'device'` (the default) is a viewer's phone, tablet
 * or laptop: it has a battery, a thermal envelope, a link that may be metered,
 * an app lifecycle that backgrounds it, and a playback window that says when
 * the viewer asked for any of this. A `'server'` is a headless relay or seeder
 * whose whole job is to serve: it has none of those. That is not a machine
 * failing to read its signals — it is a machine those signals do not describe,
 * and the difference matters, because an unread signal must keep failing
 * closed. A server still answers to user permission, to measured free disk,
 * and to the operator's own ceilings; an explicitly reported bad signal still
 * stops it.
 */
export function evaluateParticipation(state = {}) {
  const source = state == null ? {} : state
  const resolved = resolveMode(source.mode)
  const mode = resolved.mode
  const limits = PARTICIPATION_LIMITS[mode]
  // The two user-facing byte ceilings may be overridden by an explicit viewer
  // setting; everything else about a mode is fixed, and no override touches a
  // hard or OS gate.
  const cacheCeilingBytes = effectiveCeiling(source.cacheCeilingBytes, limits.cacheCeilingBytes)
  const uploadCeilingBytesPer24h = effectiveCeiling(source.uploadCeilingBytesPer24h, limits.uploadCeilingBytesPer24h)
  const reasons = []
  if (resolved.unrecognized) reasons.push('MODE_UNRECOGNIZED')

  // A headless server has no battery, no thermal throttle, no metered link, no
  // app lifecycle and no playback window. Absent values for those are
  // not-applicable here, never "unread".
  const server = source.hostKind === 'server'

  const permissionOk = source.userAllowsP2P !== false
  if (!permissionOk) reasons.push('USER_DECLINED_P2P')

  // Each OS signal resolves to one of three answers, and the difference
  // matters: a signal that is READ and comes back bad stops every kind of
  // contribution, while a signal this device cannot read at all only stops the
  // opportunistic background work. Acceptance promises upload during playback
  // and its grace window outright, and names the unmetered/thermal/power/disk
  // conditions as requirements for background work — so an unreadable signal
  // is never a green light for unsupervised work, and never a reason to refuse
  // to serve a peer while the viewer is watching.
  let networkBlocked = false
  let networkKnown = false
  if (source.metered === false || (server && source.metered == null)) networkKnown = true
  else if (source.metered === true) { networkBlocked = true; reasons.push('NETWORK_METERED') }
  else reasons.push('NETWORK_SIGNAL_UNKNOWN')

  let thermalBlocked = false
  let thermalKnown = false
  const thermalState = typeof source.thermalState === 'string' ? source.thermalState : null
  if (thermalState !== null && PERMISSIVE_THERMAL_STATES.has(thermalState)) thermalKnown = true
  else if (thermalState !== null && BLOCKING_THERMAL_STATES.has(thermalState)) { thermalBlocked = true; reasons.push('THERMAL_PRESSURE') }
  else if (server && thermalState === null) thermalKnown = true
  else reasons.push('THERMAL_SIGNAL_UNKNOWN')

  const batteryPercent = finitePercent(source.batteryPercent)
  let powerBlocked = false
  let powerKnown = false
  if (source.charging === true) powerKnown = true
  else if (batteryPercent === null) {
    if (server && source.charging == null) powerKnown = true
    else reasons.push('POWER_SIGNAL_UNKNOWN')
  }
  else if (batteryPercent < PARTICIPATION_HARD_LIMITS.minBatteryPercent) { powerBlocked = true; reasons.push('BATTERY_BELOW_FLOOR') }
  else powerKnown = true

  const freeDiskBytes = nonNegativeCount(source.freeDiskBytes)
  const totalDiskBytes = nonNegativeCount(source.totalDiskBytes)
  let diskBlocked = false
  let diskKnown = false
  if (freeDiskBytes === null || totalDiskBytes === null) reasons.push('DISK_SIGNAL_UNKNOWN')
  else if (freeDiskBytes < freeDiskFloor(totalDiskBytes, server)) { diskBlocked = true; reasons.push('DISK_BELOW_FLOOR') }
  else diskKnown = true

  const playbackActive = source.playbackActive === true
  const msSincePlaybackEnded = nonNegativeCount(source.msSincePlaybackEnded)
  const withinGrace = limits.postPlaybackGraceMs > 0 &&
    msSincePlaybackEnded !== null &&
    msSincePlaybackEnded <= limits.postPlaybackGraceMs
  // A server is not waiting for anyone to press play; serving continuously is
  // the whole point of it.
  const windowOk = server || playbackActive || withinGrace
  if (!windowOk) reasons.push('OUTSIDE_PLAYBACK_WINDOW')

  const uploadedBytesLast24h = nonNegativeCount(source.uploadedBytesLast24h) ?? 0
  const quotaOk = uploadedBytesLast24h < uploadCeilingBytesPer24h
  if (!quotaOk) reasons.push('UPLOAD_QUOTA_EXHAUSTED')

  // "Actively uploading" is a measurement, not a guess: it means bytes left
  // this device recently. A player that is eligible but sending nothing is
  // eligible, not uploading.
  const recentOutboundBytes = nonNegativeCount(source.recentOutboundBytes) ?? 0

  const backgroundRemainingSessionMs = Math.max(
    0,
    limits.backgroundSessionMs - (nonNegativeCount(source.backgroundMsThisSession) ?? 0),
  )
  const backgroundRemainingDailyMs = Math.max(
    0,
    limits.backgroundPer24hMs - (nonNegativeCount(source.backgroundMsLast24h) ?? 0),
  )
  const backgroundBlockers = []
  if (limits.backgroundSessionMs <= 0 || limits.backgroundPer24hMs <= 0) {
    backgroundBlockers.push('MODE_BACKGROUND_DISABLED')
  } else {
    if (source.backgroundPermitted !== true) backgroundBlockers.push('BACKGROUND_NOT_PERMITTED')
    if (backgroundRemainingSessionMs <= 0) backgroundBlockers.push('BACKGROUND_SESSION_BUDGET_EXHAUSTED')
    if (backgroundRemainingDailyMs <= 0) backgroundBlockers.push('BACKGROUND_DAILY_BUDGET_EXHAUSTED')
  }
  const backgroundWorkOk = backgroundBlockers.length === 0
  // Foreground is a categorical signal like every other: only an explicit
  // boolean counts, and anything we cannot read is treated as backgrounded so
  // an unknown lifecycle never buys unsupervised work.
  const foreground = source.foreground === true
  // Background constraints only block while the app is actually backgrounded,
  // and a server is never "backgrounded" — nothing is in front of it.
  if (!server && !foreground) reasons.push(...backgroundBlockers)

  // A signal the device reported as bad stops what it is about. Fetching for
  // the viewer's own playback answers to the network and thermal signals;
  // taking on more storage additionally answers to power and disk.
  const fetchBlocked = networkBlocked || thermalBlocked
  const contributionBlocked = fetchBlocked || powerBlocked || diskBlocked
  // Serving a block is a read. A full disk is a reason to stop writing, never a
  // reason to stop reading, and on a server the two come apart: its uploads are
  // pure reads of bytes it already holds, so silencing a nearly-full relay
  // would delete availability from the network and free not one byte. On a
  // viewer's device the same bytes arrive by caching what it watches, so there
  // the disk still governs both.
  const uploadBlocked = server ? (fetchBlocked || powerBlocked) : contributionBlocked
  // Unsupervised work additionally requires every one of those signals to have
  // actually been read.
  const allSignalsKnown = networkKnown && thermalKnown && powerKnown && diskKnown

  const runnable = server || foreground || (backgroundWorkOk && allSignalsKnown)
  // Discovery and cache fill serve the viewer's own playback, so they answer to
  // the device signals but not to the contribution budgets.
  const peerDiscovery = permissionOk && !fetchBlocked && runnable
  const cacheFill = peerDiscovery && !diskBlocked
  const contributionOk = permissionOk && !uploadBlocked && windowOk && quotaOk
  const uploadEligible = contributionOk && runnable
  const uploading = uploadEligible && recentOutboundBytes > 0
  const backgroundEligible = permissionOk && !contributionBlocked && allSignalsKnown &&
    (server || backgroundWorkOk) && windowOk && quotaOk
  // Archiving is custody: it writes, so it answers to the disk even where
  // serving does not.
  const archiving = uploadEligible && !contributionBlocked && source.archiveOptIn === true
  // An archive pledge is an unattended storage commitment, not a viewing side
  // effect: a dedicated archivist that never plays anything still qualifies,
  // and — because nobody is watching it — every device signal must have been
  // read and come back good, not merely not-bad.
  const archiveEligible = permissionOk && !contributionBlocked && allSignalsKnown && source.archiveOptIn === true

  return {
    mode,
    state: uploading ? 'uploading' : uploadEligible ? 'eligible' : 'suspended',
    localPlayback: true,
    peerDiscovery,
    upload: uploadEligible,
    cacheFill,
    archiving,
    archiveEligible,
    uploadEligible,
    uploading,
    backgroundEligible,
    cacheCeilingBytes,
    uploadCeilingBytesPer24h,
    uploadedBytesLast24h,
    outboundBytesPerSecond: limits.outboundBytesPerSecond,
    postPlaybackGraceMs: limits.postPlaybackGraceMs,
    backgroundRemainingSessionMs,
    backgroundRemainingDailyMs,
    reasonCodes: orderReasonCodes(reasons),
  }
}

export function createPlaybackResourcePolicy(options = {}) {
  const limits = {
    maxPeers: boundedInteger(options.maxPeers, 'maxPeers', 8),
    maxRequests: boundedInteger(options.maxRequests, 'maxRequests', 16),
    maxInFlightBytes: boundedInteger(options.maxInFlightBytes, 'maxInFlightBytes', 64 * 1024 * 1024),
    maxDiskBytes: boundedInteger(options.maxDiskBytes, 'maxDiskBytes', 512 * 1024 * 1024),
    deadlineMs: boundedInteger(options.deadlineMs, 'deadlineMs', 15000),
  }

  return {
    limits() {
      return { ...limits }
    },
    evaluate(state = {}) {
      const source = state == null ? {} : state
      const participation = evaluateParticipation({
        ...source,
        thermalState: source.thermalState ?? LEGACY_SIGNAL_DEFAULTS.thermalState,
        metered: source.metered ?? LEGACY_SIGNAL_DEFAULTS.metered,
        // Legacy state carried external power as a single boolean, and it gated
        // upload exactly the way the battery floor does now.
        batteryPercent: source.batteryPercent ??
          (source.charging === false ? 0 : PARTICIPATION_HARD_LIMITS.minBatteryPercent),
        freeDiskBytes: source.freeDiskBytes ?? LEGACY_SIGNAL_DEFAULTS.freeDiskBytes,
        totalDiskBytes: source.totalDiskBytes ?? LEGACY_SIGNAL_DEFAULTS.totalDiskBytes,
        backgroundPermitted: source.backgroundPermitted ?? LEGACY_SIGNAL_DEFAULTS.backgroundPermitted,
        playbackActive: source.playbackActive ?? LEGACY_SIGNAL_DEFAULTS.playbackActive,
        foreground: source.foreground ?? LEGACY_SIGNAL_DEFAULTS.foreground,
        // The pledge is never assumed: an archive commitment needs the same
        // explicit opt-in here as anywhere else, and it is owned by the archive
        // policy, which reads evaluateParticipation() with the real opt-in.
        archiveOptIn: source.archiveOptIn === true,
      })
      return {
        localPlayback: participation.localPlayback,
        peerDiscovery: participation.peerDiscovery,
        upload: participation.upload,
        cacheFill: participation.cacheFill,
        archiving: participation.archiving,
      }
    },
  }
}
