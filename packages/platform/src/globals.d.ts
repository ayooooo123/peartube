export type PlatformRuntimeGlobals = typeof globalThis & {
  Pear?: {
    config?: {
      storage?: string
    }
  }
  Bare?: {
    argv?: unknown[]
  }
}
