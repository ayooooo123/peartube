// Throwaway: minimal convergence probe — works with or without today's pool fields.
import proc from 'node:process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

globalThis.process ??= proc

const KEY = '115932df5e3b460bc057ec916881c56404f8ccbff854e096c0899b154e6852ea'
const { createNode } = await import('./src/index.js')

const base = mkdtempSync(join(os.tmpdir(), 'pt-min-'))
const node = await createNode({
  storage: join(base, 'n'),
  sources: [{ key: KEY, kind: 'channel' }],
  worklet: true,
  maxActiveSources: 8,
  bootstrap: [{ host: '10.0.10.10', port: 49737 }]
})

for (let i = 0; i < 16; i++) {
  await new Promise(r => setTimeout(r, 5000))
  const all = await node.search()
  const st = node.status()
  let announces = null
  try { announces = node.listSources().find(s => !s.primary)?.entries ?? null } catch {}
  console.log(JSON.stringify({
    t: i * 5,
    publicPeers: st.routes?.public?.peers ?? st.peers,
    lanPeers: st.lanPeers,
    announces,
    total: all.length,
    inter: all.some(e => e.id === 'imdb:tt0816692')
  }))
  if (all.some(e => e.id === 'imdb:tt0816692') && all.length >= 540) break
}

await node.close()
rmSync(base, { recursive: true, force: true })
process.exit(0)
