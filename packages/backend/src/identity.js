/**
 * Identity Management Module
 *
 * Handles identity creation, recovery, and management for PearTube.
 * Identities are linked to Hyperdrives for content publishing.
 */

import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import Hyperdrive from 'hyperdrive';

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
        .filter(i => i && typeof i.publicKey === 'string' && i.publicKey &&
                     typeof i.driveKey === 'string' && i.driveKey)
        .map(i => ({
          ...i,
          isActive: i.publicKey === activeIdentity,
          createdAt: typeof i.createdAt === 'number' && i.createdAt >= 0
            ? i.createdAt : Date.now(),
        }));
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

      // Create the channel's Hyperdrive with timeout
      console.log('[Identity] Creating Hyperdrive...');
      let drive;
      try {
        drive = new Hyperdrive(ctx.store);
        console.log('[Identity] Hyperdrive created, waiting for ready...');

        // Add timeout to prevent infinite hang
        await Promise.race([
          drive.ready(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Hyperdrive ready timeout after 30s')), 30000)
          )
        ]);
        console.log('[Identity] Hyperdrive ready');
      } catch (driveErr) {
        console.error('[Identity] Failed to create/ready Hyperdrive:', driveErr.message);
        throw driveErr;
      }

      const driveKey = b4a.toString(drive.key, 'hex');

      // Store channel metadata in drive
      await drive.put('/channel.json', Buffer.from(JSON.stringify({
        name,
        publicKey,
        createdAt: Date.now(),
        description: '',
        avatar: null
      })));

      // Create identity record
      const identity = {
        publicKey,
        driveKey,
        name,
        createdAt: Date.now(),
        secretKey: b4a.toString(keypair.secretKey, 'hex'),
        isActive: false
      };

      identities.push(identity);
      await this.saveIdentities();
      ctx.drives.set(driveKey, drive);

      // Join swarm for this channel
      if (ctx.swarm) {
        ctx.swarm.join(drive.discoveryKey);
      }

      // Set as active if first identity
      if (identities.length === 1) {
        activeIdentity = publicKey;
        await ctx.metaDb.put('activeIdentity', publicKey);
        identity.isActive = true;
      }

      console.log('[Identity] Created:', publicKey.slice(0, 16));
      console.log('[Identity] Drive key:', driveKey.slice(0, 16));

      return {
        success: true,
        publicKey,
        driveKey,
        mnemonic
      };
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

      // For recovery, create a new drive
      // TODO: In future, try to find existing drive via DHT
      const drive = new Hyperdrive(ctx.store);
      await drive.ready();
      const driveKey = b4a.toString(drive.key, 'hex');

      const identity = {
        publicKey,
        driveKey,
        name: name || `Recovered ${Date.now()}`,
        createdAt: Date.now(),
        secretKey: b4a.toString(keypair.secretKey, 'hex'),
        recovered: true,
        isActive: false
      };

      identities.push(identity);
      await this.saveIdentities();
      ctx.drives.set(driveKey, drive);

      if (ctx.swarm) {
        ctx.swarm.join(drive.discoveryKey);
      }

      return {
        success: true,
        publicKey,
        driveKey
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
        if (identity.driveKey && !ctx.drives.has(identity.driveKey)) {
          try {
            console.log(`[Identity] Loading drive for "${identity.name}":`, identity.driveKey.slice(0, 16));
            const drive = new Hyperdrive(ctx.store, b4a.from(identity.driveKey, 'hex'));
            await drive.ready();
            console.log(`[Identity] Drive loaded, writable: ${drive.writable}`);

            ctx.drives.set(identity.driveKey, drive);

            if (ctx.swarm) {
              ctx.swarm.join(drive.discoveryKey);
            }
          } catch (err) {
            console.error('[Identity] Failed to load drive:', identity.driveKey.slice(0, 16), err.message);
          }
        }
      }
    },

    /**
     * Get drive for the active identity
     * @returns {import('hyperdrive')|null}
     */
    getActiveDrive() {
      const active = this.getActiveIdentity();
      if (!active) return null;
      return ctx.drives.get(active.driveKey) || null;
    }
  };
}
