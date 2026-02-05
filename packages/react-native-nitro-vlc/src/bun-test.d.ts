declare module 'bun:test' {
  export function test(name: string, fn: () => void | Promise<void>): void

  export function expect<T>(value: T): {
    toBe(expected: T): void
    toMatch(expected: RegExp | string): void
  }
}
