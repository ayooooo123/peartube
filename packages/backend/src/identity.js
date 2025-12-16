/**
 * Identity Management Module
 *
 * Handles identity creation, recovery, and management for PearTube.
 * Identities are linked to Hyperdrives for content publishing.
 */

import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import Hyperdrive from 'hyperdrive';
import { createChannel, loadChannel, loadDrive } from './storage.js'

/**
 * @typedef {import('./types.js').StorageContext} StorageContext
 * @typedef {import('./types.js').Identity} Identity
 */

// Simplified BIP39-like word list (real BIP39 has 2048 words)
const WORD_LIST = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract',
  'absurd', 'abuse', 'access', 'accident', 'account', 'accuse', 'achieve', 'acid',
  'acoustic', 'acquire', 'across', 'act', 'action', 'actor', 'actress', 'actual',
  'adapt', 'add', 'addict', 'address', 'adjust', 'admit', 'adult', 'advance',
  'advice', 'aerobic', 'affair', 'afford', 'afraid', 'again', 'age', 'agent',
  'agree', 'ahead', 'aim', 'air', 'airport', 'aisle', 'alarm', 'album',
  'alcohol', 'alert', 'alien', 'all', 'alley', 'allow', 'almost', 'alone',
  'alpha', 'already', 'also', 'alter', 'always', 'amateur', 'amazing', 'among',
  'amount', 'amused', 'analyst', 'anchor', 'ancient', 'anger', 'angle', 'angry',
  'animal', 'ankle', 'announce', 'annual', 'another', 'answer', 'antenna', 'antique',
  'anxiety', 'any', 'apart', 'apology', 'appear', 'apple', 'approve', 'april',
  'arch', 'arctic', 'area', 'arena', 'argue', 'arm', 'armed', 'armor',
  'army', 'around', 'arrange', 'arrest', 'arrive', 'arrow', 'art', 'artefact'
];

/**
 * Generate a BIP39-like mnemonic phrase
 * @param {number} [wordCount=12] - Number of words (12 or 24)
 * @returns {string} Space-separated mnemonic phrase
 */
export function generateMnemonic(wordCount = 12) {
  const words = [];
  for (let i = 0; i < wordCount; i++) {
    const idx = Math.floor(Math.random() * WORD_LIST.length);
    words.push(WORD_LIST[idx]);
  }
  return words.join(' ');
}

/**
 * Derive a keypair from a mnemonic phrase
 * @param {string} mnemonic - Space-separated mnemonic phrase
 * @returns {{publicKey: Buffer, secretKey: Buffer}} Keypair
 */
export function keypairFromMnemonic(mnemonic) {
  // Simple derivation - hash the mnemonic to get seed
  // In production, use proper BIP39 derivation
  const seed = Buffer.from(mnemonic, 'utf-8');
  return crypto.keyPair(seed.slice(0, 32));
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
        console.log(`[Identity] Loaded ${identities.length} identities`);
      }

      // Load active identity
      const storedActive = await ctx.metaDb.get('activeIdentity');
      if (storedActive && storedActive.value) {
        activeIdentity = storedActive.value;
      }

      // Normalize identities - drop malformed, mark active
      identities = (identities || [])
        .filter(i => i && typeof i.publicKey === 'string' && i.publicKey)
        .map(i => ({
          ...i,
          // Backward compat:
          // - legacy identities used `driveKey` for the channel Hyperdrive key
          // - multi-writer identities use `channelKey` (Autobase key)
          channelKey: i.channelKey || null,
          channelEncryptionKey: i.channelEncryptionKey || null,
          legacyDriveKey: i.legacyDriveKey || (i.driveKey && !i.channelKey ? i.driveKey : null),
          // Keep `driveKey` as the canonical "channel key" for app compatibility.
          // Once frontend is fully migrated, this can be removed.
          driveKey: i.channelKey || i.driveKey || null,
          isActive: i.publicKey === activeIdentity,
          createdAt: typeof i.createdAt === 'number' && i.createdAt >= 0
            ? i.createdAt : Date.now(),
        }));

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
     * Create a new identity with associated Hyperdrive
     * @param {string} name - Display name for the identity
     * @param {boolean} [generateMnem=true] - Whether to generate mnemonic
     * @returns {Promise<{success: boolean, publicKey: string, driveKey: string, mnemonic?: string}>}
     */
    async createIdentity(name, generateMnem = true) {
      console.log('[Identity] Creating identity:', name);

      // Check if corestore is in a valid state
      if (!ctx.store) {
        throw new Error('Corestore not available');
      }
      if (ctx.store.closed) {
        throw new Error('Corestore is closed - storage may have been terminated');
      }
      console.log('[Identity] Corestore state: opened=', ctx.store.opened, 'closed=', ctx.store.closed);

      let keypair;
      let mnemonic;

      if (generateMnem) {
        mnemonic = generateMnemonic();
        keypair = keypairFromMnemonic(mnemonic);
      } else {
        keypair = crypto.keyPair();
      }

      const publicKey = b4a.toString(keypair.publicKey, 'hex');
      console.log('[Identity] Generated keypair:', publicKey.slice(0, 16));

      // Create the channel's multi-writer metadata log (Autobase)
      const { channel, channelKeyHex, encryptionKeyHex } = await createChannel(ctx, { encrypt: false })
      await channel.updateMetadata({ name, description: '', avatar: null })
      await channel.ensureLocalBlobDrive({ deviceName: name })

      // Create identity record
      const identity = {
        publicKey,
        // Backward-compat: expose channelKey via driveKey for existing app code.
        driveKey: channelKeyHex,
        channelKey: channelKeyHex,
        channelEncryptionKey: encryptionKeyHex,
        legacyDriveKey: null,
        name,
        createdAt: Date.now(),
        secretKey: b4a.toString(keypair.secretKey, 'hex'),
        isActive: false
      };

      identities.push(identity);
      await this.saveIdentities();
      // Channel is cached in ctx.channels by createChannel()

      // Set as active if first identity
      if (identities.length === 1) {
        activeIdentity = publicKey;
        await ctx.metaDb.put('activeIdentity', publicKey);
        identity.isActive = true;
      }

      console.log('[Identity] Created:', publicKey.slice(0, 16));
      console.log('[Identity] Channel key:', channelKeyHex.slice(0, 16));

      return {
        success: true,
        publicKey,
        driveKey: channelKeyHex,
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
      } catch {}

      const keypair = crypto.keyPair()
      const publicKey = b4a.toString(keypair.publicKey, 'hex')

      const identity = {
        publicKey,
        driveKey: channelKeyHex, // app compat: driveKey used as channel key throughout the UI
        channelKey: channelKeyHex,
        channelEncryptionKey: null,
        legacyDriveKey: null,
        name,
        createdAt: Date.now(),
        secretKey: b4a.toString(keypair.secretKey, 'hex'),
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
      console.log('[Identity] Recovering from mnemonic');

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

      // Recovery currently creates a fresh channel.
      const { channelKeyHex, encryptionKeyHex, channel } = await createChannel(ctx, { encrypt: false })
      await channel.updateMetadata({ name: name || `Recovered ${Date.now()}`, description: '', avatar: null })
      await channel.ensureLocalBlobDrive({ deviceName: name || '' })

      const identity = {
        publicKey,
        driveKey: channelKeyHex,
        channelKey: channelKeyHex,
        channelEncryptionKey: encryptionKeyHex,
        legacyDriveKey: null,
        name: name || `Recovered ${Date.now()}`,
        createdAt: Date.now(),
        secretKey: b4a.toString(keypair.secretKey, 'hex'),
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
      console.log('[Identity] Active identity set to:', publicKey.slice(0, 16));
    },

    /**
     * Load existing channel drives for all identities
     * @returns {Promise<void>}
     */
    async loadChannelDrives() {
      for (const identity of identities) {
        // Load multi-writer channel (new)
        if (identity.channelKey) {
          try {
            await loadChannel(ctx, identity.channelKey, { encryptionKeyHex: identity.channelEncryptionKey || null })
          } catch (err) {
            console.error('[Identity] Failed to load channel:', identity.channelKey?.slice(0, 16), err.message)
          }
        }

        // Load legacy drive if present (blob source during migration)
        if (identity.legacyDriveKey && !ctx.drives.has(identity.legacyDriveKey)) {
          try {
            await loadDrive(ctx, identity.legacyDriveKey, { waitForSync: false })
          } catch (err) {
            console.error('[Identity] Failed to load legacy drive:', identity.legacyDriveKey?.slice(0, 16), err.message)
          }
        }
      }
    },

    /**
     * Migrate legacy single-writer identity channels to multi-writer channels.
     * This creates a new Autobase channel and references the legacy Hyperdrive as a blob source.
     *
     * @returns {Promise<void>}
     */
    async migrateLegacyIdentities() {
      for (const identity of identities) {
        if (identity.channelKey) continue
        if (!identity.legacyDriveKey) continue

        const legacyDriveKey = identity.legacyDriveKey
        try {
          const existing = await ctx.metaDb.get(`migration:${legacyDriveKey}`).catch(() => null)
          if (existing?.value?.channelKey) {
            identity.channelKey = existing.value.channelKey
            identity.channelEncryptionKey = existing.value.channelEncryptionKey || null
            identity.driveKey = identity.channelKey
            continue
          }

          console.log('[Identity] Migrating legacy channel:', legacyDriveKey.slice(0, 16))
          const legacyDrive = await loadDrive(ctx, legacyDriveKey, { waitForSync: true, syncTimeout: 15000 })

          // Create new multi-writer channel
          const { channel, channelKeyHex, encryptionKeyHex } = await createChannel(ctx, { encrypt: false })

          // Migrate channel metadata
          const legacyMetaBuf = await legacyDrive.get('/channel.json').catch(() => null)
          if (legacyMetaBuf) {
            const legacyMeta = JSON.parse(b4a.toString(legacyMetaBuf))
            await channel.updateMetadata({
              name: legacyMeta?.name || identity.name || 'Channel',
              description: legacyMeta?.description || '',
              avatar: legacyMeta?.avatar || null
            })
          } else {
            await channel.updateMetadata({ name: identity.name || 'Channel', description: '', avatar: null })
          }

          // Migrate video metadata (reference legacy drive blobs)
          try {
            // Collect entries first since readdir returns async iterator
            const entries = []
            try {
              for await (const entry of legacyDrive.readdir('/videos')) {
                entries.push(entry)
              }
            } catch {
              // /videos dir may not exist
            }
            for (const entry of entries) {
              if (!entry.endsWith('.json')) continue
              const metaBuf = await legacyDrive.get(`/videos/${entry}`).catch(() => null)
              if (!metaBuf) continue
              const v = JSON.parse(b4a.toString(metaBuf))
              const id = v.id || entry.replace(/\.json$/, '')
              await channel.addVideo({
                ...v,
                id,
                channelKey: channelKeyHex,
                blobDriveKey: legacyDriveKey,
                // Keep legacy path for blob resolution
                path: v.path || `/videos/${id}.mp4`
              })
            }
          } catch (e) {
            console.log('[Identity] Video migration warning:', e?.message)
          }

          // Ensure this device has a writable blob drive for future uploads
          await channel.ensureLocalBlobDrive({ deviceName: identity.name || '' })

          // Persist identity upgrade
          identity.channelKey = channelKeyHex
          identity.channelEncryptionKey = encryptionKeyHex
          identity.driveKey = channelKeyHex // app compat

          await ctx.metaDb.put(`migration:${legacyDriveKey}`, {
            channelKey: channelKeyHex,
            channelEncryptionKey: encryptionKeyHex,
            migratedAt: Date.now()
          })

          console.log('[Identity] Migration complete:', legacyDriveKey.slice(0, 16), '->', channelKeyHex.slice(0, 16))
        } catch (err) {
          console.error('[Identity] Migration failed for', legacyDriveKey?.slice(0, 16), err?.message)
        }
      }

      await this.saveIdentities()
    },

    /**
     * Get drive for the active identity
     * @returns {import('hyperdrive')|null}
     */
    getActiveDrive() {
      const active = this.getActiveIdentity();
      if (!active) return null;
      // Legacy-only: return the old single-writer drive if still present
      const full = identities.find(i => i.publicKey === active.publicKey)
      const legacyKey = full?.legacyDriveKey
      if (!legacyKey) return null
      return ctx.drives.get(legacyKey) || null;
    },

    /**
     * Get active multi-writer channel (Autobase)
     * @returns {Promise<any|null>}
     */
    async getActiveChannel() {
      const active = this.getActiveIdentity()
      if (!active) return null
      const full = identities.find(i => i.publicKey === active.publicKey)
      const channelKey = full?.channelKey || active.driveKey
      if (!channelKey) return null
      return await loadChannel(ctx, channelKey, { encryptionKeyHex: full?.channelEncryptionKey || null })
    }
  };
}
