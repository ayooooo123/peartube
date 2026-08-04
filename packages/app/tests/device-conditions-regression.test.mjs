/**
 * The OS signals the backend participation decision runs on have to come from
 * somewhere, and this app is the only thing that can send them.
 *
 * Two rules are load-bearing and both are asserted here. A signal this device
 * cannot read is omitted, because the backend treats an absent signal as unknown
 * and an unknown signal as a constraint — a fabricated "cool and charged" would
 * make the device promise work it cannot do. And a reporter that fires on every
 * lifecycle flicker would hammer the backend, so a burst collapses into one
 * send and an unchanged reading never reaches the wire at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const appRoot = path.resolve(import.meta.dirname, '..')
const conditions = await import(pathToFileURL(path.join(appRoot, 'lib/device-conditions.ts')).href)
const hookSource = fs.readFileSync(path.join(appRoot, 'hooks/useNetworkPolicy.ts'), 'utf8')
const layoutSource = fs.readFileSync(path.join(appRoot, 'app/_layout.tsx'), 'utf8')

/**
 * A backend that records what it was told. `fail` makes the next sends reject so
 * the retry path can be observed.
 */
function recordingRpc() {
  const calls = []
  return {
    fail: false,
    calls,
    async setDeviceConditions(next) {
      calls.push(next)
      if (this.fail) throw new Error('backend refused the report')
      return { success: true }
    },
  }
}

/**
 * Drain every pending microtask. A report chains one await per signal reader
 * before it reaches the backend, so counting ticks by hand would be a race.
 */
const settle = () => new Promise((resolve) => { setImmediate(resolve) })

/**
 * A hand-cranked clock and timer queue. Nothing here sleeps: `advance` moves the
 * clock and runs the timers that became due, which is the only way to assert
 * throttling without racing it.
 */
function fakeClock() {
  let time = 1_000_000
  let nextId = 1
  const timers = new Map()
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = nextId++
      timers.set(id, { fn, dueAt: time + Math.max(0, ms) })
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
    get pending() {
      return timers.size
    },
    async advance(ms) {
      time += ms
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= time)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)
      for (const [id, timer] of due) {
        if (!timers.has(id)) continue
        timers.delete(id)
        timer.fn()
        // Timer callbacks start async sends; let them settle before asserting.
        await settle()
      }
    },
  }
}

test('a signal the platform cannot read is omitted, never guessed', async () => {
  // A platform that answers nothing: no reader is installed at all.
  assert.deepEqual(await conditions.readDeviceConditions({}), {})

  // A reader that throws has not read anything either.
  assert.deepEqual(await conditions.readDeviceConditions({
    readMetered: () => { throw new Error('no network module') },
    readThermalState: async () => { throw new Error('no thermal bridge') },
    readPower: () => { throw new Error('no battery bridge') },
    readDisk: () => { throw new Error('no filesystem') },
    readBackgroundPermitted: () => { throw new Error('unknown lifecycle') },
  }), {})

  // Neither has one that answers null or undefined.
  assert.deepEqual(await conditions.readDeviceConditions({
    readMetered: () => null,
    readThermalState: () => undefined,
    readPower: () => null,
    readDisk: () => undefined,
    readBackgroundPermitted: () => null,
  }), {})

  // Everything the platform does know is reported verbatim.
  assert.deepEqual(await conditions.readDeviceConditions({
    readMetered: () => false,
    readThermalState: () => 'fair',
    readPower: () => ({ batteryPercent: 82.4, charging: false }),
    readBackgroundPermitted: () => true,
    readDisk: () => ({ freeBytes: 9_000_000_000, totalBytes: 500_000_000_000 }),
  }), {
    metered: false,
    thermalState: 'fair',
    batteryPercent: 82,
    charging: false,
    backgroundPermitted: true,
    freeDiskBytes: 9_000_000_000,
    totalDiskBytes: 500_000_000_000,
  })

  // The dedupe key has to keep "not read" distinct from every value, or a signal
  // going from unknown to false would look unchanged and never be resent — and
  // unknown and false are opposite answers at the gate.
  const unknown = conditions.serializeDeviceConditions({})
  assert.notEqual(unknown, conditions.serializeDeviceConditions({ metered: false }))
  assert.notEqual(unknown, conditions.serializeDeviceConditions({ backgroundPermitted: false }))
  assert.notEqual(unknown, conditions.serializeDeviceConditions({ freeDiskBytes: 0 }))
  assert.notEqual(
    conditions.serializeDeviceConditions({ charging: false }),
    conditions.serializeDeviceConditions({ charging: true }),
  )
})

test('an unusable reading is not a reading: nothing is coerced into a value', async () => {
  // A thermal category the backend does not recognise is not a thermal state.
  // Reporting it would read as "cool enough" on the permissive side of the gate.
  for (const thermalState of ['warm', 'NOMINAL', '', 'unknown', 'ok']) {
    const reading = await conditions.readDeviceConditions({ readThermalState: () => thermalState })
    assert.equal(reading.thermalState, undefined, `${JSON.stringify(thermalState)} is not an OS thermal category`)
  }
  for (const thermalState of ['nominal', 'fair', 'serious', 'critical']) {
    const reading = await conditions.readDeviceConditions({ readThermalState: () => thermalState })
    assert.equal(reading.thermalState, thermalState)
  }

  // A battery level outside 0-100 is a broken reader, not a battery.
  for (const batteryPercent of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, 'half']) {
    const reading = await conditions.readDeviceConditions({ readPower: () => ({ batteryPercent }) })
    assert.equal(reading.batteryPercent, undefined, `${String(batteryPercent)} is not a battery level`)
  }
  // A dead battery is a real reading, and 0 must survive to the wire.
  assert.equal((await conditions.readDeviceConditions({ readPower: () => ({ batteryPercent: 0 }) })).batteryPercent, 0)

  // Charging is categorical: a truthy non-boolean says nothing about power.
  assert.equal((await conditions.readDeviceConditions({ readPower: () => ({ charging: 1 }) })).charging, undefined)

  // The backend's free-disk floor is the greater of 2 GiB and 10% of the total,
  // so an incoherent pair moves the floor rather than failing loudly. Report
  // neither half of it.
  assert.deepEqual(
    await conditions.readDeviceConditions({ readDisk: () => ({ freeBytes: 900, totalBytes: 100 }) }),
    {},
  )
  assert.deepEqual(
    await conditions.readDeviceConditions({ readDisk: () => ({ freeBytes: -5, totalBytes: 100 }) }),
    { totalDiskBytes: 100 },
  )
})

test('the platform mapping never installs a thermal or battery reader it cannot back', () => {
  // Native: no thermal bridge and no battery bridge ship in this app, so those
  // readers must not exist at all. Metered has no source on any platform.
  const native = conditions.platformDeviceConditionSources({
    platformOS: 'ios',
    playback: { isActive: false },
    paths: { availableDiskSpace: 12, totalDiskSpace: 64 },
  })
  assert.equal(typeof native.readThermalState, 'undefined', 'no platform here reports OS thermal state')
  assert.equal(typeof native.readPower, 'undefined', 'no native platform here reports battery or power')
  assert.equal(typeof native.readMetered, 'undefined', 'no platform here reports the OS metered flag')
  assert.equal(typeof native.readDisk, 'function')

  // Web: expo-file-system answers 0 for both disk figures, which is not a
  // reading, so the disk reader is not installed there.
  const web = conditions.platformDeviceConditionSources({
    platformOS: 'web',
    paths: { availableDiskSpace: 0, totalDiskSpace: 0 },
  })
  assert.equal(typeof web.readDisk, 'undefined', 'a zero from an unsupported build is not a disk reading')
  assert.equal(typeof web.readThermalState, 'undefined')
  assert.equal(typeof web.readMetered, 'undefined')

  // With no platform module at all, even the lifecycle answer stays unknown.
  const blind = conditions.platformDeviceConditionSources({})
  assert.equal(typeof blind.readBackgroundPermitted, 'undefined')
  assert.equal(typeof blind.readDisk, 'undefined')

  // Nothing in the reporter path may name a thermal category or a battery level.
  const source = fs.readFileSync(path.join(appRoot, 'lib/device-conditions.ts'), 'utf8')
  assert.doesNotMatch(source, /thermalState:\s*'/, 'a literal thermal state would be a fabricated reading')
  assert.doesNotMatch(source, /batteryPercent:\s*\d/, 'a literal battery level would be a fabricated reading')
  assert.doesNotMatch(hookSource, /thermalState/, 'the hook supplies modules, it never names a thermal state')
})

test('background permission follows the entitlement that actually keeps this app alive', async () => {
  // iOS `UIBackgroundModes: audio` and the Android `mediaPlayback` foreground
  // service keep the process working while a media session is open. Without one,
  // backgrounding stops the app, and the decision must suspend rather than
  // pretend to seed.
  const playback = { isActive: false }
  const native = conditions.platformDeviceConditionSources({ platformOS: 'android', playback })
  assert.equal(await native.readBackgroundPermitted(), false)
  playback.isActive = true
  assert.equal(await native.readBackgroundPermitted(), true)

  // Without the emitter there is no fact to report.
  const detached = conditions.platformDeviceConditionSources({ platformOS: 'android' })
  assert.equal(await detached.readBackgroundPermitted(), undefined)

  // The desktop shell and the browser keep running while hidden and have no OS
  // background-work permission to consult.
  const web = conditions.platformDeviceConditionSources({ platformOS: 'web' })
  assert.equal(await web.readBackgroundPermitted(), true)
})

test('the reporter reports on foreground and background transitions', async () => {
  const rpc = recordingRpc()
  const clock = fakeClock()
  const appStateHandlers = []
  const playback = { isActive: false }

  const sources = conditions.platformDeviceConditionSources({
    platformOS: 'ios',
    playback,
    appState: {
      addEventListener(type, handler) {
        assert.equal(type, 'change')
        appStateHandlers.push(handler)
        return { remove() { appStateHandlers.length = 0 } }
      },
    },
  })

  const reporter = conditions.createDeviceConditionsReporter({
    rpc,
    sources,
    throttleMs: 10000,
    heartbeatMs: 0,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  await reporter.start()
  assert.equal(appStateHandlers.length, 1, 'the lifecycle listener is subscribed')
  assert.deepEqual(rpc.calls, [{ backgroundPermitted: false }], 'startup reports what the device knows')

  // Backgrounding while a media session is open is legally runnable work.
  playback.isActive = true
  await clock.advance(10000)
  appStateHandlers[0]('background')
  await settle()
  assert.deepEqual(rpc.calls.at(-1), { backgroundPermitted: true }, 'backgrounding with playback reports permitted')

  // Playback ends: the entitlement is gone and the report says so.
  playback.isActive = false
  await clock.advance(10000)
  appStateHandlers[0]('active')
  await settle()
  assert.deepEqual(rpc.calls.at(-1), { backgroundPermitted: false })
  assert.equal(rpc.calls.length, 3)

  reporter.stop()
  assert.equal(appStateHandlers.length, 0, 'stopping unsubscribes the lifecycle listener')
})

test('the reporter reports on network change', async () => {
  const rpc = recordingRpc()
  const clock = fakeClock()
  const listeners = new Map()
  let metered = false

  const sources = conditions.platformDeviceConditionSources({
    platformOS: 'web',
    eventTarget: {
      addEventListener(type, handler) { listeners.set(type, handler) },
      removeEventListener(type) { listeners.delete(type) },
    },
  })
  // The mapping installs no metered reader because no platform here exposes the
  // OS flag; this stands in for one so the network trigger can be observed.
  sources.readMetered = () => metered

  const reporter = conditions.createDeviceConditionsReporter({
    rpc,
    sources,
    throttleMs: 10000,
    heartbeatMs: 0,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  await reporter.start()
  assert.deepEqual([...listeners.keys()].sort(), ['offline', 'online'])
  assert.deepEqual(rpc.calls, [{ metered: false, backgroundPermitted: true }])

  metered = true
  await clock.advance(10000)
  listeners.get('online')()
  await settle()
  assert.deepEqual(rpc.calls.at(-1), { metered: true, backgroundPermitted: true }, 'a network change re-reports')

  reporter.stop()
  assert.equal(listeners.size, 0, 'stopping unsubscribes the network listeners')
})

test('the shipped throttle and heartbeat leave the backend room to breathe', () => {
  assert.ok(conditions.DEVICE_CONDITIONS_THROTTLE_MS > 0, 'an unthrottled reporter would follow every lifecycle flicker')
  assert.ok(
    conditions.DEVICE_CONDITIONS_HEARTBEAT_MS >= conditions.DEVICE_CONDITIONS_THROTTLE_MS,
    'the periodic re-read must be rarer than the change throttle, not faster',
  )
})

test('a burst collapses into one send instead of hammering the backend', async () => {
  const rpc = recordingRpc()
  const clock = fakeClock()
  let tick = 0
  const reporter = conditions.createDeviceConditionsReporter({
    rpc,
    sources: {
      // Every read differs, so nothing is deduplicated and only the throttle can
      // hold the traffic down.
      readDisk: () => ({ freeBytes: 1000 + tick++, totalBytes: 100000 }),
    },
    throttleMs: 10000,
    heartbeatMs: 0,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  await reporter.start()
  assert.equal(rpc.calls.length, 1, 'the first report is immediate')

  for (let index = 0; index < 50; index += 1) await reporter.report()
  assert.equal(rpc.calls.length, 1, 'a burst inside the window sends nothing more')

  // One trailing send carries the whole burst.
  await clock.advance(10000)
  assert.equal(rpc.calls.length, 2)
  assert.equal(clock.pending, 0, 'no timer is left armed for the collapsed reports')

  // The window reopens, so a later change sends again.
  await clock.advance(10000)
  await reporter.report()
  assert.equal(rpc.calls.length, 3)

  reporter.stop()
  await reporter.report()
  await clock.advance(60000)
  assert.equal(rpc.calls.length, 3, 'a stopped reporter sends nothing')
})

test('an unchanged reading never reaches the wire, and a refused one is retried', async () => {
  const rpc = recordingRpc()
  const clock = fakeClock()
  const reporter = conditions.createDeviceConditionsReporter({
    rpc,
    sources: { readBackgroundPermitted: () => true, readDisk: () => ({ freeBytes: 10, totalBytes: 100 }) },
    throttleMs: 1000,
    heartbeatMs: 0,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  await reporter.start()
  assert.equal(rpc.calls.length, 1)

  for (let index = 0; index < 5; index += 1) {
    await clock.advance(1000)
    await reporter.report()
  }
  assert.equal(rpc.calls.length, 1, 'the backend already holds this reading')

  // A refused send was never delivered, so the next attempt must resend rather
  // than deduplicate against a payload the backend never saw.
  rpc.fail = true
  const failures = []
  const retrying = conditions.createDeviceConditionsReporter({
    rpc,
    sources: { readBackgroundPermitted: () => false },
    throttleMs: 0,
    heartbeatMs: 0,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (error) => failures.push(error),
  })
  await retrying.report()
  await retrying.report()
  assert.equal(failures.length, 2, 'both refusals are surfaced')
  assert.deepEqual(rpc.calls.slice(-2), [{ backgroundPermitted: false }, { backgroundPermitted: false }])

  rpc.fail = false
  await retrying.report()
  const delivered = rpc.calls.length
  await retrying.report()
  assert.equal(rpc.calls.length, delivered, 'once delivered, the same reading stops being resent')
  retrying.stop()
  reporter.stop()
})

test('the free-disk reading is re-read on a heartbeat, because it has no change event', async () => {
  const rpc = recordingRpc()
  const clock = fakeClock()
  let freeBytes = 8_000_000_000
  const reporter = conditions.createDeviceConditionsReporter({
    rpc,
    sources: { readDisk: () => ({ freeBytes, totalBytes: 500_000_000_000 }) },
    throttleMs: 1000,
    heartbeatMs: 60000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  await reporter.start()
  assert.equal(rpc.calls.length, 1)

  // Nothing moved: the heartbeat re-reads but does not send.
  await clock.advance(60000)
  assert.equal(rpc.calls.length, 1)

  freeBytes = 1_000_000_000
  await clock.advance(60000)
  assert.deepEqual(rpc.calls.at(-1), { freeDiskBytes: 1_000_000_000, totalDiskBytes: 500_000_000_000 })

  reporter.stop()
  await clock.advance(600000)
  assert.equal(rpc.calls.length, 2, 'stopping disarms the heartbeat')
})

test('one reporter is shared per backend connection, and released when the last caller leaves', async () => {
  const rpc = recordingRpc()
  const sources = { readBackgroundPermitted: () => true }

  const releaseFirst = conditions.startDeviceConditionsReporting(rpc, sources, { heartbeatMs: 0 })
  const releaseSecond = conditions.startDeviceConditionsReporting(rpc, sources, { heartbeatMs: 0 })
  await settle()
  assert.equal(rpc.calls.length, 1, 'a second screen shares the reporter and its throttle')

  releaseFirst()
  releaseFirst()
  releaseSecond()

  // A backend without the method is not an error; it simply cannot be told.
  const release = conditions.startDeviceConditionsReporting({}, sources)
  assert.equal(typeof release, 'function')
  release()
  assert.equal(typeof conditions.startDeviceConditionsReporting(null, sources), 'function')
})

test('startup wires the reporter, so the signals are not left to chance', () => {
  assert.match(hookSource, /export function useDeviceConditionsReporter/)
  assert.match(hookSource, /startDeviceConditionsReporting/)
  assert.match(hookSource, /platformOS: Platform\.OS/)
  assert.match(hookSource, /appState: AppState/)
  assert.match(hookSource, /paths: Paths/)
  assert.match(hookSource, /playback: playbackActiveEmitter/)

  assert.match(layoutSource, /useDeviceConditionsReporter\(activeRpc\)/, 'the root layout reports once the backend is up')
})
