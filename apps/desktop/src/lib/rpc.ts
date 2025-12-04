/**
 * RPC Client - Frontend to Backend Communication (IPC v2)
 *
 * Uses pear-run to spawn worker and the returned pipe for bidirectional communication.
 * This is the v2 standard pattern for Pear worker communication.
 */

import path from 'path';
import run from 'pear-run';

// Import shared types - single source of truth
export type {
  BackendStatus,
  Identity,
  CreateIdentityResult,
  Channel,
  Video,
  UploadVideoResult,
  PublicFeedEntry,
  ChannelMetadata,
  VideoStats,
  PublicFeedResult,
} from '@peartube/shared'

import type {
  BackendStatus,
  Identity,
  CreateIdentityResult,
  Channel,
  Video,
  UploadVideoResult,
  PublicFeedResult,
  ChannelMetadata,
  VideoStats,
} from '@peartube/shared'

interface Pipe {
  on(event: 'data', handler: (data: Buffer) => void): void;
  on(event: 'end', handler: () => void): void;
  write(data: string | Buffer): boolean;
  destroy(): void;
}

class RPCClient {
  private requestId = 0;
  private pending = new Map<number, { resolve: Function; reject: Function }>();
  private initialized = false;
  private pipe: Pipe | null = null;
  private messageBuffer = '';

  constructor() {
    if (typeof window !== 'undefined') {
      this.initialize();
    }
  }

  private initialize() {
    const Pear = (window as any).Pear;
    if (!Pear || !Pear.config) {
      console.error('[RPC] Pear config not available');
      return;
    }

    // Build worker path
    const cfg = Pear.config;
    const workerPath = Pear.key
      ? `${cfg.applink || ''}/build/workers/core/index.js`
      : path.join(cfg.dir || '', 'build', 'workers', 'core', 'index.js');

    console.log('[RPC] Spawning worker:', workerPath);

    // pear-run returns a pipe for bidirectional communication
    this.pipe = run(workerPath) as Pipe;

    if (!this.pipe) {
      console.error('[RPC] Failed to create worker pipe');
      return;
    }

    // Handle incoming data from worker
    this.pipe.on('data', (data: Buffer | Uint8Array | string) => {
      // Decode buffer to string
      let str: string;
      if (typeof data === 'string') {
        str = data;
      } else if (data instanceof Uint8Array || ArrayBuffer.isView(data)) {
        str = new TextDecoder().decode(data);
      } else {
        str = (data as Buffer).toString('utf-8');
      }

      // Buffer messages (newline-delimited JSON)
      this.messageBuffer += str;
      const lines = this.messageBuffer.split('\n');
      this.messageBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim() === '') continue;

        try {
          const msg = JSON.parse(line);
          this.handleResponse(msg);
        } catch (err) {
          console.error('[RPC] JSON parse error:', err, 'Line:', line);
        }
      }
    });

    this.pipe.on('end', () => {
      console.log('[RPC] Worker pipe ended');
      this.initialized = false;
      this.pipe = null;
    });

    this.initialized = true;
    console.log('[RPC] Pipe-based RPC initialized (IPC v2)');
  }

  private handleResponse(msg: any) {
    const { id, error, result, type } = msg;

    // Handle RPC responses
    if (type === 'rpc-response' && id !== undefined) {
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
  }

  private async call<T>(method: string, ...args: any[]): Promise<T> {
    if (!this.initialized || !this.pipe) {
      throw new Error('RPC not initialized');
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

      // Send RPC request as newline-delimited JSON
      const request = JSON.stringify({
        type: 'rpc-request',
        id,
        method,
        args
      }) + '\n';

      this.pipe!.write(request);
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

  // Channel methods
  async getChannel(driveKey: string): Promise<Channel> {
    return this.call<Channel>('getChannel', driveKey);
  }

  async listVideos(driveKey: string): Promise<Video[]> {
    return this.call<Video[]>('listVideos', driveKey);
  }

  async uploadVideo(title: string, description: string, filePath: string, mimeType: string): Promise<UploadVideoResult> {
    return this.call<UploadVideoResult>('uploadVideo', title, description, filePath, mimeType);
  }

  // Stream upload - sends binary data directly through pipe
  async streamUpload(
    title: string,
    description: string,
    fileName: string,
    mimeType: string,
    file: File,
    onProgress?: (percent: number) => void
  ): Promise<UploadVideoResult> {
    if (!this.initialized || !this.pipe) {
      throw new Error('RPC not initialized');
    }

    // Start the upload session via RPC
    const session = await this.call<{ uploadId: string; ready: boolean }>(
      'startStreamUpload',
      title,
      description,
      fileName,
      mimeType,
      file.size
    );

    console.log('[RPC] Stream upload started:', session.uploadId);

    // Stream the file through the pipe as raw binary with a simple framing protocol
    // Frame format: [4 bytes: upload ID length][upload ID][4 bytes: chunk length][chunk data]
    const uploadIdBytes = new TextEncoder().encode(session.uploadId);
    const CHUNK_SIZE = 64 * 1024; // 64KB chunks for streaming
    let offset = 0;

    while (offset < file.size) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const chunk = file.slice(offset, end);
      const arrayBuffer = await chunk.arrayBuffer();
      const chunkData = new Uint8Array(arrayBuffer);

      // Create frame: magic byte (0x02 for binary) + uploadId length (4) + uploadId + chunk length (4) + chunk
      const frame = new Uint8Array(1 + 4 + uploadIdBytes.length + 4 + chunkData.length);
      const view = new DataView(frame.buffer);

      let pos = 0;
      frame[pos++] = 0x02; // Binary frame marker
      view.setUint32(pos, uploadIdBytes.length, false); pos += 4;
      frame.set(uploadIdBytes, pos); pos += uploadIdBytes.length;
      view.setUint32(pos, chunkData.length, false); pos += 4;
      frame.set(chunkData, pos);

      this.pipe.write(Buffer.from(frame));

      offset = end;
      if (onProgress) {
        onProgress(Math.round((offset / file.size) * 100));
      }
    }

    // Signal upload complete and get result
    return this.call<UploadVideoResult>('finishStreamUpload', session.uploadId);
  }

  async getVideoUrl(driveKey: string, videoPath: string): Promise<{ url: string }> {
    return this.call<{ url: string }>('getVideoUrl', driveKey, videoPath);
  }

  // Subscription methods
  async subscribeChannel(driveKey: string): Promise<{ success: boolean; driveKey: string }> {
    return this.call<{ success: boolean; driveKey: string }>('subscribeChannel', driveKey);
  }

  async getSubscriptions(): Promise<Channel[]> {
    return this.call<Channel[]>('getSubscriptions');
  }

  async getBlobServerPort(): Promise<{ port: number }> {
    return this.call<{ port: number }>('getBlobServerPort');
  }

  // Public Feed methods
  async getPublicFeed(): Promise<PublicFeedResult> {
    return this.call<PublicFeedResult>('getPublicFeed');
  }

  async refreshFeed(): Promise<{ success: boolean; peerCount: number }> {
    return this.call<{ success: boolean; peerCount: number }>('refreshFeed');
  }

  async getChannelMetadata(driveKey: string): Promise<ChannelMetadata> {
    return this.call<ChannelMetadata>('getChannelMetadata', driveKey);
  }

  async hideChannel(driveKey: string): Promise<{ success: boolean }> {
    return this.call<{ success: boolean }>('hideChannel', driveKey);
  }

  async submitToFeed(driveKey: string): Promise<{ success: boolean }> {
    return this.call<{ success: boolean }>('submitToFeed', driveKey);
  }

  // Video prefetch (start downloading all blocks for seeking)
  async prefetchVideo(driveKey: string, videoPath: string): Promise<{ success: boolean }> {
    return this.call<{ success: boolean }>('prefetchVideo', driveKey, videoPath);
  }

  // Get real-time P2P stats for a video
  async getVideoStats(driveKey: string, videoPath: string): Promise<VideoStats> {
    return this.call<VideoStats>('getVideoStats', driveKey, videoPath);
  }
}

export const rpc = new RPCClient();
