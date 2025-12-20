import ReadyResource from 'ready-resource'
import Autobase from 'autobase'
import BlindPairing from 'blind-pairing'
import Hyperswarm from 'hyperswarm'
import z32 from 'z32'
import b4a from 'b4a'

import { MultiWriterChannel } from './multi-writer-channel.js'

/**
 * ChannelPairer
 *
 * Joins an existing multi-writer channel on a second device using a short invite code.
 * The invite exchange returns the Autobase bootstrap key + encryption key.
 */
export class ChannelPairer extends ReadyResource {
  /**
   * @param {import('corestore')} store
   * @param {string} inviteCode z32 string
   * @param {Object} [opts]
   * @param {import('hyperswarm')} [opts.swarm]
   * @param {string} [opts.deviceName]
   */
  constructor(store, inviteCode, opts = {}) {
    super()
    this.store = store
    this.inviteCode = inviteCode
    this.opts = opts

    this.swarm = opts.swarm || null
    this.pairing = null
    this.candidate = null
    this.channel = null
    // Track replicated connections for the pairing swarm we manage (if we create one).
    // This is intentionally local to the pairer: replication idempotency for Autobase is per-channel.
    this._replicatedConns = new WeakSet()

    this._resolve = null
    this._reject = null
    this._pendingError = null  // Store error if it occurs before finished() is called

    this.ready().catch(() => {})
  }

  finished() {
    return new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject
      
      // If an error occurred before finished() was called, reject immediately
      if (this._pendingError) {
        const err = this._pendingError
        this._pendingError = null
        reject(err)
      }
    })
  }

  async _open() {
    console.log('[ChannelPairer] _open() starting...')
    await this.store.ready()
    console.log('[ChannelPairer] Store ready')

    if (!this.swarm) {
      console.log('[ChannelPairer] Creating new Hyperswarm')
      this.swarm = new Hyperswarm()
      // Use idempotent replication - check before calling store.replicate()
      this.swarm.on('connection', (conn) => {
        if (this._replicatedConns.has(conn)) {
          console.log('[ChannelPairer] Connection already replicated, skipping')
          return
        }
        this._replicatedConns.add(conn)
        this.store.replicate(conn)
      })
    }

    console.log('[ChannelPairer] Getting local writer key...')
    const localWriterKey = await Autobase.getLocalKey(this.store)
    console.log('[ChannelPairer] Local writer key:', b4a.toString(localWriterKey, 'hex').slice(0, 16))

    console.log('[ChannelPairer] Decoding invite code...')
    let inviteBuf
    try {
      inviteBuf = z32.decode(this.inviteCode)
      console.log('[ChannelPairer] Invite decoded, length:', inviteBuf.length)
    } catch (err) {
      console.error('[ChannelPairer] Failed to decode invite:', err?.message)
      const error = new Error('Invalid invite code')
      // If finished() has been called, reject immediately
      if (this._reject) {
        this._reject(error)
      } else {
        // Otherwise, store the error to reject when finished() is called
        this._pendingError = error
      }
      return
    }

    console.log('[ChannelPairer] Creating BlindPairing...')
    this.pairing = new BlindPairing(this.swarm)

    console.log('[ChannelPairer] Adding candidate...')
    this.candidate = this.pairing.addCandidate(null, {
      invite: inviteBuf,
      userData: localWriterKey,
      onadd: async (result) => {
        console.log('[ChannelPairer] onadd callback received')
        try {
          // result.key and result.encryptionKey are Buffers
          console.log('[ChannelPairer] Creating channel with key:', b4a.toString(result.key, 'hex').slice(0, 16))
          this.channel = new MultiWriterChannel(this.store, {
            key: result.key,
            encryptionKey: result.encryptionKey
          })
          await this.channel.ready()
          console.log('[ChannelPairer] Channel ready')

          // Wait until the original device has added us as a writer.
          console.log('[ChannelPairer] Waiting for writable...')
          await this.channel.base.waitForWritable()
          console.log('[ChannelPairer] Channel is writable')

          // Register our blob drive for uploads
          console.log('[ChannelPairer] Ensuring local blob drive...')
          await this.channel.ensureLocalBlobDrive({ deviceName: this.opts.deviceName || '' })

          // Join the channel's discovery key on the swarm for data sync
          // This is critical - without this, the newly paired device won't find peers
          if (this.swarm && this.channel.discoveryKey) {
            console.log('[ChannelPairer] Joining swarm for channel discovery...')
            this.channel.swarm = this.swarm
            const discovery = this.swarm.join(this.channel.discoveryKey)
            await discovery.flushed().catch(() => {})
            console.log('[ChannelPairer] Swarm join flushed')

            // CRITICAL: Start Autobase replication on existing connections
            // This ensures data syncs immediately after pairing, not just for future connections
            // Use idempotent replication - check before calling base.replicate()
            if (this.swarm.connections && this.swarm.connections.size > 0) {
              console.log('[ChannelPairer] Replicating Autobase on', this.swarm.connections.size, 'existing connections')
              for (const conn of this.swarm.connections) {
                if (this._replicatedConns.has(conn)) {
                  console.log('[ChannelPairer] Connection already replicated, skipping')
                  continue
                }
                this._replicatedConns.add(conn)
                try {
                  this.channel.base.replicate(conn)
                } catch (err) {
                  console.log('[ChannelPairer] Error replicating:', err?.message)
                }
              }
            }
          }

          console.log('[ChannelPairer] Pairing complete')

          if (this._resolve) this._resolve(this.channel)
        } catch (err) {
          console.error('[ChannelPairer] onadd error:', err?.message, err?.stack)
          if (this._reject) this._reject(err)
        } finally {
          this.close().catch(() => {})
        }
      }
    })
    console.log('[ChannelPairer] Candidate added, waiting for pairing...')
  }

  async _close() {
    try {
      if (this.candidate) await this.candidate.close()
    } catch {}
    try {
      if (this.pairing) await this.pairing.close()
    } catch {}
    // If we created our own swarm, we should destroy it; otherwise leave it to owner.
    // Heuristic: if opts.swarm not provided, we created it.
    if (!this.opts.swarm && this.swarm) {
      try { await this.swarm.destroy() } catch {}
    }
    this.candidate = null
    this.pairing = null
    this.swarm = null
  }
}


