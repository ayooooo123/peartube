import type { HostLifecycleEvent, HostReadyData } from './index.js'

export interface HostInstance {
  stream: unknown
  entrypoint: string
  args: string[]
  waitUntilReady(): Promise<HostReadyData>
  terminate(): Promise<void>
  onLifecycle(cb: (event: HostLifecycleEvent) => void): () => void
}

export function startHost(options: {
  platform: 'mobile' | 'desktop'
  storagePath: string
  entrypoint: string
  args?: string[]
  stream: any
  createBackendImpl?: (options: any) => Promise<{ destroy?: () => Promise<void> | void }>
  onLifecycle?: (event: HostLifecycleEvent) => void
  onVideoStats?: (...args: any[]) => void
  network?: Record<string, any>
  swarmOptions?: Record<string, any>
}): Promise<HostInstance>
