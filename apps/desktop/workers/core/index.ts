/**
 * PearTube - Core Backend Worker
 *
 * This worker handles all P2P operations, storage, and networking.
 * It runs in a separate process from the UI for better performance.
 * Uses pear-pipe with newline-delimited JSON (qvac pattern).
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

// Import shared modules
import { CMD as SharedCMD } from '@peartube/shared';
// @ts-ignore - backend-core is JavaScript
import { PublicFeedManager } from '@peartube/backend-core/public-feed';

// Get Pear runtime globals
declare const Pear: any;

// Use shared CMD, with backwards-compatible aliases for desktop-specific commands
const CMD = {
  ...SharedCMD,
  // Desktop uses different IDs currently - map to shared for new code
  // These will be gradually migrated to match shared IDs
  GET_STATUS: 1,
  CREATE_IDENTITY: 2,
  GET_IDENTITIES: 3,
  SET_ACTIVE_IDENTITY: 4,
  LIST_VIDEOS: 5,
  GET_VIDEO_URL: 6,
  SUBSCRIBE_CHANNEL: 7,
  GET_SUBSCRIPTIONS: 8,
  GET_BLOB_SERVER_PORT: 9,
  UPLOAD_VIDEO: 10,
  GET_CHANNEL: 11,
  RECOVER_IDENTITY: 12,
  PICK_VIDEO_FILE: 13,
  GET_PUBLIC_FEED: 14,
  REFRESH_FEED: 15,
  SUBMIT_TO_FEED: 16,
  HIDE_CHANNEL: 17,
  GET_CHANNEL_META: 18,
  PREFETCH_VIDEO: 19,
  GET_VIDEO_STATS: 20,
};

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
const blobServerPort = blobServer.address.port;
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
    return identities.map(i => ({
      publicKey: i.publicKey,
      driveKey: i.driveKey,
      name: i.name,
      createdAt: i.createdAt,
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
// Uses newline-delimited JSON protocol (qvac pattern)
const ipcPipe = pipe();

if (!ipcPipe) {
  console.error('[Worker] Failed to get IPC pipe');
} else {
  console.log('[Worker] IPC pipe connected via pear-pipe');

  // Message buffer for newline-delimited JSON
  let messageBuffer = '';

  // Helper to send a response (newline-delimited JSON)
  const sendResponse = (id: string, success: boolean, data?: any, error?: string) => {
    const response = success
      ? { id, success: true, data }
      : { id, success: false, error: error || 'Unknown error' };
    ipcPipe.write(JSON.stringify(response) + '\n');
  };

  // Send worker_initialized message
  ipcPipe.write(JSON.stringify({ type: 'worker_initialized' }) + '\n');
  console.log('[Worker] Sent worker_initialized');

  // Handle incoming data with newline-delimited JSON
  ipcPipe.on('data', async (chunk: Buffer) => {
    messageBuffer += Buffer.from(chunk).toString();

    // Process complete messages (split by newline)
    const messages = messageBuffer.split('\n');
    messageBuffer = messages.pop() || '';

    for (const msg of messages) {
      if (!msg.trim()) continue;

      // Check for exit command
      let parsed: any;
      try {
        parsed = JSON.parse(msg);
      } catch (err) {
        console.error('[Worker] Failed to parse message:', err);
        continue;
      }

      // Handle exit
      if (parsed.type === 'exit') {
        console.log('[Worker] Received exit command');
        Pear.exit();
        return;
      }

      const { id, command, method, args = [], data = {} } = parsed;
      console.log(`[Worker] Command ${command || method} (id: ${id})`);

      try {
        let result: any;

        // Handle method-based RPC calls (from rpc.ts client)
        if (method && typeof method === 'string' && api[method as keyof typeof api]) {
          result = await (api[method as keyof typeof api] as Function)(...args);
          // Send response in format expected by rpc.ts
          ipcPipe.write(JSON.stringify({ type: 'rpc-response', id, result }) + '\n');
          continue;
        }

        switch (command) {
          case CMD.GET_STATUS:
            result = await api.getStatus();
            break;

          case CMD.CREATE_IDENTITY:
            result = await api.createIdentity(data.name, data.generateMnemonic ?? true);
            break;

          case CMD.RECOVER_IDENTITY:
            result = await api.recoverIdentity(data.mnemonic, data.name);
            break;

          case CMD.GET_IDENTITIES:
            result = await api.getIdentities();
            break;

          case CMD.SET_ACTIVE_IDENTITY:
            result = await api.setActiveIdentity(data.publicKey);
            break;

          case CMD.LIST_VIDEOS:
            result = await api.listVideos(data.driveKey);
            break;

          case CMD.GET_VIDEO_URL:
            result = await api.getVideoUrl(data.driveKey, data.videoPath);
            break;

          case CMD.SUBSCRIBE_CHANNEL:
            result = await api.subscribeChannel(data.driveKey);
            break;

          case CMD.GET_SUBSCRIPTIONS:
            result = await api.getSubscriptions();
            break;

          case CMD.GET_BLOB_SERVER_PORT:
            result = await api.getBlobServerPort();
            break;

          case CMD.GET_CHANNEL:
            result = await api.getChannel(data.driveKey);
            break;

          case CMD.UPLOAD_VIDEO:
            // Upload via file path with progress callback
            result = await api.uploadVideo(data.title, data.description, data.filePath, data.mimeType, (progress, bytesWritten, totalBytes) => {
              // Send progress event to UI
              ipcPipe.write(JSON.stringify({
                type: 'upload_progress',
                requestId: id,
                progress,
                bytesWritten,
                totalBytes
              }) + '\n');
            });
            break;

          case CMD.PICK_VIDEO_FILE:
            result = await api.pickVideoFile();
            break;

          // Public Feed commands
          case CMD.GET_PUBLIC_FEED:
            result = await api.getPublicFeed();
            break;

          case CMD.REFRESH_FEED:
            result = await api.refreshFeed();
            break;

          case CMD.SUBMIT_TO_FEED:
            result = await api.submitToFeed(data.driveKey);
            break;

          case CMD.HIDE_CHANNEL:
            result = await api.hideChannel(data.driveKey);
            break;

          case CMD.GET_CHANNEL_META:
            result = await api.getChannelMeta(data.driveKey);
            break;

          case CMD.PREFETCH_VIDEO:
            result = await api.prefetchVideo(data.driveKey, data.videoPath);
            break;

          case CMD.GET_VIDEO_STATS:
            result = await api.getVideoStats(data.driveKey, data.videoPath);
            break;

          default:
            throw new Error(`Unknown command: ${command}`);
        }

        sendResponse(id, true, result);
      } catch (error: any) {
        console.error('[Worker] Error:', error);
        sendResponse(id, false, null, error.message || 'Unknown error');
      }
    }
  });

  ipcPipe.on('error', (err: Error) => {
    console.error('[Worker] Pipe error:', err);
  });

  console.log('[Worker] Newline-delimited JSON message handler ready');
}

// Keep worker alive
Pear.teardown(async () => {
  console.log('Worker shutting down...');
  await blobServer.close();
  await swarm.destroy();
});
