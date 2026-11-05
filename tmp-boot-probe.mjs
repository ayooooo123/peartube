// Throwaway: with the forced-read tick, does bootstrapping straight to the relay converge fast?
import proc from 'node:process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

globalThis.process ??= proc

const KEY = '115932df5e3b460bc057ec916881c56404f8ccbff854e096c0899b154e6852ea'
const { createNode } = await import('./src/index.js')

const base = mkdtempSync(join(os.tmpdir(), 'pt-boot-'))
const node = await createNode({
  storage: join(base, 'n'),
  sources: [{ key: KEY, kind: 'channel' }],
  worklet: true,
  maxActiveSources: 8,
  bootstrap: [{ host: '10.0.40.100', port: 49738 }]
})

for (let i = 0; i < 16; i++) {
  await new Promise(r => setTimeout(r, 5000))
  const src = node.listSources().find(s => !s.primary)
  const all = await node.search()
  const st = node.status()
  console.log(JSON.stringify({
    t: i * 5,
    publicPeers: st.routes.public.peers,
    announces: src?.entries,
    total: all.length,
    inter: all.some(e => e.id === 'imdb:tt0816692')
  }))
  if (all.some(e => e.id === 'imdb:tt0816692') && all.length >= 542) break
}

await node.close()
rmSync(base, { recursive: true, force: true })
process.exit(0)
