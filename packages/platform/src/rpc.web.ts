/**
 * RPC Client - Web (Pear Desktop)
 *
 * Uses the PearWorkerClient to communicate with the Pear worker.
 * The worker runs in a separate process via pear-run.
 */

import type { VideoStats } from './types';

// PearWorkerClient is set on window by worker-client.js
declare global {
  interface Window {
    PearWorkerClient?: {
      rpc: any;
      isConnected: boolean;
      blobServerPort: number | null;
      initialize(): Promise<void>;
    };
  }
}

/**
 * Get the RPC instance from PearWorkerClient
 */
function getRpc() {
  if (typeof window === 'undefined') {
    throw new Error('RPC not available in non-browser context');
  }
  if (!window.PearWorkerClient?.rpc) {
    throw new Error('PearWorkerClient not initialized');
  }
  return window.PearWorkerClient.rpc;
}

/**
 * RPC Client for Desktop (Pear)
 *
 * Provides typed methods that call the backend via HRPC
 */
export const rpc = {
  // Identity
  async createIdentity(name: string) {
    return getRpc().createIdentity({ name });
  },

  async getIdentity() {
    return getRpc().getIdentity({});
  },

  async getIdentities() {
    return getRpc().getIdentities({});
  },

  async setActiveIdentity(publicKey: string) {
    return getRpc().setActiveIdentity({ publicKey });
  },

  async recoverIdentity(seedPhrase: string, name?: string) {
    return getRpc().recoverIdentity({ seedPhrase, name });
  },

  // Videos
  async listVideos(channelKey: string) {
    return getRpc().listVideos({ channelKey });
  },

  async getVideoUrl(channelKey: string, videoId: string) {
    return getRpc().getVideoUrl({ channelKey, videoId });
  },

  async prefetchVideo(channelKey: string, videoId: string) {
    return getRpc().prefetchVideo({ channelKey, videoId });
  },

  async getVideoStats(channelKey: string, videoId: string): Promise<{ stats: VideoStats }> {
    return getRpc().getVideoStats({ channelKey, videoId });
  },

  async uploadVideo(title: string, description: string, filePath: string) {
    return getRpc().uploadVideo({ title, description, filePath });
  },

  // Channels
  async getChannel(publicKey: string) {
    return getRpc().getChannel({ publicKey });
  },

  async subscribeChannel(channelKey: string) {
    return getRpc().subscribeChannel({ channelKey });
  },

  async unsubscribeChannel(channelKey: string) {
    return getRpc().unsubscribeChannel({ channelKey });
  },

  async getSubscriptions() {
    return getRpc().getSubscriptions({});
  },

  // Public Feed
  async getPublicFeed() {
    return getRpc().getPublicFeed({});
  },

  async refreshFeed() {
    return getRpc().refreshFeed({});
  },

  async submitToFeed() {
    return getRpc().submitToFeed({});
  },

  async hideChannel(channelKey: string) {
    return getRpc().hideChannel({ channelKey });
  },

  async getChannelMeta(channelKey: string) {
    return getRpc().getChannelMeta({ channelKey });
  },

  // Status
  async getStatus() {
    return getRpc().getStatus({});
  },

  async getSwarmStatus() {
    return getRpc().getSwarmStatus({});
  },

  async getBlobServerPort() {
    return getRpc().getBlobServerPort({});
  },

  // Desktop-specific
  async pickVideoFile() {
    return getRpc().pickVideoFile({});
  },
};

export type RPCClient = typeof rpc;

/**
 * Initialize the RPC connection
 * Called once during app startup
 */
export async function initializeRPC(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!window.PearWorkerClient) {
    console.warn('[RPC] PearWorkerClient not available');
    return;
  }
  await window.PearWorkerClient.initialize();
}

/**
 * Check if RPC is connected
 */
export function isRPCConnected(): boolean {
  return window?.PearWorkerClient?.isConnected ?? false;
}

/**
 * Get the blob server port
 */
export function getBlobServerPort(): number | null {
  return window?.PearWorkerClient?.blobServerPort ?? null;
}
