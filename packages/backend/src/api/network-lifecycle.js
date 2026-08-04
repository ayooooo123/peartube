// Network lifecycle API group, extracted from api.js.
//
// This module owns the *live* participation signals - what playback is doing,
// whether the app is foregrounded, how long it has run in the background, how
// many bytes it has uploaded - and nothing else. The decision those signals
// feed is made in exactly one place, evaluateParticipation, so no manager here
// invents a ceiling, a grace window, or a battery floor of its own. Every
// decision is published to the network-policy runtime, which is what keeps the
// status this module reports and the bytes the transport actually serves from
// contradicting each other.
import {
  evaluateParticipation,
} from '../playback/resource-policy.js'
import {
  getNetworkStats,
  getNetworkStatsReadable,
  resumeNetworking,
  setPlaybackActive as storageSetPlaybackActive,
  suspendNetworking,
} from '../storage.js'
import { DEFAULT_NETWORK_POLICY } from './policy.js'

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000

// Ledger entries are coalesced into buckets so that a device polling its status
// every second cannot grow a persisted ledger without bound: a rolling day
// holds at most 1440 upload buckets and 1440 background buckets.
const LEDGER_BUCKET_MS = 60 * 1000

// "Actively uploading" means bytes really left this device a moment ago, not
// that something is playing. The window is short enough to fall back to
// "eligible" when a transfer stops and long enough not to flicker between
// blocks.
const RECENT_OUTBOUND_WINDOW_MS = 60 * 1000
const RECENT_OUTBOUND_BUCKET_MS = 1000

const LEDGER_STATE_VERSION = 1
const MAX_LEDGER_ENTRIES = 4096

// Categorical OS signals only. A flag-bearing field is adopted only when its
// presence flag says the platform measured it, because the wire cannot tell
// `false`/`0` from absent - and an omitted signal stays unknown, which the
// decision treats as a constraint. Nothing here derives a signal from another.
const DEVICE_CONDITION_FIELDS = Object.freeze([
  Object.freeze({ key: 'metered', flag: 'meteredProvided', decode: decodeBooleanSignal }),
  Object.freeze({ key: 'thermalState', flag: null, decode: decodeThermalSignal }),
  Object.freeze({ key: 'batteryPercent', flag: 'batteryPercentProvided', decode: decodePercentSignal }),
  Object.freeze({ key: 'charging', flag: 'chargingProvided', decode: decodeBooleanSignal }),
  Object.freeze({ key: 'backgroundPermitted', flag: 'backgroundPermittedProvided', decode: decodeBooleanSignal }),
  Object.freeze({ key: 'freeDiskBytes', flag: 'freeDiskBytesProvided', decode: decodeCountSignal }),
  Object.freeze({ key: 'totalDiskBytes', flag: 'totalDiskBytesProvided', decode: decodeCountSignal }),
])

function hasOwn(value, key) {
  return value != null && Object.prototype.hasOwnProperty.call(value, key)
}

function decodeBooleanSignal(value) {
  return value === true
}

function decodeCountSignal(value) {
  const next = Number(value)
  return Number.isFinite(next) && next >= 0 ? Math.floor(next) : undefined
}

function decodePercentSignal(value) {
  const next = Number(value)
  return Number.isFinite(next) && next >= 0 && next <= 100 ? next : undefined
}

function decodeThermalSignal(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 ? value : undefined
}

/**
 * Decode a set-device-conditions request. A wire request carries a presence
 * flag beside every value that cannot distinguish absent from zero, so an
 * unreported signal reaches the decision as unknown instead of as a permissive
 * default. An in-process call omits the flags, and an omitted key is already
 * undefined.
 */
function decodeDeviceConditions(request = {}) {
  const conditions = {}
  for (const { key, flag, decode } of DEVICE_CONDITION_FIELDS) {
    if (flag !== null && hasOwn(request, flag) && request[flag] !== true) continue
    if (request[key] === undefined) continue
    const value = decode(request[key])
    if (value !== undefined) conditions[key] = value
  }
  return conditions
}

/**
 * Hyperswarm reports a monotonic total of bytes written across every stream it
 * has ever opened. The rolling 24-hour quota needs increments, so the ledger
 * samples the counter and banks the difference; a counter that moves backwards
 * means the swarm restarted, and a restart is rebased rather than credited.
 */
function defaultOutboundBytesTotal() {
  const stats = getNetworkStats()
  const total = Number(stats?.bytesTransmittedOverSwarmStreams)
  return Number.isFinite(total) && total >= 0 ? total : 0
}

function createRollingWindow({
  windowMs = ROLLING_WINDOW_MS,
  bucketMs = LEDGER_BUCKET_MS,
  entries = [],
} = {}) {
  const banked = entries.map(entry => ({ at: entry.at, amount: entry.amount }))
  let total = banked.reduce((sum, entry) => sum + entry.amount, 0)
  const prune = at => {
    while (banked.length > 0 && at - banked[0].at >= windowMs) total -= banked.shift().amount
  }
  return {
    add(at, amount) {
      if (!(amount > 0)) return false
      const bucket = Math.floor(at / bucketMs) * bucketMs
      const last = banked[banked.length - 1]
      if (last && last.at === bucket) last.amount += amount
      else banked.push({ at: bucket, amount })
      total += amount
      return true
    },
    total(at) {
      prune(at)
      return Math.max(0, total)
    },
    entries(at) {
      prune(at)
      return banked.map(entry => ({ at: entry.at, amount: entry.amount }))
    },
  }
}

/**
 * Rolling ledgers age by wall clock, so a stored entry older than the window is
 * simply gone: a device that was switched off for a day comes back with a clean
 * ledger, and a device that was off for an hour comes back owing the other 23.
 * An entry dated in the future is kept - the conservative reading, since
 * dropping it would hand the device quota it already spent.
 */
function decodeLedgerEntries(value, at, windowMs) {
  if (!Array.isArray(value)) return []
  const entries = []
  for (const raw of value) {
    const bucket = Number(raw?.at)
    const amount = Number(raw?.amount)
    if (!Number.isSafeInteger(bucket) || !Number.isFinite(amount) || amount <= 0) continue
    if (at - bucket >= windowMs) continue
    entries.push({ at: bucket, amount: Math.floor(amount) })
  }
  entries.sort((left, right) => left.at - right.at)
  return entries.slice(-MAX_LEDGER_ENTRIES)
}

export function createNetworkLifecycleApi({
  onPlaybackActive,
  onPlaybackInactive,
  networkPolicyRuntime,
  policyApi = null,
  onParticipationDecision = null,
  now = Date.now,
  readOutboundBytesTotal = defaultOutboundBytesTotal,
  suspendTransport = suspendNetworking,
  repository = null,
  // 'device' (a viewer's phone/tablet/desktop) or 'server' (a headless relay
  // or seeder). See evaluateParticipation: a server is not a device that
  // failed to read its battery, it is a machine that has none.
  hostKind = 'device',
} = {}) {
  let playbackActive = false
  let playbackEndedAt = null
  let foreground = true
  // A background "session" is one continuous stint in the background: each
  // time the app is backgrounded it gets a fresh session budget, and the
  // rolling daily budget is what stops a device that backgrounds all day.
  let backgroundSessionAccruedMs = 0
  // Non-null only while the app is backgrounded *and* the previous decision
  // permitted background work. The budget pays for eligible work, not for
  // residency: a phone in a pocket that may not run any work burns nothing, so
  // its 60 minutes are still there when the OS finally allows them.
  let backgroundAccruingSince = null
  let uploadWindow = createRollingWindow()
  let backgroundWindow = createRollingWindow()
  // Bytes that moved a moment ago. Deliberately not persisted: after a restart
  // nothing has moved recently, which is the truth.
  const recentOutbound = createRollingWindow({
    windowMs: RECENT_OUTBOUND_WINDOW_MS,
    bucketMs: RECENT_OUTBOUND_BUCKET_MS,
  })
  let lastOutboundTotal = null
  let ledgerDirty = false
  // Every OS signal starts unknown, and an unknown signal is constrained. The
  // platform reports categorical values through setDeviceConditions; nothing
  // here infers temperature, battery health, or network cost from anything
  // else.
  let deviceConditions = {
    metered: undefined,
    thermalState: undefined,
    batteryPercent: undefined,
    charging: undefined,
    backgroundPermitted: undefined,
    freeDiskBytes: undefined,
    totalDiskBytes: undefined,
  }

  // The rolling ceilings are 24-hour promises, so the ledgers behind them
  // outlive the process. Without this a restart hands the device a fresh
  // gigabyte, and the 1 GiB daily upload ceiling means whatever the uptime says.
  const hydrated = Promise.resolve()
    .then(() => repository?.load?.())
    .then(stored => {
      if (stored == null || stored.version !== LEDGER_STATE_VERSION) return
      const at = now()
      uploadWindow = createRollingWindow({
        entries: decodeLedgerEntries(stored.upload, at, ROLLING_WINDOW_MS),
      })
      backgroundWindow = createRollingWindow({
        entries: decodeLedgerEntries(stored.background, at, ROLLING_WINDOW_MS),
      })
      const total = Number(stored.outboundTotal)
      lastOutboundTotal = Number.isFinite(total) && total >= 0 ? total : null
    })
    .catch(err => {
      console.error('[API] participation ledger load failed:', err.message)
    })

  async function persistLedger(at) {
    if (!ledgerDirty || typeof repository?.save !== 'function') return
    ledgerDirty = false
    try {
      await repository.save({
        version: LEDGER_STATE_VERSION,
        savedAt: at,
        upload: uploadWindow.entries(at),
        background: backgroundWindow.entries(at),
        // The rebase point: the counter value the last delta was measured
        // against. A fresh process reports a smaller total, which rebases
        // instead of crediting a day's worth of bytes in one sample.
        outboundTotal: lastOutboundTotal,
      })
    } catch (err) {
      ledgerDirty = true
      console.error('[API] participation ledger save failed:', err.message)
    }
  }

  function enterBackground() {
    if (!foreground) return
    foreground = false
    backgroundSessionAccruedMs = 0
    backgroundAccruingSince = null
  }

  function enterForeground(at) {
    if (foreground) return
    settleBackgroundAccrual(at)
    foreground = true
    backgroundAccruingSince = null
    backgroundSessionAccruedMs = 0
  }

  function settleBackgroundAccrual(at) {
    if (backgroundAccruingSince === null) return
    const elapsed = Math.max(0, at - backgroundAccruingSince)
    backgroundAccruingSince = at
    if (elapsed <= 0) return
    backgroundSessionAccruedMs += elapsed
    if (backgroundWindow.add(at, elapsed)) ledgerDirty = true
  }

  function sampleOutboundBytes(at) {
    let total
    try {
      total = Number(readOutboundBytesTotal())
    } catch {
      return
    }
    if (!Number.isFinite(total) || total < 0) return
    if (lastOutboundTotal !== null && total >= lastOutboundTotal) {
      const moved = total - lastOutboundTotal
      if (uploadWindow.add(at, moved)) ledgerDirty = true
      recentOutbound.add(at, moved)
    }
    if (total !== lastOutboundTotal) ledgerDirty = true
    lastOutboundTotal = total
  }

  async function readPolicy() {
    const response = await policyApi?.getNetworkPolicy?.()
    return response?.policy || DEFAULT_NETWORK_POLICY
  }

  async function publishDecision(decision) {
    // One decision, one authority. The runtime governs the byte path with it,
    // so a device reporting "suspended" cannot be serving blocks, and the
    // archive ledger reads it before taking on new custody.
    try {
      await networkPolicyRuntime?.setParticipationDecision?.(decision)
    } catch (err) {
      console.error('[API] participation decision was not applied to the transport:', err.message)
    }
    onParticipationDecision?.(decision)
  }

  async function evaluateNow() {
    await hydrated
    const at = now()
    sampleOutboundBytes(at)
    settleBackgroundAccrual(at)
    const policy = await readPolicy()
    const decision = evaluateParticipation({
      hostKind,
      mode: policy.participationMode,
      // 'manual' still means the viewer has not refused to participate; only
      // 'disabled' does.
      userAllowsP2P: policy.uploadPermission !== 'disabled',
      playbackActive,
      // A device that has never played anything has no grace clock at all, and
      // an absent elapsed time is not the same as "just stopped": it is
      // reported as unknown so the window stays closed.
      msSincePlaybackEnded: playbackEndedAt === null ? undefined : Math.max(0, at - playbackEndedAt),
      foreground,
      backgroundPermitted: deviceConditions.backgroundPermitted,
      metered: deviceConditions.metered,
      thermalState: deviceConditions.thermalState,
      batteryPercent: deviceConditions.batteryPercent,
      charging: deviceConditions.charging,
      freeDiskBytes: deviceConditions.freeDiskBytes,
      totalDiskBytes: deviceConditions.totalDiskBytes,
      uploadedBytesLast24h: uploadWindow.total(at),
      // Measured traffic, not an assumption drawn from playback: this is what
      // separates "actively uploading" from "eligible and idle".
      recentOutboundBytes: recentOutbound.total(at),
      backgroundMsThisSession: backgroundSessionAccruedMs,
      backgroundMsLast24h: backgroundWindow.total(at),
      // An archive pledge is a durable promise the viewer made in Developer
      // Settings. No participation mode creates one.
      archiveOptIn: policy.retentionMode === 'archive-pledges',
      // A ceiling the viewer set by hand outranks the mode preset, so the
      // quota gate measures against the stored policy, not the preset.
      cacheCeilingBytes: policy.diskCeilingBytes,
      uploadCeilingBytesPer24h: policy.uploadCeilingBytes,
    })
    // The next interval accrues against the background budgets only if this
    // decision permits background work and the app is still backgrounded.
    backgroundAccruingSince = !foreground && decision.backgroundEligible ? at : null
    await persistLedger(at)
    await publishDecision(decision)
    return decision
  }

  // Decisions are evaluated one at a time so they reach the transport in the
  // order they were made: a stale decision applied last would leave the byte
  // path describing a state that has already passed.
  let decisions = Promise.resolve()
  function evaluate() {
    const next = decisions.then(evaluateNow, evaluateNow)
    decisions = next.catch(() => {})
    return next
  }

  function refreshParticipation(reason) {
    evaluate().catch(err => {
      console.error(`[API] participation refresh after ${reason} failed:`, err.message)
    })
  }

  // A viewer's app publishes its first decision the moment it reports device
  // conditions or reads its status. A headless server does neither — nothing
  // is watching it — so it would never publish one, and the archive ledger
  // fails closed until a decision exists. Evaluate once at boot so a relay's
  // custody gate opens on the same authority every other host uses.
  if (hostKind === 'server') refreshParticipation('server startup')

  function participationResponse(decision) {
    return {
      success: true,
      mode: decision.mode,
      state: decision.state,
      uploadEligible: decision.uploadEligible,
      uploading: decision.uploading,
      backgroundEligible: decision.backgroundEligible,
      cacheCeilingBytes: decision.cacheCeilingBytes,
      uploadCeilingBytesPer24h: decision.uploadCeilingBytesPer24h,
      uploadedBytesLast24h: decision.uploadedBytesLast24h,
      outboundBytesPerSecond: decision.outboundBytesPerSecond,
      postPlaybackGraceMs: decision.postPlaybackGraceMs,
      backgroundRemainingSessionMs: decision.backgroundRemainingSessionMs,
      backgroundRemainingDailyMs: decision.backgroundRemainingDailyMs,
      reasonCodes: decision.reasonCodes,
    }
  }

  // Every field of get-participation-status is required on the wire, so a
  // failure still answers with a complete decision - the one an empty state
  // produces, which is suspended, because a device whose policy could not be
  // read has permission for nothing. The response carries errorCode and no
  // free-text error: the schema has no field to put one in.
  function participationUnavailable(err) {
    console.error('[API] participation status unavailable:', err.message)
    return {
      ...participationResponse(evaluateParticipation({})),
      success: false,
      errorCode: 'PARTICIPATION_UNAVAILABLE',
    }
  }

  return {
    /**
     * Suspend networking for mobile background state.
     * Call this when the app goes to background to save battery.
     * @returns {Promise<{success: boolean, state?: string, backgroundEligible?: boolean, error?: string}>}
     */
    async suspendNetwork() {
      try {
        enterBackground()
        const decision = await evaluate()
        if (networkPolicyRuntime?.setEnvironment) {
          await networkPolicyRuntime.setEnvironment({ background: true })
          // Backgrounding that cannot legally run work suspends. Leaving the
          // swarm connected so the device looks like a seeder while every gate
          // says it may not serve a byte is the failure Task 8 names.
          if (!decision.backgroundEligible) await suspendTransport()
        } else {
          await suspendTransport()
        }
        return {
          success: true,
          state: decision.state,
          backgroundEligible: decision.backgroundEligible,
          reasonCodes: decision.reasonCodes,
        }
      } catch (err) {
        console.error('[API] suspendNetwork error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Resume networking when app returns to foreground.
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async resumeNetwork() {
      try {
        enterForeground(now())
        // Foregrounding reopens the upload window, and the transport only finds
        // that out through a decision.
        await evaluate()
        if (networkPolicyRuntime?.setEnvironment) {
          await networkPolicyRuntime.setEnvironment({ background: false })
        } else {
          await resumeNetworking()
        }
        return { success: true }
      } catch (err) {
        console.error('[API] resumeNetwork error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Record the OS-reported device conditions. Every value is categorical and
     * comes straight from the platform; a value the platform did not report
     * stays unknown, and an unknown value is treated as constrained.
     * @param {{metered?: boolean, meteredProvided?: boolean, thermalState?: string, batteryPercent?: number, batteryPercentProvided?: boolean, charging?: boolean, chargingProvided?: boolean, backgroundPermitted?: boolean, backgroundPermittedProvided?: boolean, freeDiskBytes?: number, freeDiskBytesProvided?: boolean, totalDiskBytes?: number, totalDiskBytesProvided?: boolean}} [request]
     */
    async setDeviceConditions(request = {}) {
      try {
        const reported = decodeDeviceConditions(request)
        const meteredChanged = hasOwn(reported, 'metered') &&
          reported.metered !== deviceConditions.metered
        deviceConditions = { ...deviceConditions, ...reported }
        const decision = await evaluate()
        // The metered signal is an input to the operator policy too:
        // meteredNetwork can only narrow the transport if it is told.
        if (meteredChanged) {
          await networkPolicyRuntime?.setEnvironment?.({ metered: reported.metered })
        }
        // The same rule as backgrounding: if the new conditions mean background
        // work is no longer legal, stop the transport instead of pretending.
        if (!foreground && !decision.backgroundEligible) await suspendTransport()
        return participationResponse(decision)
      } catch (err) {
        return participationUnavailable(err)
      }
    },

    /**
     * Report what this device is contributing right now and why.
     * Matches the get-participation-status HRPC response field for field.
     */
    async getParticipationStatus() {
      try {
        return participationResponse(await evaluate())
      } catch (err) {
        return participationUnavailable(err)
      }
    },

    /**
     * Mirror app playback state into the backend so cache cleanup does not
     * clear blob ranges while a player or blob-server reader is active.
     * @param {{active?: boolean, ttlMs?: number}} [options]
     * @returns {{success: boolean, active: boolean, updatedAt: number, expiresAt: number}}
     */
    setPlaybackActive(options = {}) {
      const state = storageSetPlaybackActive(Boolean(options.active), { ttlMs: options.ttlMs })
      // Playback is also the participation window: upload is eligible while a
      // title is playing and for the mode's grace period after it stops, so the
      // end of playback is the instant the grace clock starts.
      if (state.active) {
        playbackActive = true
        playbackEndedAt = null
      } else {
        if (playbackActive) playbackEndedAt = now()
        playbackActive = false
      }
      // Flush deferred cache eviction when playback ends. enforceQuota() skips
      // every clear while playback is active (isCacheClearBlocked), and its only
      // other trigger — addSeed — fires *during* playback, so the over-quota
      // evictions get deferred and nothing ever re-runs them. Without this hook
      // the seed cache grows unbounded past maxStorageGB.
      //
      // The sweep is debounced and cancelled the moment playback resumes, so
      // rapid open/close, seeking, and pause/resume never trigger eviction.
      if (state.active) {
        onPlaybackActive?.()
      } else {
        onPlaybackInactive?.()
      }
      // The upload window just opened or closed, so the transport is told now
      // rather than whenever the app next asks for a status.
      refreshParticipation('a playback change')
      return { success: true, ...state }
    },

    /**
     * Get network stats for debugging.
     * @returns {{stats: Object|null, readable: string}}
     */
    getNetworkDebugStats() {
      return {
        stats: getNetworkStats(),
        readable: getNetworkStatsReadable()
      }
    },
  }
}
