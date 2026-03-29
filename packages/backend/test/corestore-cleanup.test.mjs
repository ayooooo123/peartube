import test from 'node:test'
import assert from 'node:assert/strict'

import { cleanupFailedCorestoreOpen } from '../src/corestore-cleanup.js'

test('failed-open cleanup closes both the store and underlying storage', async () => {
  const calls = []
  const store = {
    async close() {
      calls.push('store.close')
    },
    storage: {
      async close() {
        calls.push('storage.close')
      }
    }
  }

  await cleanupFailedCorestoreOpen(store, 'test cleanup')

  assert.deepEqual(calls, ['store.close', 'storage.close'])
})

test('failed-open cleanup still closes underlying storage when store.close throws', async () => {
  const calls = []
  const store = {
    async close() {
      calls.push('store.close')
      throw new Error('close failed')
    },
    storage: {
      async close() {
        calls.push('storage.close')
      }
    }
  }

  await cleanupFailedCorestoreOpen(store, 'test cleanup')

  assert.deepEqual(calls, ['store.close', 'storage.close'])
})
