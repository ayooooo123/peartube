import { createProtocolClient, PROTOCOL_EVENTS } from '@peartube/protocol'

import type { PlatformLifecycleEvent, PlatformRunner } from './rpc.shared'

type WebRunnerDependencies = {
  connectTransport(options: {
    platform: 'mobile' | 'desktop'
    storagePath: string
    entrypoint: string
    args?: string[]
  }): Promise<{
    stream: any
    terminate?(): Promise<void> | void
  }>
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

export function createWebRunner(dependencies: WebRunnerDependencies): PlatformRunner {
  const createClient = dependencies.createProtocolClientImpl ?? createProtocolClient

  return {
    async start(options) {
      const lifecycle = createLifecycleController()
      const transport = await dependencies.connectTransport(options)
      const client = createClient({ stream: transport.stream })
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

      let terminated = false

      return {
        stream: transport.stream,
        waitUntilReady() {
          return readyPromise
        },
        async terminate() {
          if (terminated) return
          terminated = true
          await transport.terminate?.()
          transport.stream?.destroy?.()
        },
        onLifecycle(listener) {
          return lifecycle.on(listener)
        }
      }
    }
  }
}
