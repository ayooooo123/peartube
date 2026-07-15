import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import b4a from 'b4a'

import { createLiveRouteFixture } from '../live-route-fixture.js'
import { LIVE_ROUTE_CONTACTS } from '../live-route-fixture.js'
import { createProcessCoordinator } from '../process/coordinator.js'
import { auditNegativeControlCapture, auditPrivateRouteCapture } from './capture-oracle.js'
import {
  createCaptureMatrix,
  createNamespaceLayout,
  createNamespaceManager,
  namespaceExecLaunch,
  namespaceLaunch
} from './netns.js'
import { parsePcap } from './pcap.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const NEGATIVE_CONTROL_RUNNER = fileURLToPath(new URL('./negative-control.js', import.meta.url))
const GRACE_INTERVAL = 1_750

function invalid(message = 'invalid namespace capture') {
  throw new Error(message)
}

export function tcpdumpLaunch(path) {
  if (typeof path !== 'string' || path.length === 0) invalid()
  return Object.freeze({
    command: 'tcpdump',
    args: Object.freeze([
      '--immediate-mode',
      '-U',
      '-Q',
      'in',
      '-s',
      '0',
      '-w',
      path,
      '-i',
      'any',
      'ip or ip6'
    ])
  })
}

export function createNamespaceFixture(layout, negativeControlPayload, now) {
  if (
    !layout ||
    !Array.isArray(layout.members) ||
    !b4a.isBuffer(negativeControlPayload) ||
    negativeControlPayload.byteLength < 1 ||
    negativeControlPayload.byteLength > 1_200 ||
    typeof now !== 'bigint'
  ) {
    invalid('invalid namespace fixture')
  }
  const routeMembers = layout.members.filter((value) => value.route)
  const sourceMember = routeMembers.find((value) => value.role === 'source')
  const decoyMember = layout.members.find((value) => value.role === 'decoy')
  if (routeMembers.length !== 7 || !sourceMember || !decoyMember) {
    invalid('invalid namespace fixture')
  }
  const fixture = createLiveRouteFixture({
    hosts: routeMembers.map((value) => value.address),
    portBase: layout.portBase,
    now,
    expiresAt: now + 60_000n
  })
  const projections = new Map(fixture.projections)
  projections.set(
    'source',
    Object.freeze({
      ...projections.get('source'),
      negativeControl: Object.freeze({
        bind: Object.freeze({ host: sourceMember.address, port: layout.portBase + 50 }),
        target: Object.freeze({ host: decoyMember.address, port: decoyMember.port }),
        payload: b4a.from(negativeControlPayload)
      })
    })
  )
  return Object.freeze({ ...fixture, projections })
}

export function createTcpdumpCapture(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid()
  const launch = tcpdumpLaunch(options.path)
  const spawnProcess = options.spawnProcess || spawn
  const statFile = options.statFile || stat
  const schedule = options.schedule || setTimeout
  const cancel = options.cancel || clearTimeout
  const deadline = options.deadline === undefined ? 5_000 : options.deadline
  if (
    typeof spawnProcess !== 'function' ||
    typeof statFile !== 'function' ||
    typeof schedule !== 'function' ||
    typeof cancel !== 'function' ||
    !Number.isSafeInteger(deadline) ||
    deadline < 1 ||
    deadline > 10_000
  ) {
    invalid()
  }
  let state = 'new'
  let child = null
  let readinessTimer = null
  let pollTimer = null
  let listening = false
  let exitResult = null
  let resolveExit = null
  let rejectReady = null
  let resolveReady = null
  let ready = null
  let exited = null

  const clearTimers = () => {
    if (readinessTimer !== null) cancel(readinessTimer)
    if (pollTimer !== null) cancel(pollTimer)
    readinessTimer = null
    pollTimer = null
  }

  const rejectStart = (error) => {
    if (state !== 'starting') return
    state = 'failed'
    clearTimers()
    try {
      child.kill('SIGINT')
    } catch {}
    rejectReady(error)
  }

  const pollHeader = async () => {
    if (state !== 'starting' || !listening) return
    try {
      const info = await statFile(options.path)
      if (info && Number.isSafeInteger(info.size) && info.size >= 24) {
        state = 'open'
        clearTimers()
        resolveReady(true)
        return
      }
    } catch {}
    if (state === 'starting') pollTimer = schedule(pollHeader, 5)
  }

  const start = () => {
    if (state !== 'new') return Promise.reject(new Error('capture already started'))
    state = 'starting'
    child = spawnProcess(launch.command, [...launch.args], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    if (
      !child ||
      typeof child.once !== 'function' ||
      typeof child.kill !== 'function' ||
      typeof child.stderr?.on !== 'function'
    ) {
      state = 'failed'
      return Promise.reject(new Error('invalid tcpdump process'))
    }
    ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    exited = new Promise((resolve) => {
      resolveExit = resolve
    })
    child.once('error', (error) => rejectStart(error))
    child.once('close', (code, signal) => {
      exitResult = Object.freeze({ code, signal })
      resolveExit(exitResult)
      if (state === 'starting') rejectStart(new Error('tcpdump exited before readiness'))
    })
    child.stderr.on('data', (chunk) => {
      if (state !== 'starting' || listening) return
      const text = String(chunk)
      if (!text.includes('listening on')) return
      listening = true
      void pollHeader()
    })
    readinessTimer = schedule(() => {
      rejectStart(
        new Error(listening ? 'tcpdump PCAP header deadline' : 'tcpdump readiness deadline')
      )
    }, deadline)
    return ready
  }

  const stop = async () => {
    if (state === 'closed') return false
    if (state !== 'open') throw new Error('capture is not open')
    state = 'stopping'
    if (!child.kill('SIGINT')) throw new Error('could not stop tcpdump')
    const result = exitResult || (await exited)
    state = 'closed'
    if (result.code !== 0 || result.signal !== null) throw new Error('unclean tcpdump exit')
    return true
  }

  const observe = async () => {
    if (state !== 'open') throw new Error('capture is not open')
    const started = Date.now()
    for (;;) {
      try {
        const info = await statFile(options.path)
        if (info && Number.isSafeInteger(info.size) && info.size > 24) return true
      } catch {}
      if (state !== 'open') throw new Error('capture closed before packet observation')
      if (Date.now() - started >= deadline) throw new Error('tcpdump packet deadline')
      await new Promise((resolve) => schedule(resolve, 5))
    }
  }

  return Object.freeze({ start, observe, stop })
}

function executeFile(command, args, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: 64 * 1024, timeout },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${command} failed`))
        else resolve(Object.freeze({ stdout, stderr }))
      }
    )
  })
}

function wait(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay))
}

function wallNowNs() {
  return BigInt(Date.now()) * 1_000_000n
}

function member(layout, role) {
  const value = layout.members.find((entry) => entry.role === role)
  if (!value) invalid('missing namespace member')
  return value
}

function startNamespaceListener(layout, payload, sourceRole, sourcePort, targetRole, targetPort) {
  const source = member(layout, sourceRole)
  const target = member(layout, targetRole)
  const child = spawn(
    'ip',
    [
      'netns',
      'exec',
      target.namespace,
      process.execPath,
      NEGATIVE_CONTROL_RUNNER,
      'listen',
      target.address,
      String(targetPort),
      source.address,
      b4a.toString(payload, 'hex')
    ],
    { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let stderr = ''
  let readyResolve
  let readyReject
  let receivedResolve
  let receivedReject
  let exitResolve
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const received = new Promise((resolve, reject) => {
    receivedResolve = resolve
    receivedReject = reject
  })
  const exited = new Promise((resolve) => {
    exitResolve = resolve
  })
  void ready.catch(() => {})
  void received.catch(() => {})
  const timer = setTimeout(() => {
    const error = new Error('negative control listener deadline')
    readyReject(error)
    receivedReject(error)
    child.kill('SIGTERM')
  }, 5_000)
  const fail = (error) => {
    readyReject(error)
    receivedReject(error)
  }
  child.once('error', () => fail(new Error('negative control listener failed')))
  child.once('close', (code, signal) => {
    clearTimeout(timer)
    const result = Object.freeze({ code, signal, stderr })
    exitResolve(result)
    if (code !== 0 || signal !== null) {
      const detail = stderr.trim()
      const diagnostic = /^negative control failed:[a-z-]{1,32}$/.test(detail)
        ? detail
        : 'negative control listener failed'
      fail(new Error(diagnostic))
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
    if (stderr.length > 1_024) {
      fail(new Error('negative control listener output overflow'))
      child.kill('SIGTERM')
    }
  })
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
    if (stdout.length > 1_024) {
      fail(new Error('negative control listener output overflow'))
      child.kill('SIGTERM')
      return
    }
    for (;;) {
      const newline = stdout.indexOf('\n')
      if (newline === -1) break
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      let record
      try {
        record = JSON.parse(line)
      } catch {
        fail(new Error('negative control listener output invalid'))
        child.kill('SIGTERM')
        return
      }
      if (record.event === 'ready' && Object.keys(record).length === 1) readyResolve(true)
      else if (
        record.event === 'received' &&
        record.bytes === payload.byteLength &&
        record.sourcePort === sourcePort &&
        Object.keys(record).length === 3
      ) {
        receivedResolve(record)
      } else {
        fail(new Error('negative control listener output invalid'))
        child.kill('SIGTERM')
      }
    }
  })
  return Object.freeze({
    ready,
    received,
    exited,
    close() {
      if (child.exitCode !== null || child.signalCode !== null) return false
      return child.kill('SIGTERM')
    }
  })
}

function startNegativeControlListener(layout, payload) {
  const decoy = member(layout, 'decoy')
  return startNamespaceListener(
    layout,
    payload,
    'source',
    layout.portBase + 50,
    'decoy',
    decoy.port
  )
}

async function sendNamespaceProbe(layout, role, bindPort, target, payload) {
  const source = member(layout, role)
  const launch = namespaceExecLaunch(layout, role, process.execPath, [
    NEGATIVE_CONTROL_RUNNER,
    'dial',
    source.address,
    String(bindPort),
    target.host,
    String(target.port),
    b4a.toString(payload, 'hex')
  ])
  const result = await executeFile(launch.command, [...launch.args], 6_000)
  if (result.stderr !== '' || result.stdout !== '{"event":"sent","invocations":1}\n') {
    throw new Error('negative control sender output invalid')
  }
  return true
}

async function proveReachability(layout) {
  const decoy = member(layout, 'decoy')
  for (const routeMember of layout.members.filter((value) => value.route)) {
    await executeFile('ip', [
      'netns',
      'exec',
      routeMember.namespace,
      'ping',
      '-n',
      '-c',
      '1',
      '-W',
      '1',
      decoy.address
    ])
  }
  return true
}

export async function calibrateNegativeControl(options = {}) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !options.layout ||
    !Array.isArray(options.layout.members) ||
    !b4a.isBuffer(options.payload) ||
    options.payload.byteLength < 1 ||
    options.payload.byteLength > 1_200 ||
    typeof options.capturePath !== 'string' ||
    options.capturePath.length === 0 ||
    !options.interfaceIndexes ||
    !Number.isSafeInteger(options.interfaceIndexes.source) ||
    options.interfaceIndexes.source < 1
  ) {
    invalid('invalid negative-control calibration')
  }
  const layout = options.layout
  const payload = options.payload
  const createCapture = options.createCapture || createTcpdumpCapture
  const createListener = options.createListener || startNegativeControlListener
  const sendProbe = options.sendProbe || sendNamespaceProbe
  const readCapture = options.readCapture || readFile
  const parseCapture = options.parseCapture || parsePcap
  const auditCapture = options.auditCapture || auditNegativeControlCapture
  const removeCapture = options.removeCapture || unlink
  for (const dependency of [
    createCapture,
    createListener,
    sendProbe,
    readCapture,
    parseCapture,
    auditCapture,
    removeCapture
  ]) {
    if (typeof dependency !== 'function') invalid('invalid negative-control calibration')
  }
  const source = member(layout, 'source')
  const decoy = member(layout, 'decoy')
  const capture = createCapture({
    path: options.capturePath
  })
  if (
    !capture ||
    typeof capture.start !== 'function' ||
    typeof capture.observe !== 'function' ||
    typeof capture.stop !== 'function'
  ) {
    invalid('invalid negative-control calibration')
  }
  let captureOpen = false
  let listener = null
  let captureBytes = null
  try {
    await capture.start()
    captureOpen = true
    listener = createListener(layout, payload)
    if (
      !listener ||
      !listener.ready ||
      !listener.received ||
      !listener.exited ||
      typeof listener.close !== 'function'
    ) {
      invalid('invalid negative-control calibration')
    }
    await listener.ready
    await sendProbe(
      layout,
      'source',
      layout.portBase + 50,
      { host: decoy.address, port: decoy.port },
      payload
    )
    await listener.received
    const exit = await listener.exited
    if (exit.code !== 0 || exit.signal !== null || exit.stderr !== '') {
      throw new Error('negative control preflight failed')
    }
    listener.close()
    listener = null
    await capture.observe()
    await capture.stop()
    captureOpen = false
    captureBytes = await readCapture(options.capturePath)
    const parsed = parseCapture(captureBytes)
    auditCapture(parsed, {
      source: source.address,
      sourcePort: layout.portBase + 50,
      destination: decoy.address,
      destinationPort: decoy.port,
      sourceInterfaceIndex: options.interfaceIndexes.source,
      payload
    })
    await removeCapture(options.capturePath)
    return true
  } finally {
    if (captureBytes && typeof captureBytes.fill === 'function') captureBytes.fill(0)
    if (listener) listener.close()
    if (captureOpen) {
      try {
        await capture.stop()
      } catch {}
    }
  }
}

async function sendCaptureSentinel(layout, payload) {
  const decoy = member(layout, 'decoy')
  const auditor = member(layout, 'auditor')
  const listener = startNamespaceListener(
    layout,
    payload,
    'decoy',
    decoy.port,
    'auditor',
    auditor.port
  )
  try {
    await listener.ready
    const sentAtNs = wallNowNs()
    const sending = sendNamespaceProbe(
      layout,
      'decoy',
      decoy.port,
      { host: auditor.address, port: auditor.port },
      payload
    )
    const [, received] = await Promise.all([sending, listener.received])
    const receivedAtNs = wallNowNs()
    if (received.bytes !== payload.byteLength || received.sourcePort !== decoy.port) {
      throw new Error('capture sentinel mismatch')
    }
    const exit = await listener.exited
    if (exit.code !== 0 || exit.signal !== null || exit.stderr !== '') {
      throw new Error('capture sentinel failed')
    }
    return Object.freeze({
      source: 'decoy',
      destination: 'auditor',
      sourcePort: decoy.port,
      destinationPort: auditor.port,
      payload: b4a.from(payload),
      sentAtNs,
      receivedAtNs
    })
  } finally {
    listener.close()
  }
}

function assertClosed(events) {
  if (!Array.isArray(events) || events.length !== 7) throw new Error('missing closed events')
  for (const event of events) {
    if (
      event.state !== 'CLOSED' ||
      event.resources.bindings !== 0 ||
      event.resources.waits !== 0 ||
      event.resources.timers !== 0 ||
      event.resources.openSockets !== 0
    ) {
      throw new Error(`unclean closed role: ${event.role}`)
    }
  }
}

export function formatNamespaceAuditSummary(result) {
  if (
    !result ||
    !Number.isSafeInteger(result.packetCount) ||
    !Number.isSafeInteger(result.rolePacketCount) ||
    result.packetCount < 1 ||
    result.rolePacketCount < 1 ||
    result.rolePacketCount > result.packetCount ||
    !Array.isArray(result.observedEdges) ||
    result.observedEdges.length < 1
  ) {
    throw new Error('invalid namespace audit summary')
  }
  return `${JSON.stringify({
    event: 'namespace-private-route-pass',
    packetCount: result.packetCount,
    rolePacketCount: result.rolePacketCount,
    edgeCount: result.observedEdges.length
  })}\n`
}

export function assertRelayFailure(events) {
  if (!Array.isArray(events) || events.length !== 7) {
    throw new Error('relay failure did not propagate')
  }
  const byRole = new Map(events.map((event) => [event?.role, event]))
  if (byRole.size !== 7) throw new Error('relay failure did not propagate')
  for (const role of ['private-entry', 'private-middle', 'private-final']) {
    if (byRole.get(role)?.state !== 'FAILED') {
      throw new Error('relay failure did not propagate')
    }
  }
  if (byRole.get('private-middle')?.resources?.openSockets !== 0) {
    throw new Error('relay failure did not close the dead relay socket')
  }
  return true
}

export async function cleanupNamespaceResources(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    invalid('invalid namespace cleanup')
  }
  const errors = []
  if (options.coordinator) {
    try {
      await options.coordinator.destroy()
    } catch (error) {
      errors.push(error)
    }
  }
  if (options.capture && options.captureOpen) {
    try {
      await options.capture.stop()
    } catch (error) {
      errors.push(error)
    }
  }
  if (options.manager && options.managerOpen) {
    try {
      await options.manager.cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'namespace cleanup failed')
  return true
}

export async function finalizeNamespaceGate(options = {}) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.capturePath !== 'string' ||
    options.capturePath.length === 0 ||
    typeof options.cleanup !== 'function' ||
    typeof options.removeCapture !== 'function'
  ) {
    invalid('invalid namespace finalization')
  }
  await options.cleanup()
  await options.removeCapture(options.capturePath)
  return true
}

export async function runNamespaceGate(options = {}) {
  if (process.platform !== 'linux') throw new Error('Linux is required for the namespace gate')
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    throw new Error('root is required for the namespace gate')
  }
  await executeFile('ip', ['-Version'])
  await executeFile('tcpdump', ['--version'])
  await executeFile('iptables', ['--version'])

  const entropy = randomBytes(4)
  const suffix = b4a.toString(entropy.subarray(0, 3), 'hex')
  const subnetId = 50 + (entropy[3] % 150)
  const portBase = 48_000 + ((entropy[0] * 256 + entropy[1]) % 500)
  entropy.fill(0)
  const layout = createNamespaceLayout({ suffix, subnetId, portBase })
  const artifactDirectory =
    options.artifactDirectory ||
    process.env.PRIVATE_ROUTE_ARTIFACT_DIR ||
    '/tmp/private-route-artifacts'
  await mkdir(artifactDirectory, { recursive: true })
  const capturePath = join(artifactDirectory, `private-route-${suffix}.pcap`)
  const preflightCapturePath = join(artifactDirectory, `private-route-${suffix}-preflight.pcap`)
  const manager = createNamespaceManager({ layout, execute: executeFile })
  const preflightPayload = b4a.from(randomBytes(32))
  const startPayload = b4a.from(randomBytes(32))
  const stopPayload = b4a.from(randomBytes(32))
  let coordinator = null
  let capture = null
  let captureOpen = false
  let managerOpen = false
  let interfaceIndexes = null
  let succeeded = false
  let auditSummary = null
  let cleanupTask = null

  const cleanup = () => {
    if (cleanupTask) return cleanupTask
    const resources = { coordinator, capture, captureOpen, manager, managerOpen }
    coordinator = null
    capture = null
    captureOpen = false
    managerOpen = false
    cleanupTask = cleanupNamespaceResources(resources)
    return cleanupTask
  }
  const onSignal = () => {
    void cleanup().catch(() => {})
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    interfaceIndexes = await manager.setup()
    managerOpen = true
    await proveReachability(layout)
    await calibrateNegativeControl({
      layout,
      payload: preflightPayload,
      capturePath: preflightCapturePath,
      interfaceIndexes
    })

    capture = createTcpdumpCapture({
      path: capturePath
    })
    await capture.start()
    captureOpen = true
    const startSentinel = await sendCaptureSentinel(layout, startPayload)
    await capture.observe()

    const now = BigInt(Date.now())
    const fixture = createNamespaceFixture(layout, preflightPayload, now)
    coordinator = await createProcessCoordinator({
      fixture,
      cwd: PACKAGE_ROOT,
      timeout: 10_000,
      launchRole(role) {
        return namespaceLaunch(layout, role, process.execPath)
      }
    })
    await coordinator.start()
    await coordinator.fault('private-middle', 'close-socket')
    await wait(GRACE_INTERVAL)
    const failureSnapshots = await coordinator.snapshot()
    assertRelayFailure(failureSnapshots)
    const retry = await coordinator.retry('source')
    if (retry.code !== 'ROUTE_UNAVAILABLE' || retry.negativeControlInvocations !== 0) {
      throw new Error('private retry used a fallback')
    }
    const closed = await coordinator.stop()
    const closedAtNs = wallNowNs()
    assertClosed(closed)
    coordinator = null

    await wait(GRACE_INTERVAL)
    const stopSentinel = await sendCaptureSentinel(layout, stopPayload)
    await capture.stop()
    captureOpen = false

    const captureBytes = await readFile(capturePath)
    try {
      const matrix = createCaptureMatrix(
        layout,
        LIVE_ROUTE_CONTACTS,
        {
          captureStartedAtNs: startSentinel.sentAtNs,
          closedAtNs,
          captureStoppedAtNs: stopSentinel.receivedAtNs
        },
        interfaceIndexes,
        Object.freeze({ start: startSentinel, stop: stopSentinel })
      )
      auditSummary = auditPrivateRouteCapture(parsePcap(captureBytes), matrix)
    } finally {
      captureBytes.fill(0)
      startSentinel.payload.fill(0)
      stopSentinel.payload.fill(0)
    }
    await finalizeNamespaceGate({ capturePath, cleanup, removeCapture: unlink })
    succeeded = true
    process.stdout.write(formatNamespaceAuditSummary(auditSummary))
    return true
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    try {
      await cleanup()
    } finally {
      preflightPayload.fill(0)
      startPayload.fill(0)
      stopPayload.fill(0)
      if (!succeeded) process.stderr.write(`namespace capture preserved: ${capturePath}\n`)
    }
  }
}

if (import.meta.main) {
  void runNamespaceGate().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
