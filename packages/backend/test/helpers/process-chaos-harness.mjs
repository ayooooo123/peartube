import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const nodeWorker = path.resolve(here, '..', 'fixtures', 'product-chaos-worker.mjs')
const bareWorker = path.resolve(here, '..', 'fixtures', 'mobile-backend-chaos-worker.mjs')

function executableFor(runtime) {
  if (runtime === 'node') return process.execPath
  if (runtime !== 'bare') throw new Error(`Unsupported chaos runtime: ${runtime}`)
  if (process.env.BARE_EXECUTABLE) return process.env.BARE_EXECUTABLE
  return path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'bare.exe' : 'bare')
}

function workerFor(runtime) {
  return runtime === 'bare' ? bareWorker : nodeWorker
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Chaos child ${child.pid} did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    const onExit = (code, signal) => {
      cleanup()
      resolve({ code, signal })
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function waitForMessage(child, wantedType, timeoutMs, output) {
  let buffered = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${wantedType} from chaos child ${child.pid}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`))
    }, timeoutMs)
    timer.unref?.()

    const onData = (chunk) => {
      const text = String(chunk)
      output.stdout = (output.stdout + text).slice(-32_768)
      buffered += text
      while (true) {
        const newline = buffered.indexOf('\n')
        if (newline === -1) break
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (!line.startsWith('{')) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message?.type !== wantedType) continue
        cleanup()
        resolve(message)
        return
      }
    }
    const onStderr = (chunk) => {
      output.stderr = (output.stderr + String(chunk)).slice(-32_768)
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`Chaos child exited before ${wantedType} (code=${code}, signal=${signal})\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`))
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onStderr)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onStderr)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function launch({ runtime, scenario, phase, storagePath }) {
  const output = { stdout: '', stderr: '' }
  const child = spawn(executableFor(runtime), [workerFor(runtime), scenario, phase, storagePath], {
    cwd: path.resolve(here, '..', '..'),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PEARTUBE_CHAOS_CHILD: '1' },
  })
  return { child, output }
}

export async function runCrashRecoveryScenario(t, {
  scenario,
  runtime = 'node',
  timeoutMs = 15_000,
} = {}) {
  if (typeof scenario !== 'string' || scenario.length === 0) throw new Error('scenario is required')
  const storagePath = await mkdtemp(path.join(tmpdir(), `peartube-chaos-${scenario}-`))
  const children = new Set()
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    for (const child of children) terminateProcessTree(child)
    await Promise.allSettled(Array.from(children, child => waitForExit(child, 1_000)))
    await rm(storagePath, { recursive: true, force: true })
  }
  t?.after?.(cleanup)

  try {
    const first = launch({ runtime, scenario, phase: 'prepare', storagePath })
    children.add(first.child)
    const barrier = await waitForMessage(first.child, 'barrier', timeoutMs, first.output)
    if (barrier.scenario !== scenario) throw new Error(`Unexpected chaos barrier for ${barrier.scenario}`)

    terminateProcessTree(first.child)
    const killed = await waitForExit(first.child, timeoutMs)
    children.delete(first.child)
    if (process.platform !== 'win32' && killed.signal !== 'SIGKILL') {
      throw new Error(`Chaos child was not SIGKILLed (code=${killed.code}, signal=${killed.signal})`)
    }

    const restarted = launch({ runtime, scenario, phase: 'recover', storagePath })
    children.add(restarted.child)
    const message = await waitForMessage(restarted.child, 'result', timeoutMs, restarted.output)
    const exit = await waitForExit(restarted.child, timeoutMs)
    children.delete(restarted.child)
    if (exit.code !== 0) {
      throw new Error(`Chaos recovery failed (code=${exit.code}, signal=${exit.signal})\nstdout:\n${restarted.output.stdout}\nstderr:\n${restarted.output.stderr}`)
    }
    await cleanup()
    return message.result
  } catch (error) {
    await cleanup()
    throw error
  }
}
