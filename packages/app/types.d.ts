// Type declarations for modules without types

declare module 'b4a' {
  export function from(data: string | ArrayBuffer | Uint8Array, encoding?: string): Uint8Array
  export function toString(data: Uint8Array, encoding?: string): string
  export function alloc(size: number): Uint8Array
  export function isBuffer(obj: any): boolean
  export function concat(buffers: Uint8Array[]): Uint8Array
  export function equals(left: Uint8Array, right: Uint8Array): boolean
}

declare module 'hypercore-crypto' {
  export function keyPair(seed?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array }
  export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array
  export function verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean
  export function hash(data: Uint8Array | Uint8Array[], out?: Uint8Array): Uint8Array
  export function randomBytes(n: number): Uint8Array
}

declare module 'pear-runtime' {
  import type { ChildProcess } from 'child_process'
  import type { Duplex, Readable, Writable } from 'stream'

  // bare-sidecar handle: stream.Duplex IPC pipe with the worker's spawned process
  // and fixed pipe stdio (spawn stdio: ['pipe', 'pipe', 'pipe', 'overlapped']).
  interface PearRuntimeIpc extends Duplex {
    _process: ChildProcess
    readonly stdin: Writable
    readonly stdout: Readable
    readonly stderr: Readable
  }

  // module.exports = class PearRuntime — `run` is a static (and instance) alias
  // for lib/run, which returns the bare-sidecar IPC duplex.
  class PearRuntime {
    static run(entrypoint: string, args?: string[], opts?: Record<string, unknown>): PearRuntimeIpc
    run(entrypoint: string, args?: string[], opts?: Record<string, unknown>): PearRuntimeIpc
  }

  export = PearRuntime
}

declare module 'bare-rpc' {
  interface RPCRequest {
    command: number
    data?: Uint8Array
    send(data: Uint8Array): void
  }

  class RPC {
    constructor(stream: any, handler?: (req: RPCRequest) => void)
    request(command: number): RPCRequest
  }

  export default RPC
}

declare module 'react-native-bare-kit' {
  interface IPC {
    on(event: string, handler: (...args: any[]) => void): void
    write(data: Uint8Array): void
  }

  export class Worklet {
    IPC: IPC
    start(filename: string, source: string, args?: string[]): void
    terminate(): void
  }
}
