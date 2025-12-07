/**
 * RPC Client - Frontend to Backend Communication via HRPC
 *
 * Uses pear-run to spawn worker and HRPC for typed binary communication.
 */

import path from 'path';
import run from 'pear-run';
// @ts-ignore - Generated HRPC code
import HRPC from '@peartube/spec';

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
} from '@peartube/core'

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
} from '@peartube/core'

interface Pipe {
  on(event: 'data', handler: (data: Buffer) => void): void;
  on(event: 'end', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  write(data: string | Buffer): boolean;
  destroy(): void;
}

// Event callbacks
type ReadyCallback = (data: { blobServerPort?: number }) => void;
type ErrorCallback = (data: { message: string }) => void;
type ProgressCallback = (data: { videoId: string; progress: number; bytesUploaded?: number; totalBytes?: number }) => void;
type FeedUpdateCallback = (data: { channelKey: string; action: string }) => void;
type VideoStatsCallback = (data: { stats: VideoStats }) => void;

class RPCClient {
  private initialized = false;
  private pipe: Pipe | null = null;
  private rpc: any = null;
  private blobServerPort: number = 0;

  // Event handlers
  private onReadyCallbacks: ReadyCallback[] = [];
  private onErrorCallbacks: ErrorCallback[] = [];
  private onProgressCallbacks: ProgressCallback[] = [];
  private onFeedUpdateCallbacks: FeedUpdateCallback[] = [];
  private onVideoStatsCallbacks: VideoStatsCallback[] = [];

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

    // Create HRPC instance with the pipe
    this.rpc = new HRPC(this.pipe);
    console.log('[RPC] HRPC client initialized');

    // Register event handlers
    this.rpc.onEventReady((data: any) => {
      console.log('[RPC] Backend ready, blobServerPort:', data?.blobServerPort);
      this.blobServerPort = data?.blobServerPort || 0;
      this.onReadyCallbacks.forEach(cb => cb(data));
    });

    this.rpc.onEventError((data: any) => {
      console.error('[RPC] Backend error:', data?.message);
      this.onErrorCallbacks.forEach(cb => cb(data));
    });

    this.rpc.onEventUploadProgress((data: any) => {
      this.onProgressCallbacks.forEach(cb => cb(data));
    });

    this.rpc.onEventFeedUpdate((data: any) => {
      this.onFeedUpdateCallbacks.forEach(cb => cb(data));
    });

    this.rpc.onEventVideoStats((data: any) => {
      this.onVideoStatsCallbacks.forEach(cb => cb(data));
    });

    this.pipe.on('end', () => {
      console.log('[RPC] Worker pipe ended');
      this.initialized = false;
      this.pipe = null;
      this.rpc = null;
    });

    this.pipe.on('error', (err: Error) => {
      console.error('[RPC] Pipe error:', err);
    });

    this.initialized = true;
    console.log('[RPC] HRPC-based RPC initialized');
  }

  // Event subscription methods
  onReady(callback: ReadyCallback) {
    this.onReadyCallbacks.push(callback);
  }

  onError(callback: ErrorCallback) {
    this.onErrorCallbacks.push(callback);
  }

  onUploadProgress(callback: ProgressCallback) {
    this.onProgressCallbacks.push(callback);
  }

  onFeedUpdate(callback: FeedUpdateCallback) {
    this.onFeedUpdateCallbacks.push(callback);
  }

  onVideoStats(callback: VideoStatsCallback) {
    this.onVideoStatsCallbacks.push(callback);
  }

  // ============================================
  // RPC Methods - All use generated HRPC client
  // ============================================

  async getStatus(): Promise<BackendStatus> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.getStatus({});
    return {
      connected: true,
      peers: 0,
      storage: '',
      version: '0.1.0',
      blobServerPort: result.status?.blobServerPort || this.blobServerPort,
      ...result.status
    } as BackendStatus;
  }

  async createIdentity(name: string, generateMnemonic = true): Promise<CreateIdentityResult> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.createIdentity({ name });
    return {
      success: true,
      publicKey: result.identity?.publicKey || '',
      driveKey: result.identity?.driveKey || result.identity?.publicKey || '',
      mnemonic: result.identity?.seedPhrase,
    };
  }

  async recoverIdentity(mnemonic: string, name?: string): Promise<CreateIdentityResult> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.recoverIdentity({ seedPhrase: mnemonic });
    return {
      success: true,
      publicKey: result.identity?.publicKey || '',
      driveKey: result.identity?.driveKey || result.identity?.publicKey || '',
    };
  }

  async getIdentities(): Promise<Identity[]> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.getIdentities({});
    return result.identities || [];
  }

  async setActiveIdentity(publicKey: string): Promise<void> {
    if (!this.rpc) throw new Error('RPC not initialized');
    await this.rpc.setActiveIdentity({ publicKey });
  }

  // Channel methods
  async getChannel(driveKey: string): Promise<Channel> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.getChannel({ publicKey: driveKey });
    return result.channel || { driveKey, name: 'Unknown' };
  }

  async listVideos(driveKey: string): Promise<Video[]> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.listVideos({ channelKey: driveKey });
    return result.videos || [];
  }

  async uploadVideo(title: string, description: string, filePath: string, mimeType: string): Promise<UploadVideoResult> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.uploadVideo({ title, description, filePath });
    return {
      success: true,
      videoId: result.video?.id || '',
      metadata: result.video,
    };
  }

  async getVideoUrl(driveKey: string, videoPath: string): Promise<{ url: string }> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.getVideoUrl({ channelKey: driveKey, videoId: videoPath });
    return { url: result.url || '' };
  }

  async setVideoThumbnail(videoId: string, imageData: string, mimeType: string): Promise<{ success: boolean }> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.setVideoThumbnail({ videoId, imageData, mimeType });
    return { success: result.success || false };
  }

  async getVideoThumbnail(driveKey: string, videoId: string): Promise<{ url: string | null; exists: boolean }> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.getVideoThumbnail({ channelKey: driveKey, videoId });
    return { url: result.url || null, exists: result.exists || false };
  }

  // Subscription methods
  async subscribeChannel(driveKey: string): Promise<{ success: boolean; driveKey: string }> {
    if (!this.rpc) throw new Error('RPC not initialized');
    await this.rpc.subscribeChannel({ channelKey: driveKey });
    return { success: true, driveKey };
  }

  async getSubscriptions(): Promise<Channel[]> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.getSubscriptions({});
    return (result.subscriptions || []).map((s: any) => ({
      driveKey: s.channelKey,
      name: s.channelName,
    }));
  }

  async getBlobServerPort(): Promise<{ port: number }> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.getBlobServerPort({});
    return { port: result.port || this.blobServerPort };
  }

  // Public Feed methods
  async getPublicFeed(): Promise<PublicFeedResult> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.getPublicFeed({});
    return {
      entries: (result.entries || []).map((e: any) => ({
        driveKey: e.channelKey,
        channelKey: e.channelKey,
        name: e.channelName,
        videoCount: e.videoCount,
        peerCount: e.peerCount,
        lastSeen: e.lastSeen,
      })),
      stats: { peerCount: 0 }
    };
  }

  async refreshFeed(): Promise<{ success: boolean; peerCount: number }> {
    if (!this.rpc) throw new Error('RPC not initialized');
    await this.rpc.refreshFeed({});
    return { success: true, peerCount: 0 };
  }

  async getChannelMetadata(driveKey: string): Promise<ChannelMetadata> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.getChannelMeta({ channelKey: driveKey });
    return {
      driveKey,
      name: result.name || 'Unknown',
      description: result.description || '',
      videoCount: result.videoCount || 0,
    };
  }

  async hideChannel(driveKey: string): Promise<{ success: boolean }> {
    if (!this.rpc) throw new Error('RPC not initialized');
    await this.rpc.hideChannel({ channelKey: driveKey });
    return { success: true };
  }

  async submitToFeed(driveKey: string): Promise<{ success: boolean }> {
    if (!this.rpc) throw new Error('RPC not initialized');
    await this.rpc.submitToFeed({});
    return { success: true };
  }

  // Video prefetch (start downloading all blocks for seeking)
  async prefetchVideo(driveKey: string, videoPath: string): Promise<{ success: boolean }> {
    if (!this.rpc) throw new Error('RPC not initialized');
    await this.rpc.prefetchVideo({ channelKey: driveKey, videoId: videoPath });
    return { success: true };
  }

  // Get real-time P2P stats for a video
  async getVideoStats(driveKey: string, videoPath: string): Promise<VideoStats> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.getVideoStats({ channelKey: driveKey, videoId: videoPath });
    return result.stats || {
      status: 'unknown',
      progress: 0,
      totalBlocks: 0,
      downloadedBlocks: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      peerCount: 0,
      speedMBps: '0',
      uploadSpeedMBps: '0',
      elapsed: 0,
      isComplete: false,
    };
  }

  // Desktop-specific: Native file picker
  async pickVideoFile(): Promise<{ filePath?: string; name?: string; size?: number; cancelled?: boolean }> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.pickVideoFile({});
    return {
      filePath: result.filePath || undefined,
      cancelled: result.cancelled || false,
    };
  }

  // Swarm status
  async getSwarmStatus(): Promise<{ connected: boolean; peerCount: number }> {
    if (!this.rpc) throw new Error('RPC not initialized');
    const result = await this.rpc.getSwarmStatus({});
    return {
      connected: result.connected || false,
      peerCount: result.peerCount || 0,
    };
  }
}

export const rpc = new RPCClient();
