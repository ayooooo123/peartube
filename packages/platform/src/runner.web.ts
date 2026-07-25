import { PROTOCOL_EVENTS } from '@peartube/host/events'

import type {
  PlatformLifecycleEvent,
  PlatformRunner,
  ProtocolClientLike,
  PublisherSignerBridgeLike,
} from './rpc.shared'

type WebRunnerDependencies = {
  connectTransport(options: {
    platform: 'mobile' | 'desktop'
    storagePath: string
    entrypoint: string
    args?: string[]
  }): Promise<{
    stream: any
    client?: ProtocolClientLike
    terminate?(): Promise<void> | void
  }>
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

export function resolveWebPublisherSigner(
  publisherSigner: PublisherSignerBridgeLike | null | undefined,
  shellBridgeSigner: PublisherSignerBridgeLike | null | undefined,
): PublisherSignerBridgeLike | null {
  return publisherSigner != null && publisherSigner === shellBridgeSigner
    ? publisherSigner
    : null
}

export function createWebRunner(dependencies: WebRunnerDependencies): PlatformRunner {
  return {
    async start(options) {
      const lifecycle = createLifecycleController()
      const { publisherSigner, ...transportOptions } = options
      const transport = await dependencies.connectTransport(transportOptions)
      const client = transport.client

      if (!client) {
        throw new Error('Web runner requires a pre-created protocol client')
      }

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
        client,
        publisherSigner: publisherSigner ?? undefined,
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
