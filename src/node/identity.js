import b4a from 'b4a'
import { join } from 'node:path'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { deriveIdentity, formatAccessUri, generateMnemonic, normalizeMnemonic, validateMnemonic } from '../mnemonic.js'
import { HEX64, cleanText } from '../protocol.js'

export function createIdentity (ctx) {
  const { storage, mnemonic: mnemonicOpt = null } = ctx.opts
  // Private 0600 vault file beside settings.json/jobs.json: holds the 12-word recovery phrase and subscriber epoch passes, never in Corestore.
  const identityFile = join(storage, 'identity.json')
  let savedIdentity = {}
  try { savedIdentity = JSON.parse(readFileSync(identityFile, 'utf8')) || {} } catch {}
  const accessKeys = new Map()
  for (const [k, v] of Object.entries(savedIdentity.accessKeys || {})) {
    if (typeof v === 'string' && HEX64.test(v.toLowerCase())) accessKeys.set(k.toLowerCase(), v.toLowerCase())
  }
  let currentMnemonic = mnemonicOpt ? normalizeMnemonic(mnemonicOpt) : (savedIdentity.mnemonic ? normalizeMnemonic(savedIdentity.mnemonic) : '')
  if (currentMnemonic && !validateMnemonic(currentMnemonic)) {
    if (mnemonicOpt) throw new Error('Invalid 12- or 24-word recovery phrase')
    currentMnemonic = ''
  }
  let idVault = currentMnemonic ? deriveIdentity(currentMnemonic) : null
  let foundedKey = typeof savedIdentity.founded === 'string' && HEX64.test(savedIdentity.founded) ? savedIdentity.founded : ''
  const savedMnemonic = savedIdentity.mnemonic ? normalizeMnemonic(savedIdentity.mnemonic) : ''
  let dirty = Boolean(mnemonicOpt && currentMnemonic && currentMnemonic !== savedMnemonic)
  // Throws when identity.json cannot be written: a phrase or pass the caller believes is saved must be.
  function saveIdentity () {
    const payload = {
      mnemonic: currentMnemonic || '',
      founded: foundedKey || '',
      accessKeys: Object.fromEntries(accessKeys)
    }
    writeFileSync(identityFile + '.tmp', JSON.stringify(payload, null, 2), { mode: 0o600 })
    renameSync(identityFile + '.tmp', identityFile)
    dirty = false
  }

  function ensureVault () {
    if (!idVault) {
      currentMnemonic = generateMnemonic(12)
      idVault = deriveIdentity(currentMnemonic)
      dirty = true
    }
    return idVault
  }

  async function claimWithMnemonic (phrase, { alias = '' } = {}) {
    const nextVault = deriveIdentity(phrase)
    const before = { currentMnemonic, idVault }
    currentMnemonic = nextVault.mnemonic
    idVault = nextVault
    try {
      saveIdentity()
    } catch (err) {
      ({ currentMnemonic, idVault } = before)
      throw err
    }
    if (nextVault.channelKey !== ctx.channel.primaryKey) {
      return { claimed: false, reopenNeeded: true, channel: nextVault.channelKey }
    }
    if (!ctx.channel.channel.writable) {
      const writerHex = b4a.toString(ctx.channel.channel.local.key, 'hex')
      await ctx.channel.append({ type: 'claim', sig: nextVault.signClaim(ctx.channel.primaryKey, writerHex), alias: cleanText(alias) })
    }
    ctx.update()
    return { claimed: true, reopenNeeded: false, channel: ctx.channel.primaryKey, writer: b4a.toString(ctx.channel.channel.local.key, 'hex') }
  }

  async function rotateEpoch () {
    if (!idVault) throw new Error('12-word recovery vault required to rotate subscriber epochs')
    const nextEpoch = (await ctx.channel.currentChannelEpoch()) + 1
    await ctx.channel.append({ type: 'epoch', epoch: nextEpoch })
    const epochKeyHex = b4a.toString(idVault.epochKey(ctx.channel.primaryKey, nextEpoch), 'hex')
    ctx.update()
    return { epoch: nextEpoch, epochKey: epochKeyHex, accessUri: formatAccessUri(ctx.channel.primaryKey, nextEpoch, epochKeyHex) }
  }

  async function addAccessKey ({ channel: chHex, epoch, key: keyHex }) {
    const c = String(chHex || '').trim().toLowerCase()
    const k = String(keyHex || '').trim().toLowerCase()
    const ep = Number(epoch)
    if (!HEX64.test(c) || !HEX64.test(k) || !Number.isSafeInteger(ep) || ep < 1) {
      throw new Error('Invalid subscriber access key')
    }
    const id = `${c}:${ep}`
    const before = accessKeys.get(id)
    accessKeys.set(id, k)
    try {
      saveIdentity()
    } catch (err) {
      if (before === undefined) accessKeys.delete(id)
      else accessKeys.set(id, before)
      throw err
    }
    ctx.update()
    return { channel: c, epoch: ep }
  }

  function epochAccess (epoch) {
    if (!idVault) return null
    const canManageEpoch = ctx.channel.primaryKey === foundedKey || idVault.channelKey === ctx.channel.primaryKey
    if (!canManageEpoch) return null
    const epochKeyHex = b4a.toString(idVault.epochKey(ctx.channel.primaryKey, epoch), 'hex')
    return { epoch, epochKey: epochKeyHex, accessUri: formatAccessUri(ctx.channel.primaryKey, epoch, epochKeyHex) }
  }

  async function identity ({ revealMnemonic = false } = {}) {
    const ep = await ctx.channel.currentChannelEpoch()
    const role = await ctx.channel.localRole()
    const access = epochAccess(ep)
    return {
      channel: ctx.channel.primaryKey,
      writer: b4a.toString(ctx.channel.channel.local.key, 'hex'),
      role,
      writable: Boolean(ctx.channel.channel.writable || role === 'owner'),
      mnemonicSet: Boolean(currentMnemonic),
      ...(revealMnemonic ? { mnemonic: currentMnemonic } : {}),
      writers: await ctx.channel.listWriters(),
      epoch: ep,
      ...(access ? { epochKey: access.epochKey, accessUri: access.accessUri } : {})
    }
  }

  return {
    get idVault () { return idVault },
    ensureVault,
    foundedKey: () => foundedKey,
    markFounded: key => { if (foundedKey !== key) { foundedKey = key; dirty = true } },
    isDirty: () => dirty,
    accessKeys,
    saveIdentity,
    claimWithMnemonic,
    rotateEpoch,
    addAccessKey,
    epochAccess,
    identity
  }
}
