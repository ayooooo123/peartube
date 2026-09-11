import type { HostInstance } from './start-host.js'

type ProcessStream = {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  destroy(): unknown
}

type ProcessTransportEvents = {
  data: Uint8Array | string
  error: Error
  end: undefined
  drain: undefined
  close: undefined
}

export interface ProcessTransport {
  on<E extends keyof ProcessTransportEvents>(event: E, listener: (value: ProcessTransportEvents[E]) => void): this
  once<E extends keyof ProcessTransportEvents>(event: E, listener: (value: ProcessTransportEvents[E]) => void): this
  off<E extends keyof ProcessTransportEvents>(event: E, listener: (value: ProcessTransportEvents[E]) => void): this
  removeListener<E extends keyof ProcessTransportEvents>(event: E, listener: (value: ProcessTransportEvents[E]) => void): this
  write(chunk: Uint8Array | string): boolean | undefined
  end(chunk?: Uint8Array | string): this
  destroy(error?: Error): this
}

export function createProcessTransport(options?: {
  input?: ProcessStream
  output?: ProcessStream & {
    write(chunk: Uint8Array | string): boolean
    end(): unknown
  }
}): ProcessTransport

export function runHostSidecar(options?: {
  platform?: 'mobile' | 'desktop'
  storagePath?: string
  entrypoint?: string
  args?: string[]
  network?: Record<string, unknown>
  swarmOptions?: Record<string, unknown>
}): Promise<HostInstance>

export function parseSidecarArgv(argv?: string[]): {
  storagePath: string
  entrypoint: string
  args: string[]
  network?: Record<string, unknown>
  swarmOptions?: Record<string, unknown>
}
