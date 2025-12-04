/* global Pear */
import Runtime from 'pear-electron'
import Bridge from 'pear-bridge'

console.log('[PearTube] Booting Pear desktop runtime...')

const bridge = new Bridge()
await bridge.ready()
console.log('[PearTube] Bridge ready')

const runtime = new Runtime()
const pipe = await runtime.start({ bridge })
console.log('[PearTube] Runtime started, opening UI window')

pipe.on('close', () => {
  Pear.exit()
})
