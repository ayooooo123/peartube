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
function evaluateNetworkSignal (source, server, reasons) {
  if (source.metered === false || (server && source.metered == null)) {
    return { blocked: false, known: true }
  }
  if (source.metered === true) {
    reasons.push('NETWORK_METERED')
    return { blocked: true, known: false }
  }
  reasons.push('NETWORK_SIGNAL_UNKNOWN')
  return { blocked: false, known: false }
}

function evaluateThermalSignal (source, server, reasons) {
  const thermalState = typeof source.thermalState === 'string' ? source.thermalState : null
  if (thermalState !== null && PERMISSIVE_THERMAL_STATES.has(thermalState)) {
    return { blocked: false, known: true }
  }
  if (thermalState !== null && BLOCKING_THERMAL_STATES.has(thermalState)) {
    reasons.push('THERMAL_PRESSURE')
    return { blocked: true, known: false }
  }
  if (server && thermalState === null) {
    return { blocked: false, known: true }
  }
  reasons.push('THERMAL_SIGNAL_UNKNOWN')
  return { blocked: false, known: false }
}

function evaluatePowerSignal (source, server, reasons) {
  if (source.charging === true) return { blocked: false, known: true }
  const batteryPercent = finitePercent(source.batteryPercent)
  if (batteryPercent === null) {
    if (server && source.charging == null) return { blocked: false, known: true }
    reasons.push('POWER_SIGNAL_UNKNOWN')
    return { blocked: false, known: false }
  }
  if (batteryPercent < PARTICIPATION_HARD_LIMITS.minBatteryPercent) {
    reasons.push('BATTERY_BELOW_FLOOR')
    return { blocked: true, known: false }
  }
  return { blocked: false, known: true }
}

function evaluateDiskSignal (source, server, reasons) {
  const freeDiskBytes = nonNegativeCount(source.freeDiskBytes)
  const totalDiskBytes = nonNegativeCount(source.totalDiskBytes)
  if (freeDiskBytes === null || totalDiskBytes === null) {
    reasons.push('DISK_SIGNAL_UNKNOWN')
    return { blocked: false, known: false }
  }
  if (freeDiskBytes < freeDiskFloor(totalDiskBytes, server)) {
    reasons.push('DISK_BELOW_FLOOR')
    return { blocked: true, known: false }
  }
  return { blocked: false, known: true }
}

function evaluatePlaybackWindow (source, limits, server, reasons) {
  const playbackActive = source.playbackActive === true
  const msSincePlaybackEnded = nonNegativeCount(source.msSincePlaybackEnded)
  const withinGrace = limits.postPlaybackGraceMs > 0 &&
    msSincePlaybackEnded !== null &&
    msSincePlaybackEnded <= limits.postPlaybackGraceMs
  const windowOk = server || playbackActive || withinGrace
  if (!windowOk) reasons.push('OUTSIDE_PLAYBACK_WINDOW')
  return windowOk
}

function evaluateBackgroundBudgets (source, limits) {
  const backgroundRemainingSessionMs = Math.max(
    0,
    limits.backgroundSessionMs - (nonNegativeCount(source.backgroundMsThisSession) ?? 0),
  )
  const backgroundRemainingDailyMs = Math.max(
    0,
    limits.backgroundPer24hMs - (nonNegativeCount(source.backgroundMsLast24h) ?? 0),
  )
  const blockers = []
  if (limits.backgroundSessionMs <= 0 || limits.backgroundPer24hMs <= 0) {
    blockers.push('MODE_BACKGROUND_DISABLED')
  } else {
    if (source.backgroundPermitted !== true) blockers.push('BACKGROUND_NOT_PERMITTED')
    if (backgroundRemainingSessionMs <= 0) blockers.push('BACKGROUND_SESSION_BUDGET_EXHAUSTED')
    if (backgroundRemainingDailyMs <= 0) blockers.push('BACKGROUND_DAILY_BUDGET_EXHAUSTED')
  }
  return {
    remainingSessionMs: backgroundRemainingSessionMs,
    remainingDailyMs: backgroundRemainingDailyMs,
    blockers,
  }
}

function isParticipationRunnable ({ server, foreground, backgroundWorkOk, allSignalsKnown }) {
  if (server || foreground) return true
  return backgroundWorkOk && allSignalsKnown
}

function isUploadBlocked ({ server, fetchBlocked, powerBlocked, contributionBlocked }) {
  return server ? (fetchBlocked || powerBlocked) : contributionBlocked
}

function resolveUploadFlags ({
  permissionOk,
  uploadBlocked,
  windowOk,
  quotaOk,
  runnable,
  recentOutboundBytes,
}) {
  const contributionOk = permissionOk && !uploadBlocked && windowOk && quotaOk
  const uploadEligible = contributionOk && runnable
  const uploading = uploadEligible && recentOutboundBytes > 0
  return { uploadEligible, uploading }
}

function isBackgroundEligible ({
  permissionOk,
  contributionBlocked,
  allSignalsKnown,
  server,
  backgroundWorkOk,
  windowOk,
  quotaOk,
}) {
  if (!permissionOk || contributionBlocked || !allSignalsKnown || !windowOk || !quotaOk) {
    return false
  }
  return server || backgroundWorkOk
}

function resolveArchiveFlags ({
  permissionOk,
  contributionBlocked,
  allSignalsKnown,
  uploadEligible,
  archiveOptIn,
}) {
  if (archiveOptIn !== true || !permissionOk || contributionBlocked) {
    return { archiving: false, archiveEligible: false }
  }
  return {
    archiving: uploadEligible,
    archiveEligible: allSignalsKnown,
  }
}

function isAcquisitionUnconstrained (state) {
  if (state.metered === true) return false
  return state.thermalState !== 'serious' && state.thermalState !== 'critical'
}

function participationStateName (uploading, uploadEligible) {
  if (uploading) return 'uploading'
  if (uploadEligible) return 'eligible'
  return 'suspended'
}

function buildParticipationDecision ({
  mode,
  limits,
  peerDiscovery,
  cacheFill,
  archiving,
  archiveEligible,
  uploadEligible,
  uploading,
  backgroundEligible,
  cacheCeilingBytes,
  uploadCeilingBytesPer24h,
  uploadedBytesLast24h,
  background,
  reasons,
}) {
  return {
    mode,
    state: participationStateName(uploading, uploadEligible),
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
    backgroundRemainingSessionMs: background.remainingSessionMs,
    backgroundRemainingDailyMs: background.remainingDailyMs,
    reasonCodes: orderReasonCodes(reasons),
  }
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
  const cacheCeilingBytes = effectiveCeiling(source.cacheCeilingBytes, limits.cacheCeilingBytes)
  const uploadCeilingBytesPer24h = effectiveCeiling(source.uploadCeilingBytesPer24h, limits.uploadCeilingBytesPer24h)
  const reasons = []
  if (resolved.unrecognized) reasons.push('MODE_UNRECOGNIZED')

  const server = source.hostKind === 'server'
  const permissionOk = source.userAllowsP2P !== false
  if (!permissionOk) reasons.push('USER_DECLINED_P2P')

  const network = evaluateNetworkSignal(source, server, reasons)
  const thermal = evaluateThermalSignal(source, server, reasons)
  const power = evaluatePowerSignal(source, server, reasons)
  const disk = evaluateDiskSignal(source, server, reasons)

  const windowOk = evaluatePlaybackWindow(source, limits, server, reasons)

  const uploadedBytesLast24h = nonNegativeCount(source.uploadedBytesLast24h) ?? 0
  const quotaOk = uploadedBytesLast24h < uploadCeilingBytesPer24h
  if (!quotaOk) reasons.push('UPLOAD_QUOTA_EXHAUSTED')

  const recentOutboundBytes = nonNegativeCount(source.recentOutboundBytes) ?? 0

  const background = evaluateBackgroundBudgets(source, limits)
  const backgroundWorkOk = background.blockers.length === 0
  const foreground = source.foreground === true
  if (!server && !foreground) reasons.push(...background.blockers)

  const fetchBlocked = network.blocked || thermal.blocked
  const contributionBlocked = fetchBlocked || power.blocked || disk.blocked
  const uploadBlocked = isUploadBlocked({
    server,
    fetchBlocked,
    powerBlocked: power.blocked,
    contributionBlocked,
  })
  const allSignalsKnown = network.known && thermal.known && power.known && disk.known
  const runnable = isParticipationRunnable({
    server,
    foreground,
    backgroundWorkOk,
    allSignalsKnown,
  })

  const peerDiscovery = permissionOk && !fetchBlocked && runnable
  const cacheFill = peerDiscovery && !disk.blocked

  const { uploadEligible, uploading } = resolveUploadFlags({
    permissionOk,
    uploadBlocked,
    windowOk,
    quotaOk,
    runnable,
    recentOutboundBytes,
  })

  const backgroundEligible = isBackgroundEligible({
    permissionOk,
    contributionBlocked,
    allSignalsKnown,
    server,
    backgroundWorkOk,
    windowOk,
    quotaOk,
  })

  const { archiving, archiveEligible } = resolveArchiveFlags({
    permissionOk,
    contributionBlocked,
    allSignalsKnown,
    uploadEligible,
    archiveOptIn: source.archiveOptIn,
  })

  return buildParticipationDecision({
    mode,
    limits,
    peerDiscovery,
    cacheFill,
    archiving,
    archiveEligible,
    uploadEligible,
    uploading,
    backgroundEligible,
    cacheCeilingBytes,
    uploadCeilingBytesPer24h,
    uploadedBytesLast24h,
    background,
    reasons,
  })

}


export function createPlaybackResourcePolicy(options = {}) {
  const limits = {
    maxPeers: boundedInteger(options.maxPeers, 'maxPeers', 8),
    maxRequests: boundedInteger(options.maxRequests, 'maxRequests', 16),
    maxInFlightBytes: boundedInteger(options.maxInFlightBytes, 'maxInFlightBytes', 64 * 1024 * 1024),
    maxDiskBytes: boundedInteger(options.maxDiskBytes, 'maxDiskBytes', 512 * 1024 * 1024),
    deadlineMs: boundedInteger(options.deadlineMs, 'deadlineMs', 15000),
  }
  let generation = 0
  let previousAcquisitionRole = null

  /**
   * The acquisition-role decision: what this host may hold on to, gated by the
   * two explicit permissions (contribute, archive) and by a pending policy
   * migration. It is separate from the five-key playback projection below,
   * because a role change has to invalidate in-flight acquisition, while a
   * device-signal change only narrows what playback itself may do.
   */
  function evaluateAcquisition(state = {}) {
    const foreground = state.foreground !== false
    const discoveryAllowed = state.userAllowsP2P !== false
    const unconstrained = isAcquisitionUnconstrained(state)
    const powered = state.charging !== false
    const migrationAllowed = state.migrationRequired !== true
    const contribute = migrationAllowed && state.permissions?.contribute === true
    const archive = migrationAllowed && state.permissions?.archive === true

    const baseEligible = foreground && unconstrained
    const peerDiscovery = discoveryAllowed && baseEligible
    const poweredEligible = baseEligible && powered

    return {
      localPlayback: true,
      peerDiscovery,
      upload: (contribute || archive) && poweredEligible,
      cacheFill: peerDiscovery,
      contributionCache: contribute && baseEligible,
      archiving: archive && poweredEligible,
    }
  }

  return {
    limits() {
      return { ...limits }
    },
    evaluate(state = {}) {
      const source = state == null ? {} : state
      // An explicit permission set is theirs to withhold: a watch-only viewer
      // downloads and discovers, and uploads nothing. Legacy state that never
      // mentions permissions keeps its historical contribution.
      const permissions = source.permissions
      const contributeAllowed = permissions == null
        ? true
        : (permissions.contribute === true || permissions.archive === true) &&
          source.migrationRequired !== true
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
        // The archive permission is that same pledge arriving through the
        // permission set, and a pending migration withdraws it.
        archiveOptIn: source.archiveOptIn === true ||
          (permissions?.archive === true && source.migrationRequired !== true),
      })
      return {
        localPlayback: participation.localPlayback,
        peerDiscovery: participation.peerDiscovery,
        upload: participation.upload && contributeAllowed,
        cacheFill: participation.cacheFill,
        archiving: participation.archiving,
      }
    },
    transition(state = {}) {
      const decision = evaluateAcquisition(state)
      const acquisitionRole = `${decision.contributionCache}:${decision.archiving}`
      if (previousAcquisitionRole !== null && acquisitionRole !== previousAcquisitionRole) generation++
      previousAcquisitionRole = acquisitionRole
      return { ...decision, generation }
    },
  }
}
