import ReadyResource from 'ready-resource'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import BlindPairing from 'blind-pairing'
import z32 from 'z32'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import { fromHex, toHex, prefixedKey } from './util.js'

/**
 * MultiWriterChannel
 *
 * - Metadata is stored in Autobase (multi-writer)
 * - A deterministic Hyperbee view is derived from Autobase.apply()
 * - Each writer/device has its own blob Hyperdrive; videos reference blob locations in metadata.
 */
export class MultiWriterChannel extends ReadyResource {
  /**
   * @param {import('corestore')} store
   * @param {Object} [opts]
   * @param {Buffer|string|null} [opts.key] Autobase bootstrap key (channel key)
   * @param {Buffer|string|null} [opts.encryptionKey] Autobase encryption key
   * @param {import('hyperswarm')|null} [opts.swarm] Hyperswarm instance for replication
   */
  constructor(store, opts = {}) {
    super()

    this.store = store
    this.opts = opts

    this.base = null
    this.view = null

    /** @type {Map<string, import('hyperdrive')>} */
    this.blobDrives = new Map()

    /** @type {import('hyperswarm')|null} */
    this.swarm = opts.swarm || null

    /** @type {BlindPairing|null} */
    this.pairing = null

    /** @type {any} */
    this.pairingMember = null

    this.ready().catch(() => {})
  }

  get key() {
    return this.base?.key || null
  }

  get keyHex() {
    return this.key ? b4a.toString(this.key, 'hex') : null
  }

  get discoveryKey() {
    return this.base?.discoveryKey || null
  }

  get encryptionKey() {
    return this.base?.encryptionKey || null
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

  async _open() {
    const bootstrapKey = this.opts.key ? fromHex(this.opts.key) : null
    const encryptionKey = this.opts.encryptionKey ? fromHex(this.opts.encryptionKey) : null

    console.log('[Channel] _open: bootstrapKey:', bootstrapKey ? toHex(bootstrapKey).slice(0, 16) : 'new')

    console.log('[Channel] _open: creating Autobase instance...')
    this.base = new Autobase(this.store, bootstrapKey, {
      valueEncoding: 'json',
      // Encryption is optional. If you want private channels, pass an encryptionKey (and/or set encrypt: true).
      // Keeping this off by default preserves current PearTube behavior where channels are publicly readable.
      encrypt: Boolean(this.opts.encrypt),
      encryptionKey,
      open: (store) => {
        console.log('[Channel] open callback: creating Hyperbee view...')
        const core = store.get({ name: 'peartube-channel-view' })
        const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
        this.view = bee
        console.log('[Channel] open callback: view created')
        return bee
      },
      apply: async (nodes, view, host) => {
        console.log('[Channel] apply callback: processing', nodes.length, 'nodes')
        // Fully deterministic view updates. Side effects allowed only via `host.*` (Autobase system).
        for (const node of nodes) {
          const value = node.value
          if (!value) continue // ack/no-op
          await this._applyOp(value, view, host, node)
        }
        console.log('[Channel] apply callback: done')
      }
    })
    console.log('[Channel] _open: Autobase instance created')

    console.log('[Channel] _open: waiting for base.ready()...')
    const baseReadyStart = Date.now()
    await this.base.ready()
    console.log('[Channel] _open: base.ready() took', Date.now() - baseReadyStart, 'ms')

    console.log('[Channel] _open: waiting for view.ready()...')
    const viewReadyStart = Date.now()
    await this.view.ready()
    console.log('[Channel] _open: view.ready() took', Date.now() - viewReadyStart, 'ms')

    // Force apply any pending operations to the view
    console.log('[Channel] _open: calling base.update() to apply pending ops...')
    const updateStart = Date.now()
    await this.base.update()
    console.log('[Channel] _open: base.update() took', Date.now() - updateStart, 'ms')

    console.log('[Channel] _open complete: key:', this.keyHex?.slice(0, 16), 'writable:', this.writable, 'local length:', this.base.local?.length, 'view length:', this.view?.core?.length)
  }

  async _close() {
    // Remove connection handler to prevent memory leaks
    if (this._connectionHandler && this.swarm) {
      this.swarm.off('connection', this._connectionHandler)
      this._connectionHandler = null
    }

    // Close pairing resources
    if (this.pairingMember) {
      try { await this.pairingMember.close() } catch {}
      this.pairingMember = null
    }
    if (this.pairing) {
      try { await this.pairing.close() } catch {}
      this.pairing = null
    }

    for (const d of this.blobDrives.values()) {
      try { await d.close() } catch {}
    }
    this.blobDrives.clear()
    if (this.view) await this.view.close()
    if (this.base) await this.base.close()
  }

  async _applyOp(op, view, host, node) {
    switch (op.type) {
      case 'update-channel': {
        const key = prefixedKey('channel-meta', op.key || 'meta')
        await view.put(key, {
          key: op.key || 'meta',
          name: op.name,
          description: op.description || '',
          avatar: op.avatar || null,
          updatedAt: op.updatedAt || Date.now(),
          updatedBy: op.updatedBy || null,
          createdAt: op.createdAt || op.updatedAt || Date.now(),
          createdBy: op.createdBy || op.updatedBy || null
        })
        return
      }

      case 'add-video': {
        const key = prefixedKey('videos', op.id)
        const { type, ...rest } = op
        console.log('[Channel] _applyOp add-video:', op.id, 'blobDriveKey:', op.blobDriveKey?.slice(0, 16), 'key:', key)
        await view.put(key, rest)
        return
      }

      case 'update-video': {
        const key = prefixedKey('videos', op.id)
        const { type, ...rest } = op
        const existing = await view.get(key).catch(() => null)
        const prev = existing?.value || {}
        await view.put(key, { ...prev, ...rest })
        return
      }

      case 'delete-video': {
        const key = prefixedKey('videos', op.id)
        await view.del(key)
        return
      }

      case 'add-writer': {
        const keyHex = op.keyHex
        if (typeof keyHex === 'string' && host?.internal) {
          // Membership change must go through Autobase system (deterministic, replicated).
          await host.addWriter(fromHex(keyHex), { indexer: true })
        }
        await view.put(prefixedKey('writers', keyHex), {
          keyHex,
          role: op.role || 'device',
          deviceName: op.deviceName || '',
          addedAt: op.addedAt || Date.now(),
          blobDriveKey: op.blobDriveKey || null
        })
        return
      }

      case 'upsert-writer': {
        const keyHex = op.keyHex
        const existing = await view.get(prefixedKey('writers', keyHex)).catch(() => null)
        const prev = existing?.value || null
        await view.put(prefixedKey('writers', keyHex), {
          keyHex,
          role: op.role || prev?.role || 'device',
          deviceName: op.deviceName ?? prev?.deviceName ?? '',
          addedAt: prev?.addedAt || op.addedAt || Date.now(),
          blobDriveKey: op.blobDriveKey ?? prev?.blobDriveKey ?? null
        })
        return
      }

      case 'remove-writer': {
        const keyHex = op.keyHex
        if (typeof keyHex === 'string' && host?.internal) {
          await host.removeWriter(fromHex(keyHex))
        }
        await view.del(prefixedKey('writers', keyHex))
        return
      }

      case 'add-invite': {
        const idHex = op.idHex
        await view.put(prefixedKey('invites', idHex), {
          idHex,
          inviteZ32: op.inviteZ32,
          publicKeyHex: op.publicKeyHex,
          expires: op.expires || 0,
          createdAt: op.createdAt || Date.now()
        })
        // Single active invite pointer (deterministic, derived from log)
        await view.put('invites/current', { idHex })
        return
      }

      case 'delete-invite': {
        const idHex = op.idHex
        await view.del(prefixedKey('invites', idHex))
        const cur = await view.get('invites/current').catch(() => null)
        if (cur?.value?.idHex === idHex) {
          await view.del('invites/current')
        }
        return
      }

      default: {
        // Unknown op: ignore to keep forward-compat. Older peers just skip new ops.
        return
      }
    }
  }

  // ----------------------------
  // Metadata API
  // ----------------------------

  async getMetadata() {
    const res = await this.view.get('channel-meta/meta').catch(() => null)
    return res?.value || null
  }

  async updateMetadata({ name, description = '', avatar = null }) {
    await this.base.append({
      type: 'update-channel',
      key: 'meta',
      name,
      description,
      avatar,
      updatedAt: Date.now(),
      updatedBy: this.localWriterKeyHex
    })
  }

  // ----------------------------
  // Writer / device
  // ----------------------------

  async listWriters() {
    const out = []
    for await (const { value } of this.view.createReadStream({ gt: 'writers/', lt: 'writers/\xff' })) {
      out.push(value)
    }
    return out
  }

  async ensureLocalBlobDrive({ deviceName = '' } = {}) {
    if (!this.localWriterKeyHex) throw new Error('Channel not ready')

    // Try to load existing writer record
    const existing = await this.view.get(prefixedKey('writers', this.localWriterKeyHex)).catch(() => null)
    const prev = existing?.value || null

    if (prev?.blobDriveKey) {
      await this._loadBlobDrive(prev.blobDriveKey)
      return prev.blobDriveKey
    }

    // Create a new per-device blob drive
    const drive = new Hyperdrive(this.store)
    await drive.ready()
    const driveKeyHex = b4a.toString(drive.key, 'hex')
    this.blobDrives.set(driveKeyHex, drive)

    // Persist writer record (does not affect membership, only metadata)
    await this.base.append({
      type: 'upsert-writer',
      keyHex: this.localWriterKeyHex,
      deviceName,
      blobDriveKey: driveKeyHex
    })

    return driveKeyHex
  }

  async addWriter({ keyHex, role = 'device', deviceName = '' }) {
    await this.base.append({
      type: 'add-writer',
      keyHex,
      role,
      deviceName,
      addedAt: Date.now()
    })
  }

  async removeWriter({ keyHex }) {
    await this.base.append({ type: 'remove-writer', keyHex })
  }

  // ----------------------------
  // Video operations
  // ----------------------------

  async listVideos() {
    // Ensure the view catches up to any newly replicated Autobase nodes.
    // (Some devices won't call base.update() elsewhere.)
    try {
      await Promise.race([
        this.base.update(),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ])
    } catch {}

    const out = []
    for await (const { value } of this.view.createReadStream({ gt: 'videos/', lt: 'videos/\xff' })) {
      out.push(value)
    }

    // Proactively join blob drives referenced by the latest metadata (helps replication + playback)
    if (this.swarm) {
      const seen = new Set()
      for (const v of out) {
        const dk = v?.blobDriveKey || v?.blobDrive || null
        if (dk && !seen.has(dk)) {
          seen.add(dk)
          this.joinBlobDrive(dk).catch(() => {})
        }
      }
    }

    // Sort newest first, consistent with existing UI expectations
    out.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
    return out
  }

  async getVideo(id) {
    const key = prefixedKey('videos', id)
    console.log('[Channel] getVideo:', id, 'key:', key)
    const res = await this.view.get(key).catch((err) => {
      console.error('[Channel] getVideo error:', err?.message)
      return null
    })
    console.log('[Channel] getVideo result:', res?.value?.id, 'blobDriveKey:', res?.value?.blobDriveKey?.slice(0, 16))
    return res?.value || null
  }

  async addVideo(meta) {
    const id = meta.id
    if (!id) throw new Error('Video id required')
    console.log('[Channel] addVideo:', id, 'blobDriveKey:', meta.blobDriveKey?.slice(0, 16))
    await this.base.append({
      type: 'add-video',
      ...meta,
      uploadedAt: meta.uploadedAt || Date.now(),
      uploadedBy: meta.uploadedBy || this.localWriterKeyHex
    })
    // Wait for the view to be updated with our new entry
    await this.base.update()
    console.log('[Channel] addVideo appended and view updated')
  }

  async deleteVideo(id) {
    // Blob deletion is best-effort; the blob store may belong to another device.
    const v = await this.getVideo(id)
    await this.base.append({ type: 'delete-video', id })
    if (v?.blobDriveKey && v?.path) {
      const d = await this._loadBlobDrive(v.blobDriveKey).catch(() => null)
      if (d) {
        try { await d.del(v.path) } catch {}
      }
    }
  }

  // ----------------------------
  // Blob resolution
  // ----------------------------

  async _loadBlobDrive(driveKeyHex) {
    if (this.blobDrives.has(driveKeyHex)) return this.blobDrives.get(driveKeyHex)
    const d = new Hyperdrive(this.store, fromHex(driveKeyHex))
    await d.ready()
    this.blobDrives.set(driveKeyHex, d)
    return d
  }

  async getBlobDrive(driveKeyHex) {
    return this._loadBlobDrive(driveKeyHex)
  }

  async getBlobEntry({ blobDriveKey, path }) {
    const drive = await this._loadBlobDrive(blobDriveKey)
    const entry = await drive.entry(path)
    if (!entry || !entry.value?.blob) return null
    const blobs = await drive.getBlobs()
    if (!blobs) return null
    return { entry, blobsKey: blobs.core.key }
  }

  // ----------------------------
  // Pairing / invites
  // ----------------------------

  async createInvite({ expires = 0 } = {}) {
    // Ensure we're listening for pairing requests on the owner device.
    if (this.swarm) {
      this.setupPairing(this.swarm).catch(() => {})
    }

    // One active invite at a time for v1.
    const existing = await this.view.get('invites/current').catch(() => null)
    if (existing?.value?.idHex) {
      const inv = await this.view.get(prefixedKey('invites', existing.value.idHex)).catch(() => null)
      if (inv?.value?.inviteZ32) return inv.value.inviteZ32
    }

    const inv = BlindPairing.createInvite(this.key, { expires })
    const inviteZ32 = z32.encode(inv.invite)

    await this.base.append({
      type: 'add-invite',
      idHex: b4a.toString(inv.id, 'hex'),
      inviteZ32,
      publicKeyHex: b4a.toString(inv.publicKey, 'hex'),
      expires,
      createdAt: Date.now()
    })
    return inviteZ32
  }

  async clearInvite() {
    // best effort: delete all invites
    for await (const { key, value } of this.view.createReadStream({ gt: 'invites/', lt: 'invites/\xff' })) {
      if (!key.startsWith('invites/')) continue
      const idHex = value?.idHex
      if (idHex) await this.base.append({ type: 'delete-invite', idHex })
    }
  }

  // ----------------------------
  // Replication & Pairing
  // ----------------------------

  /**
   * Set up BlindPairing member to handle incoming device pairing requests.
   * Should be called after channel is ready and swarm is available.
   *
   * @param {import('hyperswarm')} swarm
   */
  async setupPairing(swarm) {
    if (!swarm) return

    // Prevent duplicate setup
    if (this._pairingSetupDone) {
      console.log('[Channel] Pairing already set up, skipping')
      return
    }
    this._pairingSetupDone = true
    this.swarm = swarm

    // ALWAYS join the channel's discovery topic for replication
    // This is critical - even non-writable/paired devices need to find peers to sync data
    if (this.discoveryKey) {
      console.log('[Channel] Joining swarm for discovery key:', this.discoveryKey.toString('hex').slice(0, 16))
      const discovery = swarm.join(this.discoveryKey)
      // IMPORTANT: Do not await flushed() here.
      // On some runtimes (notably mobile/Bare), flushed() can take a long time and would prevent
      // us from wiring replication handlers (base.replicate) early, which makes the channel
      // appear "stuck" and never updating.
      discovery
        .flushed()
        .then(() => {
          console.log('[Channel] Swarm join flushed for discovery key:', this.discoveryKey.toString('hex').slice(0, 16))
        })
        .catch((err) => {
          console.log('[Channel] Swarm join flush warning:', err?.message)
        })
    }

    // CRITICAL: Wire up Autobase replication on peer connections
    // Unlike Hyperdrive, Autobase requires explicit base.replicate(conn) calls
    // Without this, data never syncs between peers!
    this._connectionHandler = (conn) => {
      console.log('[Channel] Peer connected, replicating Autobase for:', this.keyHex?.slice(0, 16))
      if (this.base) {
        this.base.replicate(conn)
      }
    }
    swarm.on('connection', this._connectionHandler)

    // Also replicate on any existing connections (e.g., established during pairing)
    // This is critical for newly paired devices that already have a connection
    if (swarm.connections && swarm.connections.size > 0) {
      console.log('[Channel] Replicating Autobase on', swarm.connections.size, 'existing connections for:', this.keyHex?.slice(0, 16))
      for (const conn of swarm.connections) {
        try {
          this.base.replicate(conn)
        } catch (err) {
          console.log('[Channel] Error replicating on existing connection:', err?.message)
        }
      }
    }

    // Only writable peers should accept pairing requests (owner devices).
    // But we've already joined the swarm above for replication.
    if (!this.writable) {
      console.log('[Channel] Not writable, skipping pairing member setup')
      return
    }

    // Set up BlindPairing to accept incoming pairing requests
    this.pairing = new BlindPairing(swarm)

    this.pairingMember = this.pairing.addMember({
      discoveryKey: this.discoveryKey,
      onadd: async (req) => {
        try {
          // Get current invite
          const currentInv = await this.view.get('invites/current').catch(() => null)
          if (!currentInv?.value?.idHex) {
            console.log('[Channel] No active invite, ignoring pairing request')
            return
          }

          const inv = await this.view.get(prefixedKey('invites', currentInv.value.idHex)).catch(() => null)
          if (!inv?.value) {
            console.log('[Channel] Invite not found')
            return
          }

          // Verify the invite ID matches
          const candidateIdHex = b4a.toString(req.inviteId, 'hex')
          if (candidateIdHex !== inv.value.idHex) {
            console.log('[Channel] Invite ID mismatch')
            return
          }

          console.log('[Channel] Valid pairing request, adding writer...')

          // Open the request with the invite's public key
          const publicKeyBuf = fromHex(inv.value.publicKeyHex)
          const userData = req.open(publicKeyBuf)

          // Add the candidate's key as a writer
          const newWriterKeyHex = b4a.toString(userData, 'hex')

          await this.addWriter({
            keyHex: newWriterKeyHex,
            role: 'device',
            deviceName: ''
          })

          // Ensure the membership change is applied promptly so the new device becomes writable
          await this.base.update()

          // Confirm the pairing - send channel key and encryption key
          req.confirm({
            key: this.key,
            encryptionKey: this.encryptionKey
          })

          // Clear the used invite
          await this.base.append({ type: 'delete-invite', idHex: inv.value.idHex })

          console.log('[Channel] Writer added and pairing confirmed:', newWriterKeyHex.slice(0, 16))
        } catch (err) {
          console.error('[Channel] Pairing error:', err)
        }
      }
    })

    console.log('[Channel] Pairing member set up for channel:', this.keyHex?.slice(0, 16))
  }

  /**
   * Join the swarm for a specific blob drive (to fetch blobs from other devices).
   *
   * @param {string} driveKeyHex
   */
  async joinBlobDrive(driveKeyHex) {
    if (!this.swarm) return

    const drive = await this._loadBlobDrive(driveKeyHex)
    if (drive.discoveryKey) {
      this.swarm.join(drive.discoveryKey)
      console.log('[Channel] Joined swarm for blob drive:', driveKeyHex.slice(0, 16))
    }
  }

  // ----------------------------
  // Sync helpers
  // ----------------------------

  /**
   * Wait for at least one peer connection on the channel's discovery key.
   * This ensures DHT discovery has completed before waiting for data.
   *
   * @param {number} timeoutMs - Maximum time to wait (default 30s)
   * @returns {Promise<boolean>} - true if connected, false if timeout
   */
  async waitForPeerConnection(timeoutMs = 30000) {
    if (!this.swarm) {
      console.log('[Channel] waitForPeerConnection: no swarm available')
      return false
    }

    // Ensure we're announced on the swarm
    if (this.discoveryKey) {
      try {
        const discovery = this.swarm.join(this.discoveryKey)
        await discovery.flushed()
        console.log('[Channel] waitForPeerConnection: discovery flushed')
      } catch (err) {
        console.log('[Channel] waitForPeerConnection: discovery flush error:', err?.message)
      }
    }

    const start = Date.now()

    // Check if we already have connections
    if (this.swarm?.connections?.size > 0) {
      console.log('[Channel] waitForPeerConnection: already have', this.swarm.connections.size, 'connections')
      return true
    }

    // Poll for connections
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const connCount = this.swarm?.connections?.size || 0
        if (connCount > 0) {
          console.log('[Channel] waitForPeerConnection: found', connCount, 'connections after', Date.now() - start, 'ms')
          clearInterval(checkInterval)
          resolve(true)
        } else if (Date.now() - start > timeoutMs) {
          console.log('[Channel] waitForPeerConnection: timeout after', timeoutMs, 'ms')
          clearInterval(checkInterval)
          resolve(false)
        }
      }, 500)
    })
  }

  /**
   * Wait for initial data sync from peers with progress callbacks.
   * This is the main method to call after pairing to ensure data is synced.
   *
   * @param {Object} opts
   * @param {number} opts.peerTimeout - Time to wait for peer connection (default 30s)
   * @param {number} opts.dataTimeout - Time to wait for data after connected (default 20s)
   * @param {(state: string, detail?: object) => void} opts.onProgress - Progress callback
   * @returns {Promise<{success: boolean, videoCount: number, state: string}>}
   */
  async waitForInitialSync(opts = {}) {
    const {
      peerTimeout = 30000,
      dataTimeout = 20000,
      onProgress = () => {}
    } = opts

    console.log('[Channel] waitForInitialSync: starting (peerTimeout:', peerTimeout, 'dataTimeout:', dataTimeout, ')')

    // Step 1: Wait for peer connection
    onProgress('connecting', { message: 'Looking for peers...' })
    const peerConnected = await this.waitForPeerConnection(peerTimeout)

    if (!peerConnected) {
      console.log('[Channel] waitForInitialSync: no peers found')
      onProgress('offline', { message: 'No peers found. Original device may be offline.' })
      return { success: false, videoCount: 0, state: 'offline' }
    }

    // Step 2: Wait for data to arrive
    onProgress('syncing', { message: 'Connected! Syncing data...', peerCount: this.swarm?.connections?.size || 0 })

    const start = Date.now()
    let lastViewLength = this.view?.core?.length || 0

    while (Date.now() - start < dataTimeout) {
      // Try to pull data from peers - use longer timeout (10s) to allow replication to complete
      try {
        await Promise.race([
          this.base.update({ wait: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('update timeout')), 10000))
        ])
      } catch (err) {
        // Timeout on individual update is ok, we'll check progress anyway
      }

      const currentLength = this.view?.core?.length || 0
      const videos = await this.listVideos()

      console.log('[Channel] waitForInitialSync: poll - viewLength:', currentLength, 'videos:', videos.length)

      if (videos.length > 0) {
        console.log('[Channel] waitForInitialSync: synced with', videos.length, 'videos')
        onProgress('synced', { videoCount: videos.length })
        return { success: true, videoCount: videos.length, state: 'synced' }
      }

      // Check if view is growing (data arriving)
      if (currentLength > lastViewLength) {
        lastViewLength = currentLength
        onProgress('syncing', {
          message: 'Receiving data...',
          peerCount: this.swarm?.connections?.size || 0
        })
      }

      // Wait longer between polls to give replication more time
      await new Promise(r => setTimeout(r, 2000))
    }

    // Timeout reached - check final state
    const videos = await this.listVideos()
    if (videos.length > 0) {
      console.log('[Channel] waitForInitialSync: timeout but found', videos.length, 'videos')
      onProgress('synced', { videoCount: videos.length })
      return { success: true, videoCount: videos.length, state: 'synced' }
    }

    console.log('[Channel] waitForInitialSync: timeout with no videos')
    onProgress('failed', { message: 'Sync timeout - no videos received yet' })
    return { success: false, videoCount: 0, state: 'failed' }
  }
}


