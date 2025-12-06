/**
 * RPC Bridge - Exposes worker RPC methods to renderer
 *
 * This bridge is injected by the main process and provides
 * access to the worker's RPC methods.
 */

export interface BackendStatus {
  connected: boolean;
  peers: number;
  storage: string;
  version: string;
}

export interface Identity {
  publicKey: string;
  name?: string;
  createdAt: number;
  isActive?: boolean;
}

export interface CreateIdentityResult {
  success: boolean;
  publicKey: string;
  mnemonic?: string;
}

// This will be injected by the main process
export function getRPCBridge() {
  if (typeof window === 'undefined') {
    throw new Error('RPC bridge only available in renderer');
  }

  const Pear = (window as any).Pear;
  if (!Pear || !Pear.worker) {
    throw new Error('Pear.worker not available - app may not be initialized');
  }

  return Pear.worker;
}

class RPCClient {
  private worker: any;
  private requestId = 0;
  private pending = new Map<number, { resolve: Function; reject: Function }>();

  constructor() {
    try {
      this.worker = getRPCBridge();

      // Listen for messages from worker
      this.worker.on('message', (data: any) => {
        this.handleMessage(data);
      });

      console.log('RPC Client: Connected to worker via Pear.worker');
    } catch (err) {
      console.error('RPC Client: Failed to initialize:', err);
    }
  }

  private handleMessage(data: any) {
    const { id, error, result } = data;
    const handler = this.pending.get(id);
    if (handler) {
      this.pending.delete(id);
      if (error) {
        handler.reject(new Error(error));
      } else {
        handler.resolve(result);
      }
    }
  }

  private async call<T>(method: string, ...args: any[]): Promise<T> {
    if (!this.worker) {
      throw new Error('RPC not ready - worker not connected');
    }

    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 30000);

      this.pending.set(id, {
        resolve: (result: T) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      // Send message to worker
      this.worker.postMessage({ id, method, args });
    });
  }

  async getStatus(): Promise<BackendStatus> {
    return this.call<BackendStatus>('getStatus');
  }

  async createIdentity(name: string, generateMnemonic = true): Promise<CreateIdentityResult> {
    return this.call<CreateIdentityResult>('createIdentity', name, generateMnemonic);
  }

  async recoverIdentity(mnemonic: string, name?: string): Promise<CreateIdentityResult> {
    return this.call<CreateIdentityResult>('recoverIdentity', mnemonic, name);
  }

  async getIdentities(): Promise<Identity[]> {
    return this.call<Identity[]>('getIdentities');
  }

  async setActiveIdentity(publicKey: string): Promise<void> {
    return this.call<void>('setActiveIdentity', publicKey);
  }
}

export const rpc = new RPCClient();
