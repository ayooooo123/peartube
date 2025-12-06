/**
 * PearTube - Core Backend Worker
 *
 * This worker handles all P2P operations, storage, and networking.
 * It runs in a separate process from the UI for better performance.
 * Uses HRPC (Holepunch RPC) over pear-pipe for typed binary communication.
 */

import Hyperswarm from 'hyperswarm';
import Corestore from 'corestore';
import Hyperbee from 'hyperbee';
import Hyperdrive from 'hyperdrive';
import BlobServer from 'hypercore-blob-server';
import crypto from 'hypercore-crypto';
import b4a from 'b4a';
import fs from 'bare-fs';
import pipe from 'pear-pipe';
import { spawn } from 'bare-subprocess';

// @ts-ignore - backend-core is JavaScript
import { PublicFeedManager } from '@peartube/backend/public-feed';
// @ts-ignore - Generated HRPC code
import HRPC from '@peartube/spec';

// Get Pear runtime globals
declare const Pear: any;

console.log('PearTube Core Worker starting...');

// Initialize storage
const storage = Pear.config.storage || './storage';
const store = new Corestore(storage);

// Initialize Hyperswarm for P2P networking
const swarm = new Hyperswarm();

// Initialize PublicFeedManager for P2P channel discovery
const publicFeed = new PublicFeedManager(swarm);

// Handle swarm connections - replicate corestore AND set up feed protocol
swarm.on('connection', (conn: any, info: any) => {
  console.log('Peer connected');
  store.replicate(conn);

  // Set up feed protocol on every connection
  publicFeed.handleConnection(conn, info);
});

// Initialize local database
const dbCore = store.get({ name: 'peartube-db' });
const db = new Hyperbee(dbCore, { keyEncoding: 'utf-8', valueEncoding: 'json' });
await db.ready();

// Initialize blob server for video streaming
const blobServer = new BlobServer(store, {
  port: 0, // Random available port
  host: '127.0.0.1'
});
await blobServer.listen();
const blobServerPort = blobServer.port;
console.log('Blob server listening on port:', blobServerPort);

console.log('Database initialized');

// In-memory state
let identities: any[] = [];
let activeIdentity: string | null = null;
const channels: Map<string, any> = new Map(); // pubkey -> Hyperdrive

// Video stats tracking - for P2P download progress monitoring
interface VideoStatsData {
  driveKey: string;
  videoPath: string;
  startTime: number;
  monitor: any;
  downloadRequest: any;
  entry: any;
}
const videoMonitors: Map<string, VideoStatsData> = new Map(); // key: `${driveKey}:${videoPath}`


// Load identities from database
async function loadIdentities() {
  const stored = await db.get('identities');
  if (stored && stored.value) {
    identities = stored.value;
    console.log(`Loaded ${identities.length} identities`);
    // Debug: show what was loaded
    for (const id of identities) {
      console.log(`  - Identity: ${id.name}, publicKey: ${id.publicKey?.slice(0,8)}..., driveKey: ${id.driveKey?.slice(0,8) || 'MISSING'}...`);
    }
  }
}

// Save identities to database
async function saveIdentities() {
  await db.put('identities', identities);
}

// Generate BIP39-like mnemonic (simplified version)
function generateMnemonic(): string {
  const words = [];
  const wordList = [
    'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract',
    'absurd', 'abuse', 'access', 'accident', 'account', 'accuse', 'achieve', 'acid',
    'acoustic', 'acquire', 'across', 'act', 'action', 'actor', 'actress', 'actual'
  ]; // Simplified - real BIP39 has 2048 words

  for (let i = 0; i < 12; i++) {
    const idx = Math.floor(Math.random() * wordList.length);
    words.push(wordList[idx]);
  }

  return words.join(' ');
}

// Derive keypair from mnemonic
function keypairFromMnemonic(mnemonic: string) {
  // Simple derivation - in production use proper BIP39
  const seed = Buffer.from(mnemonic, 'utf-8');
  return crypto.keyPair(seed.slice(0, 32));
}

// Get or create a channel's Hyperdrive
async function getChannelDrive(publicKey: string, writable = false): Promise<any> {
  // Validate key format (must be 64 hex characters = 32 bytes)
  if (!/^[a-f0-9]{64}$/i.test(publicKey)) {
    throw new Error('Invalid channel key: must be 64 hex characters');
  }

  if (channels.has(publicKey)) {
    return channels.get(publicKey);
  }

  const keyBuffer = b4a.from(publicKey, 'hex');
  const drive = new Hyperdrive(store, writable ? undefined : keyBuffer);
  await drive.ready();

  // Join swarm to find peers for this channel
  const discoveryKey = drive.discoveryKey;
  swarm.join(discoveryKey);

  channels.set(publicKey, drive);
  console.log('Loaded channel drive:', publicKey.slice(0, 8) + '...');

  return drive;
}

// RPC Methods
const api: Record<string, (...args: any[]) => Promise<any>> = {
  // Get backend status
  async getStatus() {
    return {
      connected: true,
      peers: swarm.connections.size,
      storage,
      blobServerPort,
      version: '0.1.0'
    };
  },

  // Create a new identity/channel
  async createIdentity(name: string, generateMnem = true) {
    console.log('Creating identity:', name);

    let keypair;
    let mnemonic: string | undefined;

    if (generateMnem) {
      mnemonic = generateMnemonic();
      keypair = keypairFromMnemonic(mnemonic);
    } else {
      keypair = crypto.keyPair();
    }

    const publicKey = b4a.toString(keypair.publicKey, 'hex');

    // Create the channel's Hyperdrive
    const drive = new Hyperdrive(store);
    await drive.ready();

    const driveKey = b4a.toString(drive.key, 'hex');

    // Store channel metadata
    await drive.put('/channel.json', Buffer.from(JSON.stringify({
      name,
      publicKey,
      createdAt: Date.now(),
      description: '',
      avatar: null
    })));

    // Create identity record
    const identity = {
      publicKey,
      driveKey,
      name,
      createdAt: Date.now(),
      secretKey: b4a.toString(keypair.secretKey, 'hex')
    };

    identities.push(identity);
    await saveIdentities();
    channels.set(driveKey, drive);

    // Join swarm for this channel
    swarm.join(drive.discoveryKey);

    // Set as active if first identity
    if (identities.length === 1) {
      activeIdentity = publicKey;
      await db.put('activeIdentity', publicKey);
    }

    console.log('Identity created:', publicKey);
    console.log('Channel drive key:', driveKey);

    return {
      success: true,
      publicKey,
      driveKey,
      mnemonic
    };
  },

  // Recover identity from mnemonic
  async recoverIdentity(mnemonic: string, name?: string) {
    console.log('Recovering identity from mnemonic');

    const keypair = keypairFromMnemonic(mnemonic);
    const publicKey = b4a.toString(keypair.publicKey, 'hex');

    // Check if already exists
    const existing = identities.find(i => i.publicKey === publicKey);
    if (existing) {
      return {
        success: true,
        publicKey,
        driveKey: existing.driveKey,
        message: 'Identity already exists'
      };
    }

    // For recovery, we'd need to find the drive key somehow
    // For now, create a new drive
    const drive = new Hyperdrive(store);
    await drive.ready();
    const driveKey = b4a.toString(drive.key, 'hex');

    const identity = {
      publicKey,
      driveKey,
      name: name || `Recovered ${Date.now()}`,
      createdAt: Date.now(),
      secretKey: b4a.toString(keypair.secretKey, 'hex'),
      recovered: true
    };

    identities.push(identity);
    await saveIdentities();
    channels.set(driveKey, drive);
    swarm.join(drive.discoveryKey);

    return {
      success: true,
      publicKey,
      driveKey
    };
  },

  // Get list of identities
  async getIdentities() {
    // Only return well-formed identities (with driveKey/publicKey)
    return identities
      .filter(i => typeof i.publicKey === 'string' && i.publicKey && typeof i.driveKey === 'string' && i.driveKey)
      .map(i => ({
        publicKey: i.publicKey || '',
        driveKey: i.driveKey || '',
        name: i.name || 'Channel',
        createdAt: typeof i.createdAt === 'number' && i.createdAt >= 0 ? i.createdAt : Date.now(),
        isActive: i.publicKey === activeIdentity
      }));
  },

  // Set active identity
  async setActiveIdentity(publicKey: string) {
    const identity = identities.find(i => i.publicKey === publicKey);
    if (!identity) {
      throw new Error('Identity not found');
    }

    activeIdentity = publicKey;
    await db.put('activeIdentity', publicKey);

    console.log('Active identity set to:', publicKey);
  },

  // Get channel info
  async getChannel(driveKey: string) {
    const drive = await getChannelDrive(driveKey);

    try {
      const metaBuffer = await drive.get('/channel.json');
      if (metaBuffer) {
        return JSON.parse(b4a.toString(metaBuffer, 'utf-8'));
      }
    } catch {
      // No metadata yet
    }

    return {
      driveKey,
      name: 'Unknown Channel',
      videos: []
    };
  },

  // List videos in a channel
  async listVideos(driveKey: string) {
    console.log(`[listVideos] Listing videos for drive: ${driveKey?.slice(0, 8)}...`);

    // First check if we have this drive in memory
    let drive = channels.get(driveKey);
    if (!drive) {
      console.log(`[listVideos] Drive not in cache, loading...`);
      drive = await getChannelDrive(driveKey);
    }

    const videos: any[] = [];

    try {
      // readdir returns a stream, use for-await to iterate
      for await (const entry of drive.readdir('/videos')) {
        console.log(`[listVideos] Found entry: ${entry}`);
        if (entry.endsWith('.json')) {
          const metaBuffer = await drive.get(`/videos/${entry}`);
          if (metaBuffer) {
            const meta = JSON.parse(b4a.toString(metaBuffer, 'utf-8'));
            videos.push(meta);
            console.log(`[listVideos] Found video: ${meta.title}`);
          }
        }
      }
    } catch (err) {
      console.log(`[listVideos] Error reading /videos:`, err);
      // No videos directory yet
    }

    console.log(`[listVideos] Returning ${videos.length} videos`);
    return videos;
  },

  // Upload a video using streaming from file path
  // Takes optional progressCallback for real-time progress updates
  async uploadVideo(title: string, description: string, filePath: string, mimeType: string, progressCallback?: (progress: number, bytesWritten: number, totalBytes: number) => void) {
    const identity = identities.find(i => i.publicKey === activeIdentity);
    if (!identity) {
      throw new Error('No active identity');
    }

    const drive = channels.get(identity.driveKey);
    if (!drive) {
      throw new Error('Channel drive not found');
    }

    const videoId = crypto.randomBytes(16).toString('hex');
    const ext = mimeType.includes('webm') ? 'webm' : 'mp4';
    const videoPath = `/videos/${videoId}.${ext}`;
    const metaPath = `/videos/${videoId}.json`;

    // Get file size
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    console.log(`Uploading video: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

    // Read file and write to hyperdrive using createWriteStream
    const readStream = fs.createReadStream(filePath);
    const writeStream = drive.createWriteStream(videoPath);

    // Track bytes written for progress
    let bytesWritten = 0;
    let lastProgressUpdate = 0;

    // Use streamx pipeline pattern with progress tracking
    await new Promise<void>((resolve, reject) => {
      writeStream.on('close', resolve);
      writeStream.on('error', reject);
      readStream.on('error', reject);

      // Track progress on data events
      readStream.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
        const now = Date.now();
        // Throttle progress updates to every 100ms
        if (now - lastProgressUpdate > 100 || bytesWritten === fileSize) {
          const progress = Math.round((bytesWritten / fileSize) * 100);
          if (progressCallback) {
            progressCallback(progress, bytesWritten, fileSize);
          }
          lastProgressUpdate = now;
        }
      });

      readStream.pipe(writeStream);
    });

    // Create video metadata
    const metadata = {
      id: videoId,
      title,
      description,
      path: videoPath,
      mimeType,
      size: fileSize,
      uploadedAt: Date.now(),
      channelKey: identity.driveKey
    };

    await drive.put(metaPath, Buffer.from(JSON.stringify(metadata)));

    console.log('Video uploaded:', videoId);

    return {
      success: true,
      videoId,
      metadata
    };
  },

  // Get video stream URL (via blob server)
  async getVideoUrl(driveKey: string, videoPath: string) {
    const keyBuffer = b4a.from(driveKey, 'hex');
    // Ensure drive is loaded/joined
    await getChannelDrive(driveKey);

    // Blob server expects a normalized filename (no leading slash)
    const filename = videoPath.replace(/^\/+/, '');

    const url = blobServer.getLink(keyBuffer, {
      filename
    });

    return { url };
  },

  // Subscribe to a channel (start replicating)
  async subscribeChannel(driveKey: string) {
    const drive = await getChannelDrive(driveKey);

    // Save subscription
    const subs = (await db.get('subscriptions'))?.value || [];
    if (!subs.includes(driveKey)) {
      subs.push(driveKey);
      await db.put('subscriptions', subs);
    }

    return { success: true, driveKey };
  },

  // Get subscribed channels
  async getSubscriptions() {
    const subs = (await db.get('subscriptions'))?.value || [];
    const channels = [];

    for (const driveKey of subs) {
      try {
        const channel = await api.getChannel(driveKey);
        channels.push({ driveKey, ...channel });
      } catch {
        channels.push({ driveKey, name: 'Loading...' });
      }
    }

    return channels;
  },

  // Get blob server port for frontend
  async getBlobServerPort() {
    return { port: blobServerPort };
  },

  // Native file picker using osascript (macOS)
  async pickVideoFile() {
    console.log('[Worker] Opening native file picker...');

    return new Promise((resolve, reject) => {
      // AppleScript to open file picker for video files
      const script = `
        set theFile to choose file with prompt "Select a video file" of type {"public.movie", "public.video"}
        return POSIX path of theFile
      `;

      const proc = spawn('osascript', ['-e', script]);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('exit', (code: number) => {
        if (code === 0 && stdout.trim()) {
          const filePath = stdout.trim();
          console.log('[Worker] File selected:', filePath);

          // Get file info using bare-fs
          try {
            const stat = fs.statSync(filePath);
            const name = filePath.split('/').pop() || 'video';

            resolve({
              filePath,
              name,
              size: stat.size,
            });
          } catch (err: any) {
            reject(new Error(`Failed to stat file: ${err.message}`));
          }
        } else if (code === 1) {
          // User cancelled
          resolve({ cancelled: true });
        } else {
          reject(new Error(stderr || 'File picker failed'));
        }
      });

      proc.on('error', (err: Error) => {
        reject(err);
      });
    });
  },

  // ============================================
  // Public Feed API Methods
  // ============================================

  // Get the current public feed
  async getPublicFeed() {
    const feed = publicFeed.getFeed();
    const stats = publicFeed.getStats();
    console.log(`[PublicFeed API] Returning ${feed.length} entries (${stats.peerCount} peers connected)`);
    return {
      entries: feed,
      stats
    };
  },

  // Request fresh feed from peers
  async refreshFeed() {
    console.log('[PublicFeed API] Refreshing feed from peers...');
    const peerCount = publicFeed.requestFeedsFromPeers();
    return { success: true, peerCount };
  },

  // Submit a channel to the public feed
  async submitToFeed(driveKey: string) {
    console.log('[PublicFeed API] Submitting channel:', driveKey.slice(0, 16));
    publicFeed.submitChannel(driveKey);
    return { success: true };
  },

  // Hide a channel from the feed
  async hideChannel(driveKey: string) {
    console.log('[PublicFeed API] Hiding channel:', driveKey.slice(0, 16));
    publicFeed.hideChannel(driveKey);
    return { success: true };
  },

  // Get channel metadata (lazy loaded from drive)
  async getChannelMeta(driveKey: string) {
    console.log('[PublicFeed API] Getting metadata for:', driveKey.slice(0, 16));
    try {
      const drive = await getChannelDrive(driveKey);
      const metaBuffer = await drive.get('/channel.json');
      if (metaBuffer) {
        const meta = JSON.parse(b4a.toString(metaBuffer, 'utf-8'));

        // Count videos
        let videoCount = 0;
        try {
          for await (const entry of drive.readdir('/videos')) {
            if (entry.endsWith('.json')) videoCount++;
          }
        } catch {}

        return {
          ...meta,
          videoCount,
          driveKey
        };
      }
    } catch (err) {
      console.error('[PublicFeed API] Failed to get metadata:', err);
    }

    return {
      driveKey,
      name: 'Unknown Channel',
      description: '',
      videoCount: 0
    };
  },

  // Prefetch a video - start downloading all blocks for smooth seeking
  async prefetchVideo(driveKey: string, videoPath: string) {
    console.log('[Worker] Prefetching video:', driveKey.slice(0, 8), videoPath);
    const monitorKey = `${driveKey}:${videoPath}`;

    // Already monitoring?
    if (videoMonitors.has(monitorKey)) {
      return { success: true, message: 'Already prefetching' };
    }

    try {
      const drive = await getChannelDrive(driveKey);

      // Get the file entry
      const entry = await drive.entry(videoPath);
      if (!entry) {
        console.error('[Worker] Video file not found:', videoPath);
        return { success: false, error: 'Video not found' };
      }

      // Start monitoring the drive for download progress
      const monitor = drive.monitor();
      await monitor.ready();

      // Start downloading all blocks for this file
      const downloadRequest = drive.download(videoPath, { ifAvailable: false });

      // Store monitor data
      videoMonitors.set(monitorKey, {
        driveKey,
        videoPath,
        startTime: Date.now(),
        monitor,
        downloadRequest,
        entry,
      });

      console.log('[Worker] Prefetch started for:', videoPath, 'blocks:', entry.value?.blob?.blockLength || 0);
      return { success: true };
    } catch (err: any) {
      console.error('[Worker] Prefetch failed:', err);
      return { success: false, error: err.message };
    }
  },

  // Get real-time P2P stats for a video
  async getVideoStats(driveKey: string, videoPath: string) {
    const monitorKey = `${driveKey}:${videoPath}`;
    const monitorData = videoMonitors.get(monitorKey);

    if (!monitorData) {
      return {
        status: 'unknown' as const,
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

    const { startTime, monitor, entry } = monitorData;
    const elapsed = Date.now() - startTime;

    // Get download/upload speeds from monitor
    const downloadSpeed = monitor?.downloadSpeed?.() || 0;
    const uploadSpeed = monitor?.uploadSpeed?.() || 0;

    // Get blob stats from entry
    const blob = entry?.value?.blob;
    const totalBlocks = blob?.blockLength || 0;
    const totalBytes = blob?.byteLength || 0;

    // Calculate downloaded blocks from the drive's blobs core
    const drive = await getChannelDrive(driveKey);
    const blobsCore = drive?.blobs?.core;
    const contiguousLength = blobsCore?.contiguousLength || 0;
    const downloadedBlocks = Math.min(contiguousLength, totalBlocks);
    const progress = totalBlocks > 0 ? Math.round((downloadedBlocks / totalBlocks) * 100) : 0;
    const downloadedBytes = totalBlocks > 0 ? Math.round((downloadedBlocks / totalBlocks) * totalBytes) : 0;
    const isComplete = downloadedBlocks >= totalBlocks && totalBlocks > 0;

    // Determine status
    let status: 'connecting' | 'resolving' | 'downloading' | 'complete' | 'error' | 'unknown';
    if (isComplete) {
      status = 'complete';
    } else if (downloadedBlocks > 0) {
      status = 'downloading';
    } else if (swarm.connections.size > 0) {
      status = 'resolving';
    } else {
      status = 'connecting';
    }

    // If complete, we can mark it as cached
    if (isComplete && status !== 'complete') {
      status = 'complete';
    }

    return {
      status,
      progress,
      totalBlocks,
      downloadedBlocks,
      totalBytes,
      downloadedBytes,
      peerCount: swarm.connections.size,
      speedMBps: (downloadSpeed / (1024 * 1024)).toFixed(2),
      uploadSpeedMBps: (uploadSpeed / (1024 * 1024)).toFixed(2),
      elapsed,
      isComplete,
    };
  },
};

// Initialize
await loadIdentities();

const storedActive = await db.get('activeIdentity');
if (storedActive && storedActive.value) {
  activeIdentity = storedActive.value;
}

// Normalize identities loaded from DB (drop malformed, mark active)
identities = (identities || [])
  .filter(i => i && typeof i.publicKey === 'string' && i.publicKey && typeof i.driveKey === 'string' && i.driveKey)
  .map(i => ({
    ...i,
    isActive: i.publicKey === activeIdentity,
    createdAt: typeof i.createdAt === 'number' && i.createdAt >= 0 ? i.createdAt : Date.now(),
  }));

// Load existing channel drives
for (const identity of identities) {
  if (identity.driveKey) {
    try {
      console.log(`[Startup] Loading drive for identity "${identity.name}": ${identity.driveKey.slice(0, 16)}...`);
      const drive = new Hyperdrive(store, b4a.from(identity.driveKey, 'hex'));
      await drive.ready();
      console.log(`[Startup] Drive loaded, writable: ${drive.writable}, key: ${b4a.toString(drive.key, 'hex').slice(0, 16)}...`);

      // List existing videos
      try {
        const entries: string[] = [];
        for await (const entry of drive.readdir('/videos')) {
          entries.push(entry);
        }
        console.log(`[Startup] Found ${entries.length} files in /videos:`, entries);
      } catch (e) {
        console.log(`[Startup] No /videos directory yet`);
      }

      channels.set(identity.driveKey, drive);
      swarm.join(drive.discoveryKey);
    } catch (err) {
      console.error('Failed to load drive:', identity.driveKey, err);
    }
  }
}

// Load subscribed channels
const subs = (await db.get('subscriptions'))?.value || [];
for (const driveKey of subs) {
  try {
    await getChannelDrive(driveKey);
  } catch (err) {
    console.error('Failed to load subscription:', driveKey, err);
  }
}

// Start public feed discovery
await publicFeed.start();
console.log('[PublicFeed] Started P2P discovery');

console.log('PearTube Core Worker ready');
console.log('Storage location:', storage);
console.log('Identities loaded:', identities.length);
console.log('Active identity:', activeIdentity || 'none');
console.log('Blob server port:', blobServerPort);

// Get the pipe for IPC communication using pear-pipe
const ipcPipe = pipe();

if (!ipcPipe) {
  console.error('[Worker] Failed to get IPC pipe');
} else {
  console.log('[Worker] IPC pipe connected via pear-pipe');

  // Create HRPC instance with the pipe
  const rpc = new HRPC(ipcPipe);
  console.log('[Worker] HRPC initialized');

  // ============================================
  // HRPC Handler Registration
  // ============================================

  // Identity handlers
  rpc.onCreateIdentity(async (req: any) => {
    console.log('[HRPC] createIdentity:', req);
    const result = await api.createIdentity(req.name || 'New Channel', true);

    // Mark active identity
    activeIdentity = result.publicKey;
    identities = (identities || []).map(i => ({ ...i, isActive: i.publicKey === result.publicKey }));
    await db.put('activeIdentity', result.publicKey);
    await saveIdentities();

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
    console.log('[HRPC] getIdentity');
    const allIdentities = await api.getIdentities();
    const active = allIdentities.find((i: any) => i.isActive);
    return {
      identity: active
        ? {
            publicKey: active.publicKey,
            driveKey: active.driveKey,
            name: active.name,
            createdAt: active.createdAt,
            isActive: true,
          }
        : null
    };
  });

  rpc.onGetIdentities(async () => {
    console.log('[HRPC] getIdentities');
    const allIdentities = await api.getIdentities();
    return {
      identities: allIdentities.map((i: any) => ({
        publicKey: i.publicKey || '',
        driveKey: i.driveKey || '',
        name: i.name || '',
        // Ensure createdAt is a valid positive uint
        createdAt: typeof i.createdAt === 'number' && i.createdAt >= 0 ? i.createdAt : 0,
        isActive: Boolean(i.isActive),
      }))
    };
  });

  rpc.onSetActiveIdentity(async (req: any) => {
    console.log('[HRPC] setActiveIdentity:', req.publicKey);
    await api.setActiveIdentity(req.publicKey);
    // Persist active identity
    activeIdentity = req.publicKey;
    identities = (identities || []).map(i => ({ ...i, isActive: i.publicKey === req.publicKey }));
    await saveIdentities();
    await db.put('activeIdentity', req.publicKey);
    return { success: true };
  });

  rpc.onRecoverIdentity(async (req: any) => {
    console.log('[HRPC] recoverIdentity');
    const result = await api.recoverIdentity(req.seedPhrase);
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
    console.log('[HRPC] getChannel:', req.publicKey?.slice(0, 16));
    const channel = await api.getChannel(req.publicKey || '');
    return { channel };
  });

  rpc.onUpdateChannel(async (req: any) => {
    console.log('[HRPC] updateChannel');
    // TODO: Implement updateChannel in api
    return { channel: {} };
  });

  // Video handlers
  rpc.onListVideos(async (req: any) => {
    console.log('[HRPC] listVideos:', req.channelKey?.slice(0, 16));
    const rawVideos = await api.listVideos(req.channelKey || '');
    // Map stored metadata to HRPC schema format
    // Schema expects: id, title, description, duration, thumbnail, channelKey, channelName, createdAt, views
    // Stored has: id, title, description, path, mimeType, size, uploadedAt, channelKey
    const videos = rawVideos.map((v: any) => ({
      id: v.id || '',
      title: v.title || 'Untitled',
      description: v.description || '',
      path: v.path || '',
      duration: typeof v.duration === 'number' && v.duration >= 0 ? v.duration : 0,
      thumbnail: v.thumbnail || '',
      channelKey: v.channelKey || req.channelKey || '',
      channelName: v.channelName || '',
      createdAt: typeof v.uploadedAt === 'number' && v.uploadedAt >= 0 ? v.uploadedAt : (typeof v.createdAt === 'number' && v.createdAt >= 0 ? v.createdAt : 0),
      views: typeof v.views === 'number' && v.views >= 0 ? v.views : 0,
    }));
    return { videos };
  });

  rpc.onGetVideoUrl(async (req: any) => {
    console.log('[HRPC] getVideoUrl:', req.channelKey?.slice(0, 16), req.videoId);
    // Note: Schema uses channelKey/videoId, api uses driveKey/videoPath
    const result = await api.getVideoUrl(req.channelKey, req.videoId);
    return { url: result.url };
  });

  rpc.onGetVideoData(async (req: any) => {
    console.log('[HRPC] getVideoData:', req.channelKey?.slice(0, 16), req.videoId);
    // TODO: Implement getVideoData
    return { video: { id: req.videoId, title: 'Unknown' } };
  });

  rpc.onUploadVideo(async (req: any) => {
    console.log('[HRPC] uploadVideo:', req.title);
    const result = await api.uploadVideo(
      req.title,
      req.description || '',
      req.filePath,
      'video/mp4',
      (progress: number, bytesWritten: number, totalBytes: number) => {
        // Send progress event via HRPC
        try {
          rpc.eventUploadProgress({
            videoId: '',
            progress,
            bytesUploaded: bytesWritten,
            totalBytes,
          });
        } catch (e) {
          console.error('[HRPC] Failed to send progress event:', e);
        }
      }
    );
    return {
      video: {
        id: result.videoId,
        title: req.title,
        description: req.description || '',
        channelKey: result.metadata?.channelKey,
      }
    };
  });

  // Subscription handlers
  rpc.onSubscribeChannel(async (req: any) => {
    console.log('[HRPC] subscribeChannel:', req.channelKey?.slice(0, 16));
    await api.subscribeChannel(req.channelKey);
    return { success: true };
  });

  rpc.onUnsubscribeChannel(async (req: any) => {
    console.log('[HRPC] unsubscribeChannel:', req.channelKey?.slice(0, 16));
    // TODO: Implement unsubscribeChannel in api
    return { success: true };
  });

  rpc.onGetSubscriptions(async () => {
    console.log('[HRPC] getSubscriptions');
    const subs = await api.getSubscriptions();
    return {
      subscriptions: subs.map((s: any) => ({
        channelKey: s.driveKey,
        channelName: s.name,
      }))
    };
  });

  rpc.onJoinChannel(async (req: any) => {
    console.log('[HRPC] joinChannel:', req.channelKey?.slice(0, 16));
    // Join is same as subscribe for now
    await api.subscribeChannel(req.channelKey);
    return { success: true };
  });

  // Public Feed handlers
  rpc.onGetPublicFeed(async () => {
    console.log('[HRPC] getPublicFeed');
    const result = await api.getPublicFeed();
    return {
      entries: result.entries.map((e: any) => ({
        channelKey: e.driveKey || e.channelKey,
        channelName: e.name,
        videoCount: e.videoCount || 0,
        peerCount: e.peerCount || 0,
        lastSeen: e.lastSeen || 0,
      }))
    };
  });

  rpc.onRefreshFeed(async () => {
    console.log('[HRPC] refreshFeed');
    await api.refreshFeed();
    return { success: true };
  });

  rpc.onSubmitToFeed(async () => {
    console.log('[HRPC] submitToFeed');
    const allIdentities = await api.getIdentities();
    const active = allIdentities.find((i: any) => i.isActive);
    if (active?.driveKey) {
      await api.submitToFeed(active.driveKey);
    }
    return { success: true };
  });

  rpc.onHideChannel(async (req: any) => {
    console.log('[HRPC] hideChannel:', req.channelKey?.slice(0, 16));
    await api.hideChannel(req.channelKey);
    return { success: true };
  });

  rpc.onGetChannelMeta(async (req: any) => {
    console.log('[HRPC] getChannelMeta:', req.channelKey?.slice(0, 16));
    const meta = await api.getChannelMeta(req.channelKey);
    return {
      name: meta.name,
      description: meta.description,
      videoCount: meta.videoCount || 0,
    };
  });

  rpc.onGetSwarmStatus(async () => {
    console.log('[HRPC] getSwarmStatus');
    return {
      connected: swarm.connections.size > 0,
      peerCount: swarm.connections.size,
    };
  });

  // Video prefetch and stats
  rpc.onPrefetchVideo(async (req: any) => {
    console.log('[HRPC] prefetchVideo:', req.channelKey?.slice(0, 16), req.videoId);
    await api.prefetchVideo(req.channelKey, req.videoId);
    return { success: true };
  });

  rpc.onGetVideoStats(async (req: any) => {
    console.log('[HRPC] getVideoStats:', req.channelKey?.slice(0, 16), req.videoId);
    const stats = await api.getVideoStats(req.channelKey, req.videoId);
    // Ensure all uint fields are valid positive integers
    const safeUint = (val: any) => {
      const num = typeof val === 'number' ? val : parseFloat(val);
      return isNaN(num) || num < 0 ? 0 : Math.round(num);
    };
    return {
      stats: {
        videoId: req.videoId || '',
        channelKey: req.channelKey || '',
        status: stats.status || 'unknown',
        progress: safeUint(stats.progress),
        totalBlocks: safeUint(stats.totalBlocks),
        downloadedBlocks: safeUint(stats.downloadedBlocks),
        totalBytes: safeUint(stats.totalBytes),
        downloadedBytes: safeUint(stats.downloadedBytes),
        peerCount: safeUint(stats.peerCount),
        speedMBps: stats.speedMBps || '0',
        uploadSpeedMBps: stats.uploadSpeedMBps || '0',
        elapsed: safeUint(stats.elapsed),
        isComplete: Boolean(stats.isComplete),
      }
    };
  });

  // Seeding handlers (stubs for now)
  rpc.onGetSeedingStatus(async () => {
    console.log('[HRPC] getSeedingStatus');
    return {
      status: {
        enabled: false,
        usedStorage: 0,
        maxStorage: 0,
        seedingCount: 0,
      }
    };
  });

  rpc.onSetSeedingConfig(async (req: any) => {
    console.log('[HRPC] setSeedingConfig');
    return { success: true };
  });

  rpc.onPinChannel(async (req: any) => {
    console.log('[HRPC] pinChannel:', req.channelKey?.slice(0, 16));
    return { success: true };
  });

  rpc.onUnpinChannel(async (req: any) => {
    console.log('[HRPC] unpinChannel:', req.channelKey?.slice(0, 16));
    return { success: true };
  });

  rpc.onGetPinnedChannels(async () => {
    console.log('[HRPC] getPinnedChannels');
    return { channels: [] };
  });

  // Thumbnail/Metadata handlers
  rpc.onGetVideoThumbnail(async (req: any) => {
    console.log('[HRPC] getVideoThumbnail:', req.channelKey?.slice(0, 16), req.videoId);
    return { url: null, dataUrl: null };
  });

  rpc.onGetVideoMetadata(async (req: any) => {
    console.log('[HRPC] getVideoMetadata:', req.channelKey?.slice(0, 16), req.videoId);
    return { video: { id: req.videoId, title: 'Unknown' } };
  });

  rpc.onSetVideoThumbnail(async (req: any) => {
    console.log('[HRPC] setVideoThumbnail');
    return { success: true };
  });

  // Desktop-specific handlers
  rpc.onGetStatus(async () => {
    console.log('[HRPC] getStatus');
    const status = await api.getStatus();
    return {
      status: {
        ready: true,
        hasIdentity: identities.length > 0,
        blobServerPort: status.blobServerPort,
      }
    };
  });

  rpc.onPickVideoFile(async () => {
    console.log('[HRPC] pickVideoFile');
    const result = await api.pickVideoFile();
    return {
      filePath: result.filePath || null,
      cancelled: result.cancelled || false,
    };
  });

  rpc.onGetBlobServerPort(async () => {
    console.log('[HRPC] getBlobServerPort');
    return { port: blobServerPort };
  });

  // Event handlers (client -> server, usually no-ops)
  rpc.onEventReady(() => {
    console.log('[HRPC] Client acknowledged ready');
  });

  rpc.onEventError((data: any) => {
    console.error('[HRPC] Client reported error:', data?.message);
  });

  rpc.onEventUploadProgress(() => {
    // Client shouldn't send this
  });

  rpc.onEventFeedUpdate(() => {
    // Client shouldn't send this
  });

  rpc.onEventLog(() => {
    // Client shouldn't send this
  });

  rpc.onEventVideoStats(() => {
    // Client shouldn't send this
  });

  // Send ready event to client
  try {
    rpc.eventReady({ blobServerPort });
    console.log('[Worker] Sent eventReady via HRPC');
  } catch (e) {
    console.error('[Worker] Failed to send eventReady:', e);
  }

  ipcPipe.on('error', (err: Error) => {
    console.error('[Worker] Pipe error:', err);
  });

  console.log('[Worker] HRPC handlers registered');
}

// Keep worker alive
Pear.teardown(async () => {
  console.log('Worker shutting down...');
  await blobServer.close();
  await swarm.destroy();
});
