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
import { PublicChannelBee } from './channel/public-channel-bee.js'

// Blind peering for mobile connectivity (keeps Autobases available through mirror servers)
// This solves the issue where mobile devices behind CGNAT can't establish direct P2P connections
// - BlindPeer (server): Desktop instances run as mirrors to keep data available
// - BlindPeering (client): Mobile instances connect to mirrors when direct P2P fails
let BlindPeer = null;
let BlindPeering = null;
let Wakeup = null;
try {
  BlindPeer = (await import('blind-peer')).default;
  BlindPeering = (await import('blind-peering')).default;
  Wakeup = (await import('protomux-wakeup')).default;
} catch (e) {
  // blind-peering is optional - will work without it but mobile may have connectivity issues
  console.log('[Storage] blind-peer/blind-peering not available, mobile connectivity may be limited');
}

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
  store.get = function(keyOrOpts = {}) {
    // Handle both store.get(key) and store.get({ key, ... }) signatures
    // If first arg is a Buffer, it's a raw key - wrap it in options
    if (b4a.isBuffer(keyOrOpts)) {
      return originalGet({ key: keyOrOpts, timeout: defaultTimeout });
    }
    // Otherwise it's an options object - add timeout if not present
    const optsWithTimeout = {
      ...keyOrOpts,
      timeout: keyOrOpts.timeout ?? defaultTimeout
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
 * @param {string[]} [config.blindPeerMirrors] - Z32-encoded keys of blind peer mirrors to connect to
 * @param {boolean} [config.enableBlindPeerServer=true] - Whether to run as blind peer server (desktop)
 * @returns {Promise<import('./types.js').StorageContext>}
 */
export async function initializeStorage(config) {
  const {
    storagePath,
    defaultTimeout = 30000,
    wrapTimeout = true,
    swarmKeyPath,
    blobServerPort: blobServerPortOverride,
    blobServerHost: blobServerHostOverride,
    blindPeerMirrors = [],
    enableBlindPeerServer = true
  } = config;

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

  // Start listening - DON'T block on it since it may hang on mobile
  // The listen() call starts the server but we don't need to wait for it
  console.log('[Storage] Starting swarm.listen() (non-blocking)...');
  const listenPromise = swarm.listen()

  // Track listen state for debugging
  swarm._peartubeListenResolved = false
  if (listenPromise && typeof listenPromise.then === 'function') {
    listenPromise
      .then(() => {
        swarm._peartubeListenResolved = true
        console.log('[Storage] listen() resolved, dht.firewalled:', swarm.dht?.firewalled, 'dht.bootstrapped:', swarm.dht?.bootstrapped)
      })
      .catch((e) => {
        console.log('[Storage] listen() failed:', e?.message)
      })
  }

  // Log DHT state for debugging
  const logDhtState = () => {
    const dht = swarm.dht
    if (dht) {
      console.log('[Storage] DHT state: bootstrapped=', dht.bootstrapped, 'firewalled=', dht.firewalled, 'ephemeral=', dht.ephemeral, 'online=', dht.online)
    }
  }

  // Check DHT state after a delay
  setTimeout(logDhtState, 2000)
  setTimeout(logDhtState, 5000)

  // Log swarm events for debugging mobile connectivity
  swarm.on('update', () => {
    console.log('[Storage] Swarm update event: connections=', swarm.connections?.size || 0, 'peers=', swarm.peers?.size || 0);
  });

  // Log connection events
  swarm.on('connection', (conn, info) => {
    const remoteKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : 'unknown'
    console.log('[Storage] NEW CONNECTION:', remoteKey, 'total:', swarm.connections?.size || 0)
  })

  // Log peer discovery events (DHT found a peer)
  swarm.on('peer', (peer) => {
    const peerKey = peer?.publicKey ? b4a.toString(peer.publicKey, 'hex').slice(0, 16) : 'unknown'
    console.log('[Storage] PEER DISCOVERED:', peerKey, 'total peers:', swarm.peers?.size || 0)
  })

  // Drive cache (declare early so connection handler can access)
  const drives = new Map();
  const channels = new Map();

  // Set up replication for all connections
  swarm.on('connection', (conn, info) => {
    const remoteKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : 'unknown';
    console.log('[Storage] Peer connected:', remoteKey);

    // Replicate all Hypercore data in the Corestore:
    // - Autobase cores (channel metadata, videos, comments, etc.)
    // - Hyperblobs cores (video bytes, thumbnails)
    // - Legacy Hyperdrive cores (for backward compatibility)
    store.replicate(conn);

    // CRITICAL: Also replicate all loaded Autobase channels
    // Each channel's setupPairing registers its own handler, but that only fires for
    // connections established AFTER the channel is loaded. This ensures channels loaded
    // BEFORE this peer connected also get replicated.
    if (channels.size > 0) {
      console.log('[Storage] Replicating', channels.size, 'Autobase channel(s) on new connection');
      for (const [keyHex, channel] of channels) {
        if (channel.base && channel._replicatedConns && !channel._replicatedConns.has(conn)) {
          try {
            channel._replicatedConns.add(conn)
            channel.base.replicate(conn)
            console.log('[Storage] Replicated Autobase for channel:', keyHex.slice(0, 16))
          } catch (err) {
            console.log('[Storage] Error replicating channel', keyHex.slice(0, 16), ':', err?.message)
          }
        }
      }
    }
  });

  // Initialize blind peering for mobile connectivity
  // Desktop (non-firewalled): runs as blind peer server to keep data available
  // Mobile (firewalled): connects to mirrors to sync when direct P2P fails
  // DISABLED: Testing if this affects playback
  let blindPeering = null;
  let blindPeerServer = null;
  let wakeup = null;

  // if (BlindPeering && Wakeup) {
  //   try {
  //     wakeup = new Wakeup();
  //
  //     // Set up blind peering client (for connecting to mirrors)
  //     // This helps mobile devices sync through desktop mirrors when direct P2P fails
  //     const mirrors = blindPeerMirrors.length > 0 ? blindPeerMirrors : [];
  //
  //     if (mirrors.length > 0 || enableBlindPeerServer) {
  //       blindPeering = new BlindPeering(swarm, store, {
  //         mirrors,
  //         wakeup
  //       });
  //       console.log('[Storage] BlindPeering client initialized with', mirrors.length, 'mirrors');
  //     }
  //
  //     // Set up blind peer server on desktop (when not firewalled)
  //     // This allows desktop to act as a mirror for mobile devices
  //     if (enableBlindPeerServer && BlindPeer) {
  //       // Wait for DHT to bootstrap before checking firewall status
  //       const setupBlindPeerServer = async () => {
  //         // Wait a bit for DHT state to stabilize
  //         await new Promise(r => setTimeout(r, 5000));
  //
  //         const isFirewalled = swarm.dht?.firewalled;
  //         console.log('[Storage] DHT firewalled:', isFirewalled);
  //
  //         // Only run blind peer server if NOT behind firewall (i.e., can accept connections)
  //         if (!isFirewalled) {
  //           try {
  //             blindPeerServer = new BlindPeer(swarm, store, { wakeup });
  //             await blindPeerServer.ready();
  //             const serverKey = blindPeerServer.key ? b4a.toString(blindPeerServer.key, 'hex').slice(0, 16) : 'unknown';
  //             console.log('[Storage] BlindPeer server started, key:', serverKey);
  //             console.log('[Storage] Other devices can use this as a mirror for mobile connectivity');
  //           } catch (err) {
  //             console.log('[Storage] BlindPeer server setup failed (non-fatal):', err?.message);
  //           }
  //         } else {
  //           console.log('[Storage] Firewalled, skipping blind peer server (will use client mode only)');
  //         }
  //       };
  //
  //       // Run in background, don't block initialization
  //       setupBlindPeerServer().catch(err => {
  //         console.log('[Storage] BlindPeer server setup error:', err?.message);
  //       });
  //     }
  //   } catch (err) {
  //     console.log('[Storage] BlindPeering setup failed (non-fatal):', err?.message);
  //   }
  // }

  return {
    store,
    metaDb,
    swarm,
    blobServer,
    blobServerPort,
    blobServerHost,
    drives,
    channels,
    // Blind peering for mobile connectivity
    blindPeering,
    blindPeerServer,
    wakeup
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
    const cached = ctx.channels.get(channelKeyHex)
    console.log('[Storage] loadChannel: returning cached channel:', channelKeyHex.slice(0, 16))

    // CRITICAL: Ensure replication is set up on any connections that came in after the channel was loaded
    // This handles the case where channel was cached but new peers connected since then
    if (ctx.swarm && ctx.swarm.connections?.size > 0 && cached.base && cached._replicatedConns) {
      for (const conn of ctx.swarm.connections) {
        if (!cached._replicatedConns.has(conn)) {
          cached._replicatedConns.add(conn)
          try {
            cached.base.replicate(conn)
            console.log('[Storage] loadChannel: replicated cached channel on new connection:', channelKeyHex.slice(0, 16))
          } catch (err) {
            console.log('[Storage] loadChannel: replicate error:', err?.message)
          }
        }
      }
    }

    return cached
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
      encryptionKey: options.encryptionKeyHex ? b4a.from(options.encryptionKeyHex, 'hex') : null,
      swarm: ctx.swarm  // CRITICAL: Pass swarm so replication can be set up BEFORE base.update()
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
      // Best-effort cleanup so a failed open doesn't leak resources or leave half-open cores around.
      try { await ch.close() } catch {}
      throw err
    }
    console.log('[Storage] Channel ready in', Date.now() - readyStart, 'ms:', channelKeyHex.slice(0, 16));
    ctx.channels.set(channelKeyHex, ch)

    // Ensure we join the channel topic so this device can FIND peers and replicate Autobase cores.
    // (Even non-writable peers must join; pairing setup is only for writable "members".)
    if (ctx.swarm) {
      try {
        if (ch.discoveryKey) ctx.swarm.join(ch.discoveryKey)
        // CRITICAL: AWAIT setupPairing to ensure base.replicate(conn) handlers are registered
        // BEFORE any data queries (like listVideos). Unlike Hyperdrive which auto-replicates,
        // Autobase requires explicit replication setup. Without awaiting, the race condition
        // causes listVideos to return empty on mobile because handlers aren't registered yet.
        await ch.setupPairing(ctx.swarm)
      } catch (err) {
        console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
      }
    }

    // Register Autobase with blind-peering for mobile connectivity
    // This ensures the channel data is available through mirror servers even when
    // direct P2P connections fail (common on mobile behind CGNAT)
    // DISABLED: Testing if this affects playback
    // if (ctx.blindPeering && ch.base) {
    //   try {
    //     ctx.blindPeering.addAutobaseBackground(ch.base)
    //     console.log('[Storage] Registered channel with blind-peering:', channelKeyHex.slice(0, 16))
    //   } catch (err) {
    //     console.log('[Storage] Blind-peering registration failed (non-fatal):', err?.message)
    //   }
    // }

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

// Cache for public bees (keyed by publicBeeKeyHex)
const publicBeeCache = new Map()

/**
 * Load a public channel Hyperbee for viewing.
 * This is the simple, auto-replicating layer for public feed viewers.
 * No Autobase complexity - just load the Hyperbee by key and it syncs via store.replicate().
 *
 * @param {import('./types.js').StorageContext} ctx
 * @param {string} publicBeeKeyHex - The public Hyperbee key (NOT the Autobase channel key)
 * @returns {Promise<PublicChannelBee>}
 */
export async function loadPublicBee(ctx, publicBeeKeyHex) {
  // Check cache first
  if (publicBeeCache.has(publicBeeKeyHex)) {
    console.log('[Storage] loadPublicBee: returning cached:', publicBeeKeyHex.slice(0, 16))
    return publicBeeCache.get(publicBeeKeyHex)
  }

  console.log('[Storage] loadPublicBee: loading:', publicBeeKeyHex.slice(0, 16))

  const bee = new PublicChannelBee(ctx.store, {
    key: publicBeeKeyHex
  })

  // Add timeout to prevent hanging
  try {
    await Promise.race([
      bee.ready(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('PublicBee ready timeout')), 10000))
    ])
  } catch (err) {
    console.error('[Storage] loadPublicBee failed:', err.message)
    try { await bee.close() } catch {}
    throw err
  }

  // Join swarm for discovery
  if (ctx.swarm && bee.discoveryKey) {
    ctx.swarm.join(bee.discoveryKey)
    console.log('[Storage] loadPublicBee: joined swarm for:', publicBeeKeyHex.slice(0, 16))
  }

  publicBeeCache.set(publicBeeKeyHex, bee)
  console.log('[Storage] loadPublicBee: ready:', publicBeeKeyHex.slice(0, 16), 'length:', bee.core?.length)
  return bee
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

  const ch = new MultiWriterChannel(ctx.store, {
    encrypt: Boolean(options.encrypt),
    swarm: ctx.swarm  // Pass swarm for early replication setup
  })
  await ch.ready()

  const channelKeyHex = ch.keyHex
  const encryptionKeyHex = ch.encryptionKey ? b4a.toString(ch.encryptionKey, 'hex') : null

  ctx.channels.set(channelKeyHex, ch)

  // Persist a marker so we can reliably distinguish multi-writer channels from legacy Hyperdrives.
  try {
    await ctx.metaDb.put(`mw-channel:${channelKeyHex}`, { kind: 'autobase', createdAt: Date.now() })
  } catch {}

  // Set up pairing and replication - AWAIT to ensure handlers are registered
  if (ctx.swarm) {
    try {
      if (ch.discoveryKey) ctx.swarm.join(ch.discoveryKey)
      // CRITICAL: AWAIT setupPairing to ensure base.replicate(conn) handlers are registered
      await ch.setupPairing(ctx.swarm)
    } catch (err) {
      console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
    }
  }

  // Register with blind-peering for mobile connectivity
  if (ctx.blindPeering && ch.base) {
    try {
      ctx.blindPeering.addAutobaseBackground(ch.base)
      console.log('[Storage] Registered new channel with blind-peering:', channelKeyHex.slice(0, 16))
    } catch (err) {
      console.log('[Storage] Blind-peering registration failed (non-fatal):', err?.message)
    }
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

  // Set up pairing and replication - AWAIT to ensure base.replicate(conn) handlers are registered
  if (ctx.swarm) {
    try {
      if (channel.discoveryKey) ctx.swarm.join(channel.discoveryKey)
      // CRITICAL: AWAIT setupPairing to ensure base.replicate(conn) handlers are registered
      await channel.setupPairing(ctx.swarm)
    } catch (err) {
      console.log('[Storage] Pairing setup error (non-fatal):', err?.message)
    }
  }

  // Register with blind-peering for mobile connectivity
  if (ctx.blindPeering && channel.base) {
    try {
      ctx.blindPeering.addAutobaseBackground(channel.base)
      console.log('[Storage] Registered paired channel with blind-peering:', channelKeyHex.slice(0, 16))
    } catch (err) {
      console.log('[Storage] Blind-peering registration failed (non-fatal):', err?.message)
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

/**
 * Get video URL from Hyperblobs (new multi-writer architecture)
 * @param {Object} ctx - Storage context
 * @param {string} blobsCoreKeyHex - Hex key of the blobs Hypercore
 * @param {Object} blobId - Blob ID with {blockOffset, blockLength, byteOffset, byteLength}
 * @param {Object} [options]
 * @param {string} [options.mimeType] - MIME type (default: video/mp4)
 * @returns {Promise<{url: string}>}
 */
export async function getVideoUrlFromBlob(ctx, blobsCoreKeyHex, blobId, options = {}) {
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB:', blobsCoreKeyHex?.slice(0, 16), 'blobId:', JSON.stringify(blobId), 'keyLength:', blobsCoreKeyHex?.length);

  if (!blobsCoreKeyHex) {
    throw new Error('Missing blobsCoreKeyHex')
  }

  // Validate key length - should be 64 hex chars (32 bytes)
  if (blobsCoreKeyHex.length !== 64) {
    throw new Error(`Invalid blobsCoreKey length: ${blobsCoreKeyHex.length} (expected 64). Key is truncated or corrupted. Full key: ${blobsCoreKeyHex}`)
  }

  // Load the blobs core
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: converting hex to buffer...');
  const keyBuffer = b4a.from(blobsCoreKeyHex, 'hex')
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: keyBuffer length:', keyBuffer.length, 'bytes');
  
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: calling store.get...');
  const blobsCore = ctx.store.get(keyBuffer)
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: store.get returned, calling ready...');
  
  await blobsCore.ready()
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: ready() complete');

  if (!blobsCore.key) {
    throw new Error('Blobs core key not available after ready')
  }

  console.log('[Storage] Blobs core ready, key:', b4a.toString(blobsCore.key, 'hex').slice(0, 16));

  // Join swarm for the blobs core discovery key
  if (ctx.swarm && blobsCore.discoveryKey) {
    try {
      ctx.swarm.join(blobsCore.discoveryKey)
    } catch (err) {
      console.log('[Storage] Swarm join error (non-fatal):', err?.message)
    }
  }

  // Wait briefly for peers if needed
  try {
    await Promise.race([
      blobsCore.update({ wait: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('blobs core update timeout')), 15000))
    ])
  } catch {}

  const mimeType = options.mimeType || 'video/mp4'

  // Parse blobId string to object if needed
  // blobId can be a string like "0:28174:0:1846355808" or an object
  let blob = blobId
  if (typeof blobId === 'string') {
    const parts = blobId.split(':').map(Number)
    blob = {
      blockOffset: parts[0],
      blockLength: parts[1],
      byteOffset: parts[2],
      byteLength: parts[3]
    }
  }

  // Generate direct blob URL
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: blobsCore.key type:', typeof blobsCore.key, 'isBuffer:', Buffer.isBuffer(blobsCore.key), 'length:', blobsCore.key?.length);
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: blobsCore.key hex:', blobsCore.key ? b4a.toString(blobsCore.key, 'hex') : 'NULL');
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: blob:', JSON.stringify(blob));
  console.log('[Storage] GET_VIDEO_URL_FROM_BLOB: ctx.blobServer exists:', !!ctx.blobServer, 'port:', ctx.blobServer?.port);
  
  if (!ctx.blobServer) {
    throw new Error('BlobServer not initialized')
  }
  
  try {
    const url = ctx.blobServer.getLink(blobsCore.key, {
      blob,
      type: mimeType
    });
    console.log('[Storage] Direct blob URL (hyperblobs):', url);
    return { url };
  } catch (err) {
    console.error('[Storage] GET_VIDEO_URL_FROM_BLOB: blobServer.getLink FAILED:', err.message, err.stack);
    throw err;
  }
}
