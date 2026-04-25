import b4a from 'b4a'
import { generateMnemonic as generatePearTubeMnemonic, validateMnemonic as validatePearTubeMnemonic, deriveIdentity } from './peartube-identity.js'

export function generateMnemonic(wordCount = 12) {
  if (wordCount !== 12) throw new Error('PearTube mnemonic generation supports 12 words only')
  return generatePearTubeMnemonic()
}

export function validateMnemonic(mnemonic) {
  return validatePearTubeMnemonic(mnemonic)
}

export function createIdentityManager({ ctx, engineAdapter } = {}) {
  let identities = []
  let activeIdentity = null

  async function save() {
    await ctx.metaDb.put('identities', identities)
    if (activeIdentity) await ctx.metaDb.put('activeIdentity', activeIdentity)
  }

  function normalize(identity) {
    if (!identity) return null
    const publicKey = identity.publicKey || identity.driveKey || identity.channelKey
    if (!publicKey) return null
    const driveKey = identity.driveKey || identity.channelKey || publicKey
    return {
      publicKey,
      driveKey,
      channelKey: driveKey,
      name: identity.name || 'PearTube Channel',
      description: identity.description || '',
      avatar: identity.avatar || null,
      createdAt: identity.createdAt || Date.now(),
      isActive: publicKey === activeIdentity,
      hdDerived: Boolean(identity.hdDerived)
    }
  }

  const manager = {
    async loadIdentities() {
      identities = ((await ctx.metaDb.get('identities').catch(() => null))?.value || []).map(normalize).filter(Boolean)
      activeIdentity = (await ctx.metaDb.get('activeIdentity').catch(() => null))?.value || identities[0]?.publicKey || null
      identities = identities.map((i) => ({ ...i, isActive: i.publicKey === activeIdentity }))
      await save()
    },

    async saveIdentities() { await save() },

    async createIdentity(name = 'New Channel', generateMnem = true) {
      const mnemonic = generateMnem ? generateMnemonic() : null
      let publicKey = await randomHex(32)
      if (mnemonic) {
        try {
          const { identityPublicKey } = await deriveIdentity(mnemonic)
          publicKey = Buffer.from(identityPublicKey).toString('hex')
        } catch {}
      }

      // Breaking engine v0: one identity == one UI channel key. The actual Hyperdrive key
      // is mapped lazily by engineAdapter on first upload/list operation.
      const identity = normalize({ publicKey, driveKey: publicKey, name, hdDerived: Boolean(mnemonic) })
      identities.push(identity)
      if (!activeIdentity) {
        activeIdentity = identity.publicKey
        identity.isActive = true
      }
      await save()
      return { success: true, publicKey: identity.publicKey, driveKey: identity.driveKey, mnemonic }
    },

    async recoverIdentity(seedPhrase, name = 'Recovered Channel') {
      if (!validateMnemonic(seedPhrase)) throw new Error('Invalid mnemonic')
      const { identityPublicKey } = await deriveIdentity(seedPhrase)
      const publicKey = Buffer.from(identityPublicKey).toString('hex')
      let identity = identities.find((i) => i.publicKey === publicKey)
      if (!identity) {
        identity = normalize({ publicKey, driveKey: publicKey, name, hdDerived: true })
        identities.push(identity)
      }
      activeIdentity = publicKey
      identities = identities.map((i) => ({ ...i, isActive: i.publicKey === activeIdentity }))
      await save()
      return identity
    },

    async setActiveIdentity(publicKey) {
      if (!identities.some((i) => i.publicKey === publicKey)) throw new Error('Identity not found')
      activeIdentity = publicKey
      identities = identities.map((i) => ({ ...i, isActive: i.publicKey === publicKey }))
      await save()
      return true
    },

    getActiveIdentity() { return identities.find((i) => i.publicKey === activeIdentity) || identities[0] || null },
    getIdentities() { return identities.slice() },
    async getActiveChannel() { return null },
    async loadChannelDrives() { return [] },
    async addPairedChannelIdentity(channelKeyHex, name = 'Paired Channel') {
      const identity = normalize({ publicKey: channelKeyHex, driveKey: channelKeyHex, name })
      identities.push(identity)
      if (!activeIdentity) activeIdentity = identity.publicKey
      await save()
      return identity
    },
    async updateIdentityByDriveKey(driveKey, updates = {}) {
      let found = null
      identities = identities.map((identity) => {
        if (identity.driveKey !== driveKey) return identity
        found = { ...identity, ...updates, driveKey, channelKey: driveKey }
        return found
      })
      if (found) await save()
      return found
    },
    async bootstrapDevice() { return { proof: Buffer.alloc(0), identityPublicKey: '' } },
    async attestDevice() { return { proof: Buffer.alloc(0) } },
    async verifyAttestation() { return { valid: false, identityPublicKey: '', devicePublicKey: '' } },
  }

  return manager
}

async function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
    return b4a.toString(bytes, 'hex')
  }

  const nodeCryptoName = 'node:' + 'crypto'
  const crypto = await import(nodeCryptoName)
  return crypto.randomBytes(byteLength).toString('hex')
}
