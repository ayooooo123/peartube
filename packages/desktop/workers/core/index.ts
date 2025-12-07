/**
 * PearTube Desktop Worker - Thin HRPC Handler Layer
 *
 * This worker uses createBackendContext from @peartube/backend to initialize
 * all P2P components, then registers thin HRPC handlers that delegate to the API.
 *
 * Desktop-specific features (file pickers, FFmpeg) are implemented here.
 */

import fs from 'bare-fs';
import pipe from 'pear-pipe';
import { spawn } from 'bare-subprocess';
import b4a from 'b4a';

// Import the orchestrator from backend
// @ts-ignore - backend-core is JavaScript
import { createBackendContext } from '@peartube/backend/orchestrator';
// @ts-ignore - Generated HRPC code
import HRPC from '@peartube/spec';

// Get Pear runtime globals
declare const Pear: any;

console.log('[Worker] PearTube Desktop Worker starting...');

// ============================================
// Initialize Backend using Orchestrator
// ============================================

const storage = Pear.config.storage || './storage';

const backend = await createBackendContext({
  storagePath: storage,
  onFeedUpdate: () => {
    // Feed updates will be wired after HRPC init
  },
  onStatsUpdate: (driveKey: string, videoPath: string, stats: any) => {
    // Stats updates will be wired after HRPC init
  }
});

const { ctx, api, identityManager, uploadManager, publicFeed, seedingManager, videoStats } = backend;

console.log('[Worker] Backend initialized via orchestrator');
console.log('[Worker] Blob server port:', ctx.blobServerPort);

// ============================================
// Desktop-Specific Functions (File Pickers, FFmpeg)
// ============================================

// FFmpeg availability check (cached)
let ffmpegAvailable: boolean | null = null;

async function checkFFmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;

  return new Promise((resolve) => {
    try {
      const proc = spawn('ffmpeg', ['-version']);
      proc.on('exit', (code: number) => {
        ffmpegAvailable = code === 0;
        console.log('[FFmpeg] Available:', ffmpegAvailable);
        resolve(ffmpegAvailable);
      });
      proc.on('error', () => {
        ffmpegAvailable = false;
        resolve(false);
      });
    } catch {
      ffmpegAvailable = false;
      resolve(false);
    }
  });
}

// Generate thumbnail from video file using FFmpeg
async function generateThumbnail(filePath: string, videoId: string, drive: any): Promise<string | null> {
  const thumbnailPath = `/thumbnails/${videoId}.jpg`;

  const args = [
    '-ss', '1',
    '-i', filePath,
    '-vframes', '1',
    '-vf', 'scale=640:-1',
    '-q:v', '2',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    'pipe:1'
  ];

  return new Promise((resolve) => {
    try {
      const proc = spawn('ffmpeg', args);
      const chunks: Buffer[] = [];

      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on('data', () => {}); // Ignore ffmpeg progress

      proc.on('exit', async (code: number) => {
        if (code === 0 && chunks.length > 0) {
          try {
            const thumbBuf = Buffer.concat(chunks);
            await drive.put(thumbnailPath, thumbBuf);
            resolve(thumbnailPath);
          } catch {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });

      proc.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

// Native video file picker using osascript (macOS)
async function pickVideoFile(): Promise<any> {
  return new Promise((resolve, reject) => {
    const script = `
      set theFile to choose file with prompt "Select a video file" of type {"public.movie", "public.video"}
      return POSIX path of theFile
    `;

    const proc = spawn('osascript', ['-e', script]);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('exit', (code: number) => {
      if (code === 0 && stdout.trim()) {
        const filePath = stdout.trim();
        try {
          const stat = fs.statSync(filePath);
          resolve({ filePath, name: filePath.split('/').pop() || 'video', size: stat.size });
        } catch (err: any) {
          reject(new Error(`Failed to stat file: ${err.message}`));
        }
      } else if (code === 1) {
        resolve({ cancelled: true });
      } else {
        reject(new Error(stderr || 'File picker failed'));
      }
    });

    proc.on('error', (err: Error) => reject(err));
  });
}

// Native image file picker using osascript (macOS)
async function pickImageFile(): Promise<any> {
  return new Promise((resolve, reject) => {
    const script = `
      set theFile to choose file with prompt "Select a thumbnail image" of type {"public.jpeg", "public.png", "public.image"}
      return POSIX path of theFile
    `;

    const proc = spawn('osascript', ['-e', script]);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('exit', (code: number) => {
      if (code === 0 && stdout.trim()) {
        const filePath = stdout.trim();
        try {
          const stat = fs.statSync(filePath);
          const fileBuffer = fs.readFileSync(filePath);
          const base64 = fileBuffer.toString('base64');
          const mimeType = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
          const dataUrl = `data:${mimeType};base64,${base64}`;
          resolve({ filePath, name: filePath.split('/').pop() || 'image', size: stat.size, dataUrl });
        } catch (err: any) {
          reject(new Error(`Failed to read file: ${err.message}`));
        }
      } else if (code === 1) {
        resolve({ cancelled: true });
      } else {
        reject(new Error(stderr || 'File picker failed'));
      }
    });

    proc.on('error', (err: Error) => reject(err));
  });
}

// ============================================
// HRPC Setup
// ============================================

const ipcPipe = pipe();
if (!ipcPipe) {
  console.error('[Worker] Failed to get IPC pipe');
  throw new Error('No IPC pipe');
}

const rpc = new HRPC(ipcPipe);
console.log('[Worker] HRPC initialized');

// Wire up video stats events
videoStats.setOnStatsUpdate((driveKey: string, videoPath: string, stats: any) => {
  try {
    rpc.eventVideoStats({
      videoId: videoPath,
      channelKey: driveKey,
      status: stats.status || 'unknown',
      progress: stats.progress || 0,
      totalBlocks: stats.totalBlocks || 0,
      downloadedBlocks: stats.downloadedBlocks || 0,
      totalBytes: stats.totalBytes || 0,
      downloadedBytes: stats.downloadedBytes || 0,
      peerCount: stats.peerCount || 0,
      speedMBps: stats.speedMBps || '0',
      uploadSpeedMBps: stats.uploadSpeedMBps || '0',
      elapsed: stats.elapsed || 0,
      isComplete: Boolean(stats.isComplete),
    });
  } catch (e) {
    // Ignore event send errors
  }
});

// ============================================
// HRPC Handlers - Thin Delegation Layer
// ============================================

// Identity handlers
rpc.onCreateIdentity(async (req: any) => {
  const result = await identityManager.createIdentity(req.name || 'New Channel', true);
  return {
    identity: {
      publicKey: result.publicKey,
      driveKey: result.driveKey,
      name: req.name || 'New Channel',
      seedPhrase: result.mnemonic,
      isActive: true,
    }
  };
});

rpc.onGetIdentity(async () => {
  const active = identityManager.getActiveIdentity();
  return { identity: active };
});

rpc.onGetIdentities(async () => {
  const all = identityManager.getIdentities();
  return { identities: all.map((i: any) => ({
    publicKey: i.publicKey || '',
    driveKey: i.driveKey || '',
    name: i.name || '',
    createdAt: i.createdAt || 0,
    isActive: Boolean(i.isActive),
  }))};
});

rpc.onSetActiveIdentity(async (req: any) => {
  await identityManager.setActiveIdentity(req.publicKey);
  return { success: true };
});

rpc.onRecoverIdentity(async (req: any) => {
  const result = await identityManager.recoverIdentity(req.seedPhrase, req.name);
  return {
    identity: {
      publicKey: result.publicKey,
      driveKey: result.driveKey,
      name: req.name || 'Recovered',
      isActive: true,
    }
  };
});

// Channel handlers
rpc.onGetChannel(async (req: any) => {
  const channel = await api.getChannel(req.publicKey || '');
  return { channel };
});

rpc.onGetChannelMeta(async (req: any) => {
  const meta = await api.getChannelMeta(req.channelKey);
  return { name: meta.name, description: meta.description, videoCount: meta.videoCount || 0 };
});

rpc.onUpdateChannel(async () => ({ channel: {} }));

// Video handlers
rpc.onListVideos(async (req: any) => {
  const videos = await api.listVideos(req.channelKey || '');
  // Resolve thumbnail URLs via blob server
  const enriched = await Promise.all(videos.map(async (v: any) => {
    let thumbnailUrl = '';
    const channelKey = v.channelKey || req.channelKey;
    if (v.thumbnail && channelKey) {
      try {
        const drive = ctx.drives.get(channelKey);
        if (drive) {
          const entry = await drive.entry(v.thumbnail);
          if (entry) {
            thumbnailUrl = ctx.blobServer.getLink(b4a.from(channelKey, 'hex'), {
              filename: v.thumbnail.replace(/^\/+/, '')
            });
          }
        }
      } catch {}
    }
    return {
      id: v.id || '',
      title: v.title || 'Untitled',
      description: v.description || '',
      path: v.path || '',
      duration: v.duration || 0,
      thumbnail: thumbnailUrl,
      channelKey,
      channelName: v.channelName || '',
      createdAt: v.uploadedAt || v.createdAt || 0,
      views: v.views || 0,
      category: v.category || 'Other',
    };
  }));
  return { videos: enriched };
});

rpc.onGetVideoUrl(async (req: any) => {
  const result = await api.getVideoUrl(req.channelKey, req.videoId);
  return { url: result.url };
});

rpc.onGetVideoData(async (req: any) => ({ video: { id: req.videoId, title: 'Unknown' } }));

rpc.onUploadVideo(async (req: any) => {
  const drive = identityManager.getActiveDrive();
  if (!drive) throw new Error('No active identity');

  const result = await uploadManager.uploadFromPath(
    drive,
    req.filePath,
    { title: req.title, description: req.description, mimeType: 'video/mp4' },
    fs,
    (progress: number, bytesWritten: number, totalBytes: number) => {
      try {
        rpc.eventUploadProgress({ videoId: '', progress, bytesUploaded: bytesWritten, totalBytes });
      } catch {}
    }
  );

  // Generate thumbnail if FFmpeg available
  if (result.success && result.videoId) {
    const hasFFmpeg = await checkFFmpeg();
    if (hasFFmpeg) {
      const thumbPath = await generateThumbnail(req.filePath, result.videoId, drive);
      if (thumbPath) {
        const metaPath = `/videos/${result.videoId}.json`;
        const metaBuf = await drive.get(metaPath);
        if (metaBuf) {
          const meta = JSON.parse(b4a.toString(metaBuf, 'utf-8'));
          meta.thumbnail = thumbPath;
          await drive.put(metaPath, Buffer.from(JSON.stringify(meta)));
        }
      }
    }
  }

  return {
    video: {
      id: result.videoId || '',
      title: req.title || '',
      description: req.description || '',
      channelKey: b4a.toString(drive.key, 'hex'),
    }
  };
});

// Video stats
rpc.onPrefetchVideo(async (req: any) => {
  await api.prefetchVideo(req.channelKey, req.videoId);
  return { success: true };
});

rpc.onGetVideoStats(async (req: any) => {
  const stats = api.getVideoStats(req.channelKey, req.videoId);
  return { stats: { videoId: req.videoId, channelKey: req.channelKey, ...stats } };
});

// Subscription handlers
rpc.onSubscribeChannel(async (req: any) => {
  await api.subscribeChannel(req.channelKey);
  return { success: true };
});

rpc.onUnsubscribeChannel(async (req: any) => {
  await api.unsubscribeChannel(req.channelKey);
  return { success: true };
});

rpc.onGetSubscriptions(async () => {
  const subs = await api.getSubscriptions();
  return { subscriptions: subs.map((s: any) => ({ channelKey: s.driveKey, channelName: s.name })) };
});

rpc.onJoinChannel(async (req: any) => {
  await api.subscribeChannel(req.channelKey);
  return { success: true };
});

// Public Feed handlers
rpc.onGetPublicFeed(async () => {
  const result = api.getPublicFeed();
  return {
    entries: result.entries.map((e: any) => ({
      channelKey: e.driveKey,
      channelName: e.name || '',
      videoCount: 0,
      peerCount: 0,
      lastSeen: 0,
    }))
  };
});

rpc.onRefreshFeed(async () => {
  api.refreshFeed();
  return { success: true };
});

rpc.onSubmitToFeed(async () => {
  const active = identityManager.getActiveIdentity();
  if (active?.driveKey) {
    api.submitToFeed(active.driveKey);
  }
  return { success: true };
});

rpc.onHideChannel(async (req: any) => {
  api.hideChannel(req.channelKey);
  return { success: true };
});

// Seeding handlers
rpc.onGetSeedingStatus(async () => {
  const status = await api.getSeedingStatus();
  return { status: {
    enabled: status.config?.autoSeedWatched || false,
    usedStorage: status.storageUsedBytes || 0,
    maxStorage: (status.maxStorageGB || 10) * 1024 * 1024 * 1024,
    seedingCount: status.activeSeeds || 0,
  }};
});

rpc.onSetSeedingConfig(async (req: any) => {
  await api.setSeedingConfig(req.config);
  return { success: true };
});

rpc.onPinChannel(async (req: any) => {
  await api.pinChannel(req.channelKey);
  return { success: true };
});

rpc.onUnpinChannel(async (req: any) => {
  await api.unpinChannel(req.channelKey);
  return { success: true };
});

rpc.onGetPinnedChannels(async () => {
  const result = api.getPinnedChannels();
  return { channels: result.channels || [] };
});

// Thumbnail handlers
rpc.onGetVideoThumbnail(async (req: any) => {
  const drive = ctx.drives.get(req.channelKey);
  if (drive) {
    const thumbPath = `/thumbnails/${req.videoId}.jpg`;
    const entry = await drive.entry(thumbPath);
    if (entry) {
      const url = ctx.blobServer.getLink(b4a.from(req.channelKey, 'hex'), {
        filename: thumbPath.replace(/^\/+/, '')
      });
      return { url, exists: true };
    }
  }
  return { url: null, exists: false };
});

rpc.onGetVideoMetadata(async (req: any) => {
  const drive = ctx.drives.get(req.channelKey);
  if (drive) {
    const metaPath = `/videos/${req.videoId}.json`;
    const metaBuf = await drive.get(metaPath);
    if (metaBuf) {
      return { video: JSON.parse(b4a.toString(metaBuf, 'utf-8')) };
    }
  }
  return { video: { id: req.videoId, title: 'Unknown' } };
});

rpc.onSetVideoThumbnail(async (req: any) => {
  const drive = identityManager.getActiveDrive();
  if (!drive) return { success: false };

  const imageBuffer = Buffer.from(req.imageData, 'base64');
  const ext = req.mimeType?.includes('png') ? 'png' : 'jpg';
  const thumbnailPath = `/thumbnails/${req.videoId}.${ext}`;

  await drive.put(thumbnailPath, imageBuffer);

  // Update metadata
  const metaPath = `/videos/${req.videoId}.json`;
  const metaBuf = await drive.get(metaPath);
  if (metaBuf) {
    const meta = JSON.parse(b4a.toString(metaBuf, 'utf-8'));
    meta.thumbnail = thumbnailPath;
    await drive.put(metaPath, Buffer.from(JSON.stringify(meta)));
  }

  return { success: true, thumbnailPath };
});

rpc.onSetVideoThumbnailFromFile(async (req: any) => {
  const drive = identityManager.getActiveDrive();
  if (!drive) return { success: false };

  const imageBuffer = fs.readFileSync(req.filePath);
  const ext = req.filePath.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const thumbnailPath = `/thumbnails/${req.videoId}.${ext}`;

  await drive.put(thumbnailPath, imageBuffer);

  const metaPath = `/videos/${req.videoId}.json`;
  const metaBuf = await drive.get(metaPath);
  if (metaBuf) {
    const meta = JSON.parse(b4a.toString(metaBuf, 'utf-8'));
    meta.thumbnail = thumbnailPath;
    await drive.put(metaPath, Buffer.from(JSON.stringify(meta)));
  }

  if (drive.flush) await drive.flush();
  return { success: true };
});

// Status handlers
rpc.onGetStatus(async () => ({
  status: {
    ready: true,
    hasIdentity: identityManager.getIdentities().length > 0,
    blobServerPort: ctx.blobServerPort,
  }
}));

rpc.onGetSwarmStatus(async () => ({
  connected: ctx.swarm.connections.size > 0,
  peerCount: ctx.swarm.connections.size,
}));

rpc.onGetBlobServerPort(async () => ({ port: ctx.blobServerPort }));

// Desktop-specific file pickers
rpc.onPickVideoFile(async () => {
  const result = await pickVideoFile();
  return {
    filePath: result.filePath || null,
    name: result.name || null,
    size: result.size || 0,
    cancelled: result.cancelled || false,
  };
});

rpc.onPickImageFile(async () => {
  const result = await pickImageFile();
  return {
    filePath: result.filePath || null,
    name: result.name || null,
    size: result.size || 0,
    dataUrl: result.dataUrl || null,
    cancelled: result.cancelled || false,
  };
});

// Event handlers (client->server, no-ops)
rpc.onEventReady(() => {});
rpc.onEventError((data: any) => console.error('[HRPC] Client error:', data?.message));
rpc.onEventUploadProgress(() => {});
rpc.onEventFeedUpdate(() => {});
rpc.onEventLog(() => {});
rpc.onEventVideoStats(() => {});

// Send ready event
rpc.eventReady({ blobServerPort: ctx.blobServerPort });
console.log('[Worker] HRPC ready, handlers registered');

ipcPipe.on('error', (err: Error) => {
  console.error('[Worker] Pipe error:', err);
});

// Cleanup on shutdown
Pear.teardown(async () => {
  console.log('[Worker] Shutting down...');
  await ctx.blobServer.close();
  await ctx.swarm.destroy();
});
