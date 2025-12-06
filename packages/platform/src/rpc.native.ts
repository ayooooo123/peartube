/**
 * RPC Client - Native (React Native / Mobile)
 *
 * Uses BareKit IPC to communicate with the Bare worklet backend.
 * The backend runs in a separate thread via react-native-bare-kit.
 */

import type { VideoStats } from './types';

// BareKit types (provided by react-native-bare-kit)
declare const BareKit: {
  IPC: {
    write(data: Buffer): void;
    on(event: 'data', callback: (data: Buffer) => void): void;
  };
};

// HRPC instance will be set by the app initialization
let hrpcInstance: any = null;

/**
 * Set the HRPC instance (called during app initialization)
 */
export function setHRPCInstance(rpc: any) {
  hrpcInstance = rpc;
}

/**
 * Get the HRPC instance
 */
export function getHRPCInstance() {
  return hrpcInstance;
}

/**
 * RPC Client for Mobile
 *
 * Provides typed methods that call the backend via HRPC
 */
export const rpc = {
  // Identity
  async createIdentity(name: string) {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.createIdentity({ name });
  },

  async getIdentity() {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.getIdentity({});
  },

  async getIdentities() {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.getIdentities({});
  },

  async setActiveIdentity(publicKey: string) {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.setActiveIdentity({ publicKey });
  },

  // Videos
  async listVideos(channelKey: string) {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.listVideos({ channelKey });
  },

  async getVideoUrl(channelKey: string, videoId: string) {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.getVideoUrl({ channelKey, videoId });
  },

  async prefetchVideo(channelKey: string, videoId: string) {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.prefetchVideo({ channelKey, videoId });
  },

  async getVideoStats(channelKey: string, videoId: string): Promise<{ stats: VideoStats }> {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.getVideoStats({ channelKey, videoId });
  },

  // Channels
  async getChannel(publicKey: string) {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.getChannel({ publicKey });
  },

  async subscribeChannel(channelKey: string) {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.subscribeChannel({ channelKey });
  },

  async getSubscriptions() {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.getSubscriptions({});
  },

  // Public Feed
  async getPublicFeed() {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.getPublicFeed({});
  },

  async refreshFeed() {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.refreshFeed({});
  },

  async getChannelMeta(channelKey: string) {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.getChannelMeta({ channelKey });
  },

  // Status
  async getStatus() {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.getStatus({});
  },

  async getSwarmStatus() {
    if (!hrpcInstance) throw new Error('HRPC not initialized');
    return hrpcInstance.getSwarmStatus({});
  },
};

export type RPCClient = typeof rpc;
