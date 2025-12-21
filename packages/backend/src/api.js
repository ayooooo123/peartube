/**
 * Core API Module - Shared backend API methods
 *
 * These methods are used by both mobile and desktop backends.
 * They operate on the storage context and return results.
 */

import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import { loadDrive, createDrive, getVideoUrl, getVideoUrlFromBlob, waitForDriveSync, loadChannel, loadPublicBee, pairDevice as pairChannelDevice, suspendNetworking, resumeNetworking, getNetworkStats, getNetworkStatsReadable } from './storage.js';
import { SemanticFinder } from './search/semantic-finder.js';
import { FederatedSearch } from './search/federated-search.js';
import { Recommender } from './recommendations/recommender.js';

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
  async function isMultiWriterChannelKey(channelKey) {
    try {
      const res = await ctx.metaDb.get(`mw-channel:${channelKey}`)
      return Boolean(res?.value)
    } catch {
      // Fall through to other checks
    }

    // Fallback: if channel is already loaded in-memory, treat it as multi-writer.
    if (ctx.channels && ctx.channels.has(channelKey)) return true

    // Fallback: if this channel key exists in identities as a channelKey, treat as multi-writer.
    try {
      const stored = await ctx.metaDb.get('identities')
      const identities = stored?.value || []
      if (identities.some((i) => i?.channelKey === channelKey || i?.driveKey === channelKey)) {
        // Backfill marker so future checks are fast
        try { await ctx.metaDb.put(`mw-channel:${channelKey}`, { kind: 'autobase', backfilledAt: Date.now() }) } catch {}
        return true
      }
    } catch {}

    return false
  }

  function isHyperdriveDecodeError(err) {
    const msg = (err && err.message) ? String(err.message) : ''
    // hypercore / hyperbee / hyperdrive tend to surface this exact message for schema mismatch or corruption
    return msg.includes('DECODING_ERROR') || msg.includes('Decoded message is not valid')
  }

  async function markAsMultiWriterChannel(channelKey) {
    try {
      await ctx.metaDb.put(`mw-channel:${channelKey}`, { kind: 'autobase', discoveredAt: Date.now() })
    } catch {}
  }

  // ------------------------------------------------------------
  // Lightweight in-memory caching (worker-local)
  // ------------------------------------------------------------
  // The app UI (home tab) re-mounts on navigation and calls getChannelMeta/listVideos each time.
  // Cache recent results in the backend worker so back-navigation is instant.
  const LIST_VIDEOS_CACHE_TTL_MS = 15_000
  const CHANNEL_META_CACHE_TTL_MS = 30_000

  /** @type {Map<string, { ts: number, value: any[] }>} */
  const listVideosCache = new Map()
  /** @type {Map<string, { ts: number, value: any }>} */
  const channelMetaCache = new Map()

  function cloneArrayOfObjects(arr) {
    if (!Array.isArray(arr)) return []
    return arr.map((v) => (v && typeof v === 'object') ? { ...v } : v)
  }

  function cloneObject(obj) {
    if (!obj || typeof obj !== 'object') return obj
    return { ...obj }
  }

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
        if (await isMultiWriterChannelKey(driveKey)) {
        const channel = await loadChannel(ctx, driveKey)
          const meta = await channel.getMetadata()
          return {
            name: meta?.name || 'Channel',
            description: meta?.description || '',
            avatar: meta?.avatar || null,
            createdAt: meta?.createdAt || Date.now(),
            publicKey: meta?.createdBy || null
          }
        }

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
          // If the key is actually an Autobase (multi-writer) channel key, Hyperdrive will throw a decoding error.
          if (isHyperdriveDecodeError(err)) {
            console.log('[API] GET_CHANNEL: Hyperdrive decode error; retrying as multi-writer channel')
            const channel = await loadChannel(ctx, driveKey).catch(() => null)
            if (channel) {
              await markAsMultiWriterChannel(driveKey)
        const meta = await channel.getMetadata().catch(() => null)
        return {
          name: meta?.name || 'Channel',
          description: meta?.description || '',
          avatar: meta?.avatar || null,
                createdAt: meta?.createdAt || Date.now(),
          publicKey: meta?.createdBy || null
              }
            }
          }
          throw err
        }
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
        if (await isMultiWriterChannelKey(driveKey)) {
        const channel = await loadChannel(ctx, driveKey)
        await channel.updateMetadata({ name, description: description || '', avatar: null })
        return { success: true }
        }

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
        const cached = channelMetaCache.get(driveKey)
        if (cached && (Date.now() - cached.ts) < CHANNEL_META_CACHE_TTL_MS) {
          return cloneObject(cached.value)
        }

        // Fast path for known multi-writer channels.
        if (await isMultiWriterChannelKey(driveKey)) {
          const channel = await loadChannel(ctx, driveKey)
          const meta = await channel.getMetadata().catch(() => null)
          const videos = await channel.listVideos().catch(() => [])
          const result = {
            driveKey,
            name: meta?.name || 'Channel',
            description: meta?.description || '',
            avatar: meta?.avatar || null,
            createdAt: meta?.createdAt || Date.now(),
            publicKey: meta?.createdBy || null,
            videoCount: videos?.length || 0
          }
          channelMetaCache.set(driveKey, { ts: Date.now(), value: result })
          return cloneObject(result)
        }

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
          const result = {
            ...meta,
            videoCount,
            driveKey
          };
          channelMetaCache.set(driveKey, { ts: Date.now(), value: result })
          return cloneObject(result)
        }

        console.log('[API] No channel.json found for:', driveKey?.slice(0, 16));
        const result = {
          driveKey,
          name: 'Unknown Channel',
          description: '',
          videoCount: 0
        };
        channelMetaCache.set(driveKey, { ts: Date.now(), value: result })
        return cloneObject(result)
      } catch (err) {
        // If this key is actually an Autobase (multi-writer) channel key, treating it like a Hyperdrive
        // will surface as a decoding error. Retry as multi-writer and persist the marker.
        if (isHyperdriveDecodeError(err)) {
          console.log('[API] GET_CHANNEL_META: Hyperdrive decode error; retrying as multi-writer channel')
          const channel = await loadChannel(ctx, driveKey).catch(() => null)
          if (channel) {
            await markAsMultiWriterChannel(driveKey)
            const meta = await channel.getMetadata().catch(() => null)
            const videos = await channel.listVideos().catch(() => [])
            const result = {
              driveKey,
          name: meta?.name || 'Channel',
          description: meta?.description || '',
          avatar: meta?.avatar || null,
              createdAt: meta?.createdAt || Date.now(),
          publicKey: meta?.createdBy || null,
          videoCount: videos?.length || 0
        }
            channelMetaCache.set(driveKey, { ts: Date.now(), value: result })
        return cloneObject(result)
          }
        }
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
     * @param {string} [publicBeeKey] - Optional PublicBee key for fast viewer access
     * @returns {Promise<VideoMetadata[]>}
     */
    async listVideos(driveKey, publicBeeKey) {
      console.log('[API] LIST_VIDEOS for:', driveKey?.slice(0, 16), 'publicBeeKey:', publicBeeKey?.slice(0, 16));
      try {
        const cached = listVideosCache.get(driveKey)
        if (cached && (Date.now() - cached.ts) < LIST_VIDEOS_CACHE_TTL_MS) {
          return cloneArrayOfObjects(cached.value)
        }

        // FAST PATH: If publicBeeKey is provided, read directly from PublicBee
        // This is the preferred path for public feed viewers - no Autobase sync needed
        // IMPORTANT: If publicBeeKey is provided, this is definitely a multi-writer channel,
        // so we should NEVER fall through to the Hyperdrive path.
        if (publicBeeKey) {
          console.log('[API] LIST_VIDEOS: using PublicBee fast path')
          // Mark as multi-writer since PublicBee is only used with multi-writer channels
          await markAsMultiWriterChannel(driveKey)
          try {
            const publicBee = await loadPublicBee(ctx, publicBeeKey)
            const videos = await publicBee.listVideos()
            console.log('[API] LIST_VIDEOS: PublicBee returned', videos?.length, 'videos')
            const result = (videos || []).map(v => ({ ...v, channelKey: driveKey, publicBeeKey }))
            listVideosCache.set(driveKey, { ts: Date.now(), value: result })
            return cloneArrayOfObjects(result)
          } catch (err) {
            console.log('[API] LIST_VIDEOS: PublicBee fast path failed:', err.message, '- trying channel directly')
            // If PublicBee fails, try loading the channel directly (for paired devices or when PublicBee isn't synced)
            try {
              const channel = await loadChannel(ctx, driveKey)
              const videos = await channel.listVideos()
              console.log('[API] LIST_VIDEOS: channel fallback returned', videos?.length, 'videos')
              const result = (videos || []).map(v => ({ ...v, channelKey: driveKey, publicBeeKey }))
              listVideosCache.set(driveKey, { ts: Date.now(), value: result })
              return cloneArrayOfObjects(result)
            } catch (channelErr) {
              console.log('[API] LIST_VIDEOS: channel fallback also failed:', channelErr.message)
              // Return empty - do NOT fall through to Hyperdrive since this is a multi-writer channel
              return []
            }
          }
        }

        const isMW = await isMultiWriterChannelKey(driveKey)
        console.log('[API] LIST_VIDEOS isMultiWriterChannel:', isMW, 'cached:', ctx.channels?.has(driveKey))
        if (isMW) {
          const channel = await loadChannel(ctx, driveKey)
          console.log('[API] LIST_VIDEOS channel loaded, calling listVideos...')

          // IMPORTANT: Never block listVideos on network sync.
          // Mobile has a 30s init timeout, and pairing/DHT discovery can exceed that.
          // Return current materialized view immediately; the UI already retries.
          const videos = await channel.listVideos()
          console.log('[API] LIST_VIDEOS returning', videos?.length, 'videos from channel')
          const result = (videos || []).map(v => ({ ...v, channelKey: driveKey }))
          listVideosCache.set(driveKey, { ts: Date.now(), value: result })
          return cloneArrayOfObjects(result)
        }

        // Try loading as Hyperdrive (legacy channels)
        try {
          const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 8000 });
          const videos = [];

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

          const result = videos.sort((a, b) => b.uploadedAt - a.uploadedAt);
          console.log('[API] Found', result.length, 'videos');
          listVideosCache.set(driveKey, { ts: Date.now(), value: result })
          return cloneArrayOfObjects(result)
        } catch (e) {
          console.log('[API] Error listing videos:', e.message);
          // If the key we got from discovery is actually an Autobase channel key, Hyperdrive will throw a decoding error.
          // Retry as multi-writer channel and persist the marker so later calls (e.g. getVideoUrl) use the correct path.
          if (isHyperdriveDecodeError(e)) {
            console.log('[API] LIST_VIDEOS: Hyperdrive decode error; retrying as multi-writer channel')
            const channel = await loadChannel(ctx, driveKey).catch(() => null)
            if (channel) {
              await markAsMultiWriterChannel(driveKey)
              const mwVideos = await channel.listVideos().catch(() => [])
              console.log('[API] LIST_VIDEOS: multi-writer retry returned', mwVideos?.length || 0, 'videos')
              const result = (mwVideos || []).map(v => ({ ...v, channelKey: driveKey }))
              listVideosCache.set(driveKey, { ts: Date.now(), value: result })
              return cloneArrayOfObjects(result)
            }
          }
          // Return empty if all methods fail
          return []
        }
      } catch (err) {
        console.error('[API] LIST_VIDEOS error:', err.message);
        return [];
      }
    },

    /**
     * Get video stream URL
     * @param {string} driveKey
     * @param {string} videoPath
     * @param {string} [publicBeeKey] - PublicBee key for fast viewer access
     * @returns {Promise<{url: string}>}
     */
    async getVideoUrl(driveKey, videoPath, publicBeeKey) {
      console.log('[API] getVideoUrl:', driveKey?.slice(0, 16), videoPath, 'publicBeeKey:', publicBeeKey?.slice(0, 16));

      // Use PublicBee fast path if available (for viewers)
      if (publicBeeKey || await isMultiWriterChannelKey(driveKey)) {
        console.log('[API] getVideoUrl: is multi-writer channel');
      const meta = await this.getVideoData(driveKey, videoPath, publicBeeKey)
        console.log('[API] getVideoUrl meta:', meta?.id, 'blobId:', meta?.blobId, 'blobsCoreKey:', meta?.blobsCoreKey?.slice(0, 16))
        if (!meta) {
          console.log('[API] getVideoUrl: no metadata found');
          throw new Error('Video metadata not found')
        }

      if (!meta.blobId) {
          console.log('[API] getVideoUrl: missing blobId');
          throw new Error('Video is missing blobId (not synced yet)')
        }

        // Fast path: if we have blobsCoreKey from PublicBee, use it directly
        if (meta.blobsCoreKey) {
          console.log('[API] getVideoUrl: using blobsCoreKey directly from metadata');
          const blobsKeyHex = meta.blobsCoreKey;
          
          // Join swarm for blobs core to ensure we can download from peers
          if (ctx.swarm) {
            try {
              const keyBuf = b4a.from(blobsKeyHex, 'hex')
              const discoveryKey = crypto.discoveryKey(keyBuf)
              ctx.swarm.join(discoveryKey)
              console.log('[API] getVideoUrl: joined swarm for blobs core:', blobsKeyHex.slice(0, 16));
            } catch (err) {
              console.log('[API] getVideoUrl: swarm join error:', err?.message);
            }
          }
          
          console.log('[API] getVideoUrl: blobsKey:', blobsKeyHex.slice(0, 16), 'blobId:', meta.blobId);
          return getVideoUrlFromBlob(ctx, blobsKeyHex, meta.blobId, { mimeType: meta.mimeType })
        }

        // Fallback: load channel to get blob entry (slower)
        console.log('[API] getVideoUrl: loading channel for blob entry (slow path)');
        const channel = await loadChannel(ctx, driveKey)
        if (!channel) {
          console.log('[API] getVideoUrl: failed to load channel');
          throw new Error('Failed to load channel')
        }

        const blobEntry = await channel.getBlobEntry(meta)
        if (!blobEntry?.blobsKey) {
          console.log('[API] getVideoUrl: failed to get blob entry');
          throw new Error('Video blob not accessible (not synced yet)')
        }

        // Join swarm for blobs core to ensure we can download from peers
        if (ctx.swarm && blobEntry.blobsKey) {
          try {
            const discoveryKey = crypto.discoveryKey(blobEntry.blobsKey)
            ctx.swarm.join(discoveryKey)
          } catch {}
        }

        const blobsKeyHex = b4a.toString(blobEntry.blobsKey, 'hex')
        console.log('[API] getVideoUrl: blobsKey:', blobsKeyHex.slice(0, 16), 'blobId:', meta.blobId);
        return getVideoUrlFromBlob(ctx, blobsKeyHex, blobEntry.blobId, { mimeType: meta.mimeType })
      }
      // Legacy Hyperdrive channels: accept either a full path (/videos/{id}.ext) or a video id.
      let resolvedPath = videoPath
      try {
        if (typeof resolvedPath === 'string' && resolvedPath && !resolvedPath.startsWith('/')) {
          const meta = await this.getVideoData(driveKey, resolvedPath)
          if (meta?.path) resolvedPath = meta.path
        }
      } catch {}
      return getVideoUrl(ctx, driveKey, resolvedPath);
    },

    /**
     * Download video to a local file path
     * @param {string} channelKey - Channel key (hex)
     * @param {string} videoId - Video ID
     * @param {string} destPath - Destination file path
     * @param {Object} fsModule - File system module (bare-fs or node:fs)
     * @param {Function} [onProgress] - Progress callback (progress, bytesWritten, totalBytes)
     * @returns {Promise<{success: boolean, filePath?: string, error?: string}>}
     */
    async downloadVideo(channelKey, videoId, destPath, fsModule, onProgress) {
      console.log('[API] downloadVideo:', channelKey?.slice(0, 16), videoId, 'to:', destPath);
      try {
        const meta = await this.getVideoData(channelKey, videoId);
        if (!meta) {
          return { success: false, error: 'Video metadata not found' };
        }

        if (!meta.blobId || !meta.blobsCoreKey) {
          return { success: false, error: 'Video missing blobId or blobsCoreKey' };
        }

        // Parse blobId
        const parts = meta.blobId.split(':').map(Number);
        if (parts.length !== 4) {
          return { success: false, error: 'Invalid blob ID format' };
        }
        const blob = {
          blockOffset: parts[0],
          blockLength: parts[1],
          byteOffset: parts[2],
          byteLength: parts[3]
        };

        // Load channel and get blobs core
        const channel = await loadChannel(ctx, channelKey);
        if (!channel) {
          return { success: false, error: 'Failed to load channel' };
        }

        const blobEntry = await channel.getBlobEntry(meta);
        if (!blobEntry?.blobsKey) {
          return { success: false, error: 'Video blob not accessible (not synced yet)' };
        }

        // Load the blobs Hypercore
        const blobsCore = ctx.store.get(blobEntry.blobsKey);
        await blobsCore.ready();

        // Create Hyperblobs reader
        const Hyperblobs = (await import('hyperblobs')).default;
        const blobs = new Hyperblobs(blobsCore);
        await blobs.ready();

        // Stream the blob to the destination file
        const totalBytes = blob.byteLength;
        let bytesWritten = 0;

        const readStream = blobs.createReadStream(blob);
        const writeStream = fsModule.createWriteStream(destPath);

        await new Promise((resolve, reject) => {
          readStream.on('data', (chunk) => {
            bytesWritten += chunk.length;
            if (onProgress) {
              const progress = Math.round((bytesWritten / totalBytes) * 100);
              onProgress(progress, bytesWritten, totalBytes);
            }
          });
          readStream.on('error', reject);
          writeStream.on('error', reject);
          writeStream.on('close', resolve);
          readStream.pipe(writeStream);
        });

        console.log('[API] downloadVideo complete:', destPath);
        return { success: true, filePath: destPath, size: totalBytes };
      } catch (err) {
        console.error('[API] downloadVideo failed:', err?.message);
        return { success: false, error: err?.message || 'Download failed' };
      }
    },

    /**
     * Get video metadata by ID or path
     * @param {string} driveKey
     * @param {string} videoId - Video ID or full path
     * @param {string} [publicBeeKey] - PublicBee key for fast viewer access
     * @returns {Promise<VideoMetadata|null>}
     */
    async getVideoData(driveKey, videoId, publicBeeKey) {
      console.log('[API] GET_VIDEO_DATA:', driveKey?.slice(0, 16), videoId, 'publicBeeKey:', publicBeeKey?.slice(0, 16));
      try {
        // Parse videoId to extract the actual ID
        let id = videoId
        if (typeof videoId === 'string' && videoId.startsWith('/videos/')) {
          const match = videoId.match(/\/videos\/([^.]+)/)
          if (match) id = match[1]
        }

        // Fast path: use PublicBee if we have the key (for viewers)
        if (publicBeeKey) {
          console.log('[API] GET_VIDEO_DATA: using PublicBee fast path')
          const publicBee = await loadPublicBee(ctx, publicBeeKey)
          const v = await publicBee.getVideo(id)
          console.log('[API] GET_VIDEO_DATA PublicBee result:', v?.id, 'blobId:', v?.blobId, 'blobsCoreKey:', v?.blobsCoreKey?.slice(0, 16))
          if (v) return { ...v, channelKey: driveKey }
          // Fall through to other methods if not found
        }

        const isMW = await isMultiWriterChannelKey(driveKey)
        console.log('[API] GET_VIDEO_DATA isMultiWriter:', isMW)
        if (isMW) {
          const channel = await loadChannel(ctx, driveKey)
          console.log('[API] GET_VIDEO_DATA channel loaded')
          console.log('[API] GET_VIDEO_DATA looking up id:', id)

          const v = await channel.getVideo(id)
          console.log('[API] GET_VIDEO_DATA result:', v?.id, 'blobId:', v?.blobId, 'blobsCoreKey:', v?.blobsCoreKey?.slice(0, 16))
        if (!v) return null
        return { ...v, channelKey: driveKey }
        }

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
        // Get video metadata to find thumbnail blob info
        const meta = await this.getVideoData(driveKey, videoId);
        if (!meta) {
          return { exists: false };
        }

        // New Hyperblobs-based thumbnail
        if (meta.thumbnailBlobId && meta.thumbnailBlobsCoreKey) {
          console.log('[API] GET_VIDEO_THUMBNAIL: thumbnailBlobsCoreKey length:', meta.thumbnailBlobsCoreKey?.length);
          console.log('[API] GET_VIDEO_THUMBNAIL: thumbnailBlobsCoreKey value:', meta.thumbnailBlobsCoreKey);
          const keyBuffer = b4a.from(meta.thumbnailBlobsCoreKey, 'hex');
          console.log('[API] GET_VIDEO_THUMBNAIL: keyBuffer length:', keyBuffer.length, 'bytes, isBuffer:', b4a.isBuffer(keyBuffer));
          console.log('[API] GET_VIDEO_THUMBNAIL: calling store.get...');
          
          let blobsCore;
          try {
            blobsCore = ctx.store.get(keyBuffer);
            console.log('[API] GET_VIDEO_THUMBNAIL: store.get returned, calling ready...');
            await blobsCore.ready();
            console.log('[API] GET_VIDEO_THUMBNAIL: ready done, blobsCore.key length:', blobsCore.key?.length, 'bytes');
          } catch (storeErr) {
            console.error('[API] GET_VIDEO_THUMBNAIL: store.get or ready FAILED:', storeErr.message, storeErr.stack);
            throw storeErr;
          }

          // Join swarm for thumbnail core
          if (ctx.swarm && blobsCore.discoveryKey) {
            try { ctx.swarm.join(blobsCore.discoveryKey) } catch {}
          }

          // Parse blobId string to blob object
          const parts = meta.thumbnailBlobId.split(':').map(Number);
          const blob = {
            blockOffset: parts[0],
            blockLength: parts[1],
            byteOffset: parts[2],
            byteLength: parts[3]
          };

          console.log('[API] GET_VIDEO_THUMBNAIL: blobsCore.key hex:', blobsCore.key ? b4a.toString(blobsCore.key, 'hex') : 'NULL');
          console.log('[API] GET_VIDEO_THUMBNAIL: ctx.blobServer exists:', !!ctx.blobServer);
          const url = ctx.blobServer.getLink(blobsCore.key, {
            blob,
          type: 'image/jpeg',
          host: ctx.blobServerHost || '127.0.0.1',
          port: ctx.blobServer?.port || ctx.blobServerPort
          });
          console.log('[API] Thumbnail URL (Hyperblobs):', url);
          return { url, exists: true };
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
      // Don't let loadDrive hang forever - use a 5s timeout
      // If it times out, we still add to subscriptions (data will sync later when peers are found)
      try {
            await Promise.race([
          loadDrive(ctx, driveKey),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Drive load timeout')), 5000))
        ]);
      } catch (err) {
        console.log('[API] subscribeChannel: drive load warning:', err.message, '- continuing anyway');
      }

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
        // Get publicBeeKey from the channel for fast viewer access
        let publicBeeKey = null;
        try {
          const channel = await loadChannel(ctx, driveKey);
          publicBeeKey = channel?.publicBeeKey || await channel?.getPublicBeeKey();
          console.log('[API] submitToFeed: got publicBeeKey:', publicBeeKey?.slice(0, 16));

          // Use channel's CommentsAutobase directly - it's already initialized in _open()
          // and has the key stored in channel metadata + synced to PublicBee
          const commentsBase = await channel.getCommentsAutobase();
          if (commentsBase?.keyHex) {
            console.log('[API] submitToFeed: CommentsAutobase key:', commentsBase.keyHex.slice(0, 16));

            // Ensure PublicBee has the commentsAutobaseKey synced
            if (channel.publicBee?.writable) {
              const pubMeta = await channel.publicBee.getMetadata().catch(() => ({}));
              if (!pubMeta?.commentsAutobaseKey) {
                await channel.publicBee.setMetadata({
                  ...pubMeta,
                  commentsAutobaseKey: commentsBase.keyHex
                });
                console.log('[API] submitToFeed: synced commentsAutobaseKey to PublicBee');
              }
            }
          }
        } catch (err) {
          console.log('[API] submitToFeed: channel/comments init error:', err?.message);
        }
        await publicFeed.submitChannel(driveKey, publicBeeKey);
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

      // Check if corestore is still open
      if (ctx.store.closed) {
        console.log('[API] Corestore is closed, skipping prefetch');
        return { success: false, error: 'Corestore is closed' };
      }

      // Multi-writer channels: resolve the blob source drive+path (per-writer Hyperdrive)
      let resolvedDriveKey = driveKey
      let resolvedPath = videoPath
      let isMultiWriter = await isMultiWriterChannelKey(driveKey)
      let channel = null
      if (isMultiWriter) {
        const v = await this.getVideoData(driveKey, videoPath)
        if (v?.blobDriveKey && v?.path) {
          resolvedDriveKey = v.blobDriveKey
          resolvedPath = v.path

          // Get channel for blob drive access
          channel = await loadChannel(ctx, driveKey)
          // Join swarm for blob drive if it's from another device
          if (channel?.joinBlobDrive) {
            await channel.joinBlobDrive(resolvedDriveKey).catch(() => {})
          }
        }
      }

      // Clean up any existing monitor
      if (videoStats) {
        videoStats.cleanupMonitor(driveKey, videoPath);
        videoStats.updateStats(driveKey, videoPath, {
          status: 'connecting',
          startTime: prefetchStart
        });
      }

      try {
        // For multi-writer channels, get blob drive from channel's cache
        // For legacy drives, use loadDrive from storage
        let drive;
        if (isMultiWriter && channel) {
          drive = await channel.getBlobDrive(resolvedDriveKey);
          console.log('[API] Prefetch: using blob drive from channel');
        } else {
          drive = await loadDrive(ctx, resolvedDriveKey, { waitForSync: true, syncTimeout: 10000 });
        }
        const peerCount = ctx.swarm?.connections?.size || 0;
        console.log('[API] Active swarm connections:', peerCount);

        if (videoStats) {
          videoStats.updateStats(driveKey, videoPath, { peerCount, status: 'resolving' });
        }

        // Get the blob entry
        const entry = await drive.entry(resolvedPath);
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
            await seedingManager.addSeed(resolvedDriveKey, resolvedPath, 'watched', blob);
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
        const monitor = drive.monitor(resolvedPath);
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
                await seedingManager.addSeed(resolvedDriveKey, resolvedPath, 'watched', blob);
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
          // Don't log as error if corestore was closed (expected during app shutdown)
          if (err.message?.includes('closed') || ctx.store.closed) {
            console.log('[API] Prefetch cancelled (corestore closed)');
          } else {
            console.error('[API] Prefetch error:', err.message);
          }
          if (videoStats) {
            videoStats.updateStats(driveKey, videoPath, { status: 'cancelled' });
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
     * Prefetch next videos in a channel for smooth playback.
     * Called when a video starts playing to preload upcoming content.
     *
     * @param {string} channelKey - Channel key
     * @param {string} currentVideoId - Current video ID being watched
     * @param {number} [count=3] - Number of next videos to prefetch
     * @returns {Promise<{success: boolean, prefetchedCount?: number, error?: string}>}
     */
    async prefetchNextVideos(channelKey, currentVideoId, count = 3) {
      console.log('[API] prefetchNextVideos: channel:', channelKey?.slice(0, 16), 'current:', currentVideoId, 'count:', count)

      try {
        // Get list of videos for this channel
        const videosResult = await this.listVideos({ channelKey })
        const videos = videosResult?.videos || []

        if (videos.length === 0) {
          console.log('[API] prefetchNextVideos: no videos found')
          return { success: true, prefetchedCount: 0 }
        }

        // Find current video index
        const currentIndex = videos.findIndex(v =>
          v.id === currentVideoId ||
          v.videoId === currentVideoId ||
          v.path?.includes(currentVideoId)
        )

        if (currentIndex === -1) {
          console.log('[API] prefetchNextVideos: current video not found in list')
          // Fall back to prefetching first N videos
          const toPreload = videos.slice(0, count)
          for (const video of toPreload) {
            const videoRef = video.id || video.videoId || video.path
            // Fire and forget - don't wait for each prefetch
            this.prefetchVideo(channelKey, videoRef).catch(() => {})
          }
          return { success: true, prefetchedCount: toPreload.length }
        }

        // Get next N videos after current
        const nextVideos = videos.slice(currentIndex + 1, currentIndex + 1 + count)
        console.log('[API] prefetchNextVideos: found', nextVideos.length, 'videos to prefetch')

        // Start prefetching in background (fire and forget)
        let prefetchedCount = 0
        for (const video of nextVideos) {
          const videoRef = video.id || video.videoId || video.path
          console.log('[API] prefetchNextVideos: starting prefetch for:', videoRef)
          // Don't await - run in background
          this.prefetchVideo(channelKey, videoRef).catch(err => {
            console.log('[API] prefetchNextVideos: prefetch error for', videoRef, ':', err?.message)
          })
          prefetchedCount++
        }

        return { success: true, prefetchedCount }
      } catch (err) {
        console.error('[API] prefetchNextVideos error:', err.message)
        return { success: false, prefetchedCount: 0, error: err.message }
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

    ,
    // ============================================
    // Multi-device pairing (Multi-writer channels)
    // ============================================

    /**
     * Create a device invite code for a multi-writer channel.
     * @param {string} channelKey
     * @returns {Promise<{inviteCode: string}>}
     */
    async createDeviceInvite(channelKey) {
      const channel = await loadChannel(ctx, channelKey)
      const inviteCode = await channel.createInvite({})
      return { inviteCode }
    },

    /**
     * Pair this device to an existing channel using an invite code.
     * @param {string} inviteCode
     * @param {string} [deviceName]
     * @returns {Promise<{success: boolean, channelKey: string, syncState?: string, videoCount?: number}>}
     */
    async pairDevice(inviteCode, deviceName = '') {
      const { channel, channelKeyHex } = await pairChannelDevice(ctx, inviteCode, { deviceName })

      // Use smart sync - waits for peer connection first, then polls for data
      console.log('[API] pairDevice: starting smart sync...')
      const syncResult = await channel.waitForInitialSync({
        peerTimeout: 30000,  // 30s for DHT discovery
        dataTimeout: 20000,  // 20s for data sync after connected
        onProgress: (state, detail) => {
          console.log('[API] pairDevice sync progress:', state, detail)
        }
      })

      console.log('[API] pairDevice: sync result:', syncResult)

      return {
        success: true,
        channelKey: channelKeyHex,
        syncState: syncResult.state,
        videoCount: syncResult.videoCount
      }
    },

    /**
     * Retry syncing a channel that may have failed initial sync.
     * @param {string} channelKey
     * @returns {Promise<{success: boolean, state: string, videoCount: number}>}
     */
    async retrySyncChannel(channelKey) {
      const channel = await loadChannel(ctx, channelKey)

      console.log('[API] retrySyncChannel: starting sync for', channelKey?.slice(0, 16))
      const result = await channel.waitForInitialSync({
        peerTimeout: 30000,
        dataTimeout: 20000,
        onProgress: (state, detail) => {
          console.log('[API] retrySyncChannel progress:', state, detail)
        }
      })

      return {
        success: result.success,
        state: result.state,
        videoCount: result.videoCount
      }
    },

    /**
     * List known devices/writers for a channel.
     * @param {string} channelKey
     * @returns {Promise<{devices: Array<{keyHex: string, role?: string, deviceName?: string, addedAt?: number, blobDriveKey?: string|null}>}>}
     */
    async listDevices(channelKey) {
      const channel = await loadChannel(ctx, channelKey)
      const devices = await channel.listWriters()
      return { devices }
    },

    // ============================================
    // Search Operations
    // ============================================

    /**
     * Search videos in a channel using semantic search
     * @param {string} channelKey
     * @param {string} query
     * @param {Object} [options]
     * @param {number} [options.topK=10]
     * @param {boolean} [options.federated=true]
     * @returns {Promise<Array<{id: string, score: number, metadata: any}>>}
     */
    async searchVideos(channelKey, query, options = {}) {
      const { topK = 10, federated = true } = options

      // Initialize semantic finder if not already done
      if (!ctx.semanticFinder) {
        ctx.semanticFinder = new SemanticFinder()
        await ctx.semanticFinder.init()
      }

      // Initialize federated search if not already done
      if (!ctx.federatedSearch && ctx.swarm) {
        ctx.federatedSearch = new FederatedSearch(ctx.swarm, ctx.semanticFinder)
        const channelKeyBuf = b4a.from(channelKey, 'hex')
        ctx.federatedSearch.setupTopic(channelKeyBuf)
      }

      // Use federated search if available, otherwise local only
      if (ctx.federatedSearch && federated) {
        return await ctx.federatedSearch.search(query, { topK, federated, timeout: 5000 })
      } else {
        return await ctx.semanticFinder.search(query, topK)
      }
    },

    /**
     * Index a video for semantic search
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{success: boolean}>}
     */
    async indexVideoVectors(channelKey, videoId) {
      try {
        // Get video data
        const video = await this.getVideoData(channelKey, videoId)
        if (!video) {
          return { success: false, error: 'Video not found' }
        }

        // Initialize semantic finder if not already done
        if (!ctx.semanticFinder) {
          ctx.semanticFinder = new SemanticFinder()
          await ctx.semanticFinder.init()
        }

        // Index the video
        await ctx.semanticFinder.indexVideo(
          videoId,
          video.title || '',
          video.description || '',
          { channelKey, ...video }
        )

        // Store vector index op in Autobase (for replication)
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (isMW) {
        const channel = await loadChannel(ctx, channelKey)
        const embedding = await ctx.semanticFinder.embed(`${video.title || ''} ${video.description || ''}`)
        const vectorBase64 = b4a.toString(Buffer.from(embedding.buffer), 'base64')

          await channel.base.append({
          type: 'add-vector-index',
          schemaVersion: 1,
          videoId,
          vector: vectorBase64,
          text: `${video.title || ''} ${video.description || ''}`,
          metadata: JSON.stringify({ channelKey, title: video.title }),
          indexedAt: Date.now()
        })
        }

        return { success: true }
      } catch (err) {
        console.error('[API] indexVideoVectors error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ============================================
    // Comments Operations (using separate CommentsAutobase)
    // ============================================

    /**
     * Get or create CommentsAutobase for a channel
     * @param {string} channelKey
     * @param {string} [publicBeeKey] - PublicBee key for looking up commentsAutobaseKey
     * @returns {Promise<import('./channel/comments-autobase.js').CommentsAutobase>}
     */
    async _getCommentsAutobase(channelKey, publicBeeKey = null) {
      console.log('[API] _getCommentsAutobase: START channelKey:', channelKey?.slice(0, 16), 'publicBeeKey:', publicBeeKey?.slice(0, 16) || 'null')

      // Lazy import to avoid circular deps
      console.log('[API] _getCommentsAutobase: importing comments-autobase...')
      const { getOrCreateCommentsAutobase } = await import('./channel/comments-autobase.js')
      console.log('[API] _getCommentsAutobase: import complete')

      // Cache key
      const cacheKey = `comments:${channelKey}`
      if (!ctx._commentsCache) ctx._commentsCache = new Map()

      // IMPORTANT: listComments + getReactions are commonly called in parallel.
      // If we don't cache the in-flight open, we'll instantiate multiple Autobase
      // instances for the same key on the same Corestore, which can lead to flaky
      // replication / empty reads.
      const cached = ctx._commentsCache.get(cacheKey)
      if (cached) {
        console.log('[API] _getCommentsAutobase: found cached promise, waiting with 12s timeout...')
        // Add timeout to prevent hanging forever on a stuck promise
        // Must be longer than CommentsAutobase internal timeout (8s for viewer ready)
        const result = await Promise.race([
          cached,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Cached CommentsAutobase promise timed out after 12s')), 12000))
        ]).catch(err => {
          console.log('[API] _getCommentsAutobase: cached promise failed:', err?.message)
          // Clear the bad cache entry so next call can retry
          ctx._commentsCache.delete(cacheKey)
          throw err
        })
        console.log('[API] _getCommentsAutobase: cached promise resolved')

        // FIX: Try to update admin key on cached instance if not already set
        // This handles the case where the instance was cached before admin key was available
        if (!result._adminKeyHex && publicBeeKey) {
          try {
            const pubBee = await Promise.race([
              loadPublicBee(ctx, publicBeeKey),
              new Promise((resolve) => setTimeout(() => resolve(null), 2000))
            ])
            if (pubBee) {
              const meta = await Promise.race([
                pubBee.getMetadata(),
                new Promise((resolve) => setTimeout(() => resolve(null), 1000))
              ]).catch(() => null)
              if (meta?.commentsAdminKey) {
                result.setAdminKey?.(meta.commentsAdminKey)
                console.log('[API] _getCommentsAutobase: updated admin key on cached instance')
              }
            }
          } catch (err) {
            console.log('[API] _getCommentsAutobase: could not update admin key on cached instance:', err?.message)
          }
        }

        return result
      }

      const openPromise = (async () => {
        console.log('[API] _getCommentsAutobase: openPromise STARTED')
        let resolvedPublicBeeKey = (typeof publicBeeKey === 'string' && publicBeeKey.length > 0) ? publicBeeKey : null
        let commentsAutobaseKey = null
        let commentsAdminKey = null
        /** @type {any|null} */
        let pubBee = null

        // FIRST: Try to get publicBeeKey from public feed (fastest path for viewers)
        // Do this BEFORE trying to load any channels to avoid hangs
        console.log('[API] _getCommentsAutobase: checking public feed for publicBeeKey...')
        if (!resolvedPublicBeeKey && publicFeed) {
          console.log('[API] _getCommentsAutobase: publicFeed exists, calling getFeed()...')
          try {
            const feed = publicFeed.getFeed()
            console.log('[API] _getCommentsAutobase: got feed with', feed?.length, 'entries')
            const entry = feed.find(e => e.channelKey === channelKey || e.driveKey === channelKey)
            if (entry?.publicBeeKey) {
              resolvedPublicBeeKey = entry.publicBeeKey
              console.log('[API] _getCommentsAutobase: found publicBeeKey in feed:', resolvedPublicBeeKey?.slice(0, 16))
            } else {
              console.log('[API] _getCommentsAutobase: channel not found in feed or no publicBeeKey')
            }
          } catch (err) {
            console.log('[API] _getCommentsAutobase: feed lookup error:', err?.message)
          }
        } else if (!publicFeed) {
          console.log('[API] _getCommentsAutobase: publicFeed is not available')
        }

        // Check if we have a local identity for this channel (owner/paired device)
        console.log('[API] _getCommentsAutobase: checking local identity...')
        let hasLocalIdentity = false
        try {
          const identities = await ctx.metaDb?.get('identities').catch(() => null)
          hasLocalIdentity = identities?.value?.some(i =>
            i.channelKey === channelKey || i.driveKey === channelKey
          ) || false
        } catch (err) {
          console.log('[API] _getCommentsAutobase: identity check error:', err?.message)
        }
        console.log('[API] _getCommentsAutobase: hasLocalIdentity:', hasLocalIdentity)

        // Only try loading the full channel Autobase when we have a local identity (owner/paired device)
        // Do NOT load channel just because it's in ctx.channels - that could be a stale/incomplete viewer load
        /** @type {any|null} */
        let localChannel = null
        if (hasLocalIdentity) {
          console.log('[API] _getCommentsAutobase: loading local channel (owner/paired device)...')
          try {
            // Don't block forever: if the channel is slow to open, fall back to PublicBee.
            localChannel = await Promise.race([
              loadChannel(ctx, channelKey),
              new Promise((_, reject) => setTimeout(() => reject(new Error('loadChannel timeout')), 3000))
            ])
            console.log('[API] _getCommentsAutobase: local channel loaded')

            // If the channel already has a CommentsAutobase instance, use it (fast path for owners).
            if (localChannel?.commentsAutobase) {
              console.log('[API] _getCommentsAutobase: using channel.commentsAutobase')
              const commentsBase = localChannel.commentsAutobase
              const isPublishingDevice = Boolean(localChannel.publicBee?.writable)
              if (isPublishingDevice) commentsBase.setIsChannelOwner?.(true)

              const meta = await Promise.race([
                localChannel?.getMetadata?.(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getMetadata timeout')), 2000))
              ]).catch(() => null)
              const metaAdminKey = meta?.commentsAdminKey || null
              if (metaAdminKey) {
                commentsBase.setAdminKey?.(metaAdminKey)
              }

              const adminKeyHex = commentsBase.localWriterKeyHex
              if (!metaAdminKey && adminKeyHex) {
                commentsBase.setAdminKey?.(adminKeyHex)
              }

              if (isPublishingDevice && adminKeyHex && (!metaAdminKey || metaAdminKey !== adminKeyHex)) {
                try {
                  await localChannel.updateMetadata({ commentsAdminKey: adminKeyHex })
                } catch (err) {
                  console.log('[API] _getCommentsAutobase: could not store admin key in channel metadata:', err?.message)
                }
                try {
                  await localChannel.publicBee?.setMetadata({ commentsAdminKey: adminKeyHex })
                  console.log('[API] _getCommentsAutobase: published commentsAdminKey to PublicBee')
                } catch (err) {
                  console.log('[API] _getCommentsAutobase: could not publish admin key:', err?.message)
                }
              }

              return commentsBase
            }

            // Prefer canonical keys from channel metadata / PublicBee if available.
            const meta = await Promise.race([
              localChannel?.getMetadata?.(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('getMetadata timeout')), 2000))
            ]).catch(() => null)
            commentsAutobaseKey = meta?.commentsAutobaseKey || null
            commentsAdminKey = meta?.commentsAdminKey || null
            resolvedPublicBeeKey = resolvedPublicBeeKey ||
              localChannel?.publicBeeKey ||
              null

            // Only try getPublicBeeKey if we still don't have it
            if (!resolvedPublicBeeKey) {
              resolvedPublicBeeKey = await Promise.race([
                localChannel?.getPublicBeeKey?.(),
                new Promise((resolve) => setTimeout(() => resolve(null), 1000))
              ]).catch(() => null)
            }
            console.log('[API] _getCommentsAutobase: from local channel - commentsAutobaseKey:', commentsAutobaseKey?.slice(0, 16) || 'null')
          } catch (err) {
            console.log('[API] _getCommentsAutobase: local channel lookup failed:', err?.message)
          }
        }

        // Without a PublicBee key, viewers cannot discover comments.
        console.log('[API] _getCommentsAutobase: resolvedPublicBeeKey is:', resolvedPublicBeeKey?.slice(0, 16) || 'null')
        if (!resolvedPublicBeeKey) {
          console.log('[API] _getCommentsAutobase: no publicBeeKey found, throwing error')
          throw new Error('Comments unavailable (missing publicBeeKey)')
        }

        // Load the PublicBee and read the published commentsAutobaseKey.
        // The PublicBee writer (single device) is also the only device allowed to create/publish the comments key.
        let isPublishingDevice = false
        console.log('[API] _getCommentsAutobase: about to load PublicBee:', resolvedPublicBeeKey?.slice(0, 16))
        try {
          console.log('[API] _getCommentsAutobase: calling loadPublicBee with 5s timeout...')
          pubBee = await Promise.race([
            loadPublicBee(ctx, resolvedPublicBeeKey),
            new Promise((_, reject) => setTimeout(() => reject(new Error('loadPublicBee timeout after 5s')), 5000))
          ])
          console.log('[API] _getCommentsAutobase: loadPublicBee completed')
          isPublishingDevice = Boolean(pubBee?.writable)
          console.log('[API] _getCommentsAutobase: PublicBee loaded, writable:', isPublishingDevice)

          if (!commentsAutobaseKey) {
            console.log('[API] _getCommentsAutobase: getting metadata from PublicBee...')
            const meta = await Promise.race([
              pubBee.getMetadata(),
              new Promise((resolve) => setTimeout(() => resolve(null), 2000))
            ]).catch(() => null)
            commentsAutobaseKey = meta?.commentsAutobaseKey || null
            commentsAdminKey = commentsAdminKey || meta?.commentsAdminKey || null
            console.log('[API] _getCommentsAutobase: commentsAutobaseKey from PublicBee:', commentsAutobaseKey?.slice(0, 16) || 'null')
          }
        } catch (err) {
          console.log('[API] _getCommentsAutobase: PublicBee lookup failed:', err?.message)
        }

        // IMPORTANT: non-publishing devices must never create a new CommentsAutobase implicitly.
        // Creating by `{ name }` is deterministic per-device (not globally) and will fork comments.
        if (!isPublishingDevice && !commentsAutobaseKey) {
          throw new Error('Comments unavailable (commentsAutobaseKey not published yet)')
        }

        console.log('[API] _getCommentsAutobase: creating CommentsAutobase, isOwner:', isPublishingDevice, 'key:', commentsAutobaseKey?.slice(0, 16) || 'new')
        console.log('[API] _getCommentsAutobase: swarm connections:', ctx.swarm?.connections?.size || 0)

        let commentsBase
        try {
          commentsBase = await getOrCreateCommentsAutobase(ctx.store, {
            channelKey,
            commentsAutobaseKey,
            commentsAdminKey,
            isChannelOwner: isPublishingDevice,
            swarm: ctx.swarm
          })
        } catch (err) {
          // Provide a user-friendly error for viewers when owner is offline
          if (err?.message?.includes('timeout') && !isPublishingDevice) {
            throw new Error('Comments unavailable - channel owner may be offline. Try again later.')
          }
          throw err
        }
        console.log('[API] _getCommentsAutobase: CommentsAutobase ready, key:', commentsBase.keyHex?.slice(0, 16))
        if (commentsAdminKey) {
          commentsBase.setAdminKey?.(commentsAdminKey)
        }

        // Publishing device: publish the key to PublicBee if it wasn't there yet.
        if (isPublishingDevice && pubBee?.writable && commentsBase.keyHex && !commentsAutobaseKey) {
          try {
            await pubBee.setMetadata({ commentsAutobaseKey: commentsBase.keyHex })
            console.log('[API] _getCommentsAutobase: published commentsAutobaseKey to PublicBee')
          } catch (err) {
            console.log('[API] _getCommentsAutobase: could not publish key to PublicBee:', err?.message)
          }
        }

        // Publishing device: publish admin key if missing or stale.
        if (isPublishingDevice && pubBee?.writable && commentsBase.localWriterKeyHex) {
          const adminKeyHex = commentsBase.localWriterKeyHex
          if (!commentsAdminKey || commentsAdminKey !== adminKeyHex) {
            try {
              await pubBee.setMetadata({ commentsAdminKey: adminKeyHex })
              console.log('[API] _getCommentsAutobase: published commentsAdminKey to PublicBee')
            } catch (err) {
              console.log('[API] _getCommentsAutobase: could not publish admin key:', err?.message)
            }
          }
          if (localChannel) {
            try {
              await localChannel.updateMetadata({ commentsAdminKey: adminKeyHex })
            } catch (err) {
              console.log('[API] _getCommentsAutobase: could not store admin key in channel metadata:', err?.message)
            }
          }
        }

        return commentsBase
      })()

      ctx._commentsCache.set(cacheKey, openPromise)
      try {
        return await openPromise
      } catch (err) {
        ctx._commentsCache.delete(cacheKey)
        throw err
      }
    },

    /**
     * Add a comment to a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} text
     * @param {string} [parentId]
     * @param {string} [publicBeeKey]
     * @returns {Promise<{success: boolean, commentId?: string, error?: string}>}
     */
    async addComment(channelKey, videoId, text, parentId = null, publicBeeKey = null) {
      // SYNC LOG - this should ALWAYS appear immediately
      console.log('[API] ====== addComment ENTERED ======')
      console.log('[API] addComment: channelKey:', channelKey?.slice(0, 16), 'videoId:', videoId?.slice(0, 16), 'publicBeeKey:', publicBeeKey?.slice(0, 16) || 'null')

      try {
        console.log('[API] addComment: getting CommentsAutobase...')
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        console.log('[API] addComment: got CommentsAutobase, adding comment...')
        const result = await commentsBase.addComment(videoId, text, parentId)
        const peerCount = commentsBase?.swarm?.connections?.size || 0
        const queued = typeof result?.queued === 'boolean'
          ? result.queued
          : (!commentsBase?.writable && peerCount === 0)
        console.log('[API] addComment: comment added:', result.commentId?.slice(0, 8))
        return { success: true, commentId: result.commentId, queued }
      } catch (err) {
        console.error('[API] addComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * List comments for a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {Object} [options]
     * @param {number} [options.page=0]
     * @param {number} [options.limit=50]
     * @param {string} [options.publicBeeKey]
     * @returns {Promise<{comments: Array, success: boolean, error?: string}>}
     */
    async listComments(channelKey, videoId, options = {}) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, options.publicBeeKey)
        const comments = await commentsBase.listComments(videoId, options)
        return { success: true, comments }
      } catch (err) {
        console.error('[API] listComments error:', err.message)
        return { success: false, comments: [], error: err.message }
      }
    },

    /**
     * Hide a comment (moderator action)
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} commentId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async hideComment(channelKey, videoId, commentId, publicBeeKey = null) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        await commentsBase.hideComment(videoId, commentId)
        return { success: true }
      } catch (err) {
        console.error('[API] hideComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Remove a comment (moderator or author)
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} commentId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async removeComment(channelKey, videoId, commentId, publicBeeKey = null) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        await commentsBase.removeComment(videoId, commentId)
        return { success: true }
      } catch (err) {
        console.error('[API] removeComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ============================================
    // Reactions Operations (using separate CommentsAutobase)
    // ============================================

    /**
     * Add a reaction to a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} reactionType
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async addReaction(channelKey, videoId, reactionType, publicBeeKey = null) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        await commentsBase.addReaction(videoId, reactionType)
        return { success: true }
      } catch (err) {
        console.error('[API] addReaction error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Remove a reaction from a video
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async removeReaction(channelKey, videoId, publicBeeKey = null) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        await commentsBase.removeReaction(videoId)
        return { success: true }
      } catch (err) {
        console.error('[API] removeReaction error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Get reactions for a video
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{counts: Record<string, number>, userReaction: string|null, success: boolean, error?: string}>}
     */
    async getReactions(channelKey, videoId, publicBeeKey = null) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        const result = await commentsBase.getReactionCounts(videoId)
        return { success: true, counts: { like: result.likes, dislike: result.dislikes }, userReaction: result.userReaction }
      } catch (err) {
        console.error('[API] getReactions error:', err.message)
        return { success: false, counts: {}, userReaction: null, error: err.message }
      }
    },

    /**
     * Get debug info about the comments system for a channel
     * @param {string} channelKey
     * @param {string} [publicBeeKey]
     * @returns {Promise<Object>}
     */
    async getCommentsDebugInfo(channelKey, publicBeeKey = null) {
      const debugInfo = {
        success: false,
        // Connection
        swarmPeers: ctx.swarm?.connections?.size || 0,
        commentsConnected: false,

        // CommentsAutobase
        commentsAutobaseKey: null,
        isWriter: false,
        isChannelOwner: false,
        localWriterKey: null,

        // Channel info
        channelKey: channelKey?.slice(0, 16) || null,
        publicBeeKey: publicBeeKey?.slice(0, 16) || null,
        hasPublicBee: false,
        publicBeeHasCommentsKey: false,

        // Data
        viewLength: 0,

        // Errors
        lastError: null
      }

      try {
        // Try to load channel first
        let channel = null
        try {
          channel = await loadChannel(ctx, channelKey)
          debugInfo.hasChannel = true
          debugInfo.channelWritable = channel.writable

          // Check if channel has PublicBee
          if (channel.publicBee) {
            debugInfo.hasPublicBee = true
            const pubMeta = await channel.publicBee.getMetadata().catch(() => ({}))
            debugInfo.publicBeeHasCommentsKey = Boolean(pubMeta?.commentsAutobaseKey)
          }

          // Check if channel has CommentsAutobase
          if (channel.commentsAutobase) {
            const ca = channel.commentsAutobase
            debugInfo.commentsAutobaseKey = ca.keyHex?.slice(0, 16) || null
            debugInfo.isWriter = ca.writable
            debugInfo.isChannelOwner = ca.isChannelOwner()
            debugInfo.localWriterKey = ca.localWriterKeyHex?.slice(0, 16) || null
            debugInfo.viewLength = ca.view?.core?.length || 0
            debugInfo.commentsConnected = true
            debugInfo.success = true
            return debugInfo
          }
        } catch (err) {
          debugInfo.channelError = err?.message
        }

        // Try to get CommentsAutobase via API method
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        debugInfo.commentsAutobaseKey = commentsBase?.keyHex?.slice(0, 16) || null
        debugInfo.isWriter = commentsBase?.writable || false
        debugInfo.isChannelOwner = commentsBase?.isChannelOwner?.() || false
        debugInfo.localWriterKey = commentsBase?.localWriterKeyHex?.slice(0, 16) || null
        debugInfo.viewLength = commentsBase?.view?.core?.length || 0
        debugInfo.commentsConnected = true
        debugInfo.success = true
      } catch (err) {
        debugInfo.lastError = err?.message || 'Unknown error'
      }

      return debugInfo
    },

    // ============================================
    // Recommendations Operations
    // ============================================

    /**
     * Log a watch event for recommendations
     * @param {string} channelKey
     * @param {string} videoId
     * @param {Object} [options]
     * @param {number} [options.duration]
     * @param {boolean} [options.completed]
     * @param {boolean} [options.share=false]
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async logWatchEvent(channelKey, videoId, options = {}) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, error: 'Watch events only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.watchLogger) {
          return { success: false, error: 'Watch logger not initialized' }
        }

        await channel.watchLogger.logWatchEvent(videoId, options)
        return { success: true }
      } catch (err) {
        console.error('[API] logWatchEvent error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Get video recommendations
     * @param {string} channelKey
     * @param {Object} [options]
     * @param {number} [options.limit=10]
     * @param {string[]} [options.excludeVideoIds]
     * @returns {Promise<{recommendations: Array, success: boolean, error?: string}>}
     */
    async getRecommendations(channelKey, options = {}) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, recommendations: [], error: 'Recommendations only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.watchLogger) {
          return { success: false, recommendations: [], error: 'Watch logger not initialized' }
        }

        // Initialize semantic finder if needed
        if (!ctx.semanticFinder) {
          ctx.semanticFinder = new SemanticFinder()
          await ctx.semanticFinder.init()
        }

        // Initialize recommender
        const recommender = new Recommender(channel, ctx.semanticFinder, channel.watchLogger)
        const recommendations = await recommender.generateRecommendations(options)

        return { success: true, recommendations }
      } catch (err) {
        console.error('[API] getRecommendations error:', err.message)
        return { success: false, recommendations: [], error: err.message }
      }
    },

    /**
     * Get recommendations for a specific video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {number} [limit=5]
     * @returns {Promise<{recommendations: Array, success: boolean, error?: string}>}
     */
    async getVideoRecommendations(channelKey, videoId, limit = 5) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, recommendations: [], error: 'Recommendations only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)

        // Initialize semantic finder if needed
        if (!ctx.semanticFinder) {
          ctx.semanticFinder = new SemanticFinder()
          await ctx.semanticFinder.init()
        }

        // Initialize recommender (watch logger may be null, that's ok)
        const watchLogger = channel.watchLogger || null
        const recommender = new Recommender(channel, ctx.semanticFinder, watchLogger)
        const recommendations = await recommender.getVideoRecommendations(videoId, limit)

        return { success: true, recommendations }
      } catch (err) {
        console.error('[API] getVideoRecommendations error:', err.message)
        return { success: false, recommendations: [], error: err.message }
      }
    },

    // ============================================
    // Network Lifecycle Management
    // ============================================

    /**
     * Suspend networking for mobile background state.
     * Call this when the app goes to background to save battery.
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async suspendNetwork() {
      try {
        await suspendNetworking()
        return { success: true }
      } catch (err) {
        console.error('[API] suspendNetwork error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Resume networking when app returns to foreground.
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async resumeNetwork() {
      try {
        await resumeNetworking()
        return { success: true }
      } catch (err) {
        console.error('[API] resumeNetwork error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Get network stats for debugging.
     * @returns {{stats: Object|null, readable: string}}
     */
    getNetworkDebugStats() {
      return {
        stats: getNetworkStats(),
        readable: getNetworkStatsReadable()
      }
    }
  };
}
