/**
 * PearTube Mobile Backend - Runs in Bare thread
 * Handles P2P networking, Hyperdrive storage, video streaming
 *
 * Uses HRPC (Holepunch RPC) for typed binary communication with frontend
 */

// Use require for CommonJS modules in Bare
const HRPC = require('@peartube/spec')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const Hyperbee = require('hyperbee')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const path = require('bare-path')
const fs = require('bare-fs')
const Protomux = require('protomux')
const c = require('compact-encoding')
const BlobServer = require('hypercore-blob-server')

// Wrap a corestore to add default timeout to all get() calls
// This ensures cores used by BlobServer have timeout for P2P fetching
function wrapStoreWithTimeout(store, defaultTimeout = 30000) {
  const originalGet = store.get.bind(store)
  store.get = function(opts = {}) {
    // Ensure timeout is always set (unless explicitly provided)
    const optsWithTimeout = {
      ...opts,
      timeout: opts.timeout ?? defaultTimeout
    }
    return originalGet(optsWithTimeout)
  }
  return store
}


// Get IPC from BareKit, args from Bare (per docs)
const { IPC } = BareKit
const storagePath = Bare.argv[0] || ''

console.log('[Backend] Starting PearTube mobile backend with HRPC')
console.log('[Backend] Storage path:', storagePath)

// Initialize storage
const storageDir = path.join(storagePath, 'peartube-data')
try {
  fs.mkdirSync(storageDir, { recursive: true })
} catch (e) {
  // Directory may already exist
}

// Core components
let store = null
let swarm = null
let metaDb = null
let identity = null
let blobServer = null
let blobServerPort = null
let rpc = null  // HRPC instance
const drives = new Map()

// ============================================
// PublicFeedManager - P2P Channel Discovery
// Uses HAVE_FEED/SUBMIT_CHANNEL protocol (aligned with desktop)
// ============================================

const FEED_TOPIC_STRING = 'peartube-public-feed-v1'
const PROTOCOL_NAME = 'peartube-feed'  // Must match desktop

class PublicFeedManager {
  constructor(swarmInstance) {
    this.swarm = swarmInstance
    // Generate deterministic topic using same hash as desktop
    this.feedTopic = crypto.data(b4a.from(FEED_TOPIC_STRING, 'utf-8'))
    this.entries = new Map()
    this.hiddenKeys = new Set()
    this.feedConnections = new Set()
    this.peerChannels = new Map()  // conn -> protomux channel
    console.log('[PublicFeed] ===== INITIALIZED =====')
    console.log('[PublicFeed] Topic hex:', b4a.toString(this.feedTopic, 'hex'))
  }

  async start() {
    console.log('[PublicFeed] ===== STARTING FEED DISCOVERY =====')
    console.log('[PublicFeed] Topic hex:', b4a.toString(this.feedTopic, 'hex'))
    console.log('[PublicFeed] Swarm connections before join:', this.swarm.connections.size)

    // Join the public feed topic
    const discovery = this.swarm.join(this.feedTopic, { server: true, client: true })
    console.log('[PublicFeed] Waiting for topic flush...')
    await discovery.flushed()

    console.log('[PublicFeed] ===== TOPIC JOINED =====')
    console.log('[PublicFeed] Swarm connections after join:', this.swarm.connections.size)

    // Log status every 10 seconds for debugging
    setInterval(() => {
      console.log('[PublicFeed] Status: connections=', this.swarm.connections.size,
        'feedPeers=', this.feedConnections.size,
        'entries=', this.entries.size)
    }, 10000)

    // Handle ALL connections for feed protocol
    // Hyperswarm multiplexes connections, so a peer may connect for drives first
    // and the feed topic might not appear in info.topics
    this.swarm.on('connection', (conn, info) => {
      const remoteKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 8) : 'unknown'
      const topics = info?.topics?.map(t => b4a.toString(t, 'hex').slice(0, 8)) || []
      console.log('[PublicFeed] New swarm connection from:', remoteKey, 'topics:', topics.join(','))

      // Set up feed protocol on ALL connections
      // The protocol will gracefully handle peers that don't understand it
      this.handleFeedConnection(conn, info)
    })

    // Also set up feed protocol on any EXISTING connections
    // (connections that came in before publicFeed.start() was called)
    console.log('[PublicFeed] Checking existing connections:', this.swarm.connections.size)
    for (const conn of this.swarm.connections) {
      console.log('[PublicFeed] Setting up feed on existing connection')
      this.handleFeedConnection(conn, {})
    }
  }

  handleFeedConnection(conn, info) {
    // Skip if we're already handling this connection
    if (this.peerChannels.has(conn)) {
      console.log('[PublicFeed] Connection already being handled, skipping')
      return
    }

    const remoteKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : 'unknown'
    console.log('[PublicFeed] ===== SETTING UP PROTOMUX FEED PROTOCOL =====')
    console.log('[PublicFeed] Remote peer:', remoteKey)
    console.log('[PublicFeed] Current entries:', this.entries.size)

    // Get or create Protomux instance for this connection
    const mux = Protomux.from(conn)

    // Use mux.pair() to handle when remote opens this protocol
    mux.pair({ protocol: PROTOCOL_NAME }, () => {
      console.log('[PublicFeed] Remote peer opening feed protocol')
      this.createFeedChannel(mux, conn)
    })

    // Also try to open from our side (one side will succeed first)
    this.createFeedChannel(mux, conn)

    // Clean up on connection close
    conn.on('close', () => {
      console.log('[PublicFeed] Connection closed:', remoteKey)
      this.peerChannels.delete(conn)
      this.feedConnections.delete(conn)
    })

    conn.on('error', (err) => {
      console.error('[PublicFeed] Connection error:', err.message)
      this.peerChannels.delete(conn)
      this.feedConnections.delete(conn)
    })
  }

  createFeedChannel(mux, conn) {
    // Check if we already have a channel for this connection
    if (this.peerChannels.has(conn)) {
      return
    }

    // Create channel with messages defined in options (matching desktop)
    const channel = mux.createChannel({
      protocol: PROTOCOL_NAME,
      messages: [{
        encoding: c.json,
        onmessage: (msg) => {
          this.handleMessage(msg, conn)
        }
      }],
      onopen: () => {
        console.log('[PublicFeed] Feed channel opened!')
        this.feedConnections.add(conn)
        // Immediately send our feed when channel opens
        this.sendHaveFeed(conn)
      },
      onclose: () => {
        console.log('[PublicFeed] Feed channel closed')
        this.peerChannels.delete(conn)
        this.feedConnections.delete(conn)
      }
    })

    if (!channel) {
      console.log('[PublicFeed] Channel already exists or failed to create')
      return
    }

    // Store the channel
    this.peerChannels.set(conn, channel)

    // Open the channel
    channel.open()
    console.log('[PublicFeed] Feed channel created and opening...')
  }

  handleMessage(msg, conn) {
    // Handle HAVE_FEED - peer is sharing their known channels
    if (msg.type === 'HAVE_FEED' && msg.keys) {
      console.log('[PublicFeed] Received HAVE_FEED with', msg.keys.length, 'keys')
      let added = 0
      for (const key of msg.keys) {
        if (this.addEntry(key, 'peer')) {
          added++
        }
      }
      if (added > 0) {
        console.log('[PublicFeed] Added', added, 'new channels from peer')
      }
    }
    // Handle SUBMIT_CHANNEL - peer is broadcasting a new channel
    else if (msg.type === 'SUBMIT_CHANNEL' && msg.key) {
      console.log('[PublicFeed] Received SUBMIT_CHANNEL:', msg.key.slice(0, 16))
      if (this.addEntry(msg.key, 'peer')) {
        console.log('[PublicFeed] Added new channel, re-gossiping...')
        this.broadcastSubmitChannel(msg.key, conn)
      }
    }
    // Also handle legacy NEED_FEED/FEED_RESPONSE for backwards compat
    else if (msg.type === 'NEED_FEED') {
      console.log('[PublicFeed] Received legacy NEED_FEED, sending HAVE_FEED')
      this.sendHaveFeed(conn)
    }
    else if (msg.type === 'FEED_RESPONSE' && msg.keys) {
      console.log('[PublicFeed] Received legacy FEED_RESPONSE with', msg.keys.length, 'keys')
      let added = 0
      for (const key of msg.keys) {
        if (this.addEntry(key, 'peer')) {
          added++
        }
      }
      if (added > 0) {
        console.log('[PublicFeed] Added', added, 'new channels')
      }
    }
  }

  sendHaveFeed(conn) {
    const channel = this.peerChannels.get(conn)
    if (!channel) {
      console.log('[PublicFeed] No channel for connection, cannot send HAVE_FEED')
      return
    }

    const keys = Array.from(this.entries.keys())
    const msg = { type: 'HAVE_FEED', keys }
    try {
      channel.messages[0].send(msg)
      console.log('[PublicFeed] Sent HAVE_FEED with', keys.length, 'keys')
    } catch (err) {
      console.error('[PublicFeed] Failed to send HAVE_FEED:', err.message)
    }
  }

  addEntry(driveKey, source) {
    if (this.entries.has(driveKey) || this.hiddenKeys.has(driveKey)) {
      return false
    }

    if (!/^[a-f0-9]{64}$/i.test(driveKey)) {
      console.warn('[PublicFeed] Invalid driveKey format:', driveKey.slice(0, 16))
      return false
    }

    this.entries.set(driveKey, {
      driveKey,
      addedAt: Date.now(),
      source
    })

    return true
  }

  requestFeedsFromPeers() {
    console.log('[PublicFeed] ===== REQUESTING FEEDS FROM PEERS =====')
    let sent = 0
    for (const [conn] of this.peerChannels) {
      this.sendHaveFeed(conn)
      sent++
    }
    console.log('[PublicFeed] Sent HAVE_FEED to', sent, 'peers')
    return sent
  }

  submitChannel(driveKey) {
    if (this.addEntry(driveKey, 'local')) {
      console.log('[PublicFeed] Submitted local channel:', driveKey.slice(0, 16))
    }
    this.broadcastSubmitChannel(driveKey)
  }

  broadcastSubmitChannel(driveKey, excludeConn) {
    const msg = { type: 'SUBMIT_CHANNEL', key: driveKey }

    let sent = 0
    for (const [conn, channel] of this.peerChannels) {
      if (conn === excludeConn) continue
      try {
        channel.messages[0].send(msg)
        sent++
      } catch (err) {
        console.error('[PublicFeed] Failed to broadcast channel:', err.message)
      }
    }
    console.log('[PublicFeed] Broadcast SUBMIT_CHANNEL to', sent, 'peers')
  }

  hideChannel(driveKey) {
    this.hiddenKeys.add(driveKey)
    this.entries.delete(driveKey)
    console.log('[PublicFeed] Hidden channel:', driveKey.slice(0, 16))
  }

  getFeed() {
    return Array.from(this.entries.values())
      .filter(e => !this.hiddenKeys.has(e.driveKey))
      .sort((a, b) => b.addedAt - a.addedAt)
  }

  getStats() {
    return {
      totalEntries: this.entries.size,
      hiddenCount: this.hiddenKeys.size,
      peerCount: this.peerChannels.size  // Active Protomux channels
    }
  }
}

// Public feed instance (initialized after swarm)
let publicFeed = null

// ============================================
// SeedingManager - Distributed Content Availability
// "Pied Piper" model: viewers become seeders
// ============================================

class SeedingManager {
  constructor(store, metaDb) {
    this.store = store
    this.metaDb = metaDb
    this.activeSeeds = new Map() // key: `${driveKey}:${videoPath}` -> seed info
    this.pinnedChannels = new Set() // driveKeys that are pinned (always seed)
    this.config = {
      maxStorageGB: 10,           // Default 10GB quota for seeded content
      autoSeedWatched: true,      // Automatically seed videos you watch
      autoSeedSubscribed: false,  // Automatically seed subscribed channels (opt-in)
      maxVideosPerChannel: 10     // Max videos to seed per channel if auto-seeding subscriptions
    }
    console.log('[SeedingManager] Initialized')
  }

  async init() {
    // Load config from metaDb
    const savedConfig = await this.metaDb.get('seeding-config')
    if (savedConfig?.value) {
      this.config = { ...this.config, ...savedConfig.value }
      console.log('[SeedingManager] Loaded config:', this.config)
    }

    // Load pinned channels
    const pinnedData = await this.metaDb.get('pinned-channels')
    if (pinnedData?.value) {
      for (const key of pinnedData.value) {
        this.pinnedChannels.add(key)
      }
      console.log('[SeedingManager] Loaded', this.pinnedChannels.size, 'pinned channels')
    }

    // Load active seeds
    const seedsData = await this.metaDb.get('active-seeds')
    if (seedsData?.value) {
      for (const [key, info] of Object.entries(seedsData.value)) {
        this.activeSeeds.set(key, info)
      }
      console.log('[SeedingManager] Loaded', this.activeSeeds.size, 'active seeds')
    }
  }

  async addSeed(driveKey, videoPath, reason, blobInfo) {
    if (!this.config.autoSeedWatched && reason === 'watched') {
      console.log('[SeedingManager] Auto-seed watched disabled, skipping')
      return false
    }

    const key = `${driveKey}:${videoPath}`

    // Check if already seeding
    if (this.activeSeeds.has(key)) {
      console.log('[SeedingManager] Already seeding:', key.slice(0, 32))
      return false
    }

    const seedInfo = {
      driveKey,
      videoPath,
      reason, // 'watched', 'pinned', 'subscribed'
      addedAt: Date.now(),
      blocks: blobInfo?.blockLength || 0,
      bytes: blobInfo?.byteLength || 0
    }

    this.activeSeeds.set(key, seedInfo)
    await this.persistSeeds()

    console.log('[SeedingManager] Added seed:', videoPath, 'reason:', reason, 'bytes:', seedInfo.bytes)

    // Enforce quota
    await this.enforceQuota()

    return true
  }

  async removeSeed(driveKey, videoPath) {
    const key = `${driveKey}:${videoPath}`
    if (this.activeSeeds.has(key)) {
      this.activeSeeds.delete(key)
      await this.persistSeeds()
      console.log('[SeedingManager] Removed seed:', key.slice(0, 32))
      return true
    }
    return false
  }

  async pinChannel(driveKey) {
    this.pinnedChannels.add(driveKey)
    await this.persistPinnedChannels()
    console.log('[SeedingManager] Pinned channel:', driveKey.slice(0, 16))
  }

  async unpinChannel(driveKey) {
    this.pinnedChannels.delete(driveKey)
    await this.persistPinnedChannels()
    console.log('[SeedingManager] Unpinned channel:', driveKey.slice(0, 16))
  }

  async setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig }
    await this.metaDb.put('seeding-config', this.config)
    console.log('[SeedingManager] Updated config:', this.config)
  }

  async getStatus() {
    const storageUsed = this.calculateStorage()
    return {
      activeSeeds: this.activeSeeds.size,
      pinnedChannels: this.pinnedChannels.size,
      storageUsedBytes: storageUsed,
      storageUsedGB: (storageUsed / (1024 * 1024 * 1024)).toFixed(2),
      maxStorageGB: this.config.maxStorageGB,
      config: this.config,
      seeds: Array.from(this.activeSeeds.values()).map(s => ({
        videoPath: s.videoPath,
        reason: s.reason,
        bytes: s.bytes,
        addedAt: s.addedAt
      }))
    }
  }

  calculateStorage() {
    let total = 0
    for (const seed of this.activeSeeds.values()) {
      total += seed.bytes || 0
    }
    return total
  }

  async enforceQuota() {
    const maxBytes = this.config.maxStorageGB * 1024 * 1024 * 1024
    let currentBytes = this.calculateStorage()

    if (currentBytes <= maxBytes) {
      return // Under quota
    }

    console.log('[SeedingManager] Over quota, current:', currentBytes, 'max:', maxBytes)

    // Get seeds sorted by priority (pinned > subscribed > watched) then by age
    const seeds = Array.from(this.activeSeeds.entries())
      .map(([key, info]) => ({ key, ...info }))
      .sort((a, b) => {
        // Priority order: pinned (keep) > subscribed > watched (remove first)
        const priorityOrder = { pinned: 3, subscribed: 2, watched: 1 }
        const priorityDiff = (priorityOrder[a.reason] || 0) - (priorityOrder[b.reason] || 0)
        if (priorityDiff !== 0) return priorityDiff

        // Older first for same priority
        return a.addedAt - b.addedAt
      })

    // Remove oldest/lowest priority seeds until under quota
    for (const seed of seeds) {
      if (currentBytes <= maxBytes) break
      if (seed.reason === 'pinned') continue // Never remove pinned

      this.activeSeeds.delete(seed.key)
      currentBytes -= seed.bytes || 0
      console.log('[SeedingManager] Removed seed to meet quota:', seed.key.slice(0, 32))
    }

    await this.persistSeeds()
  }

  async persistSeeds() {
    const seedsObj = Object.fromEntries(this.activeSeeds)
    await this.metaDb.put('active-seeds', seedsObj)
  }

  async persistPinnedChannels() {
    await this.metaDb.put('pinned-channels', Array.from(this.pinnedChannels))
  }

  getPinnedChannels() {
    return Array.from(this.pinnedChannels)
  }

  isChannelPinned(driveKey) {
    return this.pinnedChannels.has(driveKey)
  }
}

// Seeding manager instance (initialized after metaDb)
let seedingManager = null

// ============================================
// VideoStatsTracker - Real-time video loading stats
// Uses Hyperdrive's built-in monitor for efficient event-driven updates
// ============================================

const videoStats = new Map() // key: `${driveKey}:${videoPath}` -> stats object
const videoMonitors = new Map() // key: `${driveKey}:${videoPath}` -> { monitor, cleanup }

function getVideoStatsKey(driveKey, videoPath) {
  return `${driveKey}:${videoPath}`
}

function updateVideoStats(driveKey, videoPath, updates) {
  const key = getVideoStatsKey(driveKey, videoPath)
  const existing = videoStats.get(key) || {
    driveKey,
    videoPath,
    status: 'idle',
    totalBlocks: 0,
    downloadedBlocks: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    peerCount: 0,
    startTime: null,
    lastUpdate: Date.now(),
    initialBlocks: 0 // Blocks already local when we started monitoring
  }
  videoStats.set(key, { ...existing, ...updates, lastUpdate: Date.now() })
}

function getVideoStats(driveKey, videoPath) {
  const key = getVideoStatsKey(driveKey, videoPath)
  const stats = videoStats.get(key)
  if (!stats) return null

  // Get live speeds from monitor if available
  const monitorData = videoMonitors.get(key)
  const downloadSpeed = monitorData?.monitor?.downloadSpeed?.() || 0
  const uploadSpeed = monitorData?.monitor?.uploadSpeed?.() || 0

  // Calculate progress including initial blocks
  const totalDownloaded = stats.initialBlocks + stats.downloadedBlocks
  const progress = stats.totalBlocks > 0
    ? Math.round((totalDownloaded / stats.totalBlocks) * 100)
    : 0
  const elapsed = stats.startTime ? (Date.now() - stats.startTime) / 1000 : 0

  return {
    ...stats,
    downloadedBlocks: totalDownloaded,
    downloadedBytes: Math.round((totalDownloaded / stats.totalBlocks) * stats.totalBytes) || 0,
    progress,
    speed: Math.round(downloadSpeed), // bytes per second from speedometer
    speedMBps: (downloadSpeed / (1024 * 1024)).toFixed(2),
    uploadSpeed: Math.round(uploadSpeed), // bytes per second
    uploadSpeedMBps: (uploadSpeed / (1024 * 1024)).toFixed(2),
    elapsed: Math.round(elapsed),
    isComplete: totalDownloaded >= stats.totalBlocks && stats.totalBlocks > 0
  }
}

// Clean up monitor when done
function cleanupVideoMonitor(driveKey, videoPath) {
  const key = getVideoStatsKey(driveKey, videoPath)
  const monitorData = videoMonitors.get(key)
  if (monitorData) {
    if (monitorData.cleanup) monitorData.cleanup()
    if (monitorData.monitor?.close) monitorData.monitor.close().catch(() => {})
    videoMonitors.delete(key)
  }
}

// Push video stats event to frontend via HRPC
function emitVideoStats(driveKey, videoPath) {
  if (!rpc) {
    console.log('[Backend] emitVideoStats: rpc not ready')
    return
  }
  const stats = getVideoStats(driveKey, videoPath)
  if (stats) {
    console.log('[Backend] Pushing video stats event:', stats.progress + '% complete')
    try {
      rpc.eventVideoStats({
        videoId: videoPath,
        channelKey: driveKey,
        downloadedBytes: stats.downloadedBytes || 0,
        totalBytes: stats.totalBytes || 0,
        downloadProgress: stats.progress || 0,
        peerCount: stats.peerCount || 0,
        downloadSpeed: stats.speed || 0,
        uploadSpeed: stats.uploadSpeed || 0
      })
    } catch (e) {
      console.log('[Backend] Error pushing video stats:', e.message)
    }
  } else {
    console.log('[Backend] emitVideoStats: no stats found for', videoPath?.slice(0, 30))
  }
}

// Initialize
async function init() {
  console.log('[Backend] Initializing...')

  // Setup corestore
  store = new Corestore(path.join(storageDir, 'corestore'))
  await store.ready()

  // Initialize blob server for video streaming (like desktop)
  // Wrap store to add timeout to all core.get() calls (prevents indefinite P2P hangs)
  const blobStore = wrapStoreWithTimeout(store, 30000)
  blobServer = new BlobServer(blobStore, {
    port: 0, // Random available port
    host: '127.0.0.1'
  })

  // Hook into blob server's _getCore to return sessions optimized for video streaming
  // Uses wait:false so local blocks return instantly without network delay
  const originalGetCore = blobServer._getCore.bind(blobServer)
  let getCoreCallCount = 0
  blobServer._getCore = async function(k, info, active) {
    const callNum = ++getCoreCallCount
    const keyHex = b4a.isBuffer(k) ? b4a.toString(k, 'hex').slice(0, 16) : String(k).slice(0, 16)
    console.log(`[BlobServer] _getCore #${callNum} called for key=${keyHex}`)

    const core = await originalGetCore(k, info, active)
    if (!core) {
      console.log(`[BlobServer] _getCore #${callNum} returned null`)
      return core
    }

    // Return a fast session - wait:false means local blocks return instantly
    const session = core.session({
      wait: false,
      timeout: 5000,
      activeRequests: true
    })
    console.log(`[BlobServer] _getCore #${callNum} returning session with wait:false, core.length=${core.length}`)
    return session
  }

  await blobServer.listen()
  blobServerPort = blobServer.address.port
  console.log('[Backend] Blob server listening on port:', blobServerPort)

  // Setup metadata database
  const metaCore = store.get({ name: 'peartube-meta' })
  metaDb = new Hyperbee(metaCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await metaDb.ready()

  // Setup Hyperswarm for P2P
  console.log('[Swarm] ===== CREATING HYPERSWARM =====')
  swarm = new Hyperswarm()
  console.log('[Swarm] Swarm created, publicKey:', b4a.toString(swarm.keyPair.publicKey, 'hex').slice(0, 16))

  // Log swarm events for debugging
  swarm.on('connection', (conn, info) => {
    const remoteKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : 'unknown'
    console.log('[Swarm] ===== PEER CONNECTED =====')
    console.log('[Swarm] Remote public key:', remoteKey)
    console.log('[Swarm] Topics:', info?.topics?.length || 0)
    console.log('[Swarm] Client:', info?.client, 'Deduplicated:', info?.deduplicated)
    console.log('[Swarm] Total connections now:', swarm.connections.size)
    store.replicate(conn)
  })

  swarm.on('update', () => {
    console.log('[Swarm] Update event - connections:', swarm.connections.size)
  })

  // Load identity if exists
  const identityData = await metaDb.get('identity')
  if (identityData) {
    identity = identityData.value
    console.log('[Backend] Loaded identity:', identity.name)

    // Load own drive
    if (identity.driveKey) {
      await loadDrive(identity.driveKey)
    }
  }

  // Load subscriptions
  const subs = await metaDb.get('subscriptions')
  if (subs && subs.value) {
    for (const sub of subs.value) {
      await loadDrive(sub.driveKey)
    }
  }

  // Initialize and start public feed discovery
  publicFeed = new PublicFeedManager(swarm)
  await publicFeed.start()

  // Initialize seeding manager
  seedingManager = new SeedingManager(store, metaDb)
  await seedingManager.init()

  console.log('[Backend] Ready')
}

// Helper: wait for drive to sync with timeout
async function waitForDriveSync(drive, timeout = 5000) {
  const start = Date.now()

  // Try to update the core to get latest data from peers
  try {
    await Promise.race([
      drive.core.update({ wait: true }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Drive sync timeout')), timeout)
      )
    ])
  } catch (err) {
    console.log('[Backend] Drive sync wait:', err.message)
  }

  console.log('[Backend] Drive sync took', Date.now() - start, 'ms, length:', drive.core.length)
  return drive
}

// Load or create a drive
async function loadDrive(keyHex, options = {}) {
  const { waitForSync = false, syncTimeout = 5000 } = options

  // Validate key format (must be 64 hex characters = 32 bytes)
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) {
    throw new Error('Invalid channel key: must be 64 hex characters')
  }

  if (drives.has(keyHex)) {
    const existingDrive = drives.get(keyHex)
    if (waitForSync) {
      await waitForDriveSync(existingDrive, syncTimeout)
    }
    return existingDrive
  }

  const keyBuf = b4a.from(keyHex, 'hex')
  const drive = new Hyperdrive(store, keyBuf)
  await drive.ready()

  drives.set(keyHex, drive)

  // Join swarm for this drive
  const discovery = swarm.join(drive.discoveryKey)
  await discovery.flushed()

  console.log('[Backend] Loaded drive:', keyHex.slice(0, 8))

  // Wait for initial sync if requested
  if (waitForSync) {
    await waitForDriveSync(drive, syncTimeout)
  }

  return drive
}

// Create a new drive
async function createDrive() {
  const drive = new Hyperdrive(store)
  await drive.ready()

  const keyHex = b4a.toString(drive.key, 'hex')
  drives.set(keyHex, drive)

  // Join swarm
  const discovery = swarm.join(drive.discoveryKey)
  await discovery.flushed()

  console.log('[Backend] Created drive:', keyHex.slice(0, 8))
  return { drive, keyHex }
}

// ============================================
// API Methods (used by HRPC handlers)
// ============================================

const api = {
  async createIdentity(name) {
    const { drive, keyHex } = await createDrive()

    // Create channel metadata
    const channel = {
      name,
      description: '',
      createdAt: Date.now()
    }
    await drive.put('/channel.json', Buffer.from(JSON.stringify(channel)))

    identity = {
      name,
      publicKey: keyHex,
      driveKey: keyHex,
      createdAt: Date.now()
    }

    await metaDb.put('identity', identity)
    return identity
  },

  async getIdentity() {
    return identity
  },

  async getChannel(driveKey) {
    console.log('[Backend] GET_CHANNEL:', driveKey?.slice(0, 16))
    try {
      // Load drive with sync for remote channels
      const drive = await loadDrive(driveKey, { waitForSync: true, syncTimeout: 8000 })

      const metaBuf = await drive.get('/channel.json')
      if (metaBuf) {
        const result = JSON.parse(b4a.toString(metaBuf))
        console.log('[Backend] Got channel:', result.name)
        return result
      } else {
        return { name: 'Unknown Channel' }
      }
    } catch (err) {
      console.error('[Backend] GET_CHANNEL error:', err.message)
      return { name: 'Unknown Channel', error: err.message }
    }
  },

  async listVideos(driveKey) {
    console.log('[Backend] LIST_VIDEOS for:', driveKey?.slice(0, 16))
    try {
      // Load drive with sync for remote channels
      const drive = await loadDrive(driveKey, { waitForSync: true, syncTimeout: 8000 })

      const videos = []
      try {
        for await (const entry of drive.readdir('/videos')) {
          if (entry.endsWith('.json')) {
            const metaBuf = await drive.get(`/videos/${entry}`)
            if (metaBuf) {
              const video = JSON.parse(b4a.toString(metaBuf))
              video.channelKey = driveKey
              videos.push(video)
            }
          }
        }
      } catch (e) {
        console.log('[Backend] Error listing videos:', e.message)
      }

      const result = videos.sort((a, b) => b.uploadedAt - a.uploadedAt)
      console.log('[Backend] Found', result.length, 'videos')
      return result
    } catch (err) {
      console.error('[Backend] LIST_VIDEOS error:', err.message)
      return []
    }
  },

  async getVideoUrl(driveKey, videoPath) {
    console.log('[Backend] GET_VIDEO_URL:', driveKey?.slice(0, 16), videoPath)
    try {
      // Make sure the drive is loaded and synced
      const drive = await loadDrive(driveKey, { waitForSync: true, syncTimeout: 15000 })

      // Resolve the filename to get blob info directly
      const entry = await drive.entry(videoPath)
      if (!entry || !entry.value?.blob) {
        throw new Error('Video not found in drive')
      }

      const blob = entry.value.blob
      console.log('[Backend] Resolved blob:', JSON.stringify(blob))

      // Get the content key for the blobs core
      const blobsCore = await drive.getBlobs()
      if (!blobsCore) {
        throw new Error('Could not get blobs core')
      }
      const blobsKey = blobsCore.core.key

      // Generate direct blob URL (no redirect needed)
      const url = blobServer.getLink(blobsKey, {
        blob: blob,
        type: videoPath.endsWith('.webm') ? 'video/webm' : 'video/mp4'
      })

      console.log('[Backend] Direct blob URL:', url)
      return { url }
    } catch (err) {
      console.error('[Backend] GET_VIDEO_URL error:', err.message)
      throw err
    }
  },

  async uploadVideo(title, description, fileName, fileData) {
    const drive = drives.get(identity?.driveKey)
    if (!drive) {
      throw new Error('No identity drive')
    }

    const videoId = `video_${Date.now()}`
    const ext = fileName.split('.').pop() || 'mp4'
    const videoPath = `/videos/${videoId}.${ext}`
    const metaPath = `/videos/${videoId}.json`

    // Decode base64 video data
    const videoBuf = b4a.from(fileData, 'base64')
    await drive.put(videoPath, videoBuf)

    // Write metadata
    const meta = {
      id: videoId,
      title,
      description,
      path: videoPath,
      size: videoBuf.length,
      mimeType: `video/${ext}`,
      uploadedAt: Date.now()
    }
    await drive.put(metaPath, Buffer.from(JSON.stringify(meta)))

    return meta
  },

  async subscribeChannel(driveKey) {
    await loadDrive(driveKey)

    const existing = await metaDb.get('subscriptions')
    const subs = existing?.value || []

    if (!subs.find(s => s.driveKey === driveKey)) {
      subs.push({
        driveKey,
        subscribedAt: Date.now()
      })
      await metaDb.put('subscriptions', subs)
    }

    return { success: true }
  },

  async getSubscriptions() {
    const existing = await metaDb.get('subscriptions')
    const subs = existing?.value || []

    const enriched = []
    for (const sub of subs) {
      const drive = drives.get(sub.driveKey)
      let name = 'Unknown'
      if (drive) {
        try {
          const meta = await drive.get('/channel.json')
          if (meta) {
            name = JSON.parse(b4a.toString(meta)).name
          }
        } catch (e) {}
      }
      enriched.push({ ...sub, name })
    }

    return enriched
  },

  async getPublicFeed() {
    const feed = publicFeed ? publicFeed.getFeed() : []
    const stats = publicFeed ? publicFeed.getStats() : { totalEntries: 0, hiddenCount: 0, peerCount: 0 }
    console.log(`[PublicFeed API] Returning ${feed.length} entries (${stats.peerCount} peers connected)`)
    return { entries: feed, stats }
  },

  async refreshFeed() {
    console.log('[PublicFeed API] ===== REFRESH REQUESTED =====')
    let peerCount = 0
    if (publicFeed) {
      peerCount = publicFeed.requestFeedsFromPeers()
    }
    return { success: true, peerCount }
  },

  async submitToFeed(driveKey) {
    console.log('[PublicFeed API] Submitting channel:', driveKey?.slice(0, 16))
    if (publicFeed && driveKey) {
      publicFeed.submitChannel(driveKey)
    }
    return { success: true }
  },

  async hideChannel(driveKey) {
    console.log('[PublicFeed API] Hiding channel:', driveKey?.slice(0, 16))
    if (publicFeed && driveKey) {
      publicFeed.hideChannel(driveKey)
    }
    return { success: true }
  },

  async getChannelMeta(driveKey) {
    console.log('[PublicFeed API] Getting metadata for:', driveKey?.slice(0, 16))
    try {
      const drive = await loadDrive(driveKey, { waitForSync: true, syncTimeout: 8000 })

      let metaBuf = null
      try {
        const entryPromise = drive.entry('/channel.json', { wait: true })
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Entry fetch timeout')), 5000)
        )
        const entry = await Promise.race([entryPromise, timeoutPromise])
        if (entry) {
          metaBuf = await drive.get('/channel.json')
        }
      } catch (err) {
        console.log('[PublicFeed API] Entry wait error:', err.message, 'trying direct get...')
        metaBuf = await drive.get('/channel.json')
      }

      if (metaBuf) {
        const meta = JSON.parse(b4a.toString(metaBuf))

        // Count videos
        let videoCount = 0
        try {
          for await (const entry of drive.readdir('/videos')) {
            if (entry.endsWith('.json')) videoCount++
          }
        } catch {}

        return {
          ...meta,
          videoCount,
          driveKey
        }
      } else {
        return {
          driveKey,
          name: 'Unknown Channel',
          description: '',
          videoCount: 0
        }
      }
    } catch (err) {
      console.error('[PublicFeed API] Failed to get metadata:', err.message)
      return {
        driveKey,
        name: 'Unknown Channel',
        description: '',
        videoCount: 0,
        error: err.message
      }
    }
  },

  async getSwarmStatus() {
    const topicHex = publicFeed ? b4a.toString(publicFeed.feedTopic, 'hex') : 'not initialized'
    return {
      swarmConnections: swarm?.connections?.size || 0,
      swarmPeers: swarm?.peers?.size || 0,
      feedConnections: publicFeed?.feedConnections?.size || 0,
      feedEntries: publicFeed?.entries?.size || 0,
      feedTopicHex: topicHex,
      swarmPublicKey: swarm?.keyPair?.publicKey ? b4a.toString(swarm.keyPair.publicKey, 'hex').slice(0, 32) : 'unknown',
      drivesLoaded: drives.size,
    }
  },

  async prefetchVideo(driveKey, videoPath) {
    const prefetchStart = Date.now()
    const statsKey = getVideoStatsKey(driveKey, videoPath)

    console.log('[Prefetch] ===== STARTING PREFETCH =====')
    console.log('[Prefetch] Drive:', driveKey?.slice(0, 16))
    console.log('[Prefetch] Path:', videoPath)

    // Clean up any existing monitor for this video
    cleanupVideoMonitor(driveKey, videoPath)

    // Initialize stats
    updateVideoStats(driveKey, videoPath, {
      status: 'connecting',
      startTime: prefetchStart
    })

    try {
      const driveStart = Date.now()
      const drive = await loadDrive(driveKey, { waitForSync: true, syncTimeout: 10000 })
      console.log('[Prefetch] Drive loaded in', Date.now() - driveStart, 'ms')

      const peerCount = swarm?.connections?.size || 0
      console.log('[Prefetch] Active swarm connections:', peerCount)
      updateVideoStats(driveKey, videoPath, { peerCount, status: 'resolving' })

      const entryStart = Date.now()
      const entry = await drive.entry(videoPath)
      if (!entry || !entry.value?.blob) {
        throw new Error('Video not found in drive')
      }
      console.log('[Prefetch] Entry resolved in', Date.now() - entryStart, 'ms')

      const blob = entry.value.blob
      console.log('[Prefetch] Blob info:', JSON.stringify(blob))

      const blobsCore = await drive.getBlobs()
      if (!blobsCore) {
        throw new Error('Could not get blobs core')
      }

      const core = blobsCore.core
      const startBlock = blob.blockOffset
      const endBlock = blob.blockOffset + blob.blockLength
      const totalBlocks = blob.blockLength
      const totalBytes = blob.byteLength

      console.log('[Prefetch] Block range:', startBlock, '->', endBlock, '(', totalBlocks, 'blocks,', totalBytes, 'bytes )')

      let initialAvailable = 0
      for (let i = startBlock; i < endBlock; i++) {
        if (core.has(i)) initialAvailable++
      }
      console.log(`[Prefetch] Initial block check: ${initialAvailable}/${totalBlocks} blocks available (${Math.round(initialAvailable/totalBlocks*100)}%)`)

      updateVideoStats(driveKey, videoPath, {
        status: initialAvailable === totalBlocks ? 'complete' : 'downloading',
        totalBlocks,
        totalBytes,
        initialBlocks: initialAvailable,
        downloadedBlocks: 0
      })

      emitVideoStats(driveKey, videoPath)

      if (initialAvailable === totalBlocks) {
        console.log('[Prefetch] Already fully cached, skipping download')
        if (seedingManager) {
          await seedingManager.addSeed(driveKey, videoPath, 'watched', blob)
          console.log('[Prefetch] Now seeding:', videoPath)
        }
        return {
          success: true,
          totalBlocks,
          totalBytes,
          peerCount,
          cached: true,
          message: 'Video already fully cached'
        }
      }

      const monitor = drive.monitor(videoPath)
      await monitor.ready()

      let lastLoggedProgress = Math.round((initialAvailable / totalBlocks) * 100)
      let markedAsCached = false

      const onUpdate = async () => {
        try {
          const stats = monitor.downloadStats
          const downloadedBlocks = stats.blocks
          const totalDownloaded = initialAvailable + downloadedBlocks
          const progress = Math.round((totalDownloaded / totalBlocks) * 100)
          const isComplete = totalDownloaded >= totalBlocks

          updateVideoStats(driveKey, videoPath, {
            downloadedBlocks,
            peerCount: stats.peers || swarm?.connections?.size || 0,
            status: isComplete ? 'complete' : 'downloading'
          })

          emitVideoStats(driveKey, videoPath)

          if (progress >= lastLoggedProgress + 10 || progress === 100) {
            const speed = monitor.downloadSpeed()
            console.log(`[Prefetch] Progress: ${progress}% (${totalDownloaded}/${totalBlocks} blocks, ${(speed / (1024 * 1024)).toFixed(2)} MB/s)`)
            lastLoggedProgress = progress
          }

          if (isComplete && !markedAsCached) {
            markedAsCached = true
            console.log('[Prefetch] 100% complete via monitor')
            if (seedingManager) {
              await seedingManager.addSeed(driveKey, videoPath, 'watched', blob)
              console.log('[Prefetch] Now seeding:', videoPath)
            }
          }
        } catch (e) {
          // Ignore errors during progress check
        }
      }

      monitor.on('update', onUpdate)

      videoMonitors.set(statsKey, {
        monitor,
        cleanup: () => monitor.off('update', onUpdate)
      })

      const downloadRange = core.download({ start: startBlock, end: endBlock })

      downloadRange.done().then(async () => {
        console.log('[Prefetch] Download range done, verifying blocks...')

        let verifiedBlocks = 0
        for (let i = startBlock; i < endBlock; i++) {
          if (core.has(i)) verifiedBlocks++
        }

        const verificationPercent = Math.round((verifiedBlocks / totalBlocks) * 100)
        console.log(`[Prefetch] Verification: ${verifiedBlocks}/${totalBlocks} blocks (${verificationPercent}%)`)

        const isActuallyComplete = verifiedBlocks === totalBlocks
        console.log('[Prefetch] Complete:', isActuallyComplete)

        updateVideoStats(driveKey, videoPath, {
          status: isActuallyComplete ? 'complete' : 'downloading',
          downloadedBlocks: verifiedBlocks - initialAvailable,
          initialBlocks: initialAvailable
        })

        if (seedingManager && isActuallyComplete && !markedAsCached) {
          await seedingManager.addSeed(driveKey, videoPath, 'watched', blob)
          console.log('[Prefetch] Now seeding:', videoPath)
        }

        setTimeout(() => cleanupVideoMonitor(driveKey, videoPath), 30000)
      }).catch(err => {
        console.error('[Prefetch] ===== FAILED =====')
        console.error('[Prefetch] Error:', err.message)
        updateVideoStats(driveKey, videoPath, {
          status: 'error',
          error: err.message
        })
        cleanupVideoMonitor(driveKey, videoPath)
      })

      return {
        success: true,
        totalBlocks,
        totalBytes,
        peerCount,
        initialBlocks: initialAvailable,
        message: 'Prefetch started with drive.monitor()'
      }
    } catch (err) {
      console.error('[Prefetch] ===== ERROR =====')
      console.error('[Prefetch] Error:', err.message)
      updateVideoStats(driveKey, videoPath, {
        status: 'error',
        error: err.message
      })
      cleanupVideoMonitor(driveKey, videoPath)
      return { success: false, error: err.message }
    }
  },

  async getVideoStats(driveKey, videoPath) {
    const stats = getVideoStats(driveKey, videoPath)
    if (stats) {
      stats.swarmConnections = swarm?.connections?.size || 0
      return stats
    }
    return {
      status: 'unknown',
      progress: 0,
      totalBlocks: 0,
      downloadedBlocks: 0,
      peerCount: swarm?.connections?.size || 0,
      swarmConnections: swarm?.connections?.size || 0
    }
  },

  async getSeedingStatus() {
    if (seedingManager) {
      return await seedingManager.getStatus()
    }
    return { error: 'Seeding manager not initialized' }
  },

  async setSeedingConfig(config) {
    if (seedingManager) {
      await seedingManager.setConfig(config)
      return { success: true, config: seedingManager.config }
    }
    return { success: false, error: 'Seeding manager not initialized' }
  },

  async pinChannel(driveKey) {
    if (seedingManager && driveKey) {
      await seedingManager.pinChannel(driveKey)
      await loadDrive(driveKey)
      return { success: true }
    }
    return { success: false, error: 'Invalid request' }
  },

  async unpinChannel(driveKey) {
    if (seedingManager && driveKey) {
      await seedingManager.unpinChannel(driveKey)
      return { success: true }
    }
    return { success: false, error: 'Invalid request' }
  },

  async getPinnedChannels() {
    if (seedingManager) {
      return { channels: seedingManager.getPinnedChannels() }
    }
    return { channels: [] }
  },

  async getVideoThumbnail(driveKey, videoId) {
    console.log('[Backend] GET_VIDEO_THUMBNAIL:', driveKey?.slice(0, 16), videoId)
    try {
      const drive = await loadDrive(driveKey, { waitForSync: true, syncTimeout: 5000 })

      const thumbnailPath = `/thumbnails/${videoId}.jpg`
      const thumbnailPngPath = `/thumbnails/${videoId}.png`

      let thumbEntry = await drive.entry(thumbnailPath)
      if (!thumbEntry) {
        thumbEntry = await drive.entry(thumbnailPngPath)
      }

      if (thumbEntry && thumbEntry.value?.blob) {
        const blob = thumbEntry.value.blob
        const blobsCore = await drive.getBlobs()
        if (blobsCore) {
          const url = blobServer.getLink(blobsCore.core.key, {
            blob: blob,
            type: thumbEntry.key.endsWith('.png') ? 'image/png' : 'image/jpeg'
          })
          console.log('[Backend] Thumbnail URL:', url)
          return { url, exists: true }
        }
      }
      return { exists: false }
    } catch (err) {
      console.error('[Backend] GET_VIDEO_THUMBNAIL error:', err.message)
      return { exists: false, error: err.message }
    }
  },

  async setVideoThumbnail(videoId, imageData, mimeType) {
    console.log('[Backend] SET_VIDEO_THUMBNAIL:', videoId)
    try {
      const drive = drives.get(identity?.driveKey)
      if (!drive) {
        throw new Error('No identity drive - must be own video')
      }

      const thumbBuf = b4a.from(imageData, 'base64')
      const ext = mimeType?.includes('png') ? 'png' : 'jpg'
      const thumbnailPath = `/thumbnails/${videoId}.${ext}`

      await drive.put(thumbnailPath, thumbBuf)

      const thumbEntry = await drive.entry(thumbnailPath)
      let thumbnailUrl = null

      if (thumbEntry && thumbEntry.value?.blob) {
        const blobsCore = await drive.getBlobs()
        if (blobsCore) {
          thumbnailUrl = blobServer.getLink(blobsCore.core.key, {
            blob: thumbEntry.value.blob,
            type: mimeType || 'image/jpeg'
          })
        }
      }

      console.log('[Backend] Thumbnail saved:', thumbnailPath)
      return { success: true, thumbnailUrl, path: thumbnailPath }
    } catch (err) {
      console.error('[Backend] SET_VIDEO_THUMBNAIL error:', err.message)
      return { success: false, error: err.message }
    }
  }
}

// ============================================
// HRPC Handler Registration
// ============================================

function registerHRPCHandlers() {
  console.log('[Backend] Registering HRPC handlers...')

  // Identity handlers
  rpc.onCreateIdentity(async (req) => {
    console.log('[HRPC] createIdentity:', req)
    const result = await api.createIdentity(req.name || 'New Channel')
    return {
      identity: {
        publicKey: result.publicKey,
        name: req.name || 'New Channel',
        seedPhrase: '', // Mobile doesn't use seed phrases currently
      }
    }
  })

  rpc.onGetIdentity(async () => {
    console.log('[HRPC] getIdentity')
    const ident = await api.getIdentity()
    return { identity: ident || null }
  })

  rpc.onGetIdentities(async () => {
    console.log('[HRPC] getIdentities')
    const ident = await api.getIdentity()
    return { identities: ident ? [{ ...ident, isActive: true }] : [] }
  })

  rpc.onSetActiveIdentity(async (req) => {
    console.log('[HRPC] setActiveIdentity:', req.publicKey)
    // Mobile has single identity, no-op
    return { success: true }
  })

  rpc.onRecoverIdentity(async (req) => {
    console.log('[HRPC] recoverIdentity')
    // Mobile doesn't support recovery yet
    return { identity: null }
  })

  // Channel handlers
  rpc.onGetChannel(async (req) => {
    console.log('[HRPC] getChannel:', req.publicKey?.slice(0, 16))
    const channel = await api.getChannel(req.publicKey || '')
    return { channel }
  })

  rpc.onUpdateChannel(async (req) => {
    console.log('[HRPC] updateChannel')
    // TODO: Implement
    return { channel: {} }
  })

  // Video handlers
  rpc.onListVideos(async (req) => {
    console.log('[HRPC] listVideos:', req.channelKey?.slice(0, 16))
    const videos = await api.listVideos(req.channelKey || '')
    return { videos }
  })

  rpc.onGetVideoUrl(async (req) => {
    console.log('[HRPC] getVideoUrl:', req.channelKey?.slice(0, 16), req.videoId)
    const result = await api.getVideoUrl(req.channelKey, req.videoId)
    return { url: result.url }
  })

  rpc.onGetVideoData(async (req) => {
    console.log('[HRPC] getVideoData:', req.channelKey?.slice(0, 16), req.videoId)
    // TODO: Implement getVideoData
    return { video: { id: req.videoId, title: 'Unknown' } }
  })

  rpc.onUploadVideo(async (req) => {
    console.log('[HRPC] uploadVideo:', req.title)
    // Mobile uses base64 fileData instead of filePath
    const result = await api.uploadVideo(
      req.title,
      req.description || '',
      req.fileName || 'video.mp4',
      req.fileData || ''
    )
    return {
      video: {
        id: result.id,
        title: req.title,
        description: req.description || '',
        channelKey: identity?.driveKey,
      }
    }
  })

  // Subscription handlers
  rpc.onSubscribeChannel(async (req) => {
    console.log('[HRPC] subscribeChannel:', req.channelKey?.slice(0, 16))
    await api.subscribeChannel(req.channelKey)
    return { success: true }
  })

  rpc.onUnsubscribeChannel(async (req) => {
    console.log('[HRPC] unsubscribeChannel:', req.channelKey?.slice(0, 16))
    // TODO: Implement
    return { success: true }
  })

  rpc.onGetSubscriptions(async () => {
    console.log('[HRPC] getSubscriptions')
    const subs = await api.getSubscriptions()
    return {
      subscriptions: subs.map(s => ({
        channelKey: s.driveKey,
        channelName: s.name,
      }))
    }
  })

  rpc.onJoinChannel(async (req) => {
    console.log('[HRPC] joinChannel:', req.channelKey?.slice(0, 16))
    await api.subscribeChannel(req.channelKey)
    return { success: true }
  })

  // Public Feed handlers
  rpc.onGetPublicFeed(async () => {
    console.log('[HRPC] getPublicFeed')
    const result = await api.getPublicFeed()
    return {
      entries: result.entries.map(e => ({
        channelKey: e.driveKey || e.channelKey,
        channelName: e.name,
        videoCount: e.videoCount || 0,
        peerCount: e.peerCount || 0,
        lastSeen: e.lastSeen || 0,
      }))
    }
  })

  rpc.onRefreshFeed(async () => {
    console.log('[HRPC] refreshFeed')
    await api.refreshFeed()
    return { success: true }
  })

  rpc.onSubmitToFeed(async () => {
    console.log('[HRPC] submitToFeed')
    if (identity?.driveKey) {
      await api.submitToFeed(identity.driveKey)
    }
    return { success: true }
  })

  rpc.onHideChannel(async (req) => {
    console.log('[HRPC] hideChannel:', req.channelKey?.slice(0, 16))
    await api.hideChannel(req.channelKey)
    return { success: true }
  })

  rpc.onGetChannelMeta(async (req) => {
    console.log('[HRPC] getChannelMeta:', req.channelKey?.slice(0, 16))
    const meta = await api.getChannelMeta(req.channelKey)
    return {
      name: meta.name,
      description: meta.description,
      videoCount: meta.videoCount || 0,
    }
  })

  rpc.onGetSwarmStatus(async () => {
    console.log('[HRPC] getSwarmStatus')
    const status = await api.getSwarmStatus()
    return {
      connected: status.swarmConnections > 0,
      peerCount: status.swarmConnections,
    }
  })

  // Video prefetch and stats
  rpc.onPrefetchVideo(async (req) => {
    console.log('[HRPC] prefetchVideo:', req.channelKey?.slice(0, 16), req.videoId)
    await api.prefetchVideo(req.channelKey, req.videoId)
    return { success: true }
  })

  rpc.onGetVideoStats(async (req) => {
    console.log('[HRPC] getVideoStats:', req.channelKey?.slice(0, 16), req.videoId)
    const stats = await api.getVideoStats(req.channelKey, req.videoId)
    return {
      stats: {
        videoId: req.videoId,
        channelKey: req.channelKey,
        downloadedBytes: stats.downloadedBytes || 0,
        totalBytes: stats.totalBytes || 0,
        downloadProgress: stats.progress || 0,
        peerCount: stats.peerCount || 0,
        downloadSpeed: stats.speed || 0,
        uploadSpeed: stats.uploadSpeed || 0,
      }
    }
  })

  // Seeding handlers
  rpc.onGetSeedingStatus(async () => {
    console.log('[HRPC] getSeedingStatus')
    const status = await api.getSeedingStatus()
    return {
      status: {
        enabled: status.config?.autoSeedWatched || false,
        usedStorage: status.storageUsedBytes || 0,
        maxStorage: (status.maxStorageGB || 10) * 1024 * 1024 * 1024,
        seedingCount: status.activeSeeds || 0,
      }
    }
  })

  rpc.onSetSeedingConfig(async (req) => {
    console.log('[HRPC] setSeedingConfig')
    await api.setSeedingConfig(req.config || {})
    return { success: true }
  })

  rpc.onPinChannel(async (req) => {
    console.log('[HRPC] pinChannel:', req.channelKey?.slice(0, 16))
    await api.pinChannel(req.channelKey)
    return { success: true }
  })

  rpc.onUnpinChannel(async (req) => {
    console.log('[HRPC] unpinChannel:', req.channelKey?.slice(0, 16))
    await api.unpinChannel(req.channelKey)
    return { success: true }
  })

  rpc.onGetPinnedChannels(async () => {
    console.log('[HRPC] getPinnedChannels')
    const result = await api.getPinnedChannels()
    return { channels: result.channels || [] }
  })

  // Thumbnail/Metadata handlers
  rpc.onGetVideoThumbnail(async (req) => {
    console.log('[HRPC] getVideoThumbnail:', req.channelKey?.slice(0, 16), req.videoId)
    const result = await api.getVideoThumbnail(req.channelKey, req.videoId)
    return { url: result.url || null, dataUrl: null }
  })

  rpc.onGetVideoMetadata(async (req) => {
    console.log('[HRPC] getVideoMetadata:', req.channelKey?.slice(0, 16), req.videoId)
    // TODO: Implement
    return { video: { id: req.videoId, title: 'Unknown' } }
  })

  rpc.onSetVideoThumbnail(async (req) => {
    console.log('[HRPC] setVideoThumbnail')
    const result = await api.setVideoThumbnail(req.videoId, req.imageData, req.mimeType)
    return { success: result.success }
  })

  // Desktop-specific handlers (stubs for mobile)
  rpc.onGetStatus(async () => {
    console.log('[HRPC] getStatus')
    return {
      status: {
        ready: true,
        hasIdentity: identity !== null,
        blobServerPort: blobServerPort || 0,
      }
    }
  })

  rpc.onPickVideoFile(async () => {
    console.log('[HRPC] pickVideoFile - not supported on mobile')
    return { filePath: null, cancelled: true }
  })

  rpc.onGetBlobServerPort(async () => {
    console.log('[HRPC] getBlobServerPort')
    return { port: blobServerPort || 0 }
  })

  // Event handlers (client -> server, usually no-ops)
  rpc.onEventReady(() => {
    console.log('[HRPC] Client acknowledged ready')
  })

  rpc.onEventError((data) => {
    console.error('[HRPC] Client reported error:', data?.message)
  })

  rpc.onEventUploadProgress(() => {
    // Client shouldn't send this
  })

  rpc.onEventFeedUpdate(() => {
    // Client shouldn't send this
  })

  rpc.onEventLog(() => {
    // Client shouldn't send this
  })

  rpc.onEventVideoStats(() => {
    // Client shouldn't send this
  })

  console.log('[Backend] HRPC handlers registered')
}

// ============================================
// Main Initialization
// ============================================

init().then(() => {
  // Create HRPC instance with the IPC stream
  rpc = new HRPC(IPC)
  console.log('[Backend] HRPC initialized')

  // Register all handlers
  registerHRPCHandlers()

  // Send ready event
  try {
    rpc.eventReady({ blobServerPort: blobServerPort || 0 })
    console.log('[Backend] Sent eventReady via HRPC')
  } catch (e) {
    console.error('[Backend] Failed to send eventReady:', e.message)
  }
}).catch((err) => {
  console.error('[Backend] Init error:', err)
  // Try to send error event if rpc is initialized
  if (rpc) {
    try {
      rpc.eventError({ message: err.message })
    } catch (e) {
      console.error('[Backend] Failed to send error event:', e)
    }
  }
})
