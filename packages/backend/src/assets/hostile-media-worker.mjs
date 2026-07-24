import { parentPort } from 'node:worker_threads'

import { createMediaValidationPolicy, validateHostileMediaProbe } from './media-validation.js'

parentPort?.on('message', (message = {}) => {
  try {
    const result = validateHostileMediaProbe(message.probe || {}, createMediaValidationPolicy(message.policy || {}))
    parentPort.postMessage({ ok: true, result })
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error?.message || String(error) })
  }
})
