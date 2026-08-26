/**
 * Report this device's OS categorical signals to the backend participation
 * decision (`set-device-conditions`).
 *
 * Everything here is a *report*, never a derivation. The backend treats an
 * absent signal as unknown and an unknown signal as a constraint, so omitting a
 * signal is always the safe answer and inventing one is never acceptable:
 * a fabricated "cool and charged" would make this device promise work it cannot
 * do. Nothing in this file infers temperature or power state from anything else.
 *
 * Signals this app genuinely cannot read today, and therefore never sends:
 *
 * - `metered`. No network-information module is installed (`expo-network`,
 *   `@react-native-community/netinfo` and `expo-device` are all absent), and
 *   neither `navigator.onLine` nor Chromium's `NetworkInformation` exposes the
 *   OS metered flag — `effectiveType` is a speed class and `saveData` is a user
 *   preference. Connection *type* would be a guess, not the flag.
 * - `thermalState`. `ProcessInfo.thermalState` (iOS) and
 *   `PowerManager.getCurrentThermalStatus()` (Android) both require a native
 *   module this app does not ship, and no web API reports it at all.
 * - `batteryPercent`/`charging` on native. Same missing bridge. The desktop
 *   shell does expose the Battery Status API, which is the OS's own reading, so
 *   power is reported there and only there.
 *
 * This module deliberately imports nothing platform-specific: the host modules
 * arrive through `platformDeviceConditionSources`, so the mapping from platform
 * facts to reported signals is testable without a device.
 */

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical'

/** The OS thermal categories the backend recognises. Nothing else is a reading. */
const RECOGNISED_THERMAL_STATES: Readonly<Record<ThermalState, true>> = Object.freeze({
  nominal: true,
  fair: true,
  serious: true,
  critical: true,
})

/**
 * A signal is present only when this device actually read it. Every key is
 * optional for exactly that reason.
 */
export type DeviceConditions = {
  metered?: boolean
  thermalState?: ThermalState
  batteryPercent?: number
  charging?: boolean
  backgroundPermitted?: boolean
  freeDiskBytes?: number
  totalDiskBytes?: number
}

export type DeviceConditionsRpc = {
  setDeviceConditions?: (conditions: DeviceConditions) => Promise<unknown>
}

type MaybePromise<T> = T | Promise<T>

/**
 * One reader per signal, and no reader at all for a signal this platform cannot
 * read. A reader that returns `undefined` (or throws) leaves its signal unknown.
 */
export type DeviceSignalSources = {
  readMetered?: () => MaybePromise<boolean | null | undefined>
  readThermalState?: () => MaybePromise<string | null | undefined>
  readPower?: () => MaybePromise<{ batteryPercent?: number; charging?: boolean } | null | undefined>
  readBackgroundPermitted?: () => MaybePromise<boolean | null | undefined>
  readDisk?: () => MaybePromise<{ freeBytes?: number; totalBytes?: number } | null | undefined>
  /**
   * Fires whenever a reported signal may have changed. Returns an unsubscribe.
   * One subscription point keeps every trigger — lifecycle, network, power —
   * behind the same throttle.
   */
  subscribe?: (listener: () => void) => (() => void) | void
}

/** Leading-edge send, then at most one send per window. */
export const DEVICE_CONDITIONS_THROTTLE_MS = 10000

/**
 * Free disk has no change event on any platform here, so an unchanged report is
 * re-read at this interval. Identical readings never reach the wire.
 */
export const DEVICE_CONDITIONS_HEARTBEAT_MS = 5 * 60 * 1000

const CONDITION_KEYS = Object.freeze([
  'metered',
  'thermalState',
  'batteryPercent',
  'charging',
  'backgroundPermitted',
  'freeDiskBytes',
  'totalDiskBytes',
] as const)

/**
 * Stable rendering of a reading, used to drop a report identical to the one the
 * backend already holds. `?` is "not read", which is distinct from any value.
 */
export function serializeDeviceConditions(conditions: DeviceConditions): string {
  return CONDITION_KEYS
    .map((key) => `${key}=${conditions[key] === undefined ? '?' : String(conditions[key])}`)
    .join('|')
}

async function readSignal<T>(reader: (() => MaybePromise<T>) | undefined): Promise<T | undefined> {
  if (typeof reader !== 'function') return undefined
  try {
    return await reader()
  } catch {
    // A reader that fails has not read anything, so the signal stays unknown.
    return undefined
  }
}

function wholeBytes(value: unknown): number | null {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return null
  const whole = Math.floor(bytes)
  return Number.isSafeInteger(whole) ? whole : null
}

/**
 * Collect one reading. Every value is validated before it is reported: an
 * out-of-range battery level, an unrecognised thermal category, or an
 * incoherent disk pair is not a reading and is left out.
 */
export async function readDeviceConditions(sources: DeviceSignalSources = {}): Promise<DeviceConditions> {
  const conditions: DeviceConditions = {}

  const metered = await readSignal(sources.readMetered)
  if (typeof metered === 'boolean') conditions.metered = metered

  const thermalState = await readSignal(sources.readThermalState)
  if (typeof thermalState === 'string' && RECOGNISED_THERMAL_STATES[thermalState as ThermalState] === true) {
    conditions.thermalState = thermalState as ThermalState
  }

  const power = await readSignal(sources.readPower)
  if (power) {
    const percent = Number(power.batteryPercent)
    if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
      conditions.batteryPercent = Math.round(percent)
    }
    if (typeof power.charging === 'boolean') conditions.charging = power.charging
  }

  const backgroundPermitted = await readSignal(sources.readBackgroundPermitted)
  if (typeof backgroundPermitted === 'boolean') conditions.backgroundPermitted = backgroundPermitted

  const disk = await readSignal(sources.readDisk)
  if (disk) {
    const free = wholeBytes(disk.freeBytes)
    const total = wholeBytes(disk.totalBytes)
    // The backend's free-disk floor is the greater of 2 GiB and 10% of the
    // total, so an incoherent pair would move the floor rather than fail
    // loudly. More free than total is not a reading; report neither half.
    if (free === null || total === null || free <= total) {
      if (free !== null) conditions.freeDiskBytes = free
      if (total !== null) conditions.totalDiskBytes = total
    }
  }

  return conditions
}

export type DeviceConditionsReporterOptions = {
  rpc: DeviceConditionsRpc | null | undefined
  sources: DeviceSignalSources
  throttleMs?: number
  /** 0 disables the periodic re-read. */
  heartbeatMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  onError?: (error: unknown) => void
}

export type DeviceConditionsReporter = {
  /** Subscribe to change triggers, arm the heartbeat, and send the first report. */
  start(): Promise<void>
  /** Request a report. Throttled: the window collapses a burst into one send. */
  report(): Promise<void>
  stop(): void
}

/**
 * Drives `setDeviceConditions` from a set of readers.
 *
 * Two rules keep it off the backend's back: a burst inside one throttle window
 * becomes a single trailing send, and a reading identical to the last delivered
 * one is not sent at all. A refused send forgets the payload so the next
 * attempt retries rather than deduplicating against something that never
 * arrived.
 */
export function createDeviceConditionsReporter(options: DeviceConditionsReporterOptions): DeviceConditionsReporter {
  const sources = options.sources ?? {}
  const requestedThrottleMs = Number(options.throttleMs)
  const throttleMs = Number.isFinite(requestedThrottleMs) && requestedThrottleMs >= 0
    ? requestedThrottleMs
    : DEVICE_CONDITIONS_THROTTLE_MS
  const requestedHeartbeatMs = Number(options.heartbeatMs)
  const heartbeatMs = Number.isFinite(requestedHeartbeatMs) && requestedHeartbeatMs >= 0
    ? requestedHeartbeatMs
    : DEVICE_CONDITIONS_HEARTBEAT_MS
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown)
  const clearTimer = options.clearTimer ?? ((handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })

  let stopped = false
  let trailing: unknown = null
  let heartbeat: unknown = null
  let inFlight: Promise<void> | null = null
  let queued = false
  let lastAttemptAt: number | null = null
  let lastDelivered: string | null = null
  let unsubscribe: (() => void) | null = null

  const send = async (): Promise<void> => {
    lastAttemptAt = now()
    const conditions = await readDeviceConditions(sources)
    const payload = serializeDeviceConditions(conditions)
    if (payload === lastDelivered) return
    const rpc = options.rpc
    const setter = rpc?.setDeviceConditions
    if (typeof setter !== 'function') return
    try {
      await setter.call(rpc, conditions)
      lastDelivered = payload
    } catch (error) {
      lastDelivered = null
      options.onError?.(error)
    }
  }

  const runNow = (): Promise<void> => {
    if (trailing !== null) {
      clearTimer(trailing)
      trailing = null
    }
    const task = send().then(
      () => {
        inFlight = null
        if (!queued || stopped) return undefined
        queued = false
        return report()
      },
      () => { inFlight = null },
    )
    inFlight = task
    return task
  }

  const report = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    // A report raised mid-send is not lost: it is re-applied, throttle and all,
    // once the send in flight settles.
    if (inFlight !== null) {
      queued = true
      return inFlight
    }
    const elapsed = lastAttemptAt === null ? Number.POSITIVE_INFINITY : now() - lastAttemptAt
    if (elapsed < throttleMs) {
      if (trailing === null) {
        trailing = setTimer(() => {
          trailing = null
          if (!stopped) void runNow()
        }, throttleMs - elapsed)
      }
      return Promise.resolve()
    }
    return runNow()
  }

  const scheduleHeartbeat = () => {
    if (stopped || heartbeatMs <= 0) return
    heartbeat = setTimer(() => {
      heartbeat = null
      if (stopped) return
      void report()
      scheduleHeartbeat()
    }, heartbeatMs)
  }

  const start = async (): Promise<void> => {
    if (stopped) return
    if (unsubscribe === null && typeof sources.subscribe === 'function') {
      const dispose = sources.subscribe(() => { void report() })
      unsubscribe = typeof dispose === 'function' ? dispose : () => {}
    }
    scheduleHeartbeat()
    await report()
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    queued = false
    if (trailing !== null) {
      clearTimer(trailing)
      trailing = null
    }
    if (heartbeat !== null) {
      clearTimer(heartbeat)
      heartbeat = null
    }
    if (unsubscribe !== null) {
      const dispose = unsubscribe
      unsubscribe = null
      try {
        dispose()
      } catch {
        // A host that already tore the listener down is not an error here.
      }
    }
  }

  return { start, report, stop }
}

/** A `BatteryManager`, described structurally: no DOM lib is in scope here. */
type BatteryManagerLike = {
  level?: number
  charging?: boolean
  addEventListener?: (type: string, handler: () => void) => void
  removeEventListener?: (type: string, handler: () => void) => void
}

/**
 * The host modules this mapping reads. Each one is optional so a platform that
 * lacks it simply loses that signal instead of reporting a fabricated one.
 */
export type DeviceConditionEnv = {
  /** `Platform.OS`. Without it, lifecycle-dependent signals stay unknown. */
  platformOS?: string | null
  /**
   * `AppState`. Its `change` event is a report trigger. Declared with method
   * syntax so a host that narrows the event name (React Native types it as
   * `AppStateEvent`) still satisfies it.
   */
  appState?: { addEventListener?(type: 'change', handler: (state: string) => void): { remove?: () => void } | void } | null
  /** `playbackActiveEmitter`: true while a media session is holding the process up. */
  playback?: { isActive?: boolean } | null
  /** `Paths` from expo-file-system. Its web build answers 0, so it is not used there. */
  paths?: { availableDiskSpace?: number; totalDiskSpace?: number } | null
  /** `globalThis` when it carries `online`/`offline` events. */
  eventTarget?: {
    addEventListener?(type: string, handler: () => void): void
    removeEventListener?(type: string, handler: () => void): void
  } | null
  /** `() => navigator.getBattery()` where the Battery Status API exists. */
  battery?: (() => MaybePromise<BatteryManagerLike | null | undefined>) | null
}

const NETWORK_EVENTS = Object.freeze(['online', 'offline'])
const BATTERY_EVENTS = Object.freeze(['chargingchange', 'levelchange'])

/**
 * Map platform facts onto reported signals.
 *
 * `readMetered` and `readThermalState` are deliberately never installed: see
 * the file header. Everything else is installed only when its host module is
 * actually present and actually answers on this platform.
 */
export function platformDeviceConditionSources(env: DeviceConditionEnv = {}): DeviceSignalSources {
  const platformOS = typeof env.platformOS === 'string' && env.platformOS !== '' ? env.platformOS : null
  const web = platformOS === 'web'
  const battery = typeof env.battery === 'function' ? env.battery : null
  const sources: DeviceSignalSources = {}

  if (platformOS !== null) {
    if (web) {
      // The desktop shell and the browser keep this runtime alive when the
      // window is hidden, and neither has an OS background-work permission to
      // consult, so work is permitted whatever the window is doing.
      sources.readBackgroundPermitted = () => true
    } else {
      // On mobile the OS lets this process keep working while backgrounded only
      // for as long as a media session holds it up: `UIBackgroundModes: audio`
      // on iOS and the `mediaPlayback` foreground service on Android. Without
      // one, backgrounding stops the app, so `false` is the fact and the
      // decision must suspend rather than pretend to seed. The answer is the
      // same in the foreground because it describes the same entitlement, which
      // also keeps it correct if the backend evaluates a moment later.
      const playback = env.playback
      sources.readBackgroundPermitted = () => (playback ? playback.isActive === true : undefined)
    }
  }

  const paths = env.paths
  if (!web && paths) {
    // The same filesystem the cache is measured on. The web build of
    // expo-file-system answers 0 for both, which is not a reading, so it is not
    // consulted there at all.
    sources.readDisk = () => ({ freeBytes: paths.availableDiskSpace, totalBytes: paths.totalDiskSpace })
  }

  if (battery !== null) {
    // The Battery Status API is the OS's own reading, including the "no battery,
    // running on mains" answer of charging with a full level. It is not inferred
    // from anything, and where it is missing power stays unknown.
    sources.readPower = async () => {
      const manager = await battery()
      if (!manager) return undefined
      const level = Number(manager.level)
      return {
        batteryPercent: Number.isFinite(level) ? level * 100 : undefined,
        charging: typeof manager.charging === 'boolean' ? manager.charging : undefined,
      }
    }
  }

  sources.subscribe = (listener) => {
    const disposers: (() => void)[] = []

    const appState = env.appState
    if (appState && typeof appState.addEventListener === 'function') {
      const subscription = appState.addEventListener('change', () => { listener() })
      if (subscription && typeof subscription.remove === 'function') {
        disposers.push(() => { subscription.remove?.() })
      }
    }

    const target = env.eventTarget
    if (target && typeof target.addEventListener === 'function') {
      const handler = () => { listener() }
      for (const type of NETWORK_EVENTS) {
        target.addEventListener(type, handler)
        disposers.push(() => { target.removeEventListener?.(type, handler) })
      }
    }

    if (battery !== null) {
      // The manager resolves asynchronously, so the listener is attached when it
      // arrives and skipped if the reporter stopped first.
      let cancelled = false
      disposers.push(() => { cancelled = true })
      void Promise.resolve()
        .then(() => battery())
        .then((manager) => {
          if (cancelled || !manager || typeof manager.addEventListener !== 'function') return
          const handler = () => { listener() }
          for (const type of BATTERY_EVENTS) manager.addEventListener?.(type, handler)
          disposers.push(() => {
            for (const type of BATTERY_EVENTS) manager.removeEventListener?.(type, handler)
          })
        })
        .catch(() => {
          // No power signal, and therefore no power trigger.
        })
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Tearing the rest down matters more than one uncooperative host.
        }
      }
    }
  }

  return sources
}

type ActiveReporter = { reporter: DeviceConditionsReporter; refs: number }

/**
 * One reporter per backend connection, however many screens ask for it. Two
 * reporters would each hold their own throttle and double the traffic, so
 * callers share one and release it when they unmount.
 */
const activeReporters = new Map<object, ActiveReporter>()

export function startDeviceConditionsReporting(
  rpc: DeviceConditionsRpc | null | undefined,
  sources: DeviceSignalSources,
  options: Omit<DeviceConditionsReporterOptions, 'rpc' | 'sources'> = {},
): () => void {
  if (!rpc || typeof rpc.setDeviceConditions !== 'function') return () => {}
  let shared = activeReporters.get(rpc)
  if (!shared) {
    shared = { reporter: createDeviceConditionsReporter({ ...options, rpc, sources }), refs: 0 }
    activeReporters.set(rpc, shared)
    void shared.reporter.start()
  }
  // Captured so the release closure holds the entry itself rather than looking
  // it up again: a later caller may already have replaced it.
  const entry = shared
  entry.refs += 1
  let released = false
  return () => {
    if (released) return
    released = true
    entry.refs -= 1
    if (entry.refs > 0) return
    entry.reporter.stop()
    if (activeReporters.get(rpc) === entry) activeReporters.delete(rpc)
  }
}
