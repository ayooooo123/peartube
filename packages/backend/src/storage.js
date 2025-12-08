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
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function tryRequire(mod) {
  try {
    return require(mod);
  } catch {
    return null;
  }
}

const fs = tryRequire('bare-fs') || tryRequire('fs');
const path = tryRequire('bare-path') || tryRequire('path');

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
 * @returns {Promise<import('./types.js').StorageContext>}
 */
export async function initializeStorage(config) {
  const { storagePath, defaultTimeout = 30000, wrapTimeout = true, swarmKeyPath, blobServerPort: blobServerPortOverride } = config;

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
  let blobServerHost = '127.0.0.1';

  if (process?.env?.BLOB_SERVER_HOST) {
    blobServerHost = process.env.BLOB_SERVER_HOST;
  }

  try {
    const envPort = Number(process?.env?.BLOB_SERVER_PORT);
    const desiredPort = Number.isFinite(envPort) ? envPort : (blobServerPortOverride || 0);

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
    store.replicate(conn);
  });

  // Drive cache
  const drives = new Map();

  return {
    store,
    metaDb,
    swarm,
    blobServer,
    blobServerPort,
    blobServerHost,
    drives
  };
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
  await discovery.flushed();

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
  await discovery.flushed();

  console.log('[Storage] Created drive:', keyHex.slice(0, 8));
  return { drive, keyHex };
}

/**
 * Get video blob URL from blob server.
 *
 * @param {import('./types.js').StorageContext} ctx - Storage context
 * @param {string} driveKey - Drive key
 * @param {string} videoPath - Path to video in drive
 * @returns {Promise<{url: string}>}
 */
export async function getVideoUrl(ctx, driveKey, videoPath) {
  console.log('[Storage] GET_VIDEO_URL:', driveKey?.slice(0, 16), videoPath);

  // Make sure the drive is loaded and synced
  const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 15000 });

  // Resolve the filename to get blob info directly
  // This avoids HTTP 307 redirect which can break VLC seeking
  const entry = await drive.entry(videoPath);
  if (!entry || !entry.value?.blob) {
    throw new Error('Video not found in drive');
  }

  const blob = entry.value.blob;
  console.log('[Storage] Resolved blob:', JSON.stringify(blob));

  // Get the content key for the blobs core
  const blobsCore = await drive.getBlobs();
  if (!blobsCore) {
    throw new Error('Could not get blobs core');
  }
  const blobsKey = blobsCore.core.key;

  // Generate direct blob URL (no redirect needed)
  const url = ctx.blobServer.getLink(blobsKey, {
    blob: blob,
    type: videoPath.endsWith('.webm') ? 'video/webm' : 'video/mp4'
  });

  console.log('[Storage] Direct blob URL:', url);
  return { url };
}
