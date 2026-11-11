import b4a from 'b4a'
import { verifyClaim } from './mnemonic.js'
import { cleanText, decodeOp, isSystemViewKey } from './protocol.js'

// Deterministic ACL gate at the mouth of every unified Channel: ungranted strangers get swallowed and ignored,
// linked devices prove ownership via detached 12-word vault claims or owner grants, and owners/mods can purge any key.
export function makeApply (getChannelHex) {
  return async function apply (nodes, view, host) {
    const chHex = getChannelHex()
    const roles = new Map()
    const revokedCache = new Map()
    let ownerHex = null
    let curEpoch = null
    const ops = []
    async function flushOps () {
      if (!ops.length) return
      const w = view.write()
      for (const [kind, k, v] of ops) {
        if (kind === 'put') w.tryPut(k, v)
        else w.tryDelete(k)
      }
      ops.length = 0
      await w.flush()
    }
    async function getOwner () {
      if (ownerHex !== null) return ownerHex
      const n = await view.get(b4a.from('meta/owner'))
      ownerHex = n ? b4a.toString(n.value) : ''
      return ownerHex
    }
    async function isRevoked (wHex) {
      if (revokedCache.has(wHex)) return revokedCache.get(wHex)
      const r = Boolean(await view.get(b4a.from(`revoked/${wHex}`)))
      revokedCache.set(wHex, r)
      return r
    }
    for (const node of nodes) {
      const op = decodeOp(node.value)
      if (!op) continue
      const writer = b4a.toString(node.key, 'hex')
      let role = writer === chHex ? 'owner' : (roles.get(writer) ?? null)
      let claimedHere = false
      let legacyGrantedHere = false
      if (!role && !roles.has(writer)) {
        const rec = await view.get(b4a.from(`writer/${writer}`))
        if (rec) {
          try { role = JSON.parse(b4a.toString(rec.value))?.role || null } catch {}
        }
        if (role) roles.set(writer, role)
      }
      if (!role) {
        const curOwner = await getOwner()
        const claimSig = op.type === 'claim' ? op.sig : op.claim
        if (claimSig && curOwner) {
          if (!(await isRevoked(writer)) && verifyClaim(chHex, writer, curOwner, claimSig)) {
            await host.addWriter(node.key, { isIndexer: false })
            role = 'owner'
            roles.set(writer, role)
            claimedHere = true
          }
        } else if (!curOwner) {
          await host.addWriter(node.key, { isIndexer: false })
          role = 'writer'
          roles.set(writer, role)
          legacyGrantedHere = true
        } else {
          roles.set(writer, '')
        }
      }
      if (!role) continue
      if (claimedHere) {
        ops.push(['put', b4a.from(`writer/${writer}`), b4a.from(JSON.stringify({ role: 'owner', alias: cleanText(op.alias || '') }))])
        if (op.type === 'claim') continue
      } else if (legacyGrantedHere) {
        ops.push(['put', b4a.from(`writer/${writer}`), b4a.from(JSON.stringify({ role: 'writer', alias: '' }))])
      }
      if (op.type === 'init') {
        if (writer === chHex) {
          roles.set(writer, 'owner')
          ops.push(['put', b4a.from(`writer/${writer}`), b4a.from(JSON.stringify({ role: 'owner', alias: 'primary' }))])
          if (op.owner) {
            ownerHex = op.owner
            ops.push(['put', b4a.from('meta/owner'), b4a.from(op.owner)])
          }
          if (op.epoch) {
            curEpoch = op.epoch
            ops.push(['put', b4a.from('meta/epoch'), b4a.from(String(op.epoch))])
          }
        }
      } else if (op.type === 'owner') {
        if (role === 'owner' && !(await getOwner())) {
          ownerHex = op.owner
          ops.push(['put', b4a.from('meta/owner'), b4a.from(op.owner)])
        }
      } else if (op.type === 'epoch') {
        if (role === 'owner') {
          if (curEpoch === null) curEpoch = Number(b4a.toString((await view.get(b4a.from('meta/epoch')))?.value || '1')) || 1
          if (op.epoch > curEpoch) {
            curEpoch = op.epoch
            ops.push(['put', b4a.from('meta/epoch'), b4a.from(String(op.epoch))])
          }
        }
      } else if (op.type === 'grant') {
        if (role === 'owner') {
          const nextRole = op.role || 'writer'
          revokedCache.set(op.writer, false)
          roles.set(op.writer, nextRole)
          ops.push(['del', b4a.from(`revoked/${op.writer}`)])
          await host.addWriter(b4a.from(op.writer, 'hex'), { isIndexer: false })
          ops.push(['put', b4a.from(`writer/${op.writer}`), b4a.from(JSON.stringify({ role: nextRole, alias: cleanText(op.alias || '') }))])
        }
      } else if (op.type === 'revoke') {
        if (role === 'owner' && op.writer !== chHex) {
          await host.removeWriter(b4a.from(op.writer, 'hex'))
          roles.set(op.writer, '')
          revokedCache.set(op.writer, true)
          ops.push(['del', b4a.from(`writer/${op.writer}`)])
          ops.push(['put', b4a.from(`revoked/${op.writer}`), b4a.from('1')])
          if (op.purgeEntries) {
            await flushOps()
            for await (const entry of view.createReadStream()) {
              const ek = b4a.toString(entry.key)
              if (ek === `peer/${op.writer}` || ek.startsWith(`source/${op.writer}/`) || (!isSystemViewKey(ek) && ek.split('/')[1] === op.writer)) {
                ops.push(['del', entry.key])
              }
            }
          }
        }
      } else if (op.type === 'remove') {
        if (!op.key.startsWith('meta/') && !op.key.startsWith('writer/') && !op.key.startsWith('revoked/')) {
          if (role === 'owner' || role === 'mod' || op.key.split('/')[1] === writer) {
            ops.push(['del', b4a.from(op.key)])
          }
        }
      } else if (op.type === 'source') {
        ops.push(['put', b4a.from(`source/${writer}/${op.sourceKey}`), node.value])
      } else if (op.type === 'announce') {
        ops.push(['put', b4a.from(`${op.id}/${writer}/${op.blobs}:${op.blob.blockOffset}`), node.value])
      }
    }
    await flushOps()
  }
}
// Fast-forward trust: only the channel key and devices linked to it as owner (and not revoked) may vouch for a view.
// The reference is this node's own view, sparse after a landing: an unbounded read here would wedge Autobee's
// fast-forward search for good, so a record nobody serves in time counts as untrusted.
export function makeIsTrusted (getChannelHex) {
  return async function isTrusted (key, reference) {
    const hex = b4a.toString(key, 'hex')
    if (hex === getChannelHex()) return true
    if (!reference) return false
    try {
      if (await reference.get(b4a.from(`revoked/${hex}`), { timeout: 5_000 })) return false
      const rec = await reference.get(b4a.from(`writer/${hex}`), { timeout: 5_000 })
      return JSON.parse(b4a.toString(rec.value)).role === 'owner'
    } catch { return false }
  }
}
