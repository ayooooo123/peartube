/**
 * Storage Module - Shared storage initialization and drive management
 *
 * Handles Corestore, Hyperbee, Hyperdrive, and BlobServer setup.
 */

import Corestore from 'corestore';
import Hyperbee from 'hyperbee';
import Hyperdrive from 'hyperdrive';
import BlobServer from 'hypercore-blob-server';
import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import { MultiWriterChannel, ChannelPairer } from './channel/index.js'

// Import bare-fs and bare-path for Bare runtime environments (mobile/desktop)
// Note: These are only available in Bare runtime, guards below handle when they're not
let fs = null;
let path = null;
try { fs = (await import('bare-fs')).default || (await import('bare-fs')); } catch {}
try { path = (await import('bare-path')).default || (await import('bare-path')); } catch {}

/**
 * Wrap a corestore to add default timeout to all get() calls.
 * This ensures cores used by BlobServer have timeout for P2P fetching.
 *
 * @param {import('corestore')} store - Corestore instance
 * @param {number} [defaultTimeout=30000] - Default timeout in ms
 * @returns {import('corestore')} Wrapped store
 */
export function wrapStoreWithTimeout(store, defaultTimeout = 30000) {
  const originalGet = store.get.bind(store);
  store.get = function(opts = {}) {
    const optsWithTimeout = {
      ...opts,
      timeout: opts.timeout ?? defaultTimeout
    };
    return originalGet(optsWithTimeout);
  };
  return store;
}

/**
 * Initialize core storage components.
 *
 * @param {Object} config
 * @param {string} config.storagePath - Path to storage directory
 * @param {number} [config.defaultTimeout=30000] - Default timeout for operations
 * @param {boolean} [config.wrapTimeout=true] - Whether to wrap store with timeout
 * @param {string} [config.swarmKeyPath] - Optional path to persist Hyperswarm keypair
 * @param {number} [config.blobServerPort] - Optional fixed blob server port
 * @param {string} [config.blobServerHost] - Optional blob server host (defaults to 127.0.0.1)
 * @returns {Promise<import('./types.js').StorageContext>}
 */
export async function initializeStorage(config) {
  const { storagePath, defaultTimeout = 30000, wrapTimeout = true, swarmKeyPath, blobServerPort: blobServerPortOverride, blobServerHost: blobServerHostOverride } = config;

  console.log('[Storage] Initializing storage at:', storagePath);

  // Validate storage path
  if (!storagePath || storagePath === './storage') {
    console.warn('[Storage] WARNING: Using relative/default storage path. Data may not persist!');
    console.warn('[Storage] Consider using --store flag for persistent storage.');
  }

  // Initialize Corestore
  console.log('[Storage] Creating Corestore...');
  const store = new Corestore(storagePath);

  console.log('[Storage] Waiting for Corestore ready...');
  await store.ready();
  console.log('[Storage] Corestore ready, opened:', store.opened, 'closed:', store.closed);

  // Optionally wrap with timeout for P2P operations
  const blobStore = wrapTimeout ? wrapStoreWithTimeout(store, defaultTimeout) : store;

  // Initialize blob server for video streaming
  let blobServer = null;
  let blobServerPort = 0;
  let blobServerHost = blobServerHostOverride || '127.0.0.1';

  try {
    const desiredPort = blobServerPortOverride || 0;

    blobServer = new BlobServer(blobStore, {
      port: desiredPort || 0, // Use fixed if provided
      host: blobServerHost
    });

    console.log('[Storage] Starting blob server listen...');
    await blobServer.listen();
    blobServerPort = blobServer.port;
    console.log('[Storage] Blob server listening on port:', blobServerPort);
  } catch (err) {
    console.error('[Storage] Failed to initialize blob server:', err.message);
    // Continue without blob server - will need alternative video streaming
  }

  // Initialize metadata database
  const metaCore = store.get({ name: 'peartube-meta' });
  const metaDb = new Hyperbee(metaCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  });
  await metaDb.ready();

  // Initialize Hyperswarm for P2P networking
  let keyPair = null;
  const resolvedSwarmKeyPath = swarmKeyPath || (path && storagePath ? path.join(storagePath, 'swarm-key.json') : null);

  if (resolvedSwarmKeyPath && fs) {
    try {
      const raw = fs.readFileSync(resolvedSwarmKeyPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.publicKey && parsed?.secretKey) {
        keyPair = {
          publicKey: b4a.from(parsed.publicKey, 'hex'),
          secretKey: b4a.from(parsed.secretKey, 'hex')
        };
        console.log('[Storage] Loaded persisted swarm key:', parsed.publicKey.slice(0, 16));
      }
    } catch (e) {
      // If missing or invalid, we'll generate below
    }
  }

  if (!keyPair) {
    keyPair = crypto.keyPair();
    if (resolvedSwarmKeyPath && fs) {
      try {
        fs.mkdirSync(path.dirname(resolvedSwarmKeyPath), { recursive: true });
        fs.writeFileSync(resolvedSwarmKeyPath, JSON.stringify({
          publicKey: b4a.toString(keyPair.publicKey, 'hex'),
          secretKey: b4a.toString(keyPair.secretKey, 'hex')
        }));
        console.log('[Storage] Persisted new swarm key to', resolvedSwarmKeyPath);
      } catch (e) {
        console.log('[Storage] Could not persist swarm key:', e.message);
      }
    }
  }

  console.log('[Storage] Creating Hyperswarm...');
  const swarm = new Hyperswarm({ keyPair });
  console.log('[Storage] Swarm created, publicKey:', b4a.toString(swarm.keyPair.publicKey, 'hex').slice(0, 16));

  // Set up replication for all connections
  swarm.on('connection', (conn, info) => {
    const remoteKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : 'unknown';
    console.log('[Storage] Peer connected:', remoteKey);

    // Replicate Hypercore/Hyperdrive storage
    store.replicate(conn);

    // CRITICAL: Also replicate all loaded Autobase channels
    // This ensures comments, reactions, and other Autobase ops sync between devices
    // Without this, only Hypercore data syncs but Autobase linearization doesn't happen
    if (channels && channels.size > 0) {
      console.log('[Storage] Replicating', channels.size, 'Autobase channel(s) on new connection');
      for (const [keyHex, channel] of channels) {
        if (channel.base) {
          try {
            channel.base.replicate(conn)
            console.log('[Storage] Replicated Autobase for channel:', keyHex.slice(0, 16))
          } catch (err) {
            console.log('[Storage] Error replicating channel', keyHex.slice(0, 16), ':', err?.message)
          }
        }
      }
    }
  });

  // Drive cache
  const drives = new Map();
  const channels = new Map();

  return {
    store,
    metaDb,
    swarm,
    blobServer,
    blobServerPort,
    blobServerHost,
    drives,
    channels
  };
}

/**
 * Load or create a multi-writer channel by Autobase key.
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {string} channelKeyHex
 * @param {Object} [options]
 * @param {string} [options.encryptionKeyHex]
 * @returns {Promise<import('./channel/multi-writer-channel.js').MultiWriterChannel>}
 */
// Track in-progress channel loads to prevent duplicate concurrent loads
const loadingChannels = new Map()

export async function loadChannel(ctx, channelKeyHex, options = {}) {
  if (!ctx.channels) ctx.channels = new Map()
  if (ctx.channels.has(channelKeyHex)) {
    console.log('[Storage] loadChannel: returning cached channel:', channelKeyHex.slice(0, 16))
    return ctx.channels.get(channelKeyHex)
  }

  // Check if already loading - wait for existing load to complete
  if (loadingChannels.has(channelKeyHex)) {
    console.log('[Storage] loadChannel: already loading, waiting...:', channelKeyHex.slice(0, 16))
    return loadingChannels.get(channelKeyHex)
  }

  console.log('[Storage] loadChannel: cache miss, loading new:', channelKeyHex.slice(0, 16))

  // Create loading promise and store it to prevent duplicate loads
  const loadPromise = (async () => {
    // Check if corestore is still open
    if (ctx.store.closed) {
      console.error('[Storage] ERROR: Corestore is closed! Cannot load channel:', channelKeyHex.slice(0, 16));
      throw new Error('Corestore is closed');
    }

    console.log('[Storage] Loading channel:', channelKeyHex.slice(0, 16));
    const ch = new MultiWriterChannel(ctx.store, {
      key: b4a.from(channelKeyHex, 'hex'),
      encryptionKey: options.encryptionKeyHex ? b4a.from(options.encryptionKeyHex, 'hex') : null
    })

    // Add timeout to prevent hanging on channel ready
    const readyStart = Date.now()
    try {
      await Promise.race([
        ch.ready(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Channel ready timeout')), 10000))
      ])
    } catch (err) {
      console.error('[Storage] Channel ready failed:', err.message)
      throw err
    }
    console.log('[Storage] Channel ready in', Date.now() - readyStart, 'ms:', channelKeyHex.slice(0, 16));
    ctx.channels.set(channelKeyHex, ch)

    // Ensure we join the channel topic so this device can FIND peers and replicate Autobase cores.
    // (Even non-writable peers must join; pairing setup is only for writable "members".)
    if (ctx.swarm) {
      try {
        if (ch.discoveryKey) ctx.swarm.join(ch.discoveryKey)
        // Non-blocking: setupPairing may wait on swarm internals; don't let this stall API calls.
        ch.setupPairing(ctx.swarm).catch((err) => {
          console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
        })
      } catch (err) {
        console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
      }
    }

    return ch
  })()

  // Store the promise so concurrent callers can wait on the same load
  loadingChannels.set(channelKeyHex, loadPromise)

  try {
    const ch = await loadPromise
    return ch
  } finally {
    // Clean up loading state
    loadingChannels.delete(channelKeyHex)
  }
}

/**
 * Create a new multi-writer channel and join it on the swarm.
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {Object} [options]
 * @returns {Promise<{channel: import('./channel/multi-writer-channel.js').MultiWriterChannel, channelKeyHex: string, encryptionKeyHex: string|null}>}
 */
export async function createChannel(ctx, options = {}) {
  if (!ctx.channels) ctx.channels = new Map()

  const ch = new MultiWriterChannel(ctx.store, { encrypt: Boolean(options.encrypt) })
  await ch.ready()

  const channelKeyHex = ch.keyHex
  const encryptionKeyHex = ch.encryptionKey ? b4a.toString(ch.encryptionKey, 'hex') : null

  ctx.channels.set(channelKeyHex, ch)

  // Persist a marker so we can reliably distinguish multi-writer channels from legacy Hyperdrives.
  try {
    await ctx.metaDb.put(`mw-channel:${channelKeyHex}`, { kind: 'autobase', createdAt: Date.now() })
  } catch {}

  // Set up pairing and replication in background (non-blocking)
  if (ctx.swarm) {
    try {
      if (ch.discoveryKey) ctx.swarm.join(ch.discoveryKey)
    } catch {}

    ch.setupPairing(ctx.swarm).catch(err => {
      console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
    })
  }

  return { channel: ch, channelKeyHex, encryptionKeyHex }
}

/**
 * Pair a new device into an existing channel using an invite code.
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {string} inviteCode
 * @param {Object} [options]
 * @param {string} [options.deviceName]
 * @returns {Promise<{channel: import('./channel/multi-writer-channel.js').MultiWriterChannel, channelKeyHex: string}>}
 */
export async function pairDevice(ctx, inviteCode, options = {}) {
  const pairer = new ChannelPairer(ctx.store, inviteCode, {
    swarm: ctx.swarm,
    deviceName: options.deviceName || ''
  })
  await pairer.ready()
  const channel = await pairer.finished()
  const channelKeyHex = channel.keyHex
  if (!ctx.channels) ctx.channels = new Map()
  ctx.channels.set(channelKeyHex, channel)

  // Persist marker for multi-writer channel
  try {
    await ctx.metaDb.put(`mw-channel:${channelKeyHex}`, { kind: 'autobase', createdAt: Date.now() })
  } catch {}

  // Set up pairing and replication - MUST await to ensure base.replicate(conn) handler is wired up
  // before waitForInitialSync() is called in the API layer.
  // NOTE: API no longer blocks on waitForInitialSync in listVideos; keep this non-blocking to
  // avoid mobile hangs while still joining replication.
  if (ctx.swarm) {
    try {
      if (channel.discoveryKey) ctx.swarm.join(channel.discoveryKey)
      channel.setupPairing(ctx.swarm).catch((err) => {
        console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
      })
    } catch (err) {
      console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
    }
  }

  return { channel, channelKeyHex }
}

/**
 * Helper: wait for drive to sync with timeout
 *
 * @param {import('hyperdrive')} drive - Hyperdrive instance
 * @param {number} [timeout=5000] - Timeout in ms
 * @returns {Promise<import('hyperdrive')>}
 */
export async function waitForDriveSync(drive, timeout = 5000) {
  const start = Date.now();

  try {
    await Promise.race([
      drive.core.update({ wait: true }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Drive sync timeout')), timeout)
      )
    ]);
  } catch (err) {
    console.log('[Storage] Drive sync wait:', err.message);
  }

  console.log('[Storage] Drive sync took', Date.now() - start, 'ms, length:', drive.core.length);
  return drive;
}

/**
 * Load or get an existing drive by key.
 *
 * @param {import('./types.js').StorageContext} ctx - Storage context
 * @param {string} keyHex - Drive key as hex string
 * @param {Object} [options]
 * @param {boolean} [options.waitForSync=false] - Wait for sync with peers
 * @param {number} [options.syncTimeout=5000] - Sync timeout in ms
 * @returns {Promise<import('hyperdrive')>}
 */
export async function loadDrive(ctx, keyHex, options = {}) {
  const { waitForSync = false, syncTimeout = 5000 } = options;

  // Validate key format (must be 64 hex characters = 32 bytes)
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) {
    throw new Error('Invalid channel key: must be 64 hex characters');
  }

  // Check if corestore is still open
  if (ctx.store.closed) {
    console.error('[Storage] ERROR: Corestore is closed! Cannot load drive:', keyHex.slice(0, 16));
    throw new Error('Corestore is closed');
  }

  // Return cached drive if exists
  if (ctx.drives.has(keyHex)) {
    const existingDrive = ctx.drives.get(keyHex);
    if (waitForSync) {
      await waitForDriveSync(existingDrive, syncTimeout);
    }
    return existingDrive;
  }

  // Create new drive from key
  const keyBuf = b4a.from(keyHex, 'hex');
  const drive = new Hyperdrive(ctx.store, keyBuf);
  await drive.ready();

  ctx.drives.set(keyHex, drive);

  // Join swarm for this drive
  const discovery = ctx.swarm.join(drive.discoveryKey);
  // IMPORTANT: On some runtimes (notably mobile/Bare), `flushed()` can take a long time or never resolve
  // (e.g. after app resume/restart while the network stack is still warming up). Never block callers on it.
  try {
    await Promise.race([
      discovery.flushed(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('swarm join flush timeout')), 3000))
    ])
  } catch (err) {
    console.log('[Storage] Swarm join flush warning:', err?.message)
  }

  console.log('[Storage] Loaded drive:', keyHex.slice(0, 8));

  // Wait for initial sync if requested
  if (waitForSync) {
    await waitForDriveSync(drive, syncTimeout);
  }

  return drive;
}

/**
 * Create a new writable drive.
 *
 * @param {import('./types.js').StorageContext} ctx - Storage context
 * @returns {Promise<{drive: import('hyperdrive'), keyHex: string}>}
 */
export async function createDrive(ctx) {
  const drive = new Hyperdrive(ctx.store);
  await drive.ready();

  const keyHex = b4a.toString(drive.key, 'hex');
  ctx.drives.set(keyHex, drive);

  // Join swarm
  const discovery = ctx.swarm.join(drive.discoveryKey);
  try {
    await Promise.race([
      discovery.flushed(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('swarm join flush timeout')), 3000))
    ])
  } catch (err) {
    console.log('[Storage] Swarm join flush warning:', err?.message)
  }

  console.log('[Storage] Created drive:', keyHex.slice(0, 8));
  return { drive, keyHex };
}

/**
 * Get video blob URL from blob server.
 *
 * @param {import('./types.js').StorageContext} ctx - Storage context
 * @param {string} driveKey - Drive key
 * @param {string} videoPath - Path to video in drive
 * @param {Object} [options]
 * @param {import('hyperdrive')} [options.drive] - Pre-loaded drive (for multi-writer blob drives)
 * @returns {Promise<{url: string}>}
 */
export async function getVideoUrl(ctx, driveKey, videoPath, options = {}) {
  console.log('[Storage] GET_VIDEO_URL:', driveKey?.slice(0, 16), videoPath);

  // Use pre-loaded drive if provided (for multi-writer blob drives)
  // Otherwise load the drive and sync
  let drive;
  if (options.drive) {
    console.log('[Storage] GET_VIDEO_URL: using pre-loaded drive');
    drive = options.drive;
  } else {
    drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 15000 });
  }

  // Best-effort: pull latest blocks for remote drives with a bounded wait.
  // This helps public-feed playback where the blob drive is remote and has just been joined.
  try {
    await Promise.race([
      drive.core.update({ wait: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('drive update timeout')), 15000))
    ])
  } catch {}

  // Resolve the filename to get blob info directly.
  // This avoids HTTP 307 redirect which can break VLC seeking.
  //
  // NOTE: For public-feed playback, the blob drive is often remote and metadata may not be
  // available immediately. Use a bounded wait here so "play" works once peers are connected.
  let entry = null
  try {
    entry = await drive.entry(videoPath, { wait: true, timeout: 15000 })
  } catch (err) {
    // Fall back to non-waiting lookup (helps on older hyperdrive builds that may not support opts)
    try { entry = await drive.entry(videoPath) } catch {}
  }
  if (!entry || !entry.value?.blob) {
    throw new Error('Video not found in drive (not synced yet)');
  }

  const blob = entry.value.blob;
  console.log('[Storage] Resolved blob:', JSON.stringify(blob));

  // Get the content key for the blobs core
  const blobsCore = await drive.getBlobs();
  if (!blobsCore) {
    throw new Error('Could not get blobs core');
  }
  const blobsKey = blobsCore.core.key;

  // Try to get MIME type from video metadata (detected during upload)
  let mimeType = 'video/mp4'; // Default fallback
  try {
    // Extract videoId from path like /videos/{id}.ext
    const match = videoPath.match(/\/videos\/([^.]+)\./);
    if (match) {
      const metaPath = `/videos/${match[1]}.json`;
      const metaBuf = await drive.get(metaPath);
      if (metaBuf) {
        const meta = JSON.parse(b4a.toString(metaBuf, 'utf-8'));
        if (meta.mimeType) {
          mimeType = meta.mimeType;
          console.log('[Storage] Got MIME type from metadata:', mimeType);
        }
      }
    }
  } catch (err) {
    console.log('[Storage] Could not read video metadata, using default MIME type');
  }

  // Generate direct blob URL (no redirect needed)
  const url = ctx.blobServer.getLink(blobsKey, {
    blob: blob,
    type: mimeType
  });

  console.log('[Storage] Direct blob URL:', url);
  return { url };
}
