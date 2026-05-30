/* eslint-disable no-empty */
import { createProtocolClient, PROTOCOL_EVENTS } from '@peartube/protocol'

import { createJsonFrameParser, encodeJsonFrame } from './ipc-json-framing.js'
import type { PlatformLifecycleEvent, PlatformRunner } from './rpc.shared'
import { launchNativeWorklet } from './native-worklet-launch.js'

declare const Buffer: any

type WorkletInstance = {
  start(id: string, source: string, args?: string[]): void
  start(path: string, args?: string[]): void
  terminate(): void
  IPC: any
}

type NativeRunnerDependencies = {
  WorkletCtor: new () => WorkletInstance
  backendSource?: string
  backendPath?: string
  workletId?: string
  shutdownTimeoutMs?: number
  resolveLaunchArgs?(options: {
    platform: 'mobile' | 'desktop'
    storagePath: string
    entrypoint: string
    args?: string[]
  }): string[]
  createProtocolClientImpl?: typeof createProtocolClient
}

function createLifecycleController() {
  const listeners = new Set<(event: PlatformLifecycleEvent) => void>()

  return {
    emit(event: PlatformLifecycleEvent) {
      for (const listener of listeners) listener(event)
    },
    on(listener: (event: PlatformLifecycleEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

function sendShutdownSignalViaIpc(worklet: WorkletInstance, timeoutMs: number) {
  const ipc = worklet?.IPC
  if (!ipc?.write) return Promise.resolve()

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)

    const parser = createJsonFrameParser()

    function onData(chunk: any) {
      for (const message of parser.push(chunk)) {
        if (message?.type === 'shutdown-complete') {
          cleanup()
          resolve()
          return
        }
      }
    }

    function onClose() {
      cleanup()
      resolve()
    }

    function cleanup() {
      clearTimeout(timer)
      try { ipc.removeListener?.('data', onData) } catch {}
      try { ipc.removeListener?.('close', onClose) } catch {}
    }

    try {
      ipc.on?.('data', onData)
      ipc.on?.('close', onClose)
      ipc.write(Buffer.from(encodeJsonFrame({ type: 'shutdown' })))
    } catch {
      cleanup()
      resolve()
    }
  })
}

export function createNativeRunner(dependencies: NativeRunnerDependencies): PlatformRunner {
  const createClient = dependencies.createProtocolClientImpl ?? createProtocolClient

  return {
    async start(options) {
      const lifecycle = createLifecycleController()
      const worklet = new dependencies.WorkletCtor()
      const stream = worklet.IPC
      const client = createClient({ stream })

      const readyPromise = client.ready()

      client.events.on(PROTOCOL_EVENTS.HOST_READY, (data: any) => {
        lifecycle.emit({ type: 'host.ready', data })
      })

      client.events.on(PROTOCOL_EVENTS.HOST_ERROR, (data: any) => {
        lifecycle.emit({ type: 'host.error', ...data })
      })

      client.events.on(PROTOCOL_EVENTS.TRANSPORT_CLOSED, (data: any) => {
        lifecycle.emit({ type: 'transport.closed', reason: data?.reason })
      })

      const launchArgs = dependencies.resolveLaunchArgs
        ? dependencies.resolveLaunchArgs(options)
        : [options.storagePath, options.entrypoint, ...(options.args ?? [])]

      launchNativeWorklet(worklet, {
        backendPath: dependencies.backendPath ?? '',
        backendSource: dependencies.backendSource ?? '',
        workletId: dependencies.workletId ?? options.entrypoint,
        launchArgs,
      })

      let terminated = false

      return {
        stream,
        client,
        waitUntilReady() {
          return readyPromise
        },
        async terminate() {
          if (terminated) return
          terminated = true
          await sendShutdownSignalViaIpc(worklet, dependencies.shutdownTimeoutMs ?? 4000)
          worklet.terminate()
        },
        onLifecycle(listener) {
          return lifecycle.on(listener)
        }
      }
    }
  }
}
