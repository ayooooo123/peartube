/**
 * PearTube Mobile Backend - Runs in Bare thread
 * Handles P2P networking, Hyperdrive storage, video streaming
 */

import RPC from 'bare-rpc'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import Hyperbee from 'hyperbee'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import path from 'bare-path'
import fs from 'bare-fs'
import Protomux from 'protomux'
import c from 'compact-encoding'
import BlobServer from 'hypercore-blob-server'
import { RPC as Commands } from '../rpc-commands.mjs'

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

console.log('[Backend] Starting PearTube mobile backend')
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

// Push video stats event to frontend (called by monitor onUpdate)
// rpc is initialized later, so this is a lazy reference
let pushVideoStatsEvent = null
function emitVideoStats(driveKey, videoPath) {
  if (!pushVideoStatsEvent) {
    console.log('[Backend] emitVideoStats: pushVideoStatsEvent not ready')
    return
  }
  const stats = getVideoStats(driveKey, videoPath)
  if (stats) {
    console.log('[Backend] Pushing video stats event:', stats.progress + '% complete')
    try {
      pushVideoStatsEvent({ driveKey, videoPath, stats })
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

// RPC Handler
const rpc = new RPC(IPC, async (req) => {
  // Initialize push function for video stats events
  if (!pushVideoStatsEvent) {
    pushVideoStatsEvent = (data) => {
      const event = rpc.request(Commands.EVENT_VIDEO_STATS)
      event.send(Buffer.from(JSON.stringify(data)))
    }
  }
  const command = req.command
  const data = req.data ? JSON.parse(b4a.toString(req.data)) : {}
  const requestId = data._requestId  // Extract request ID for response matching

  console.log('[Backend] RPC:', command, requestId !== undefined ? `(reqId: ${requestId})` : '')

  try {
    let result = null

    switch (command) {
      case Commands.CREATE_IDENTITY: {
        const { drive, keyHex } = await createDrive()

        // Create channel metadata
        const channel = {
          name: data.name,
          description: '',
          createdAt: Date.now()
        }
        await drive.put('/channel.json', Buffer.from(JSON.stringify(channel)))

        identity = {
          name: data.name,
          publicKey: keyHex,
          driveKey: keyHex,
          createdAt: Date.now()
        }

        await metaDb.put('identity', identity)
        result = identity
        break
      }

      case Commands.GET_IDENTITY: {
        result = identity
        break
      }

      case Commands.GET_CHANNEL: {
        console.log('[Backend] GET_CHANNEL:', data.driveKey?.slice(0, 16))
        try {
          // Load drive with sync for remote channels
          const drive = await loadDrive(data.driveKey, { waitForSync: true, syncTimeout: 8000 })

          const metaBuf = await drive.get('/channel.json')
          if (metaBuf) {
            result = JSON.parse(b4a.toString(metaBuf))
            console.log('[Backend] Got channel:', result.name)
          } else {
            result = { name: 'Unknown Channel' }
          }
        } catch (err) {
          console.error('[Backend] GET_CHANNEL error:', err.message)
          result = { name: 'Unknown Channel', error: err.message }
        }
        break
      }

      case Commands.LIST_VIDEOS: {
        console.log('[Backend] LIST_VIDEOS for:', data.driveKey?.slice(0, 16))
        try {
          // Load drive with sync for remote channels
          const drive = await loadDrive(data.driveKey, { waitForSync: true, syncTimeout: 8000 })

          const videos = []
          try {
            for await (const entry of drive.readdir('/videos')) {
              if (entry.endsWith('.json')) {
                const metaBuf = await drive.get(`/videos/${entry}`)
                if (metaBuf) {
                  const video = JSON.parse(b4a.toString(metaBuf))
                  video.channelKey = data.driveKey
                  videos.push(video)
                }
              }
            }
          } catch (e) {
            console.log('[Backend] Error listing videos:', e.message)
          }

          result = videos.sort((a, b) => b.uploadedAt - a.uploadedAt)
          console.log('[Backend] Found', result.length, 'videos')
        } catch (err) {
          console.error('[Backend] LIST_VIDEOS error:', err.message)
          result = []
        }
        break
      }

      case Commands.GET_VIDEO_URL: {
        // Get video stream URL via blob server
        // Resolve blob directly to avoid HTTP redirect issues with VLC seeking
        console.log('[Backend] GET_VIDEO_URL:', data.driveKey?.slice(0, 16), data.videoPath)
        try {
          // Make sure the drive is loaded and synced
          const drive = await loadDrive(data.driveKey, { waitForSync: true, syncTimeout: 15000 })

          // Resolve the filename to get blob info directly
          // This avoids HTTP 307 redirect which can break VLC seeking
          const entry = await drive.entry(data.videoPath)
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
            type: data.videoPath.endsWith('.webm') ? 'video/webm' : 'video/mp4'
          })

          console.log('[Backend] Direct blob URL:', url)
          result = { url }
        } catch (err) {
          console.error('[Backend] GET_VIDEO_URL error:', err.message)
          throw err
        }
        break
      }

      case Commands.GET_VIDEO_DATA: {
        // Stream video data back to React Native
        console.log('[Backend] GET_VIDEO_DATA:', data.driveKey?.slice(0, 16), data.path)
        try {
          // Load drive with sync - videos need more time as files are larger
          const drive = await loadDrive(data.driveKey, { waitForSync: true, syncTimeout: 15000 })

          // Try to wait for the specific video entry
          let videoData = null
          try {
            const entryPromise = drive.entry(data.path, { wait: true })
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Video entry timeout')), 10000)
            )
            const entry = await Promise.race([entryPromise, timeoutPromise])
            if (entry) {
              videoData = await drive.get(data.path)
            }
          } catch (err) {
            console.log('[Backend] Video entry wait error:', err.message, 'trying direct get...')
            videoData = await drive.get(data.path)
          }

          if (!videoData) {
            throw new Error('Video not found - data may still be syncing')
          }

          console.log('[Backend] Got video data, size:', videoData.length)

          // Return base64 encoded for mobile
          // For large files, we'd want to chunk this
          result = {
            data: b4a.toString(videoData, 'base64'),
            size: videoData.length
          }
        } catch (err) {
          console.error('[Backend] GET_VIDEO_DATA error:', err.message)
          throw err
        }
        break
      }

      case Commands.UPLOAD_VIDEO: {
        const drive = drives.get(identity?.driveKey)
        if (!drive) {
          throw new Error('No identity drive')
        }

        const { title, description, fileName, fileData } = data
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

        result = meta
        break
      }

      case Commands.SUBSCRIBE_CHANNEL: {
        await loadDrive(data.driveKey)

        const existing = await metaDb.get('subscriptions')
        const subs = existing?.value || []

        if (!subs.find(s => s.driveKey === data.driveKey)) {
          subs.push({
            driveKey: data.driveKey,
            subscribedAt: Date.now()
          })
          await metaDb.put('subscriptions', subs)
        }

        result = { success: true }
        break
      }

      case Commands.LIST_SUBSCRIPTIONS: {
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

        result = enriched
        break
      }

      case Commands.JOIN_CHANNEL: {
        await loadDrive(data.driveKey)
        result = { success: true }
        break
      }

      // ============================================
      // Public Feed Commands
      // ============================================

      case Commands.GET_PUBLIC_FEED: {
        const feed = publicFeed ? publicFeed.getFeed() : []
        const stats = publicFeed ? publicFeed.getStats() : { totalEntries: 0, hiddenCount: 0, peerCount: 0 }
        console.log(`[PublicFeed API] Returning ${feed.length} entries (${stats.peerCount} peers connected)`)
        result = { entries: feed, stats }
        break
      }

      case Commands.REFRESH_FEED: {
        console.log('[PublicFeed API] ===== REFRESH REQUESTED =====')
        console.log('[PublicFeed API] Connected peers:', publicFeed?.feedConnections.size || 0)
        console.log('[PublicFeed API] Total entries:', publicFeed?.entries.size || 0)
        let peerCount = 0
        if (publicFeed) {
          peerCount = publicFeed.requestFeedsFromPeers()
        }
        result = { success: true, peerCount }
        break
      }

      case Commands.SUBMIT_TO_FEED: {
        console.log('[PublicFeed API] Submitting channel:', data.driveKey?.slice(0, 16))
        if (publicFeed && data.driveKey) {
          publicFeed.submitChannel(data.driveKey)
        }
        result = { success: true }
        break
      }

      case Commands.HIDE_CHANNEL: {
        console.log('[PublicFeed API] Hiding channel:', data.driveKey?.slice(0, 16))
        if (publicFeed && data.driveKey) {
          publicFeed.hideChannel(data.driveKey)
        }
        result = { success: true }
        break
      }

      case Commands.GET_CHANNEL_META: {
        console.log('[PublicFeed API] Getting metadata for:', data.driveKey?.slice(0, 16))
        try {
          // Load the drive with sync enabled to wait for data from peers
          const drive = await loadDrive(data.driveKey, { waitForSync: true, syncTimeout: 8000 })

          // Use entry() with wait to properly wait for the file from peers
          let metaBuf = null
          try {
            // First try with wait to fetch from peers if needed (with timeout)
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
            // Fallback to direct get
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

            result = {
              ...meta,
              videoCount,
              driveKey: data.driveKey
            }
            console.log('[PublicFeed API] Got metadata:', meta.name, 'videos:', videoCount)
          } else {
            console.log('[PublicFeed API] No channel.json found for:', data.driveKey?.slice(0, 16))
            result = {
              driveKey: data.driveKey,
              name: 'Unknown Channel',
              description: '',
              videoCount: 0
            }
          }
        } catch (err) {
          console.error('[PublicFeed API] Failed to get metadata:', err.message)
          result = {
            driveKey: data.driveKey,
            name: 'Unknown Channel',
            description: '',
            videoCount: 0,
            error: err.message
          }
        }
        break
      }

      case Commands.GET_SWARM_STATUS: {
        console.log('[Debug] GET_SWARM_STATUS requested')
        const topicHex = publicFeed ? b4a.toString(publicFeed.feedTopic, 'hex') : 'not initialized'
        result = {
          swarmConnections: swarm?.connections?.size || 0,
          swarmPeers: swarm?.peers?.size || 0,
          feedConnections: publicFeed?.feedConnections?.size || 0,
          feedEntries: publicFeed?.entries?.size || 0,
          feedTopicHex: topicHex,
          swarmPublicKey: swarm?.keyPair?.publicKey ? b4a.toString(swarm.keyPair.publicKey, 'hex').slice(0, 32) : 'unknown',
          drivesLoaded: drives.size,
        }
        console.log('[Debug] Swarm status:', JSON.stringify(result, null, 2))
        break
      }

      case Commands.PREFETCH_VIDEO: {
        // Download all blocks of a video blob in background for smooth seeking
        // "Pied Piper" model: watching a video = becoming a seeder for that video
        // Uses Hyperdrive's built-in monitor for efficient event-driven progress tracking
        const prefetchStart = Date.now()
        const driveKey = data.driveKey
        const videoPath = data.videoPath
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
          // Load drive with detailed timing
          const driveStart = Date.now()
          const drive = await loadDrive(driveKey, { waitForSync: true, syncTimeout: 10000 })
          console.log('[Prefetch] Drive loaded in', Date.now() - driveStart, 'ms')

          // Get peer count for this drive
          const peerCount = swarm?.connections?.size || 0
          console.log('[Prefetch] Active swarm connections:', peerCount)
          updateVideoStats(driveKey, videoPath, { peerCount, status: 'resolving' })

          // Get the blob entry for the video
          const entryStart = Date.now()
          const entry = await drive.entry(videoPath)
          if (!entry || !entry.value?.blob) {
            throw new Error('Video not found in drive')
          }
          console.log('[Prefetch] Entry resolved in', Date.now() - entryStart, 'ms')

          const blob = entry.value.blob
          console.log('[Prefetch] Blob info:', JSON.stringify(blob))

          // Get the blobs core for initial block count
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

          // Count initial blocks already available locally (monitor doesn't track these)
          let initialAvailable = 0
          for (let i = startBlock; i < endBlock; i++) {
            if (core.has(i)) initialAvailable++
          }
          console.log(`[Prefetch] Initial block check: ${initialAvailable}/${totalBlocks} blocks available (${Math.round(initialAvailable/totalBlocks*100)}%)`)

          // Update stats with initial info
          updateVideoStats(driveKey, videoPath, {
            status: initialAvailable === totalBlocks ? 'complete' : 'downloading',
            totalBlocks,
            totalBytes,
            initialBlocks: initialAvailable, // Blocks already local before monitoring
            downloadedBlocks: 0 // Monitor will track newly downloaded blocks
          })

          // Push initial stats to frontend immediately
          emitVideoStats(driveKey, videoPath)

          // If already complete, skip download
          if (initialAvailable === totalBlocks) {
            console.log('[Prefetch] Already fully cached, skipping download')
            if (seedingManager) {
              await seedingManager.addSeed(driveKey, videoPath, 'watched', blob)
              console.log('[Prefetch] Now seeding:', videoPath)
            }
            result = {
              success: true,
              totalBlocks,
              totalBytes,
              peerCount,
              cached: true,
              message: 'Video already fully cached'
            }
            break
          }

          // Create Hyperdrive monitor for event-driven progress tracking
          const monitor = drive.monitor(videoPath)
          await monitor.ready()

          // Track progress via monitor 'update' events (fires on each block download)
          let lastLoggedProgress = Math.round((initialAvailable / totalBlocks) * 100)
          let markedAsCached = false

          const onUpdate = async () => {
            try {
              const stats = monitor.downloadStats
              const downloadedBlocks = stats.blocks // Blocks downloaded during monitoring
              const totalDownloaded = initialAvailable + downloadedBlocks
              const progress = Math.round((totalDownloaded / totalBlocks) * 100)
              const isComplete = totalDownloaded >= totalBlocks

              // Update stats with monitor data
              updateVideoStats(driveKey, videoPath, {
                downloadedBlocks, // Only newly downloaded blocks (getVideoStats adds initialBlocks)
                peerCount: stats.peers || swarm?.connections?.size || 0,
                status: isComplete ? 'complete' : 'downloading'
              })

              // Push stats event to frontend
              emitVideoStats(driveKey, videoPath)

              // Log every 10% progress
              if (progress >= lastLoggedProgress + 10 || progress === 100) {
                const speed = monitor.downloadSpeed()
                console.log(`[Prefetch] Progress: ${progress}% (${totalDownloaded}/${totalBlocks} blocks, ${(speed / (1024 * 1024)).toFixed(2)} MB/s)`)
                lastLoggedProgress = progress
              }

              // When complete, register as seed
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

          // Store monitor for cleanup and live speed access
          videoMonitors.set(statsKey, {
            monitor,
            cleanup: () => monitor.off('update', onUpdate)
          })

          // Use core.download() to request all blocks from peers
          const downloadRange = core.download({ start: startBlock, end: endBlock })

          // Handle completion
          downloadRange.done().then(async () => {
            // Verify blocks are truly local
            console.log('[Prefetch] Download range done, verifying blocks...')

            let verifiedBlocks = 0
            let missingBlocks = []
            for (let i = startBlock; i < endBlock; i++) {
              if (core.has(i)) {
                verifiedBlocks++
              } else {
                missingBlocks.push(i)
              }
            }

            const verificationPercent = Math.round((verifiedBlocks / totalBlocks) * 100)
            console.log(`[Prefetch] Verification: ${verifiedBlocks}/${totalBlocks} blocks (${verificationPercent}%)`)

            if (missingBlocks.length > 0) {
              console.log(`[Prefetch] WARNING: ${missingBlocks.length} blocks still missing!`)
              console.log(`[Prefetch] Missing block indices: ${missingBlocks.slice(0, 10).join(', ')}${missingBlocks.length > 10 ? '...' : ''}`)

              // Try to download missing blocks explicitly
              for (const blockIdx of missingBlocks.slice(0, 50)) {
                try {
                  await core.get(blockIdx, { timeout: 5000 })
                } catch (e) {
                  // Ignore individual block failures
                }
              }

              // Re-verify
              verifiedBlocks = 0
              for (let i = startBlock; i < endBlock; i++) {
                if (core.has(i)) verifiedBlocks++
              }
              console.log(`[Prefetch] After retry: ${verifiedBlocks}/${totalBlocks} blocks`)
            }

            const elapsed = Date.now() - prefetchStart
            const avgSpeed = totalBytes / (elapsed / 1000)
            const isActuallyComplete = verifiedBlocks === totalBlocks

            console.log('[Prefetch] ===== VERIFICATION COMPLETE =====')
            console.log('[Prefetch] Time:', elapsed, 'ms')
            console.log('[Prefetch] Avg Speed:', (avgSpeed / (1024 * 1024)).toFixed(2), 'MB/s')
            console.log('[Prefetch] Path:', videoPath)
            console.log('[Prefetch] Complete:', isActuallyComplete)

            // Update final stats
            updateVideoStats(driveKey, videoPath, {
              status: isActuallyComplete ? 'complete' : 'downloading',
              downloadedBlocks: verifiedBlocks - initialAvailable, // Subtract initial for accurate count
              initialBlocks: initialAvailable
            })

            // Register as seed if complete
            if (seedingManager && isActuallyComplete && !markedAsCached) {
              await seedingManager.addSeed(driveKey, videoPath, 'watched', blob)
              console.log('[Prefetch] Now seeding:', videoPath)
            }

            // Clean up monitor after a delay (keep for live speed queries)
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

          result = {
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
          result = { success: false, error: err.message }
        }
        break
      }

      // ============================================
      // Seeding Commands (Pied Piper distributed availability)
      // ============================================

      case Commands.GET_SEEDING_STATUS: {
        console.log('[Backend] GET_SEEDING_STATUS')
        if (seedingManager) {
          result = await seedingManager.getStatus()
        } else {
          result = { error: 'Seeding manager not initialized' }
        }
        break
      }

      case Commands.SET_SEEDING_CONFIG: {
        console.log('[Backend] SET_SEEDING_CONFIG:', data)
        if (seedingManager) {
          await seedingManager.setConfig(data)
          result = { success: true, config: seedingManager.config }
        } else {
          result = { success: false, error: 'Seeding manager not initialized' }
        }
        break
      }

      case Commands.PIN_CHANNEL: {
        console.log('[Backend] PIN_CHANNEL:', data.driveKey?.slice(0, 16))
        if (seedingManager && data.driveKey) {
          await seedingManager.pinChannel(data.driveKey)
          // Also load the drive to start replicating
          await loadDrive(data.driveKey)
          result = { success: true }
        } else {
          result = { success: false, error: 'Invalid request' }
        }
        break
      }

      case Commands.UNPIN_CHANNEL: {
        console.log('[Backend] UNPIN_CHANNEL:', data.driveKey?.slice(0, 16))
        if (seedingManager && data.driveKey) {
          await seedingManager.unpinChannel(data.driveKey)
          result = { success: true }
        } else {
          result = { success: false, error: 'Invalid request' }
        }
        break
      }

      case Commands.GET_PINNED_CHANNELS: {
        console.log('[Backend] GET_PINNED_CHANNELS')
        if (seedingManager) {
          result = { channels: seedingManager.getPinnedChannels() }
        } else {
          result = { channels: [] }
        }
        break
      }

      // ============================================
      // Video Stats (real-time P2P loading status)
      // ============================================

      case Commands.GET_VIDEO_STATS: {
        const stats = getVideoStats(data.driveKey, data.videoPath)
        if (stats) {
          // Add current swarm info
          stats.swarmConnections = swarm?.connections?.size || 0
          result = stats
        } else {
          result = {
            status: 'unknown',
            progress: 0,
            totalBlocks: 0,
            downloadedBlocks: 0,
            peerCount: swarm?.connections?.size || 0,
            swarmConnections: swarm?.connections?.size || 0
          }
        }
        break
      }

      // ============================================
      // Thumbnail and Metadata Commands
      // ============================================

      case Commands.GET_VIDEO_THUMBNAIL: {
        // Get thumbnail URL for a video via blob server
        console.log('[Backend] GET_VIDEO_THUMBNAIL:', data.driveKey?.slice(0, 16), data.videoId)
        try {
          const drive = await loadDrive(data.driveKey, { waitForSync: true, syncTimeout: 5000 })

          // Check for user-uploaded thumbnail first
          const thumbnailPath = `/thumbnails/${data.videoId}.jpg`
          const thumbnailPngPath = `/thumbnails/${data.videoId}.png`

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
              result = { url, exists: true }
            } else {
              result = { exists: false }
            }
          } else {
            // No thumbnail exists yet
            console.log('[Backend] No thumbnail found for:', data.videoId)
            result = { exists: false }
          }
        } catch (err) {
          console.error('[Backend] GET_VIDEO_THUMBNAIL error:', err.message)
          result = { exists: false, error: err.message }
        }
        break
      }

      case Commands.GET_VIDEO_METADATA: {
        // Get extended metadata for a video (duration, thumbnail, etc.)
        console.log('[Backend] GET_VIDEO_METADATA:', data.driveKey?.slice(0, 16), data.videoId)
        try {
          const drive = await loadDrive(data.driveKey, { waitForSync: true, syncTimeout: 8000 })

          // Get the video's JSON metadata
          const metaPath = `/videos/${data.videoId}.json`
          const metaBuf = await drive.get(metaPath)

          if (!metaBuf) {
            throw new Error('Video metadata not found')
          }

          const meta = JSON.parse(b4a.toString(metaBuf))

          // Try to get thumbnail URL
          let thumbnailUrl = null
          const thumbnailPath = `/thumbnails/${data.videoId}.jpg`
          const thumbEntry = await drive.entry(thumbnailPath)

          if (thumbEntry && thumbEntry.value?.blob) {
            const blobsCore = await drive.getBlobs()
            if (blobsCore) {
              thumbnailUrl = blobServer.getLink(blobsCore.core.key, {
                blob: thumbEntry.value.blob,
                type: 'image/jpeg'
              })
            }
          }

          // Return enriched metadata
          result = {
            ...meta,
            channelKey: data.driveKey,
            thumbnailUrl,
            // Duration might be stored in meta, or we could extract it later
            duration: meta.duration || null
          }
          console.log('[Backend] Got video metadata:', meta.title)
        } catch (err) {
          console.error('[Backend] GET_VIDEO_METADATA error:', err.message)
          result = { error: err.message }
        }
        break
      }

      case Commands.SET_VIDEO_THUMBNAIL: {
        // Upload a thumbnail for a video
        console.log('[Backend] SET_VIDEO_THUMBNAIL:', data.videoId)
        try {
          const drive = drives.get(identity?.driveKey)
          if (!drive) {
            throw new Error('No identity drive - must be own video')
          }

          // Decode base64 image data
          const thumbBuf = b4a.from(data.imageData, 'base64')
          const ext = data.mimeType?.includes('png') ? 'png' : 'jpg'
          const thumbnailPath = `/thumbnails/${data.videoId}.${ext}`

          // Ensure thumbnails directory exists by writing the file
          await drive.put(thumbnailPath, thumbBuf)

          // Get the thumbnail URL for immediate use
          const thumbEntry = await drive.entry(thumbnailPath)
          let thumbnailUrl = null

          if (thumbEntry && thumbEntry.value?.blob) {
            const blobsCore = await drive.getBlobs()
            if (blobsCore) {
              thumbnailUrl = blobServer.getLink(blobsCore.core.key, {
                blob: thumbEntry.value.blob,
                type: data.mimeType || 'image/jpeg'
              })
            }
          }

          console.log('[Backend] Thumbnail saved:', thumbnailPath)
          result = { success: true, thumbnailUrl, path: thumbnailPath }
        } catch (err) {
          console.error('[Backend] SET_VIDEO_THUMBNAIL error:', err.message)
          result = { success: false, error: err.message }
        }
        break
      }

      default:
        throw new Error(`Unknown command: ${command}`)
    }

    // Send response - include _requestId for request/response matching
    const response = rpc.request(command)
    response.send(Buffer.from(JSON.stringify({ success: true, data: result, _requestId: requestId })))

  } catch (error) {
    console.error('[Backend] RPC error:', error)
    const response = rpc.request(command)
    response.send(Buffer.from(JSON.stringify({ success: false, error: error.message, _requestId: requestId })))
  }
})

// Start initialization
init().then(() => {
  const ready = rpc.request(Commands.EVENT_READY)
  ready.send(Buffer.from(JSON.stringify({ ready: true })))
}).catch((err) => {
  console.error('[Backend] Init error:', err)
  const error = rpc.request(Commands.EVENT_ERROR)
  error.send(Buffer.from(JSON.stringify({ error: err.message })))
})
