import type { startHost } from './index.js'

export function runHostSidecar(options?: {
  platform?: 'mobile' | 'desktop'
  storagePath?: string
  entrypoint?: string
  args?: string[]
}): ReturnType<typeof startHost>

export function createProcessTransport(): {
  on(event: string, listener: (...args: any[]) => void): any
  once(event: string, listener: (...args: any[]) => void): any
  off(event: string, listener: (...args: any[]) => void): any
  removeListener(event: string, listener: (...args: any[]) => void): any
  write(chunk: any): any
  end(chunk?: any): any
  destroy(error?: Error): any
}

export function parseSidecarArgv(argv?: string[]): {
  storagePath: string
  entrypoint: string
  args: string[]
}
