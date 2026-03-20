import type { startHost } from './index.js'

export function runHostSidecar(options?: {
  platform?: 'mobile' | 'desktop'
  storagePath?: string
  entrypoint?: string
  args?: string[]
}): ReturnType<typeof startHost>

export function parseSidecarArgv(argv?: string[]): {
  storagePath: string
  entrypoint: string
  args: string[]
}
