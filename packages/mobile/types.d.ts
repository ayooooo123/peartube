// Type declarations for modules without types

declare module 'b4a' {
  export function from(data: string | ArrayBuffer | Uint8Array, encoding?: string): Uint8Array
  export function toString(data: Uint8Array, encoding?: string): string
  export function alloc(size: number): Uint8Array
  export function isBuffer(obj: any): boolean
  export function concat(buffers: Uint8Array[]): Uint8Array
}

declare module 'bare-rpc' {
  interface RPCRequest {
    command: number
    data?: Uint8Array
    send(data: Uint8Array): void
  }

  interface RPC {
    request(command: number): RPCRequest
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
