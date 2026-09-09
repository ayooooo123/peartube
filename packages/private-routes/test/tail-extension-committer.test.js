import b4a from 'b4a'
import test from 'brittle'

import {
  createTailExtensionCommitter,
  destroyTailExtensionCommitter,
  enqueueTailExtended,
  installTailExtension
} from '../lib/tail-extension-committer.js'
import { M3_CONTEXT_ENVELOPE_SIZE } from '../lib/m3-context.js'

function expectCode(t, operation, code, message) {
  let error = null
  try {
    operation()
  } catch (err) {
    error = err
  }
  t.is(error && error.code, code, message)
}

function forwarding(onDestroy = () => {}) {
  let live = true
  return Object.freeze({
    diagnostics() {
      if (!live) throw new Error('destroyed')
      return Object.freeze({ state: 'CREATE', expiresAt: 5_000n })
    },
    destroy() {
      if (!live) return false
      live = false
      onDestroy()
      return true
    }
  })
}

test('tail extension committer enforces enqueue before one atomic runtime install', (t) => {
  const events = []
  const envelope = b4a.alloc(M3_CONTEXT_ENVELOPE_SIZE, 0x11)
  const nextRuntime = Object.freeze({})
  const installed = forwarding()
  const committer = createTailExtensionCommitter({
    enqueue(value) {
      events.push(['enqueue', value])
    },
    install(value) {
      events.push(['install', value])
      return installed
    },
    destroy() {
      events.push(['destroy'])
    }
  })

  expectCode(t, () => installTailExtension(committer, nextRuntime), 'ERR_REPLAY')
  t.is(enqueueTailExtended(committer, envelope), true)
  expectCode(t, () => enqueueTailExtended(committer, envelope), 'ERR_REPLAY')
  t.is(installTailExtension(committer, nextRuntime), installed)
  t.alike(events, [
    ['enqueue', envelope],
    ['install', nextRuntime]
  ])
  expectCode(t, () => installTailExtension(committer, nextRuntime), 'ERR_REPLAY')
  t.is(destroyTailExtensionCommitter(committer), false)
})

test('caught enqueue reentry poisons the committer before runtime installation', (t) => {
  const envelope = b4a.alloc(M3_CONTEXT_ENVELOPE_SIZE, 0x21)
  let committer = null
  let nestedCode = null
  let installs = 0
  let destroys = 0
  committer = createTailExtensionCommitter({
    enqueue() {
      try {
        enqueueTailExtended(committer, envelope)
      } catch (err) {
        nestedCode = err && err.code
      }
    },
    install() {
      installs++
      return forwarding()
    },
    destroy() {
      destroys++
    }
  })

  expectCode(t, () => enqueueTailExtended(committer, envelope), 'INVALID_ROUTE')
  t.is(nestedCode, 'ERR_BUSY')
  t.is(installs, 0)
  t.is(destroys, 1)
  t.is(destroyTailExtensionCommitter(committer), false)
})

test('caught install reentry destroys an unpublished forwarding record and branch owner', (t) => {
  const envelope = b4a.alloc(M3_CONTEXT_ENVELOPE_SIZE, 0x31)
  const nextRuntime = Object.freeze({})
  let committer = null
  let nestedCode = null
  let forwardingDestroys = 0
  let branchDestroys = 0
  committer = createTailExtensionCommitter({
    enqueue() {},
    install() {
      try {
        installTailExtension(committer, nextRuntime)
      } catch (err) {
        nestedCode = err && err.code
      }
      return forwarding(() => forwardingDestroys++)
    },
    destroy() {
      branchDestroys++
    }
  })
  enqueueTailExtended(committer, envelope)

  expectCode(t, () => installTailExtension(committer, nextRuntime), 'INVALID_ROUTE')
  t.is(nestedCode, 'ERR_BUSY')
  t.is(forwardingDestroys, 1)
  t.is(branchDestroys, 1)
  t.is(destroyTailExtensionCommitter(committer), false)
})
