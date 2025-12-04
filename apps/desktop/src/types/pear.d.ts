/**
 * Type declarations for Pear runtime modules
 * These modules don't have official TypeScript types yet
 */

declare module 'pear-bridge' {
  export default class PearBridge {
    constructor(options: { waypoint: string });
    ready(): Promise<void>;
  }
}

declare module 'pear-electron' {
  export default class PearElectron {
    start(options: { bridge: any }): Promise<any>;
  }
}

declare module 'pear-run' {
  export default function run(path: string, args?: string[]): any;
}

declare module 'pear-message' {
  export default function message(data: any): Promise<void>;
}

declare module 'pear-messages' {
  interface PearMessageStream {
    on(event: 'data', handler: (msg: any) => void): void;
    destroy(): void;
  }
  export default function messages(pattern?: any, listener?: (msg: any) => void): PearMessageStream;
}

declare module 'pear-message' {
  export default function message(data: any): Promise<void>;
}

declare module 'pear-messages' {
  interface PearMessageStream {
    on(event: 'data', handler: (msg: any) => void): void;
    destroy(): void;
  }
  export default function messages(pattern?: any, listener?: (msg: any) => void): PearMessageStream;
}

declare module 'pear-ipc-client' {
  export default class PearIPCClient {
    // Add methods as needed
  }
}

declare module 'framed-stream' {
  import { Duplex } from 'stream';
  export default class FramedStream extends Duplex {
    constructor(stream: any);
  }
}

declare module 'tiny-buffer-rpc' {
  export default class RPC {
    constructor(send: (data: Buffer) => void);
    on(method: string, handler: (req: any) => Promise<any>): void;
    recv(data: Buffer): void;
    call(method: string, ...args: any[]): Promise<any>;
  }
}

declare module 'hyperswarm' {
  import { EventEmitter } from 'events';

  export default class Hyperswarm extends EventEmitter {
    connections: Set<any>;
    destroy(): void;
  }
}

declare module 'hyperdrive' {
  export default class Hyperdrive {
    constructor(store: any, key?: Buffer);
    ready(): Promise<void>;
    key: Buffer;
  }
}

declare module 'corestore' {
  export default class Corestore {
    constructor(storage: string | ((name: string) => any));
  }
}

declare module 'hyperbee' {
  export default class Hyperbee {
    constructor(core: any, options?: any);
    ready(): Promise<void>;
    get(key: string): Promise<{ value: any } | null>;
    put(key: string, value: any): Promise<void>;
    del(key: string): Promise<void>;
  }
}

declare module 'hypercore' {
  export default class Hypercore {
    constructor(storage: any, key?: Buffer, options?: any);
    ready(): Promise<void>;
    key: Buffer;
  }
}

declare module 'hypercore-crypto' {
  export function randomBytes(n: number): Buffer;
  export function keyPair(seed?: Buffer): { publicKey: Buffer; secretKey: Buffer };
  export function sign(message: Buffer, secretKey: Buffer): Buffer;
  export function verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean;
}

declare module 'autobase' {
  export default class Autobase {
    constructor(store: any, bootstrap?: Buffer[], options?: any);
    ready(): Promise<void>;
  }
}

declare module 'b4a' {
  export function from(input: string | Buffer | Uint8Array, encoding?: string): Buffer;
  export function toString(buffer: Buffer, encoding?: string): string;
  export function isBuffer(obj: any): boolean;
  export function concat(buffers: Buffer[]): Buffer;
}

// Global Pear runtime object
declare const Pear: {
  config: {
    storage: string;
    args: string[];
  };
  message(data: any): Promise<void>;
  messages(pattern?: any, listener?: (msg: any) => void): {
    on(event: 'data', handler: (msg: any) => void): void;
    destroy(): void;
  };
  updates(callback: () => void): void;
  reload(): void;
  worker: {
    pipe(): any;
  };
  exit(code: number): void;
  versions(): Promise<{
    app: { fork: string; length: number; key: string };
    platform: { fork: string; length: number; key: string };
  }>;
};
