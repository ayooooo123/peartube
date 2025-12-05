/**
 * Core API Module - Shared backend API methods
 *
 * These methods are used by both mobile and desktop backends.
 * They operate on the storage context and return results.
 */

import b4a from 'b4a';
import { loadDrive, createDrive, getVideoUrl, waitForDriveSync } from './storage.js';

/**
 * @typedef {import('./types.js').StorageContext} StorageContext
 * @typedef {import('./types.js').Identity} Identity
 * @typedef {import('./types.js').VideoMetadata} VideoMetadata
 * @typedef {import('./types.js').ChannelMetadata} ChannelMetadata
 */

/**
 * Create the API object with all shared methods
 *
 * @param {Object} deps
 * @param {StorageContext} deps.ctx - Storage context
 * @param {import('./public-feed.js').PublicFeedManager} [deps.publicFeed] - Public feed manager
 * @param {import('./seeding.js').SeedingManager} [deps.seedingManager] - Seeding manager
 * @param {import('./video-stats.js').VideoStatsTracker} [deps.videoStats] - Video stats tracker
 * @returns {Object}
 */
export function createApi({ ctx, publicFeed, seedingManager, videoStats }) {
  return {
    // ============================================
    // Channel Operations
    // ============================================

    /**
     * Get channel metadata
     * @param {string} driveKey
     * @returns {Promise<ChannelMetadata>}
     */
    async getChannel(driveKey) {
      console.log('[API] GET_CHANNEL:', driveKey?.slice(0, 16));
      try {
        const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 8000 });
        const metaBuf = await drive.get('/channel.json');
        if (metaBuf) {
          const result = JSON.parse(b4a.toString(metaBuf));
          console.log('[API] Got channel:', result.name);
          return result;
        }
        return { name: 'Unknown Channel' };
      } catch (err) {
        console.error('[API] GET_CHANNEL error:', err.message);
        return { name: 'Unknown Channel', error: err.message };
      }
    },

    /**
     * Get channel metadata with video count (for public feed)
     * @param {string} driveKey
     * @returns {Promise<ChannelMetadata>}
     */
    async getChannelMeta(driveKey) {
      console.log('[API] GET_CHANNEL_META:', driveKey?.slice(0, 16));
      try {
        const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 8000 });

        let metaBuf = null;
        try {
          const entryPromise = drive.entry('/channel.json', { wait: true });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Entry fetch timeout')), 5000)
          );
          const entry = await Promise.race([entryPromise, timeoutPromise]);
          if (entry) {
            metaBuf = await drive.get('/channel.json');
          }
        } catch (err) {
          console.log('[API] Entry wait error:', err.message, 'trying direct get...');
          metaBuf = await drive.get('/channel.json');
        }

        if (metaBuf) {
          const meta = JSON.parse(b4a.toString(metaBuf));

          // Count videos
          let videoCount = 0;
          try {
            for await (const entry of drive.readdir('/videos')) {
              if (entry.endsWith('.json')) videoCount++;
            }
          } catch {}

          console.log('[API] Got channel meta:', meta.name, 'videos:', videoCount);
          return {
            ...meta,
            videoCount,
            driveKey
          };
        }

        console.log('[API] No channel.json found for:', driveKey?.slice(0, 16));
        return {
          driveKey,
          name: 'Unknown Channel',
          description: '',
          videoCount: 0
        };
      } catch (err) {
        console.error('[API] GET_CHANNEL_META error:', err.message);
        return {
          driveKey,
          name: 'Unknown Channel',
          description: '',
          videoCount: 0,
          error: err.message
        };
      }
    },

    // ============================================
    // Video Operations
    // ============================================

    /**
     * List videos in a channel
     * @param {string} driveKey
     * @returns {Promise<VideoMetadata[]>}
     */
    async listVideos(driveKey) {
      console.log('[API] LIST_VIDEOS for:', driveKey?.slice(0, 16));
      try {
        const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 8000 });
        const videos = [];

        try {
          for await (const entry of drive.readdir('/videos')) {
            if (entry.endsWith('.json')) {
              const metaBuf = await drive.get(`/videos/${entry}`);
              if (metaBuf) {
                const video = JSON.parse(b4a.toString(metaBuf));
                video.channelKey = driveKey;
                videos.push(video);
              }
            }
          }
        } catch (e) {
          console.log('[API] Error listing videos:', e.message);
        }

        const result = videos.sort((a, b) => b.uploadedAt - a.uploadedAt);
        console.log('[API] Found', result.length, 'videos');
        return result;
      } catch (err) {
        console.error('[API] LIST_VIDEOS error:', err.message);
        return [];
      }
    },

    /**
     * Get video stream URL
     * @param {string} driveKey
     * @param {string} videoPath
     * @returns {Promise<{url: string}>}
     */
    async getVideoUrl(driveKey, videoPath) {
      return getVideoUrl(ctx, driveKey, videoPath);
    },

    // ============================================
    // Subscription Operations
    // ============================================

    /**
     * Subscribe to a channel
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async subscribeChannel(driveKey) {
      await loadDrive(ctx, driveKey);

      const existing = await ctx.metaDb.get('subscriptions');
      const subs = existing?.value || [];

      if (!subs.find(s => s.driveKey === driveKey)) {
        subs.push({
          driveKey,
          subscribedAt: Date.now()
        });
        await ctx.metaDb.put('subscriptions', subs);
      }

      return { success: true };
    },

    /**
     * Unsubscribe from a channel
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async unsubscribeChannel(driveKey) {
      const existing = await ctx.metaDb.get('subscriptions');
      const subs = existing?.value || [];

      const filtered = subs.filter(s => s.driveKey !== driveKey);
      await ctx.metaDb.put('subscriptions', filtered);

      return { success: true };
    },

    /**
     * Get subscriptions list with channel names
     * @returns {Promise<Array<{driveKey: string, name: string, subscribedAt?: number}>>}
     */
    async getSubscriptions() {
      const existing = await ctx.metaDb.get('subscriptions');
      const subs = existing?.value || [];

      const enriched = [];
      for (const sub of subs) {
        const drive = ctx.drives.get(sub.driveKey);
        let name = 'Unknown';
        if (drive) {
          try {
            const meta = await drive.get('/channel.json');
            if (meta) {
              name = JSON.parse(b4a.toString(meta)).name;
            }
          } catch (e) {}
        }
        enriched.push({ ...sub, name });
      }

      return enriched;
    },

    // ============================================
    // Public Feed Operations
    // ============================================

    /**
     * Get public feed entries
     * @returns {{entries: Array, stats: Object}}
     */
    getPublicFeed() {
      if (!publicFeed) {
        return { entries: [], stats: { totalEntries: 0, hiddenCount: 0, peerCount: 0 } };
      }
      const feed = publicFeed.getFeed();
      const stats = publicFeed.getStats();
      console.log(`[API] Returning ${feed.length} feed entries (${stats.peerCount} peers)`);
      return { entries: feed, stats };
    },

    /**
     * Refresh feed from peers
     * @returns {{success: boolean, peerCount: number}}
     */
    refreshFeed() {
      console.log('[API] Refreshing feed...');
      let peerCount = 0;
      if (publicFeed) {
        peerCount = publicFeed.requestFeedsFromPeers();
      }
      return { success: true, peerCount };
    },

    /**
     * Submit channel to public feed
     * @param {string} driveKey
     * @returns {{success: boolean}}
     */
    submitToFeed(driveKey) {
      console.log('[API] Submitting channel to feed:', driveKey?.slice(0, 16));
      if (publicFeed && driveKey) {
        publicFeed.submitChannel(driveKey);
      }
      return { success: true };
    },

    /**
     * Hide channel from feed
     * @param {string} driveKey
     * @returns {{success: boolean}}
     */
    hideChannel(driveKey) {
      console.log('[API] Hiding channel:', driveKey?.slice(0, 16));
      if (publicFeed && driveKey) {
        publicFeed.hideChannel(driveKey);
      }
      return { success: true };
    },

    // ============================================
    // Prefetch and Stats Operations
    // ============================================

    /**
     * Prefetch a video - download all blocks for smooth seeking
     * @param {string} driveKey
     * @param {string} videoPath
     * @returns {Promise<Object>}
     */
    async prefetchVideo(driveKey, videoPath) {
      const prefetchStart = Date.now();

      console.log('[API] ===== STARTING PREFETCH =====');
      console.log('[API] Drive:', driveKey?.slice(0, 16));
      console.log('[API] Path:', videoPath);

      // Clean up any existing monitor
      if (videoStats) {
        videoStats.cleanupMonitor(driveKey, videoPath);
        videoStats.updateStats(driveKey, videoPath, {
          status: 'connecting',
          startTime: prefetchStart
        });
      }

      try {
        const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 10000 });
        const peerCount = ctx.swarm?.connections?.size || 0;
        console.log('[API] Active swarm connections:', peerCount);

        if (videoStats) {
          videoStats.updateStats(driveKey, videoPath, { peerCount, status: 'resolving' });
        }

        // Get the blob entry
        const entry = await drive.entry(videoPath);
        if (!entry || !entry.value?.blob) {
          throw new Error('Video not found in drive');
        }

        const blob = entry.value.blob;
        console.log('[API] Blob info:', JSON.stringify(blob));

        const blobsCore = await drive.getBlobs();
        if (!blobsCore) {
          throw new Error('Could not get blobs core');
        }

        const core = blobsCore.core;
        const startBlock = blob.blockOffset;
        const endBlock = blob.blockOffset + blob.blockLength;
        const totalBlocks = blob.blockLength;
        const totalBytes = blob.byteLength;

        // Count initial blocks already available
        let initialAvailable = 0;
        for (let i = startBlock; i < endBlock; i++) {
          if (core.has(i)) initialAvailable++;
        }
        console.log(`[API] Initial: ${initialAvailable}/${totalBlocks} blocks (${Math.round(initialAvailable/totalBlocks*100)}%)`);

        if (videoStats) {
          videoStats.updateStats(driveKey, videoPath, {
            status: initialAvailable === totalBlocks ? 'complete' : 'downloading',
            totalBlocks,
            totalBytes,
            initialBlocks: initialAvailable,
            downloadedBlocks: 0
          });
          videoStats.emitStats(driveKey, videoPath);
        }

        // If already complete, skip download
        if (initialAvailable === totalBlocks) {
          console.log('[API] Already fully cached');
          if (seedingManager) {
            await seedingManager.addSeed(driveKey, videoPath, 'watched', blob);
          }
          return {
            success: true,
            totalBlocks,
            totalBytes,
            peerCount,
            cached: true,
            message: 'Video already fully cached'
          };
        }

        // Create monitor for progress tracking
        const monitor = drive.monitor(videoPath);
        await monitor.ready();

        let lastLoggedProgress = Math.round((initialAvailable / totalBlocks) * 100);
        let markedAsCached = false;

        const onUpdate = async () => {
          try {
            const stats = monitor.downloadStats;
            const downloadedBlocks = stats.blocks;
            const totalDownloaded = initialAvailable + downloadedBlocks;
            const progress = Math.round((totalDownloaded / totalBlocks) * 100);
            const isComplete = totalDownloaded >= totalBlocks;

            if (videoStats) {
              videoStats.updateStats(driveKey, videoPath, {
                downloadedBlocks,
                peerCount: stats.peers || ctx.swarm?.connections?.size || 0,
                status: isComplete ? 'complete' : 'downloading'
              });
              videoStats.emitStats(driveKey, videoPath);
            }

            if (progress >= lastLoggedProgress + 10 || progress === 100) {
              const speed = monitor.downloadSpeed();
              console.log(`[API] Progress: ${progress}% (${totalDownloaded}/${totalBlocks} blocks, ${(speed / (1024 * 1024)).toFixed(2)} MB/s)`);
              lastLoggedProgress = progress;
            }

            if (isComplete && !markedAsCached) {
              markedAsCached = true;
              console.log('[API] 100% complete');
              if (seedingManager) {
                await seedingManager.addSeed(driveKey, videoPath, 'watched', blob);
              }
            }
          } catch (e) {
            // Ignore errors during progress check
          }
        };

        monitor.on('update', onUpdate);

        if (videoStats) {
          videoStats.registerMonitor(driveKey, videoPath, monitor, () => monitor.off('update', onUpdate));
        }

        // Start downloading all blocks
        const downloadRange = core.download({ start: startBlock, end: endBlock });

        // Handle completion (async, don't await)
        downloadRange.done().then(async () => {
          console.log('[API] Download complete');
          if (videoStats) {
            videoStats.updateStats(driveKey, videoPath, { status: 'complete' });
            // Clean up after delay
            setTimeout(() => videoStats.cleanupMonitor(driveKey, videoPath), 30000);
          }
        }).catch(err => {
          console.error('[API] Prefetch error:', err.message);
          if (videoStats) {
            videoStats.updateStats(driveKey, videoPath, { status: 'error', error: err.message });
            videoStats.cleanupMonitor(driveKey, videoPath);
          }
        });

        return {
          success: true,
          totalBlocks,
          totalBytes,
          peerCount,
          initialBlocks: initialAvailable,
          message: 'Prefetch started'
        };
      } catch (err) {
        console.error('[API] Prefetch error:', err.message);
        if (videoStats) {
          videoStats.updateStats(driveKey, videoPath, { status: 'error', error: err.message });
          videoStats.cleanupMonitor(driveKey, videoPath);
        }
        return { success: false, error: err.message };
      }
    },

    /**
     * Get video stats
     * @param {string} driveKey
     * @param {string} videoPath
     * @returns {Object}
     */
    getVideoStats(driveKey, videoPath) {
      if (videoStats) {
        const stats = videoStats.getStats(driveKey, videoPath);
        if (stats) {
          stats.swarmConnections = ctx.swarm?.connections?.size || 0;
          return stats;
        }
      }

      return {
        status: 'unknown',
        progress: 0,
        totalBlocks: 0,
        downloadedBlocks: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        peerCount: ctx.swarm?.connections?.size || 0,
        swarmConnections: ctx.swarm?.connections?.size || 0,
        speedMBps: '0',
        elapsed: 0,
        isComplete: false
      };
    },

    // ============================================
    // Seeding Operations
    // ============================================

    /**
     * Get seeding status
     * @returns {Promise<Object>}
     */
    async getSeedingStatus() {
      if (seedingManager) {
        return seedingManager.getStatus();
      }
      return { error: 'Seeding manager not initialized' };
    },

    /**
     * Set seeding config
     * @param {Object} config
     * @returns {Promise<Object>}
     */
    async setSeedingConfig(config) {
      if (seedingManager) {
        await seedingManager.setConfig(config);
        return { success: true, config: seedingManager.config };
      }
      return { success: false, error: 'Seeding manager not initialized' };
    },

    /**
     * Pin a channel
     * @param {string} driveKey
     * @returns {Promise<Object>}
     */
    async pinChannel(driveKey) {
      console.log('[API] PIN_CHANNEL:', driveKey?.slice(0, 16));
      if (seedingManager && driveKey) {
        await seedingManager.pinChannel(driveKey);
        await loadDrive(ctx, driveKey);
        return { success: true };
      }
      return { success: false, error: 'Invalid request' };
    },

    /**
     * Unpin a channel
     * @param {string} driveKey
     * @returns {Promise<Object>}
     */
    async unpinChannel(driveKey) {
      console.log('[API] UNPIN_CHANNEL:', driveKey?.slice(0, 16));
      if (seedingManager && driveKey) {
        await seedingManager.unpinChannel(driveKey);
        return { success: true };
      }
      return { success: false, error: 'Invalid request' };
    },

    /**
     * Get pinned channels
     * @returns {{channels: string[]}}
     */
    getPinnedChannels() {
      if (seedingManager) {
        return { channels: seedingManager.getPinnedChannels() };
      }
      return { channels: [] };
    },

    // ============================================
    // Status Operations
    // ============================================

    /**
     * Get backend status
     * @returns {Object}
     */
    getStatus() {
      return {
        connected: true,
        peers: ctx.swarm?.connections?.size || 0,
        blobServerPort: ctx.blobServerPort,
        version: '0.1.0'
      };
    },

    /**
     * Get swarm status for debugging
     * @returns {Object}
     */
    getSwarmStatus() {
      const topicHex = publicFeed ? b4a.toString(publicFeed.feedTopic, 'hex') : 'not initialized';
      return {
        swarmConnections: ctx.swarm?.connections?.size || 0,
        swarmPeers: ctx.swarm?.peers?.size || 0,
        feedConnections: publicFeed?.feedConnections?.size || 0,
        feedEntries: publicFeed?.entries?.size || 0,
        feedTopicHex: topicHex,
        swarmPublicKey: ctx.swarm?.keyPair?.publicKey
          ? b4a.toString(ctx.swarm.keyPair.publicKey, 'hex').slice(0, 32)
          : 'unknown',
        drivesLoaded: ctx.drives.size,
      };
    }
  };
}
