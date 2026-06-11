/**
 * Identity Management Module
 *
 * Handles identity creation, recovery, and management for PearTube.
 * Identities are linked to multi-writer channels for content publishing.
 */

import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import { createChannel, deriveDeterministicChannelSeed, loadChannel } from './storage.js'
import { logger } from './logger.js'
import {
  generateMnemonic as generatePearTubeMnemonic,
  validateMnemonic as validatePearTubeMnemonic,
  deriveIdentity
} from './peartube-identity.js'
import {
  createChannelRootDescriptor,
  signChannelRootDescriptor,
  verifySignedChannelRootDescriptor
} from './channel-descriptor.js'

// Lazy load IdentityKey to support both Node.js and Bare runtime
let IdentityKey = null
async function getIdentityKey () {
  if (!IdentityKey) {
    IdentityKey = (await import('keet-identity-key')).default || (await import('keet-identity-key'))
  }
  return IdentityKey
}

const log = logger('Identity')

function isEmbeddedBareKitRuntime() {
  return globalThis?.process?.env?.PEARTUBE_NATIVE_EMBEDDED_BAREKIT === '1'
}

/**
 * @typedef {import('./types.js').StorageContext} StorageContext
 * @typedef {import('./types.js').Identity} Identity
 */

/**
 * Generate a proper BIP39 mnemonic phrase
 * Uses the standard 2048-word English word list with checksum validation.
 *
 * @param {number} [wordCount=12] - Number of words (12 only)
 * @returns {string} Space-separated mnemonic phrase
 */
export function generateMnemonic(wordCount = 12) {
  if (wordCount !== 12) {
    throw new Error('PearTube mnemonic generation supports 12 words only')
  }
  return generatePearTubeMnemonic()
}

/**
 * Validate a mnemonic phrase
 * @param {string} mnemonic - Space-separated mnemonic phrase
 * @returns {boolean} True if valid BIP39 mnemonic
 */
export function validateMnemonic(mnemonic) {
  return validatePearTubeMnemonic(mnemonic)
}

/**
 * Create the identity manager
 *
 * @param {Object} deps
 * @param {StorageContext} deps.ctx - Storage context
 * @returns {Object} Identity manager API
 */
export function createIdentityManager({ ctx }) {
  /** @type {Identity[]} */
  let identities = [];

  /** @type {string|null} */
  let activeIdentity = null;

  return {
    /**
     * Load identities from database
     * @returns {Promise<void>}
     */
    async loadIdentities() {
      const stored = await ctx.metaDb.get('identities');
      if (stored && stored.value) {
        identities = stored.value;
        log.info(` Loaded ${identities.length} identities`);
      }

      // Load active identity
      const storedActive = await ctx.metaDb.get('activeIdentity');
      if (storedActive && storedActive.value) {
        activeIdentity = storedActive.value;
      }

      // Normalize identities - drop malformed, mark active, STRIP SECRET KEYS
      identities = (identities || [])
        .filter(i => i && typeof i.publicKey === 'string' && i.publicKey)
        .map(i => {
          // SECURITY: Remove any persisted secretKey from legacy records
          // This is a one-time migration to improve security posture
          const { secretKey, ...safeIdentity } = i;
          if (secretKey) {
            log.info(' Stripped secretKey from identity:', i.publicKey?.slice(0, 16));
          }
          const channelKey = i.channelKey || i.driveKey || null
          return {
            ...safeIdentity,
            // Backward compat: keep driveKey as the canonical channel key for app compatibility.
            channelKey,
            channelEncryptionKey: i.channelEncryptionKey || null,
            channelWriterKeyName: i.channelWriterKeyName || null,
            driveKey: channelKey,
            isActive: i.publicKey === activeIdentity,
            createdAt: typeof i.createdAt === 'number' && i.createdAt >= 0
              ? i.createdAt : Date.now(),
          };
        });

      // Persist normalized form
      await this.saveIdentities()
    },

    /**
     * Save identities to database
     * @returns {Promise<void>}
     */
    async saveIdentities() {
      await ctx.metaDb.put('identities', identities);
    },

    /**
     * Create a new identity with associated channel
     * @param {string} name - Display name for the identity
     * @param {boolean} [generateMnem=true] - Whether to generate mnemonic
     * @returns {Promise<{success: boolean, publicKey: string, driveKey: string, mnemonic?: string}>}
     */
    async createIdentity(name, generateMnem = true) {
      log.info(' Creating identity:', name);

      // Check if corestore is in a valid state
      if (!ctx.store) {
        throw new Error('Corestore not available');
      }
      if (ctx.store.closed) {
        throw new Error('Corestore is closed - storage may have been terminated');
      }
      log.info(' Corestore state: opened=', ctx.store.opened, 'closed=', ctx.store.closed);

      let keypair;
      let mnemonic;
      let hdDerived = false
      let derivedPublicKey = null

      if (generateMnem) {
        mnemonic = generateMnemonic();
        const { identityKeyPair, identityPublicKey } = await deriveIdentity(mnemonic)
        keypair = identityKeyPair
        derivedPublicKey = identityPublicKey
        hdDerived = true
        log.info(' Generated HD identity keypair:', b4a.toString(identityPublicKey, 'hex').slice(0, 16));
      } else {
        keypair = crypto.keyPair();
      }

      const publicKey = b4a.toString(derivedPublicKey || keypair.publicKey, 'hex');
      log.info(' Generated keypair:', publicKey.slice(0, 16));

      // Create the channel's multi-writer HyperDB store
      const writerKeyName = `peartube-channel-writer:${publicKey}`
      log.info(' Creating channel for identity writer:', writerKeyName.slice(0, 32))
      const { channel, channelKeyHex, encryptionKeyHex } = await createChannel(ctx, {
        encrypt: false,
        writerKeyName
      })
      const createdAt = Date.now()
      log.info(' Channel created:', channelKeyHex.slice(0, 16))
      if (isEmbeddedBareKitRuntime()) {
        try {
          if (channel.publicBee?.writable) {
            await channel.publicBee.setMetadata({
              name,
              description: '',
              avatar: null,
              createdAt,
              createdBy: publicKey
            })
          }
        } catch (err) {
          log.warn(' Embedded identity metadata publish skipped:', err?.message)
        }
      } else {
        log.info(' Updating channel metadata for identity')
        await channel.updateMetadata({
          name,
          description: '',
          avatar: null,
          createdAt,
          createdBy: publicKey
        })
        log.info(' Channel metadata updated')
        log.info(' Ensuring local blob drive for identity')
        await channel.ensureLocalBlobDrive({ deviceName: name })
        log.info(' Local blob drive ready')
      }

      if (!channel.blobsKeyHex) {
        await channel.ensureLocalBlobDrive({ deviceName: name })
      }

      let signedDescriptor = null
      try {
        const metadataKey = channel.publicBeeKey || await channel.getPublicBeeKey()
        const mediaKey = channel.blobsKeyHex
        if (metadataKey && mediaKey) {
          const descriptor = createChannelRootDescriptor({
            identityPublicKey: publicKey,
            // Peers verify gossip entries by binding the descriptor to the
            // key the channel is announced under (the multi-writer channel
            // key), not the identity key.
            channelId: channelKeyHex,
            metadataKey,
            mediaKey,
            seq: 1,
            createdAt,
            updatedAt: Date.now(),
            profile: { name }
          })
          const deviceProof = await this.attestDevice(keypair, ctx.swarm.keyPair.publicKey)
          signedDescriptor = await signChannelRootDescriptor({
            descriptor,
            deviceKeyPair: ctx.swarm.keyPair,
            deviceProof
          })
          if (channel.publicBee?.writable) {
            await channel.publicBee.bee.put('channel/root', signedDescriptor)
            await channel.publicBee.setMetadata({
              channelId: descriptor.channelId,
              identityPublicKey: publicKey,
              mediaKey,
              signedDescriptor
            })
          }
        }
      } catch (err) {
        log.warn(' Signed channel root descriptor skipped:', err?.message)
      }

      // Create identity record
      // SECURITY: Do NOT persist secretKey - it can be re-derived from mnemonic if needed.
      // The mnemonic is shown once at creation time and should be backed up by the user.
      // Storing secretKey in plaintext risks key theft if the database is compromised.
      const identity = {
        publicKey,
        // Backward-compat: expose channelKey via driveKey for existing app code.
        driveKey: channelKeyHex,
        channelKey: channelKeyHex,
        channelEncryptionKey: encryptionKeyHex,
        channelWriterKeyName: writerKeyName,
        name,
        createdAt,
        // secretKey removed for security - derive from mnemonic when needed
        isActive: false,
        hdDerived,
        channelId: signedDescriptor?.descriptor?.channelId || publicKey,
        signedDescriptor
      };

      identities.push(identity);
      log.info(' Identity appended to in-memory list')
      await this.saveIdentities();
      log.info(' Identities persisted')
      // Channel is cached in ctx.channels by createChannel()

      // Set as active if first identity
      if (identities.length === 1) {
        activeIdentity = publicKey;
        log.info(' Setting active identity')
        await ctx.metaDb.put('activeIdentity', publicKey);
        log.info(' Active identity persisted')
        identity.isActive = true;
      }

      log.info(' Created:', publicKey.slice(0, 16));
      log.info(' Channel key:', channelKeyHex.slice(0, 16));

      return {
        success: true,
        publicKey,
        driveKey: channelKeyHex,
        channelId: signedDescriptor?.descriptor?.channelId || publicKey,
        signedDescriptor,
        mnemonic
      };
    },

    /**
     * Create a local identity entry that points at an existing (paired) multi-writer channel.
     * This is used for onboarding when a device joins via invite code.
     *
     * @param {string} channelKeyHex
     * @param {string} [name]
     * @returns {Promise<Identity>}
     */
    async addPairedChannelIdentity(channelKeyHex, name = 'Paired Channel') {
      if (!channelKeyHex || typeof channelKeyHex !== 'string') {
        throw new Error('channelKeyHex is required')
      }

      // Ensure we have the channel cached/loaded (best-effort)
      try {
        await loadChannel(ctx, channelKeyHex)
      } catch (err) {
        log.debug(' Paired channel preload skipped:', err?.message)
      }

      const keypair = crypto.keyPair()
      const publicKey = b4a.toString(keypair.publicKey, 'hex')

      // SECURITY: Do NOT persist secretKey - paired identities don't need local signing
      // since they operate through the channel's multi-writer system.
      const identity = {
        publicKey,
        driveKey: channelKeyHex, // app compat: driveKey used as channel key throughout the UI
        channelKey: channelKeyHex,
        channelEncryptionKey: null,
        channelWriterKeyName: null,
        name,
        createdAt: Date.now(),
        // secretKey removed for security
        isActive: true,
        paired: true,
      }

      // Mark all others inactive
      identities = (identities || []).map(i => ({ ...i, isActive: false }))
      identities.push(identity)
      activeIdentity = publicKey
      await ctx.metaDb.put('activeIdentity', publicKey)
      await this.saveIdentities()

      return identity
    },

    /**
     * Recover identity from mnemonic phrase
     * @param {string} mnemonic - Mnemonic phrase
     * @param {string} [name] - Optional display name
     * @returns {Promise<{success: boolean, publicKey: string, driveKey: string, message?: string}>}
     */
    async recoverIdentity(mnemonic, name) {
      log.info(' Recovering from mnemonic');

      const { identityPublicKey } = await deriveIdentity(mnemonic)
      const publicKey = b4a.toString(identityPublicKey, 'hex');

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

      const writerKeyName = `peartube-channel-writer:${publicKey}`
      const { channelKeyHex, encryptionKeyHex } = await deriveDeterministicChannelSeed(ctx.store, {
        writerKeyName,
        encrypt: false
      })
      if (!channelKeyHex) {
        throw new Error('Failed to derive deterministic channel key for recovery')
      }

      await loadChannel(ctx, channelKeyHex, {
        writerKeyName,
        encryptionKeyHex,
        preferWritable: true
      })

      // SECURITY: Do NOT persist secretKey - it can be re-derived from mnemonic.
      // The user has proven they have the mnemonic by successfully recovering.
      const identity = {
        publicKey,
        driveKey: channelKeyHex,
        channelKey: channelKeyHex,
        channelEncryptionKey: encryptionKeyHex,
        channelWriterKeyName: writerKeyName,
        name: name || `Recovered ${Date.now()}`,
        createdAt: Date.now(),
        // secretKey removed for security - derive from mnemonic when needed
        recovered: true,
        isActive: false
      };

      identities.push(identity);
      await this.saveIdentities();

      return {
        success: true,
        publicKey,
        driveKey: channelKeyHex
      };
    },

    async bootstrapDevice(mnemonic) {
      if (!activeIdentity) {
        throw new Error('No active identity')
      }
      if (!ctx?.swarm?.keyPair?.publicKey) {
        throw new Error('Device swarm public key is unavailable')
      }

      const IK = await getIdentityKey()
      const proof = await IK.bootstrap({ mnemonic }, ctx.swarm.keyPair.publicKey)
      const verified = IK.verify(proof, null)
      if (!verified) {
        throw new Error('Generated attestation proof failed verification')
      }

      identities = identities.map(identity =>
        identity.publicKey === activeIdentity
          ? { ...identity, attestationProof: b4a.toString(proof, 'hex') }
          : identity
      )
      await this.saveIdentities()

      return {
        proof,
        identityPublicKey: b4a.toString(verified.identityPublicKey, 'hex')
      }
    },

    async attestDevice(identityKeyPair, devicePublicKey, existingProofBuffer = null) {
      const IK = await getIdentityKey()
      const normalizedDeviceKey = Buffer.isBuffer(devicePublicKey)
        ? devicePublicKey
        : b4a.from(devicePublicKey, 'hex')
      return IK.attestDevice(normalizedDeviceKey, identityKeyPair, existingProofBuffer)
    },

    async verifyAttestation(proofBuffer) {
      const IK = await getIdentityKey()
      const result = IK.verify(proofBuffer, null)
      if (!result) return { valid: false }

      return {
        valid: true,
        identityPublicKey: b4a.toString(result.identityPublicKey, 'hex'),
        devicePublicKey: b4a.toString(result.devicePublicKey, 'hex')
      }
    },

    getDeviceProof() {
      if (!activeIdentity) return null
      const identity = identities.find(i => i.publicKey === activeIdentity)
      if (!identity?.attestationProof) return null
      return b4a.from(identity.attestationProof, 'hex')
    },

    /**
     * Get list of all identities
     * @returns {Identity[]}
     */
    getIdentities() {
      return identities
        .filter(i => typeof i.publicKey === 'string' && i.publicKey &&
                     typeof i.driveKey === 'string' && i.driveKey)
        .map(i => ({
          publicKey: i.publicKey || '',
          driveKey: i.driveKey || '',
          name: i.name || 'Channel',
          createdAt: typeof i.createdAt === 'number' && i.createdAt >= 0
            ? i.createdAt : Date.now(),
          isActive: i.publicKey === activeIdentity
        }));
    },

    /**
     * Get the currently active identity
     * @returns {Identity|null}
     */
    getActiveIdentity() {
      const all = this.getIdentities();
      return all.find(i => i.isActive) || null;
    },

    /**
     * Get the active identity's public key
     * @returns {string|null}
     */
    getActivePublicKey() {
      return activeIdentity;
    },

    /**
     * Set the active identity
     * @param {string} publicKey - Public key of identity to activate
     * @returns {Promise<void>}
     */
    async setActiveIdentity(publicKey) {
      const identity = identities.find(i => i.publicKey === publicKey);
      if (!identity) {
        throw new Error('Identity not found');
      }

      activeIdentity = publicKey;
      await ctx.metaDb.put('activeIdentity', publicKey);

      // Update isActive flags
      identities = identities.map(i => ({
        ...i,
        isActive: i.publicKey === publicKey
      }));

      await this.saveIdentities();
      log.info(' Active identity set to:', publicKey.slice(0, 16));
    },

    /**
     * Load existing channel drives for all identities
     * @returns {Promise<void>}
     */
    async loadChannelDrives() {
      for (const identity of identities) {
        if (identity.channelKey) {
          try {
            await loadChannel(ctx, identity.channelKey, {
              encryptionKeyHex: identity.channelEncryptionKey || null,
              writerKeyName: identity.channelWriterKeyName || null
            })
          } catch (err) {
            log.error(' Failed to load channel:', identity.channelKey?.slice(0, 16), err.message)
          }
        }
      }
    },

    /**
     * Get active multi-writer channel (HyperDB)
     * @returns {Promise<any|null>}
     */
    async getActiveChannel() {
      const active = this.getActiveIdentity()
      if (!active) return null
      const full = identities.find(i => i.publicKey === active.publicKey)
      const channelKey = full?.channelKey || active.driveKey
      if (!channelKey) return null

      try {
        return await loadChannel(ctx, channelKey, {
          encryptionKeyHex: full?.channelEncryptionKey || null,
          writerKeyName: full?.channelWriterKeyName || null,
          preferWritable: true
        })
      } catch (err) {
        if (!full?.channelWriterKeyName) throw err

        log.error(' Active channel load with writer key failed, retrying without writer key:', err?.message)

        const fallback = await loadChannel(ctx, channelKey, {
          encryptionKeyHex: full?.channelEncryptionKey || null,
          writerKeyName: null,
          preferWritable: true
        })

        identities = identities.map(i =>
          i.publicKey === full.publicKey
            ? { ...i, channelWriterKeyName: null }
            : i
        )
        await this.saveIdentities()

        return fallback
      }
    },

    /**
     * Backfill signed channel root descriptors for locally owned channels.
     *
     * Channels created before descriptor signing existed (or before the
     * descriptor was bound to the channel key) have no usable
     * `channel/root` record, so strict peers reject their gossip entries
     * with missing-signed-descriptor / descriptor-channel-mismatch.
     * Re-signing only needs the device (swarm) keypair plus a persisted
     * attestation proof — never the identity secret key. Channels without
     * a stored proof are skipped and reported.
     *
     * @returns {Promise<{checked: number, signed: number, ok: number, missingProof: number, skipped: number, failed: number}>}
     */
    async ensureSignedChannelDescriptors() {
      const summary = { checked: 0, signed: 0, ok: 0, missingProof: 0, skipped: 0, failed: 0 }
      if (!ctx?.swarm?.keyPair?.publicKey || !ctx?.swarm?.keyPair?.secretKey) {
        log.warn(' Descriptor backfill skipped: device swarm keypair unavailable')
        return summary
      }

      let identitiesChanged = false
      for (const identity of identities) {
        const channelKey = identity?.channelKey || identity?.driveKey
        if (!channelKey) continue
        summary.checked++

        try {
          const channel = await loadChannel(ctx, channelKey, {
            encryptionKeyHex: identity.channelEncryptionKey || null,
            writerKeyName: identity.channelWriterKeyName || null,
            preferWritable: true
          })
          if (!channel?.publicBee?.writable) {
            summary.skipped++
            continue
          }

          const metadataKey = channel.publicBeeKey || await channel.getPublicBeeKey()
          const mediaKey = channel.blobsKeyHex
          if (!metadataKey || !mediaKey) {
            summary.skipped++
            continue
          }

          const existing = await channel.publicBee.bee.get('channel/root').catch(() => null)
          const existingSigned = existing?.value || null
          if (existingSigned) {
            const verified = await verifySignedChannelRootDescriptor(existingSigned)
            if (
              verified?.valid &&
              verified.descriptor?.channelId === channelKey.toLowerCase() &&
              verified.descriptor?.metadataKey === metadataKey.toLowerCase()
            ) {
              summary.ok++
              continue
            }
          }

          const proofHex = identity.attestationProof || identity.signedDescriptor?.proof || null
          if (!proofHex) {
            summary.missingProof++
            log.warn(' Descriptor backfill: no attestation proof for channel', channelKey.slice(0, 16), '- recover with mnemonic to re-sign')
            continue
          }

          const previousSeq = Number(
            existingSigned?.descriptor?.seq ?? identity.signedDescriptor?.descriptor?.seq ?? 0
          ) || 0
          const descriptor = createChannelRootDescriptor({
            identityPublicKey: identity.publicKey,
            channelId: channelKey,
            metadataKey,
            mediaKey,
            seq: previousSeq + 1,
            createdAt: identity.createdAt || Date.now(),
            updatedAt: Date.now(),
            profile: { name: identity.name || 'Channel' }
          })
          const signed = await signChannelRootDescriptor({
            descriptor,
            deviceKeyPair: ctx.swarm.keyPair,
            deviceProof: proofHex
          })

          // Never write a descriptor peers would reject.
          const check = await verifySignedChannelRootDescriptor(signed)
          if (!check?.valid) {
            summary.failed++
            log.warn(' Descriptor backfill: self-verification failed for channel', channelKey.slice(0, 16), check?.error || '')
            continue
          }

          await channel.publicBee.bee.put('channel/root', signed)
          try {
            await channel.publicBee.setMetadata({
              channelId: descriptor.channelId,
              identityPublicKey: identity.publicKey,
              mediaKey,
              signedDescriptor: signed
            })
          } catch (err) {
            log.warn(' Descriptor backfill: metadata update skipped:', err?.message)
          }

          identity.signedDescriptor = signed
          identity.channelId = descriptor.channelId
          identitiesChanged = true
          summary.signed++
          log.info(' Descriptor backfill: signed channel root for', channelKey.slice(0, 16))
        } catch (err) {
          summary.failed++
          log.warn(' Descriptor backfill failed for channel', String(channelKey).slice(0, 16), err?.message)
        }
      }

      if (identitiesChanged) {
        try { await this.saveIdentities() } catch (err) {
          log.warn(' Descriptor backfill: persisting identities failed:', err?.message)
        }
      }
      return summary
    }
  };
}
