/**
 * CommentsAutobase - Separate open-membership Autobase for video comments
 * 
 * Architecture:
 * - Each channel has a dedicated comments Autobase derived from the channel key
 * - Open membership: any peer can become a writer by connecting
 * - Comments are stored in a Hyperbee view, keyed by videoId/commentId
 * - Reactions (likes/dislikes) are also stored here
 */

import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import ReadyResource from 'ready-resource'
import { prefixedKey } from './util.js'

const CURRENT_SCHEMA_VERSION = 1

/** @type {WeakMap<import('corestore'), Map<string, Promise<CommentsAutobase>>>} */
const COMMENTS_AUTOBASE_CACHE = new WeakMap()

/**
 * Get a deterministic name for the comments bootstrap core
 * Using a name allows Autobase to create/find the bootstrap core consistently
 * @param {string} channelKeyHex - The channel's key in hex
 * @returns {string} - The bootstrap core name
 */
function getCommentsBootstrapName(channelKeyHex) {
  return `peartube-comments-v1:${channelKeyHex}`
}

export class CommentsAutobase extends ReadyResource {
  /**
   * @param {import('corestore')} store - Corestore instance
   * @param {Object} opts
   * @param {Buffer|string} opts.channelKey - The parent channel's key
   * @param {Buffer|string} [opts.commentsAutobaseKey] - Existing CommentsAutobase key (for viewers)
   * @param {boolean} [opts.isChannelOwner=false] - Whether the current user owns this channel
   * @param {import('hyperswarm')|null} [opts.swarm] - Hyperswarm instance
   */
  constructor(store, opts = {}) {
    super()
    console.log('[CommentsAutobase] Constructor called for channel:', opts?.channelKey?.slice?.(0, 16) || 'unknown')

    this.store = store
    this.opts = opts
    this.swarm = opts.swarm || null

    // Whether the current user is the channel owner (for moderation)
    this._isChannelOwner = Boolean(opts.isChannelOwner)

    // Get channel key in hex
    this.channelKeyHex = typeof opts.channelKey === 'string' 
      ? opts.channelKey 
      : b4a.toString(opts.channelKey, 'hex')
    
    // Existing CommentsAutobase key (for viewers loading published comments)
    this._existingKey = opts.commentsAutobaseKey 
      ? (typeof opts.commentsAutobaseKey === 'string' 
          ? b4a.from(opts.commentsAutobaseKey, 'hex') 
          : opts.commentsAutobaseKey)
      : null
    
    // Bootstrap core name (deterministic per channel, used for owners)
    this.bootstrapName = getCommentsBootstrapName(this.channelKeyHex)

    this.base = null
    this.view = null

    /** @type {WeakSet<any>} Track connections we've already replicated */
    this._replicatedConns = new WeakSet()
    /** @type {WeakSet<any>} Track early bootstrap-core replication (store.replicate) */
    this._bootstrapReplicatedConns = new WeakSet()

    /** @type {any} Discovery handle */
    this._discovery = null

    /** @type {((conn: any) => void) | null} */
    this._connectionHandler = null

    /** @type {NodeJS.Timeout|null} Background update interval for channel owners */
    this._backgroundUpdateInterval = null

    /** @type {boolean} Whether background update loop is running */
    this._backgroundUpdateRunning = false

    /** @type {boolean} Whether ready timed out (viewer degraded mode) */
    this._readyTimedOut = false

    /** @type {boolean} Whether we've forced a fast-forward for viewer bootstrap */
    this._forcedFastForward = false

    /** @type {Promise<any>|null} Viewer keyPair promise */
    this._viewerKeyPairPromise = null

    this.ready().catch(() => {})
  }

  /**
   * Check if the current user is the channel owner
   * @returns {boolean}
   */
  isChannelOwner() {
    return this._isChannelOwner
  }

  get key() {
    return this.base?.key || null
  }

  get keyHex() {
    return this.key ? b4a.toString(this.key, 'hex') : null
  }

  get writable() {
    return Boolean(this.base?.writable)
  }

  get localWriterKey() {
    return this.base?.local?.key || null
  }

  get localWriterKeyHex() {
    return this.localWriterKey ? b4a.toString(this.localWriterKey, 'hex') : null
  }

  get discoveryKey() {
    return this.key ? crypto.discoveryKey(this.key) : null
  }

  async _open() {
    console.log('[CommentsAutobase] _open() STARTED')
    let bootstrapKey
    let bootstrapCore

    // Determine the correct code path:
    // - Owner (isChannelOwner=true): Use name-based lookup (has data locally, no network sync needed)
    // - Viewer with existing key: Use key-based lookup (needs to sync from network)
    // - New channel without key: Use name-based lookup (will create new)
    const useViewerPath = this._existingKey && !this._isChannelOwner

    if (useViewerPath) {
      // Viewer case: load existing CommentsAutobase by key (needs network sync)
      console.log('[CommentsAutobase] Opening existing (VIEWER) for channel:', this.channelKeyHex.slice(0, 16), 'key:', b4a.toString(this._existingKey, 'hex').slice(0, 16))
      bootstrapKey = this._existingKey

      // IMPORTANT: Explicitly get the bootstrap core from the store BEFORE creating Autobase
      // This ensures the core is added to the replication set early, so syncing can start
      console.log('[CommentsAutobase] Pre-loading bootstrap core for viewer...')
      bootstrapCore = this.store.get({ key: this._existingKey })

      // Set up replication on existing connections BEFORE waiting for core.ready()
      // This allows the core to sync while we wait
      if (this.swarm) {
        console.log('[CommentsAutobase] Setting up early replication for bootstrap core...')
        const connCount = this.swarm.connections?.size || 0
        console.log('[CommentsAutobase] Swarm connections for early replication:', connCount)

        // Log peer info to help debug who we're connected to
        for (const conn of this.swarm.connections || []) {
          try {
            const remoteKey = conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex').slice(0, 16) : 'unknown'
            console.log('[CommentsAutobase] Connection to peer:', remoteKey)
          } catch {}
        }

        for (const conn of this.swarm.connections || []) {
          if (!this._bootstrapReplicatedConns.has(conn)) {
            this._bootstrapReplicatedConns.add(conn)
            try {
              this.store.replicate(conn)
              console.log('[CommentsAutobase] Early replication started on connection')
            } catch (err) {
              console.log('[CommentsAutobase] Early replication error:', err?.message)
            }
          }
        }

        // Also join discovery for this key so we can find more peers who have this data
        const discoveryKey = crypto.discoveryKey(this._existingKey)
        console.log('[CommentsAutobase] Joining discovery early:', b4a.toString(discoveryKey, 'hex').slice(0, 16))
        try {
          this._discovery = this.swarm.join(discoveryKey)
          // Flush to make sure we're announced
          this._discovery?.flushed?.().then(() => {
            console.log('[CommentsAutobase] Discovery flushed, waiting for peers with this data...')
          }).catch(() => {})
        } catch {}
      }

      // Now wait for the bootstrap core to have some data (with timeout)
      console.log('[CommentsAutobase] Waiting for bootstrap core to sync...')
      const coreReadyTimeout = 6000 // 6 seconds for core to get first block
      try {
        await Promise.race([
          bootstrapCore.ready(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Bootstrap core ready timeout')), coreReadyTimeout))
        ])
        console.log('[CommentsAutobase] Bootstrap core ready, length:', bootstrapCore.length)

        // If core has no data yet, actively request sync from peers
        if (bootstrapCore.length === 0) {
          console.log('[CommentsAutobase] Core empty, actively requesting sync from peers...')

          // Set up handler to replicate on new connections that arrive during sync
          const onNewConnection = (conn) => {
            console.log('[CommentsAutobase] NEW connection during sync!')
            if (!this._bootstrapReplicatedConns.has(conn)) {
              // Track only for bootstrap sync; base replication is handled later
              this._bootstrapReplicatedConns.add(conn)
              try {
                this.store.replicate(conn)
                // Immediately try update on new connection
                bootstrapCore.update().catch(() => {})
              } catch {}
            }
          }
          this.swarm?.on('connection', onNewConnection)

          // Create a promise that resolves when we get data
          const gotDataPromise = new Promise((resolve, reject) => {
            // Use an event listener for more reliable detection
            const onAppend = () => {
              console.log('[CommentsAutobase] Got append event, length:', bootstrapCore.length)
              cleanup()
              resolve(true)
            }

            // Also check periodically in case we missed an event
            const checkInterval = setInterval(() => {
              if (bootstrapCore.length > 0) {
                cleanup()
                resolve(true)
              }
            }, 200)

            // Timeout after 12 seconds (give P2P discovery more time)
            const timeout = setTimeout(() => {
              cleanup()
              reject(new Error('No data received from peers after 12 seconds'))
            }, 12000)

            const cleanup = () => {
              bootstrapCore.off('append', onAppend)
              clearInterval(checkInterval)
              clearTimeout(timeout)
              this.swarm?.off('connection', onNewConnection)
            }

            bootstrapCore.on('append', onAppend)
          })

          // Actively request update from peers - this triggers the sync
          // Do this multiple times with short delays to handle connection timing
          const requestUpdates = async () => {
            for (let i = 0; i < 15; i++) { // 15 attempts over ~20 seconds
              if (bootstrapCore.length > 0) break
              try {
                const connCount = this.swarm?.connections?.size || 0
                console.log('[CommentsAutobase] Requesting update from peers (attempt', i + 1, '), connections:', connCount)
                // update() tells the core to request the latest length from peers
                await Promise.race([
                  bootstrapCore.update(),
                  new Promise(r => setTimeout(r, 1500))
                ])
                console.log('[CommentsAutobase] After update, length:', bootstrapCore.length)

                // If we now know there's data, request block 0 to actually download it
                if (bootstrapCore.length > 0) {
                  console.log('[CommentsAutobase] Requesting block 0...')
                  await Promise.race([
                    bootstrapCore.get(0),
                    new Promise(r => setTimeout(r, 1000))
                  ])
                  console.log('[CommentsAutobase] Got block 0')
                  break
                }
              } catch (err) {
                // Ignore update errors, keep trying
                console.log('[CommentsAutobase] Request error:', err?.message)
              }
              await new Promise(r => setTimeout(r, 800))
            }
          }

          // Run update requests in parallel with waiting for data
          try {
            await Promise.race([
              gotDataPromise,
              requestUpdates().then(() => {
                if (bootstrapCore.length > 0) return true
                throw new Error('Updates completed but no data received')
              })
            ])
            console.log('[CommentsAutobase] Got first block, length:', bootstrapCore.length)
          } finally {
            // Clean up connection handler
            this.swarm?.off('connection', onNewConnection)
          }
        }

        // CRITICAL: Download ALL blocks from the bootstrap core, not just block 0
        // Autobase needs all blocks to discover writer cores from system entries
        if (bootstrapCore.length > 1) {
          console.log('[CommentsAutobase] Downloading all', bootstrapCore.length, 'blocks from bootstrap core...')
          try {
            // Use download() to fetch all blocks in parallel
            await Promise.race([
              bootstrapCore.download({ start: 0, end: bootstrapCore.length }).done(),
              new Promise(r => setTimeout(r, 5000)) // 5s timeout for downloading all blocks
            ])
            console.log('[CommentsAutobase] All bootstrap blocks downloaded')
          } catch (err) {
            console.log('[CommentsAutobase] Bootstrap download warning (continuing):', err?.message)
            // Continue anyway - we might have enough blocks
          }
        }
      } catch (err) {
        console.log('[CommentsAutobase] Bootstrap core sync failed:', err?.message)
        throw err
      }
    } else {
      // Owner case: create/load CommentsAutobase by name (has data locally)
      // This path is used for:
      // 1. Owner creating a new CommentsAutobase (no existing key)
      // 2. Owner re-loading their own CommentsAutobase (has existing key but is owner)
      console.log('[CommentsAutobase] Opening (OWNER) for channel:', this.channelKeyHex.slice(0, 16), 'bootstrap:', this.bootstrapName.slice(0, 40))
      console.log('[CommentsAutobase] OWNER has existingKey:', this._existingKey ? b4a.toString(this._existingKey, 'hex').slice(0, 16) : 'none')

      // Use name-based lookup - this is deterministic and gives us our local data
      bootstrapCore = this.store.get({ name: this.bootstrapName })
      await bootstrapCore.ready()
      bootstrapKey = bootstrapCore.key
      console.log('[CommentsAutobase] OWNER bootstrap core ready:', b4a.toString(bootstrapKey, 'hex').slice(0, 16), 'length:', bootstrapCore.length)
      console.log('[CommentsAutobase] OWNER discoveryKey:', b4a.toString(crypto.discoveryKey(bootstrapKey), 'hex').slice(0, 16))
      console.log('[CommentsAutobase] OWNER swarm connections at init:', this.swarm?.connections?.size || 0)
    }

    console.log('[CommentsAutobase] Creating Autobase instance...')
    // Create the Autobase with the bootstrap key
    if (useViewerPath && !this._viewerKeyPairPromise) {
      this._viewerKeyPairPromise = this.store.createKeyPair(`peartube-comments-viewer:${this.channelKeyHex}`)
    }

    this.base = new Autobase(this.store, bootstrapKey, {
      valueEncoding: 'json',
      keyPair: useViewerPath ? this._viewerKeyPairPromise : null,
      // Enable optimistic mode for open participation
      // Non-writers can append optimistically, and indexers acknowledge them
      optimistic: true,
      ackInterval: 1000,
      ackThreshold: 0,
      open: (store) => {
        console.log('[CommentsAutobase] Creating Hyperbee view...')
        const core = store.get({ name: 'comments-view' })
        const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
        this.view = bee
        return bee
      },
      apply: async (nodes, view, host) => {
        for (const node of nodes) {
          const op = node.value
          if (!op || typeof op !== 'object') continue

          // Handle optimistic (non-writer) nodes from viewers
          if (node.optimistic) {
            const validOps = ['add-comment', 'add-reaction', 'remove-reaction']
            if (validOps.includes(op.type) && this._validateOp(op)) {
              // Use retry logic for ackWriter to handle transient failures
              const acked = await this._ackWriterWithRetry(host, node.from.key)
              if (!acked) {
                console.log('[CommentsAutobase] Skipping unacked optimistic op from:',
                  b4a.toString(node.from.key, 'hex').slice(0, 16))
                continue // Skip this node if we can't acknowledge the writer
              }
            } else {
              // Skip invalid or disallowed optimistic ops (like moderation attempts)
              console.log('[CommentsAutobase] Skipping invalid optimistic op:', op.type)
              continue
            }
          }

          await this._applyOp(op, view, host, node)
        }
      }
    })

    console.log('[CommentsAutobase] Autobase created, calling ready()...')

    // For ALL cases (owner and viewer), replicate on existing swarm connections immediately
    // This ensures we can sync even if we don't discover new peers on the specific topic
    // IMPORTANT: Set up replication BEFORE calling ready() so cores can sync
    if (this.swarm) {
      console.log('[CommentsAutobase] Setting up replication on existing connections...')
      const connCount = this.swarm.connections?.size || 0
      console.log('[CommentsAutobase] Current swarm connections:', connCount)

      // IMPORTANT: Always call base.replicate() on existing connections, even if we
      // previously called store.replicate() on them. The store.replicate() only syncs
      // cores in the corestore, but base.replicate() is needed for Autobase to discover
      // and sync writer cores that it finds in the bootstrap entries.
      for (const conn of this.swarm.connections || []) {
        try {
          // Autobase needs base.replicate to sync writer cores and the view
          this.base.replicate(conn)
          this._replicatedConns.add(conn) // Track for future connection handler
          console.log('[CommentsAutobase] base.replicate on existing connection')
        } catch (err) {
          console.log('[CommentsAutobase] Replicate error:', err?.message)
        }
      }

      // Also join the discovery topic for this Autobase
      const discoveryKey = crypto.discoveryKey(bootstrapKey)
      console.log('[CommentsAutobase] Joining swarm with discovery key:', b4a.toString(discoveryKey, 'hex').slice(0, 16))
      try {
        this._discovery = this.swarm.join(discoveryKey)
        // Don't await flushed - let it happen in background
        this._discovery?.flushed?.().catch(() => {})
      } catch (err) {
        console.log('[CommentsAutobase] Join error:', err?.message)
      }

      // Set up handler for new connections
      if (!this._connectionHandler) {
        this._connectionHandler = (conn) => {
          console.log('[CommentsAutobase] New connection received')
          if (this._replicatedConns.has(conn)) return
          this._replicatedConns.add(conn)
          try {
            this.base.replicate(conn)
            // Trigger update after connection to sync data
            setTimeout(() => {
              this.update(2000).catch(() => {})
            }, 500)
          } catch {}
        }
        this.swarm.on('connection', this._connectionHandler)
      }
    }

    if (useViewerPath) {
      this._forceFastForward(bootstrapKey).catch(() => {})
    }

    // Log Autobase state before waiting
    console.log('[CommentsAutobase] base.writable:', this.base.writable, 'base.key:', this.base.key ? b4a.toString(this.base.key, 'hex').slice(0, 16) : 'none')
    console.log('[CommentsAutobase] base.local:', this.base.local?.key ? b4a.toString(this.base.local.key, 'hex').slice(0, 16) : 'no local')
    if (useViewerPath) {
      try {
        const kp = await this._viewerKeyPairPromise
        console.log('[CommentsAutobase] Viewer keyPair:', kp?.publicKey ? b4a.toString(kp.publicKey, 'hex').slice(0, 16) : 'none')
      } catch {}
    }

    // For viewers, we need to wait for ready() properly because that's when Autobase
    // discovers writer cores from the bootstrap core entries.
    // The key is to give it enough time and ensure replication is active.
    if (useViewerPath) {
      console.log('[CommentsAutobase] Viewer: waiting for ready() with writer discovery...')

      // Start ready() - this is where Autobase parses bootstrap and discovers writer cores
      const readyPromise = this.base.ready()
      readyPromise.catch((err) => {
        if (this._readyTimedOut) {
          console.log('[CommentsAutobase] Viewer ready() async error (after timeout):', err?.message)
        }
      })

      // In parallel, actively help sync by triggering updates
      // This ensures the corestore is actively fetching data
      const helpSync = async () => {
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500))
          if (this.base.opened) {
            console.log('[CommentsAutobase] Autobase opened during sync help, iteration', i + 1)
            break
          }
          try {
            // Log current state
            console.log('[CommentsAutobase] Sync help iteration', i + 1,
              '- inputs:', this.base.inputs?.length || 0,
              '- activeWriters:', this.base.activeWriters?.size || 0,
              '- opened:', this.base.opened)

            // If we have inputs but they need syncing, help them
            if (this.base.inputs && this.base.inputs.length > 0) {
              for (const input of this.base.inputs) {
                if (input.length === 0) {
                  await Promise.race([
                    input.update(),
                    new Promise(r => setTimeout(r, 300))
                  ]).catch(() => {})
                }
              }
            }
          } catch {}
        }
      }

      // Run sync help in parallel with ready()
      helpSync().catch(() => {})

      // Wait for ready() with a longer timeout for viewers
      // Viewers need extra time because they need to:
      // 1. Sync bootstrap core (already done above)
      // 2. Parse bootstrap to find writer keys
      // 3. Fetch writer cores from network
      // 4. Build linearizer
      const VIEWER_READY_TIMEOUT_MS = 8000
      console.log('[CommentsAutobase] Waiting for Autobase.ready() with timeout:', VIEWER_READY_TIMEOUT_MS, 'ms')

      let readyOk = false
      try {
        await Promise.race([
          readyPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Autobase ready timeout')), VIEWER_READY_TIMEOUT_MS)
          )
        ])
        readyOk = true
        console.log('[CommentsAutobase] Viewer ready() completed successfully!')
      } catch (err) {
        console.log('[CommentsAutobase] Viewer ready() failed:', err?.message)

        // Log detailed state to help debug
        console.log('[CommentsAutobase] State at failure:')
        console.log('[CommentsAutobase] - base.opened:', this.base.opened)
        console.log('[CommentsAutobase] - base.inputs:', this.base.inputs?.length || 0, 'cores')
        console.log('[CommentsAutobase] - base.activeWriters:', this.base.activeWriters?.size || 0)
        console.log('[CommentsAutobase] - base.linearizer:', this.base.linearizer ? 'exists' : 'none')
        console.log('[CommentsAutobase] - swarm connections:', this.swarm?.connections?.size || 0)

        // If we have inputs, log their state
        if (this.base.inputs && this.base.inputs.length > 0) {
          for (let i = 0; i < this.base.inputs.length; i++) {
            const input = this.base.inputs[i]
            console.log('[CommentsAutobase] - input[' + i + ']:',
              input.key ? b4a.toString(input.key, 'hex').slice(0, 16) : 'unknown',
              'length:', input.length)
          }
        }

        // Even if ready() timed out, check if we can still use the view
        // The view might be partially usable
        if (this.base.opened && this.view) {
          console.log('[CommentsAutobase] Autobase is opened despite timeout, attempting to use view...')
          try {
            await Promise.race([
              this.view.ready(),
              new Promise(r => setTimeout(r, 1000))
            ])
            console.log('[CommentsAutobase] View is ready, proceeding despite ready() timeout')
            // Don't throw - we can proceed with a partial view
          } catch (viewErr) {
            console.log('[CommentsAutobase] View also not ready:', viewErr?.message)
            // Continue in degraded mode
          }
        }
        if (!readyOk) {
          this._readyTimedOut = true
          console.log('[CommentsAutobase] Viewer ready timed out; continuing in degraded mode')
        }
      }
    } else {
      // Owner path - should be fast since all data is local
      const OWNER_READY_TIMEOUT_MS = 3000
      console.log('[CommentsAutobase] Owner: waiting for Autobase.ready() with timeout:', OWNER_READY_TIMEOUT_MS, 'ms')

      try {
        await Promise.race([
          this.base.ready(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Autobase ready timeout')), OWNER_READY_TIMEOUT_MS)
          )
        ])
      } catch (err) {
        console.log('[CommentsAutobase] ready() failed:', err?.message)
        if (this._discovery) {
          try { this._discovery.destroy?.() } catch {}
          this._discovery = null
        }
        throw err
      }
    }
    console.log('[CommentsAutobase] Autobase.ready() complete:', this.keyHex?.slice(0, 16), 'writable:', this.writable)

    if (this._isChannelOwner && this.base?.writable) {
      const localLength = this.base.local?.length || 0
      if (localLength === 0) {
        try {
          console.log('[CommentsAutobase] Owner bootstrap: seeding init entry')
          await this.base.append({
            type: 'init',
            schemaVersion: CURRENT_SCHEMA_VERSION,
            timestamp: Date.now()
          })
          await this.update(2000)
        } catch (err) {
          console.log('[CommentsAutobase] Owner bootstrap init failed (non-fatal):', err?.message)
        }
      }
    }

    // Set up replication if not already done (for owners)
    if (!this._existingKey || !this._discovery) {
      console.log('[CommentsAutobase] Setting up swarm replication...')
      this._setupSwarmReplication()
    }

    // Start background update loop for channel owners
    // This ensures incoming optimistic comments are processed even when owner isn't viewing comments
    this._startBackgroundUpdateLoop()
  }

  /**
   * Start a background update loop for channel owners.
   * This processes incoming optimistic comments and acknowledges writers even when
   * the owner isn't actively viewing comments.
   */
  _startBackgroundUpdateLoop() {
    // Only channel owners need to run background updates to ack viewer comments
    if (!this._isChannelOwner) {
      console.log('[CommentsAutobase] Not channel owner, skipping background update loop')
      return
    }

    // Don't start if already running
    if (this._backgroundUpdateInterval) {
      return
    }

    console.log('[CommentsAutobase] Starting background update loop for OWNER')
    console.log('[CommentsAutobase] Owner key:', this.keyHex?.slice(0, 16))
    console.log('[CommentsAutobase] Owner discoveryKey:', this.discoveryKey ? b4a.toString(this.discoveryKey, 'hex').slice(0, 16) : 'none')
    console.log('[CommentsAutobase] Owner swarm connections:', this.swarm?.connections?.size || 0)

    // Log firewall status - if firewalled, viewers may have trouble connecting
    if (this.swarm?.dht) {
      const dhtState = this.swarm.dht
      console.log('[CommentsAutobase] Owner DHT firewalled:', dhtState.firewalled)
      if (dhtState.firewalled) {
        console.log('[CommentsAutobase] WARNING: Owner is firewalled - viewers may have difficulty syncing comments')
      }
    }
    this._backgroundUpdateRunning = true

    // Update every 5 seconds to process incoming viewer comments
    const BACKGROUND_UPDATE_INTERVAL_MS = 5000

    this._backgroundUpdateInterval = setInterval(async () => {
      if (!this._backgroundUpdateRunning || !this.base) {
        return
      }

      try {
        // Use a shorter timeout for background updates to avoid blocking
        await this.update(2000)
      } catch (err) {
        // Silently ignore background update errors
      }
    }, BACKGROUND_UPDATE_INTERVAL_MS)

    // Also do an immediate update to catch any pending data
    this.update(2000).catch(() => {})
  }

  /**
   * Stop the background update loop.
   */
  _stopBackgroundUpdateLoop() {
    this._backgroundUpdateRunning = false
    if (this._backgroundUpdateInterval) {
      clearInterval(this._backgroundUpdateInterval)
      this._backgroundUpdateInterval = null
      console.log('[CommentsAutobase] Stopped background update loop')
    }
  }

  async _close() {
    // Stop background update loop
    this._stopBackgroundUpdateLoop()

    // Remove swarm connection handler to prevent leaks
    if (this._connectionHandler && this.swarm) {
      this.swarm.off('connection', this._connectionHandler)
      this._connectionHandler = null
    }

    // Best-effort leave discovery
    if (this._discovery) {
      try { this._discovery.destroy?.() } catch {}
      try { this._discovery.close?.() } catch {}
      this._discovery = null
    }

    if (this.view) await this.view.close().catch(() => {})
    if (this.base) await this.base.close().catch(() => {})
  }

  setIsChannelOwner(isOwner) {
    // Only ever upgrade (never downgrade) to avoid losing moderation capability.
    if (isOwner && !this._isChannelOwner) {
      this._isChannelOwner = true
      // Start background update loop now that we're an owner
      this._startBackgroundUpdateLoop()
    }
  }

  attachSwarm(swarm) {
    if (!swarm) return
    if (this.swarm === swarm) return

    // Detach from previous swarm (if any)
    if (this._connectionHandler && this.swarm) {
      try { this.swarm.off('connection', this._connectionHandler) } catch {}
      this._connectionHandler = null
    }

    this.swarm = swarm
    this._setupSwarmReplication()

    // If we're the owner and the background loop isn't running yet, start it
    if (this._isChannelOwner && !this._backgroundUpdateInterval) {
      this._startBackgroundUpdateLoop()
    }

    // Trigger immediate update to process any pending data
    if (this._isChannelOwner) {
      this.update(2000).catch(() => {})
    }
  }

  _setupSwarmReplication() {
    // Replication is now set up in _open() before ready()
    // This method is kept for backward compatibility with attachSwarm()
    if (!this.base) return
    if (!this.swarm) return

    console.log('[CommentsAutobase] _setupSwarmReplication called, connections:', this.swarm.connections?.size || 0)

    // Join swarm for discovery (idempotent) using the base key
    if (!this._discovery && this.discoveryKey) {
      try {
        this._discovery = this.swarm.join(this.discoveryKey)
        this._discovery?.flushed?.().catch(() => {})
        console.log('[CommentsAutobase] Joined discovery topic:', b4a.toString(this.discoveryKey, 'hex').slice(0, 16))
      } catch (err) {
        console.log('[CommentsAutobase] Join error:', err?.message)
      }
    }

    // Set up replication on connections (once)
    if (!this._connectionHandler) {
      this._connectionHandler = (conn) => {
        console.log('[CommentsAutobase] New connection in _setupSwarmReplication')
        if (this._replicatedConns.has(conn)) return
        this._replicatedConns.add(conn)
        try {
          this.base.replicate(conn)
          // Trigger an update shortly after connection to process any incoming data
          setTimeout(() => this.update(2000).catch(() => {}), 500)
        } catch {}
      }
      this.swarm.on('connection', this._connectionHandler)
    }

    // Replicate on existing connections
    for (const conn of this.swarm.connections || []) {
      if (this._replicatedConns.has(conn)) continue
      this._replicatedConns.add(conn)
      try {
        this.base.replicate(conn)
        console.log('[CommentsAutobase] Replicating on connection in _setupSwarmReplication')
      } catch {}
    }
  }

  /**
   * Acknowledge a writer with retry logic
   * @param {any} host - The Autobase host
   * @param {Buffer} writerKey - The writer's key to acknowledge
   * @param {number} maxRetries - Maximum retry attempts (default 3)
   * @returns {Promise<boolean>} - True if acknowledged, false if all retries failed
   */
  async _ackWriterWithRetry(host, writerKey, maxRetries = 3) {
    const keyHex = b4a.toString(writerKey, 'hex').slice(0, 16)

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await host.ackWriter(writerKey)
        console.log('[CommentsAutobase] Acknowledged writer:', keyHex, 'attempt:', attempt)
        return true
      } catch (err) {
        console.log('[CommentsAutobase] ackWriter failed (attempt', attempt, '/', maxRetries, '):', err?.message)
        if (attempt < maxRetries) {
          // Exponential backoff: 100ms, 200ms, 400ms
          const delay = 100 * Math.pow(2, attempt - 1)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }

    console.log('[CommentsAutobase] ackWriter failed after', maxRetries, 'attempts for:', keyHex)
    return false
  }

  /**
   * Validate an operation for open participation
   * Only allow safe operations from optimistic (non-writer) nodes
   * @param {Object} op - The operation to validate
   * @returns {boolean} - Whether the operation is valid
   */
  _validateOp(op) {
    if (!op || typeof op !== 'object') return false

    if (op.type === 'add-comment') {
      if (!op.videoId || !op.commentId || !op.text) return false
      if (typeof op.text !== 'string' || op.text.length > 5000) return false
      if (op.text.trim().length === 0) return false
      return true
    }

    if (op.type === 'add-reaction') {
      if (!op.videoId || !op.reactionType) return false
      if (!['like', 'dislike'].includes(op.reactionType)) return false
      return true
    }

    if (op.type === 'remove-reaction') {
      if (!op.videoId) return false
      return true
    }

    // Moderation ops (hide-comment, remove-comment) are NOT allowed for optimistic nodes
    // Only acknowledged writers (channel owner) can moderate
    return false
  }

  async _applyOp(op, view, host, node) {
    if (!op || typeof op !== 'object') return

    const opType = op.type
    switch (opType) {
      case 'add-comment': {
        const key = prefixedKey('comments', `${op.videoId}/${op.commentId}`)
        await view.put(key, {
          videoId: op.videoId,
          commentId: op.commentId,
          text: op.text,
          authorKeyHex: op.authorKeyHex,
          timestamp: op.timestamp || Date.now(),
          parentId: op.parentId || null,
          hidden: false
        })
        return
      }

      case 'hide-comment': {
        const key = prefixedKey('comments', `${op.videoId}/${op.commentId}`)
        const existing = await view.get(key).catch(() => null)
        if (existing?.value) {
          await view.put(key, {
            ...existing.value,
            hidden: true,
            hiddenBy: op.moderatorKeyHex,
            hiddenAt: op.timestamp || Date.now()
          })
        }
        return
      }

      case 'remove-comment': {
        const key = prefixedKey('comments', `${op.videoId}/${op.commentId}`)
        await view.del(key)
        return
      }

      case 'add-reaction': {
        // Key: reactions/{videoId}/{authorKeyHex}
        const key = prefixedKey('reactions', `${op.videoId}/${op.authorKeyHex}`)
        await view.put(key, {
          videoId: op.videoId,
          authorKeyHex: op.authorKeyHex,
          reactionType: op.reactionType, // 'like' or 'dislike'
          timestamp: op.timestamp || Date.now()
        })
        return
      }

      case 'remove-reaction': {
        const key = prefixedKey('reactions', `${op.videoId}/${op.authorKeyHex}`)
        await view.del(key)
        return
      }

      default:
        // Unknown op, ignore
        return
    }
  }

  /**
   * Best-effort update of the materialized view.
   *
   * Important: never block indefinitely here. Viewers may have 0 peers for long periods,
   * and UI calls (listComments/getReactions) must still return quickly with whatever is local.
   *
   * @param {number} [timeoutMs=1500]
   */
  async update(timeoutMs = 1500) {
    if (!this.base) return
    try {
      if (this.swarm) {
        this._setupSwarmReplication()
      }
      await Promise.race([
        // Use wait:true but guard with a timeout to avoid hanging when peers are absent.
        this.base.update({ wait: true }),
        new Promise((resolve) => setTimeout(resolve, timeoutMs))
      ])
    } catch (err) {
      console.log('[CommentsAutobase] Update error:', err?.message)
    }
  }

  async _forceFastForward(bootstrapKey) {
    if (this._forcedFastForward || !this.base || !bootstrapKey) return
    this._forcedFastForward = true
    try {
      const { default: FastForward } = await import('autobase/lib/fast-forward.js')
      console.log('[CommentsAutobase] Viewer: forcing fast-forward bootstrap...')
      const ff = new FastForward(this.base, bootstrapKey, {
        verified: false,
        force: true,
        minimum: 1
      })
      await this.base._runFastForward(ff)
      console.log('[CommentsAutobase] Viewer: fast-forward complete')
    } catch (err) {
      console.log('[CommentsAutobase] Viewer: fast-forward failed (non-fatal):', err?.message)
    }
  }

  // ============================================
  // Comments API
  // ============================================

  /**
   * Add a comment to a video
   * @param {string} videoId
   * @param {string} text
   * @param {string} [parentId]
   * @returns {Promise<{commentId: string, success: boolean}>}
   */
  async addComment(videoId, text, parentId = null) {
    if (!text || typeof text !== 'string') {
      throw new Error('Comment text is required')
    }
    if (text.length > 5000) {
      throw new Error('Comment must be 5000 characters or less')
    }
    if (!this.base) {
      throw new Error('Comments Autobase not ready')
    }

    const commentId = b4a.toString(crypto.randomBytes(16), 'hex')
    const authorKeyHex = this.localWriterKeyHex

    if (!authorKeyHex) {
      throw new Error('Local writer not ready')
    }

    // Non-writers use optimistic mode so their comments can be acknowledged
    const isWriter = this.base.writable
    console.log('[CommentsAutobase] Adding comment:', commentId.slice(0, 8), 'by:', authorKeyHex.slice(0, 16), 'optimistic:', !isWriter)

    const appendPromise = this.base.append({
      type: 'add-comment',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      videoId,
      commentId,
      text,
      authorKeyHex,
      timestamp: Date.now(),
      parentId
    }, { optimistic: !isWriter })

    let appended = false
    try {
      await Promise.race([
        appendPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('append timeout')), 2500))
      ])
      appended = true
    } catch (err) {
      console.log('[CommentsAutobase] addComment append deferred, queuing locally:', err?.message)
      appendPromise.catch((appendErr) => {
        console.log('[CommentsAutobase] addComment append failed after timeout:', appendErr?.message)
      })
    }

    if (appended) {
      // Update view
      await this.update()
      return { commentId, success: true, queued: false }
    }

    return { commentId, success: true, queued: true }
  }

  /**
   * List comments for a video
   * @param {string} videoId
   * @param {Object} [options]
   * @param {number} [options.page=0]
   * @param {number} [options.limit=50]
   * @returns {Promise<Array>}
   */
  async listComments(videoId, options = {}) {
    const { page = 0, limit = 50 } = options

    // Update view first
    await this.update()

    if (!this.view) return []
    try {
      await Promise.race([
        this.view.ready(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Comments view not ready')), 800))
      ])
    } catch {
      return []
    }

    const comments = []
    const prefix = prefixedKey('comments', `${videoId}/`)

    for await (const { value } of this.view.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
      if (value && !value.hidden) {
        comments.push(value)
      }
    }

    // Sort by timestamp (newest first)
    comments.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))

    // Paginate
    const startIdx = page * limit
    return comments.slice(startIdx, startIdx + limit)
  }

  /**
   * Hide a comment (channel owner only)
   * @param {string} videoId
   * @param {string} commentId
   * @returns {Promise<{success: boolean}>}
   */
  async hideComment(videoId, commentId) {
    if (!this.base) throw new Error('Comments Autobase not ready')

    // Only channel owner can hide comments
    if (!this.isChannelOwner()) {
      throw new Error('Only the channel owner can hide comments')
    }

    await this.base.append({
      type: 'hide-comment',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      videoId,
      commentId,
      moderatorKeyHex: this.localWriterKeyHex,
      timestamp: Date.now()
    })

    await this.update()
    return { success: true }
  }

  /**
   * Remove a comment (author or channel owner)
   * @param {string} videoId
   * @param {string} commentId
   * @returns {Promise<{success: boolean}>}
   */
  async removeComment(videoId, commentId) {
    if (!this.base) throw new Error('Comments Autobase not ready')

    // Get comment to verify ownership
    const key = prefixedKey('comments', `${videoId}/${commentId}`)
    const comment = await this.view.get(key).catch(() => null)

    if (!comment?.value) {
      throw new Error('Comment not found')
    }

    const isAuthor = comment.value.authorKeyHex === this.localWriterKeyHex
    const isOwner = this.isChannelOwner()

    // Only author or channel owner can remove comments
    if (!isAuthor && !isOwner) {
      throw new Error('Only the comment author or channel owner can remove comments')
    }

    await this.base.append({
      type: 'remove-comment',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      videoId,
      commentId,
      authorKeyHex: isAuthor ? this.localWriterKeyHex : null,
      moderatorKeyHex: isOwner ? this.localWriterKeyHex : null,
      timestamp: Date.now()
    })

    await this.update()
    return { success: true }
  }

  // ============================================
  // Reactions API
  // ============================================

  /**
   * Add a reaction to a video
   * @param {string} videoId
   * @param {'like'|'dislike'} reactionType
   * @returns {Promise<{success: boolean}>}
   */
  async addReaction(videoId, reactionType) {
    if (!reactionType || !['like', 'dislike'].includes(reactionType)) {
      throw new Error('Invalid reaction type')
    }
    if (!this.base) throw new Error('Comments Autobase not ready')

    const authorKeyHex = this.localWriterKeyHex
    if (!authorKeyHex) throw new Error('Local writer not ready')

    // Non-writers use optimistic mode so their reactions can be acknowledged
    const isWriter = this.base.writable
    console.log('[CommentsAutobase] Adding reaction:', reactionType, 'to:', videoId.slice(0, 8), 'optimistic:', !isWriter)

    await this.base.append({
      type: 'add-reaction',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      videoId,
      authorKeyHex,
      reactionType,
      timestamp: Date.now()
    }, { optimistic: !isWriter })

    await this.update()
    return { success: true }
  }

  /**
   * Remove a reaction from a video
   * @param {string} videoId
   * @returns {Promise<{success: boolean}>}
   */
  async removeReaction(videoId) {
    if (!this.base) throw new Error('Comments Autobase not ready')

    // Non-writers use optimistic mode so their reaction removal can be acknowledged
    const isWriter = this.base.writable

    await this.base.append({
      type: 'remove-reaction',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      videoId,
      authorKeyHex: this.localWriterKeyHex,
      timestamp: Date.now()
    }, { optimistic: !isWriter })

    await this.update()
    return { success: true }
  }

  /**
   * Get reaction counts for a video
   * @param {string} videoId
   * @returns {Promise<{likes: number, dislikes: number, userReaction: string|null}>}
   */
  async getReactionCounts(videoId) {
    await this.update()

    if (!this.view) return { likes: 0, dislikes: 0, userReaction: null }
    try {
      await Promise.race([
        this.view.ready(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Reactions view not ready')), 800))
      ])
    } catch {
      return { likes: 0, dislikes: 0, userReaction: null }
    }

    let likes = 0
    let dislikes = 0
    let userReaction = null

    const prefix = prefixedKey('reactions', `${videoId}/`)

    for await (const { value } of this.view.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
      if (!value) continue
      if (value.reactionType === 'like') likes++
      else if (value.reactionType === 'dislike') dislikes++

      if (value.authorKeyHex === this.localWriterKeyHex) {
        userReaction = value.reactionType
      }
    }

    return { likes, dislikes, userReaction }
  }
}

/**
 * Process-wide CommentsAutobase cache keyed by `{store, channelKey}`.
 * Prevents multiple Autobase instances for the same comments key, which can
 * cause replication/view flakiness when UI calls listComments/getReactions in parallel.
 *
 * @param {import('corestore')} store
 * @param {ConstructorParameters<typeof CommentsAutobase>[1]} opts
 * @returns {Promise<CommentsAutobase>}
 */
export async function getOrCreateCommentsAutobase(store, opts = {}) {
  console.log('[CommentsAutobase] getOrCreateCommentsAutobase called for channel:', opts?.channelKey?.slice?.(0, 16) || 'unknown')
  if (!store) throw new Error('Corestore is required')
  if (!opts?.channelKey) throw new Error('channelKey is required')

  const channelKeyHex = typeof opts.channelKey === 'string'
    ? opts.channelKey
    : b4a.toString(opts.channelKey, 'hex')

  let byChannel = COMMENTS_AUTOBASE_CACHE.get(store)
  if (!byChannel) {
    byChannel = new Map()
    COMMENTS_AUTOBASE_CACHE.set(store, byChannel)
  }

  const cached = byChannel.get(channelKeyHex)
  if (cached) {
    console.log('[CommentsAutobase] getOrCreateCommentsAutobase: returning cached promise for:', channelKeyHex.slice(0, 16))
    // Best-effort upgrade of runtime wiring based on newest caller's context.
    if (opts?.swarm) cached.then((c) => c.attachSwarm(opts.swarm)).catch(() => {})
    if (opts?.isChannelOwner) cached.then((c) => c.setIsChannelOwner(true)).catch(() => {})
    return cached
  }

  console.log('[CommentsAutobase] getOrCreateCommentsAutobase: creating new instance for:', channelKeyHex.slice(0, 16))
  const openPromise = (async () => {
    console.log('[CommentsAutobase] openPromise: creating CommentsAutobase instance...')
    const comments = new CommentsAutobase(store, opts)
    console.log('[CommentsAutobase] openPromise: instance created, awaiting ready()...')
    await comments.ready()
    console.log('[CommentsAutobase] openPromise: ready() complete')
    return comments
  })()

  byChannel.set(channelKeyHex, openPromise)
  openPromise.catch((err) => {
    console.log('[CommentsAutobase] openPromise failed:', err?.message)
    byChannel.delete(channelKeyHex)
  })
  return openPromise
}
