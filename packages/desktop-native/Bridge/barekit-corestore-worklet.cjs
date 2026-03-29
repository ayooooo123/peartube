const Corestore = require('../../app/node_modules/corestore')
const Hyperbee = require('../../app/node_modules/hyperbee')
const bareFsModule = require('bare-fs')

const fs = bareFsModule?.default || bareFsModule

function appendDebugLine(line) {
  const filePath = '/tmp/peartube-barekit-corestore.log'
  if (typeof fs?.appendFileSync !== 'function') return

  try {
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

async function closeResources({ metaDb, metaCore, store }) {
  try {
    await metaDb?.close?.()
    appendDebugLine('[corestore-worklet] metaDb closed')
  } catch (error) {
    appendDebugLine(`[corestore-worklet] metaDb close failed ${error?.message || String(error)}`)
  }

  try {
    await metaCore?.close?.()
    appendDebugLine('[corestore-worklet] metaCore closed')
  } catch (error) {
    appendDebugLine(`[corestore-worklet] metaCore close failed ${error?.message || String(error)}`)
  }

  try {
    await store?.close?.()
    appendDebugLine('[corestore-worklet] Corestore closed')
  } catch (error) {
    appendDebugLine(`[corestore-worklet] Corestore close failed ${error?.message || String(error)}`)
  }
}

BareKit.on('push', async (payload, reply) => {
  const storagePath = Buffer.from(payload || []).toString('utf8')
  appendDebugLine(`[corestore-worklet] start storagePath=${storagePath}`)

  let store = null
  let metaCore = null
  let metaDb = null
  let stage = 'initial'

  try {
    if (typeof fs?.mkdirSync === 'function') {
      fs.mkdirSync(storagePath, { recursive: true })
    }

    stage = 'construct corestore'
    appendDebugLine('[corestore-worklet] constructing Corestore')
    store = new Corestore(storagePath, { wait: false })
    stage = 'corestore ready'
    appendDebugLine('[corestore-worklet] awaiting Corestore.ready()')
    await store.ready()
    appendDebugLine('[corestore-worklet] Corestore ready')

    stage = 'open meta core'
    appendDebugLine('[corestore-worklet] opening named meta core')
    metaCore = store.get({ name: 'peartube-meta' })
    stage = 'metaCore ready'
    appendDebugLine('[corestore-worklet] awaiting metaCore.ready()')
    await metaCore.ready()
    appendDebugLine('[corestore-worklet] metaCore ready')

    stage = 'construct metaDb'
    appendDebugLine('[corestore-worklet] constructing Hyperbee')
    metaDb = new Hyperbee(metaCore, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    stage = 'metaDb ready'
    appendDebugLine('[corestore-worklet] awaiting metaDb.ready()')
    await metaDb.ready()
    appendDebugLine('[corestore-worklet] metaDb ready')

    stage = 'close before reply'
    await closeResources({ metaDb, metaCore, store })
    metaDb = null
    metaCore = null
    store = null

    stage = 'reply ready'
    reply(null, Buffer.from('ready'))
  } catch (error) {
    appendDebugLine(
      `[corestore-worklet] error stage=${stage} message=${error?.message || String(error)} code=${error?.code || ''} name=${error?.name || ''} stack=${error?.stack || ''}`
    )
    reply(new Error(`stage=${stage} message=${error?.message || String(error)}`))
  } finally {
    await closeResources({ metaDb, metaCore, store })
  }
})
