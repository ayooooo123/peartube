import fs from 'fs'
import os from 'os'
import path from 'path'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hypercore from 'hypercore'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-'))
const store = new Corestore(dir)
await store.ready()

const N = 8
const BS = 1024
const kp = await store.createKeyPair('staging-xp')
const staging = store.get({ keyPair: kp })
await staging.ready()
for (let i = 0; i < N; i++) await staging.append(b4a.alloc(BS, i + 1))

const treeHash = await staging.treeHash()
const manifest = { version: 1, hash: 'blake2b', allowPatch: false, quorum: 0, signers: [], prologue: { hash: treeHash, length: staging.length } }
const key = Hypercore.key(manifest)
const final = store.get({ key, manifest, writable: false })
await final.ready()

// delete all block data from staging except a window, then copyPrologue per window
const st = staging.state.storage

async function deleteRange (start, end) {
  const tx = st.write()
  tx.deleteBlockRange(start, end)
  await tx.flush()
}
async function putBlock (i, buf) {
  const tx = st.write()
  tx.putBlock(i, buf)
  await tx.flush()
}
async function residentBlocks () {
  const out = []
  for await (const d of st.createBlockStream({ gte: 0, lt: N })) out.push(d.index)
  return out
}

await deleteRange(0, N)
console.log('resident after wipe', await residentBlocks())

const W = 2
for (let s = 0; s < N; s += W) {
  for (let i = s; i < Math.min(N, s + W); i++) await putBlock(i, b4a.alloc(BS, i + 1))
  console.log('window', s, 'resident', await residentBlocks())
  await final.core.copyPrologue(staging.state)
  await deleteRange(s, Math.min(N, s + W))
}

console.log('final.length', final.length, 'contiguousLength', final.contiguousLength, 'byteLength', final.byteLength)
let ok = true
for (let i = 0; i < N; i++) {
  const has = final.has(i)
  const blk = await final.get(i, { wait: false })
  if (!has || !blk || blk[0] !== ((i + 1) & 0xff)) { ok = false; console.log('BAD', i, has, !!blk) }
}
console.log('all blocks present+correct:', ok)
console.log('treeHash matches:', b4a.equals(await final.treeHash(), treeHash))
await store.close()
fs.rmSync(dir, { recursive: true, force: true })
