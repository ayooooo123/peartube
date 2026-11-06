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

  function saveIdentity () {
    try {
      const payload = {
        mnemonic: currentMnemonic || '',
        founded: foundedKey || '',
        accessKeys: Object.fromEntries(accessKeys)
      }
      writeFileSync(identityFile + '.tmp', JSON.stringify(payload, null, 2), { mode: 0o600 })
      renameSync(identityFile + '.tmp', identityFile)
    } catch {}
  }

  function ensureVault () {
    if (!idVault) {
      currentMnemonic = generateMnemonic(12)
      idVault = deriveIdentity(currentMnemonic)
    }
    return idVault
  }

  async function claimWithMnemonic (phrase, { alias = '' } = {}) {
    const nextVault = deriveIdentity(phrase)
    currentMnemonic = nextVault.mnemonic
    idVault = nextVault
    saveIdentity()
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
    accessKeys.set(`${c}:${ep}`, k)
    saveIdentity()
    ctx.update()
    return { channel: c, epoch: ep }
  }

  async function identity ({ revealMnemonic = false } = {}) {
    const ep = await ctx.channel.currentChannelEpoch()
    const role = await ctx.channel.localRole()
    const canManageEpoch = Boolean(idVault && (ctx.channel.primaryKey === foundedKey || idVault.channelKey === ctx.channel.primaryKey))
    const epochKeyHex = canManageEpoch ? b4a.toString(idVault.epochKey(ctx.channel.primaryKey, ep), 'hex') : ''
    return {
      channel: ctx.channel.primaryKey,
      writer: b4a.toString(ctx.channel.channel.local.key, 'hex'),
      role,
      writable: Boolean(ctx.channel.channel.writable || role === 'owner'),
      mnemonicSet: Boolean(currentMnemonic),
      ...(revealMnemonic ? { mnemonic: currentMnemonic } : {}),
      writers: await ctx.channel.listWriters(),
      epoch: ep,
      ...(epochKeyHex ? { epochKey: epochKeyHex, accessUri: formatAccessUri(ctx.channel.primaryKey, ep, epochKeyHex) } : {})
    }
  }

  return {
    get idVault () { return idVault },
    ensureVault,
    foundedKey: () => foundedKey,
    markFounded: key => { foundedKey = key },
    accessKeys,
    saveIdentity,
    claimWithMnemonic,
    rotateEpoch,
    addAccessKey,
    identity
  }
}
