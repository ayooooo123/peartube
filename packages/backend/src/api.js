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
     * Update channel metadata
     * @param {string} driveKey
     * @param {string} name
     * @param {string} [description]
     * @returns {Promise<{success: boolean}>}
     */
    async updateChannel(driveKey, name, description) {
      console.log('[API] UPDATE_CHANNEL:', driveKey?.slice(0, 16));
      try {
        const drive = ctx.drives.get(driveKey);
        if (!drive || !drive.writable) {
          throw new Error('Channel not found or not writable');
        }

        // Get existing metadata
        const metaBuf = await drive.get('/channel.json');
        let meta = {};
        if (metaBuf) {
          meta = JSON.parse(b4a.toString(metaBuf));
        }

        // Update fields
        if (name !== undefined) meta.name = name;
        if (description !== undefined) meta.description = description;
        meta.updatedAt = Date.now();

        await drive.put('/channel.json', Buffer.from(JSON.stringify(meta)));
        console.log('[API] Updated channel:', meta.name);

        return { success: true };
      } catch (err) {
        console.error('[API] UPDATE_CHANNEL error:', err.message);
        return { success: false, error: err.message };
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

    /**
     * Get video metadata by ID or path
     * @param {string} driveKey
     * @param {string} videoId - Video ID or full path
     * @returns {Promise<VideoMetadata|null>}
     */
    async getVideoData(driveKey, videoId) {
      console.log('[API] GET_VIDEO_DATA:', driveKey?.slice(0, 16), videoId);
      try {
        const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 5000 });

        // videoId could be a full path like /videos/xxx.mp4 or just the id
        let metaPath;
        if (videoId.startsWith('/videos/')) {
          // Extract ID from path
          const match = videoId.match(/\/videos\/([^.]+)/);
          if (match) {
            metaPath = `/videos/${match[1]}.json`;
          } else {
            return null;
          }
        } else {
          metaPath = `/videos/${videoId}.json`;
        }

        const metaBuf = await drive.get(metaPath);
        if (metaBuf) {
          const video = JSON.parse(b4a.toString(metaBuf));
          video.channelKey = driveKey;
          return video;
        }
        return null;
      } catch (err) {
        console.error('[API] GET_VIDEO_DATA error:', err.message);
        return null;
      }
    },

/**
     * Delete a video from a channel drive
     * @param {import('hyperdrive')} drive - The writable drive
     * @param {string} videoId - Video ID to delete
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async deleteVideo(drive, videoId) {
      console.log('[API] DELETE_VIDEO:', videoId);

      if (!drive || !drive.writable) {
        return { success: false, error: 'Drive not writable' };
      }

      try {
        // Delete video metadata
        const metaPath = `/videos/${videoId}.json`;
        const metaBuf = await drive.get(metaPath);

        if (!metaBuf) {
          return { success: false, error: 'Video not found' };
        }

        const meta = JSON.parse(b4a.toString(metaBuf));

        // Delete the video file
        if (meta.path) {
          try {
            await drive.del(meta.path);
            console.log('[API] Deleted video file:', meta.path);
          } catch (e) {
            console.log('[API] Could not delete video file:', e.message);
          }
        }

        // Delete thumbnail if exists
        if (meta.thumbnail) {
          try {
            await drive.del(meta.thumbnail);
            console.log('[API] Deleted thumbnail:', meta.thumbnail);
          } catch (e) {
            console.log('[API] Could not delete thumbnail:', e.message);
          }
        }

        // Also try common thumbnail paths
        const thumbnailPaths = [
          `/thumbnails/${videoId}.jpg`,
          `/thumbnails/${videoId}.png`,
          `/thumbnails/${videoId}.webp`,
          `/thumbnails/${videoId}.jpeg`
        ];

        for (const thumbPath of thumbnailPaths) {
          try {
            await drive.del(thumbPath);
          } catch (e) {
            // Ignore - file might not exist
          }
        }

        // Delete the metadata file
        await drive.del(metaPath);
        console.log('[API] Deleted video metadata:', metaPath);

        return { success: true };
      } catch (err) {
        console.error('[API] DELETE_VIDEO error:', err.message);
        return { success: false, error: err.message };
      }
    },

    /**
     * Get video thumbnail URL
     * @param {string} driveKey
     * @param {string} videoId
     * @returns {Promise<{url?: string, exists: boolean}>}
     */
    async getVideoThumbnail(driveKey, videoId) {
      console.log('[API] GET_VIDEO_THUMBNAIL:', driveKey?.slice(0, 16), videoId);
      try {
        const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 5000 });

        const thumbnailPaths = [
          `/thumbnails/${videoId}.jpg`,
          `/thumbnails/${videoId}.png`,
          `/thumbnails/${videoId}.webp`,
          `/thumbnails/${videoId}.jpeg`,
          `/thumbnails/${videoId}.gif`
        ];

        for (const thumbPath of thumbnailPaths) {
          const entry = await drive.entry(thumbPath).catch(() => null);
          const mime = thumbPath.endsWith('.png') ? 'image/png' :
                       thumbPath.endsWith('.webp') ? 'image/webp' :
                       thumbPath.endsWith('.gif') ? 'image/gif' : 'image/jpeg';

          if (entry && entry.value?.blob) {
            const blobsCore = await drive.getBlobs();
            if (blobsCore) {
              const url = ctx.blobServer.getLink(blobsCore.core.key, {
                blob: entry.value.blob,
                type: mime,
                host: ctx.blobServerHost || '127.0.0.1',
                port: ctx.blobServer?.port || ctx.blobServerPort
              });
              console.log('[API] Thumbnail URL:', url);
              return { url, exists: true };
            }
          } else if (entry) {
            // Inline entry - return data URL without mutating the drive
            const buf = await drive.get(thumbPath).catch(() => null);
            if (buf) {
              const dataUrl = `data:${mime};base64,${b4a.from(buf).toString('base64')}`;
              return { url: dataUrl, dataUrl, exists: true };
            }
          }
        }
        return { exists: false };
      } catch (err) {
        console.error('[API] GET_VIDEO_THUMBNAIL error:', err.message);
        return { exists: false, error: err.message };
      }
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
     * @returns {Promise<{success: boolean}>}
     */
    async submitToFeed(driveKey) {
      console.log('[API] Submitting channel to feed:', driveKey?.slice(0, 16));
      if (publicFeed && driveKey) {
        await publicFeed.submitChannel(driveKey);
      }
      return { success: true };
    },

    /**
     * Unpublish channel from public feed
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async unpublishFromFeed(driveKey) {
      console.log('[API] Unpublishing channel from feed:', driveKey?.slice(0, 16));
      if (publicFeed && driveKey) {
        await publicFeed.unpublishChannel(driveKey);
      }
      return { success: true };
    },

    /**
     * Check if channel is published to feed
     * @param {string} driveKey
     * @returns {{published: boolean}}
     */
    isChannelPublished(driveKey) {
      if (publicFeed && driveKey) {
        return { published: publicFeed.isChannelPublished(driveKey) };
      }
      return { published: false };
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

    /**
     * Get video data as base64 for download
     * Reads from Hyperdrive and returns base64-encoded content
     * @param {string} driveKey - Channel drive key
     * @param {string} videoPath - Video path in drive (e.g., /videos/xxx.mp4)
     * @returns {Promise<{success: boolean, data?: string, size?: number, error?: string}>}
     */
    async getVideoData(driveKey, videoPath) {
      console.log('[API] GET_VIDEO_DATA:', driveKey?.slice(0, 16), videoPath);

      try {
        const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 15000 });

        // Get the video entry
        const entry = await drive.entry(videoPath, { wait: true, timeout: 10000 });
        if (!entry) {
          throw new Error('Video not found in drive');
        }

        const totalBytes = entry.value?.blob?.byteLength || 0;
        console.log('[API] Video size:', totalBytes, 'bytes');

        // Read entire file into buffer
        const chunks = [];
        const readStream = drive.createReadStream(videoPath);

        return new Promise((resolve, reject) => {
          readStream.on('data', (chunk) => {
            chunks.push(chunk);
          });

          readStream.on('error', (err) => {
            console.error('[API] Read stream error:', err.message);
            reject(err);
          });

          readStream.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const base64 = buffer.toString('base64');
            console.log('[API] Video data ready, size:', buffer.length, 'base64 length:', base64.length);
            resolve({
              success: true,
              data: base64,
              size: buffer.length
            });
          });
        });
      } catch (err) {
        console.error('[API] GET_VIDEO_DATA error:', err.message);
        return {
          success: false,
          error: err.message
        };
      }
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
    // Storage Management Operations
    // ============================================

    /**
     * Get storage stats for peer content
     * @returns {{ usedBytes: number, maxBytes: number, usedGB: string, maxGB: number, seedCount: number, pinnedCount: number }}
     */
    getStorageStats() {
      if (seedingManager) {
        return seedingManager.getStorageStats();
      }
      return {
        usedBytes: 0,
        maxBytes: 5 * 1024 * 1024 * 1024,
        usedGB: '0.00',
        maxGB: 5,
        seedCount: 0,
        pinnedCount: 0
      };
    },

    /**
     * Set storage limit in GB
     * @param {number} maxGB
     * @returns {Promise<{ success: boolean }>}
     */
    async setStorageLimit(maxGB) {
      console.log('[API] SET_STORAGE_LIMIT:', maxGB, 'GB');
      if (seedingManager) {
        await seedingManager.setMaxStorageGB(maxGB);
        return { success: true };
      }
      return { success: false };
    },

    /**
     * Clear all cached peer content (non-pinned)
     * @returns {Promise<{ success: boolean, clearedBytes: number }>}
     */
    async clearCache() {
      console.log('[API] CLEAR_CACHE');
      if (seedingManager) {
        const clearedBytes = await seedingManager.clearCache();
        return { success: true, clearedBytes };
      }
      return { success: false, clearedBytes: 0 };
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
        blobServerPort: ctx.blobServer?.port || ctx.blobServerPort || 0,
        blobServerHost: ctx.blobServerHost || '127.0.0.1',
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
