import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import b4a from 'b4a'

import { createConfigurationAuditor } from './config-auditor.js'
import { ControlFrameDecoder, encodeControlFrame } from './control-channel.js'

const DEFAULT_DEADLINE = 10_000
const RUNNER = fileURLToPath(new URL('./role-runner.js', import.meta.url))

function invalid(message = 'invalid process coordinator') {
  throw new Error(message)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deadline(value) {
  if (value === undefined) return DEFAULT_DEADLINE
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_DEADLINE) invalid()
  return value
}

function waitFor(record, event, timeout) {
  if (record.failure) return Promise.reject(record.failure)
  const existing = record.events.find(
    (value) => value.event === event && !record.consumed.has(value)
  )
  if (existing) {
    record.consumed.add(existing)
    return Promise.resolve(existing)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      record.waiters.delete(waiter)
      reject(new Error(`process event deadline: ${record.role}:${event}`))
    }, timeout)
    const waiter = {
      event,
      resolve(value) {
        clearTimeout(timer)
        record.waiters.delete(waiter)
        record.consumed.add(value)
        resolve(value)
      },
      reject(error) {
        clearTimeout(timer)
        record.waiters.delete(waiter)
        reject(error)
      }
    }
    record.waiters.add(waiter)
  })
}

function emit(record, value) {
  record.events.push(value)
  if (value.event === 'error') {
    record.failure = new Error(`process error: ${record.role}:${value.code}`)
    for (const waiter of Array.from(record.waiters)) waiter.reject(record.failure)
    return
  }
  for (const waiter of record.waiters) {
    if (waiter.event === value.event) {
      waiter.resolve(value)
      break
    }
  }
}

function writeFrame(record, frame) {
  if (!record.child.stdin.writable) invalid(`closed process input: ${record.role}`)
  return new Promise((resolve, reject) => {
    try {
      record.child.stdin.write(frame, (err) => {
        frame.fill(0)
        if (err) reject(err)
        else resolve(true)
      })
    } catch (err) {
      frame.fill(0)
      reject(err)
    }
  })
}

function send(record, command) {
  const frame = encodeControlFrame(command)
  return writeFrame(record, frame)
}

function launchRole(role, command, args, cwd, auditor) {
  const child = spawn(command, [...args, RUNNER], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const record = {
    role,
    child,
    decoder: new ControlFrameDecoder(),
    events: [],
    consumed: new Set(),
    waiters: new Set(),
    failure: null,
    stderr: '',
    exited: null
  }
  record.exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      const result = Object.freeze({ code, signal })
      for (const waiter of Array.from(record.waiters)) {
        waiter.reject(new Error(`process exited before ${waiter.event}: ${role}`))
      }
      resolve(result)
    })
  })
  child.stdout.on('data', (chunk) => {
    let values
    let owned = null
    try {
      owned = b4a.from(chunk)
      values = record.decoder.push(owned)
      for (const value of values) {
        auditor.auditEvent(role, value)
        emit(record, value)
      }
    } catch (err) {
      for (const waiter of Array.from(record.waiters)) waiter.reject(err)
      child.kill()
    } finally {
      if (owned) owned.fill(0)
    }
  })
  child.stderr.on('data', (chunk) => {
    record.stderr += b4a.toString(chunk)
  })
  return record
}

export async function createProcessCoordinator(options = {}) {
  if (!object(options) || !object(options.fixture)) invalid()
  const fixture = options.fixture
  const roles = [...fixture.roles]
  if (roles.length !== 7 || !(fixture.projections instanceof Map)) invalid()
  const timeout = deadline(options.timeout)
  const command = options.command || process.execPath
  const args = options.args || []
  const cwd = options.cwd
  if (typeof command !== 'string' || !Array.isArray(args) || typeof cwd !== 'string') invalid()
  const auditor = createConfigurationAuditor(fixture)
  const records = new Map()
  let closed = false

  const cleanup = async () => {
    for (const record of records.values()) {
      try {
        record.child.stdin.end()
      } catch {}
      if (record.child.exitCode === null && record.child.signalCode === null) {
        try {
          record.child.kill()
        } catch {}
      }
    }
    const exits = await Promise.allSettled(Array.from(records.values(), (record) => record.exited))
    for (const record of records.values()) record.decoder.destroy()
    auditor.destroy()
    return exits
  }

  try {
    for (const role of roles) {
      records.set(role, launchRole(role, command, args, cwd, auditor))
    }
    for (const role of roles) {
      const projection = fixture.projections.get(role)
      const frame = encodeControlFrame({ command: 'configure', projection })
      try {
        auditor.auditConfiguration(role, projection, frame)
      } catch (err) {
        frame.fill(0)
        throw err
      }
      await writeFrame(records.get(role), frame)
    }
    const configured = await Promise.all(
      roles.map((role) => waitFor(records.get(role), 'configured', timeout))
    )
    for (const event of configured) if (event.runtime !== 'node') invalid('unexpected runtime')
  } catch (err) {
    await cleanup()
    throw err
  }

  const start = async () => {
    await Promise.all(Array.from(records.values(), (record) => send(record, { command: 'start' })))
    const ready = await Promise.all(
      roles.map((role) => waitFor(records.get(role), 'ready', timeout))
    )
    for (const record of records.values()) {
      if (record.stderr.length > 0) invalid(`stderr output from ${record.role}`)
    }
    return ready
  }

  const snapshot = async () => {
    await Promise.all(
      Array.from(records.values(), (record) => send(record, { command: 'snapshot' }))
    )
    return Promise.all(roles.map((role) => waitFor(records.get(role), 'snapshot', timeout)))
  }

  const kill = (role) => {
    const record = records.get(role)
    if (!record || closed || record.child.exitCode !== null || record.child.signalCode !== null) {
      invalid(`cannot kill process: ${role}`)
    }
    if (record.child.kill('SIGTERM') !== true) invalid(`cannot kill process: ${role}`)
    return record.exited
  }

  const fault = async (role, value) => {
    const record = records.get(role)
    if (!record || closed || record.child.exitCode !== null || record.child.signalCode !== null) {
      invalid(`cannot fault process: ${role}`)
    }
    await send(record, { command: 'fault', fault: value })
    return true
  }

  const revoke = async (role, grantDigest32) => {
    const record = records.get(role)
    if (!record || closed || record.child.exitCode !== null || record.child.signalCode !== null) {
      invalid(`cannot revoke process: ${role}`)
    }
    await send(record, { command: 'revoke', grantDigest32 })
    return true
  }

  const stop = async () => {
    if (closed) return []
    closed = true
    try {
      await Promise.all(Array.from(records.values(), (record) => send(record, { command: 'stop' })))
      const events = await Promise.all(
        roles.map((role) => waitFor(records.get(role), 'closed', timeout))
      )
      for (const record of records.values()) record.child.stdin.end()
      const exits = await Promise.all(Array.from(records.values(), (record) => record.exited))
      for (let index = 0; index < roles.length; index++) {
        const record = records.get(roles[index])
        if (record.stderr.length > 0 || exits[index].code !== 0 || exits[index].signal !== null) {
          invalid(`unclean process exit: ${record.role}`)
        }
        record.decoder.destroy()
      }
      auditor.destroy()
      return events
    } catch (err) {
      await cleanup()
      throw err
    }
  }

  const destroy = async () => {
    if (!closed) {
      closed = true
      return cleanup()
    }
    return []
  }

  return Object.freeze({
    roles: Object.freeze(roles),
    start,
    snapshot,
    fault,
    revoke,
    kill,
    stop,
    destroy
  })
}
