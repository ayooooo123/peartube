import test from 'brittle'

import {
  createExtensionLinkCompletion,
  destroyExtensionLinkCompletion,
  destroyTakenExtensionLinkCompletion,
  takeExtensionLinkCompletion
} from '../lib/extension-link-completion.js'

function expectCode(t, operation, code) {
  let error = null
  try {
    operation()
  } catch (err) {
    error = err
  }
  t.is(error && error.code, code)
}

test('extension completion moves once and retains cleanup through the internal take', (t) => {
  const material = {}
  let cleaned = 0
  const completion = createExtensionLinkCompletion(material, (value) => {
    t.is(value, material)
    cleaned++
  })

  t.ok(Object.isFrozen(completion))
  t.alike(Object.keys(completion), [])
  t.is(takeExtensionLinkCompletion(completion), material)
  expectCode(t, () => takeExtensionLinkCompletion(completion), 'ERR_REPLAY')
  t.is(destroyExtensionLinkCompletion(completion), false)
  t.is(destroyTakenExtensionLinkCompletion(material), true)
  t.is(cleaned, 1)
  t.is(destroyTakenExtensionLinkCompletion(material), false)
})

test('aborting an untaken extension completion invokes cleanup exactly once', (t) => {
  let cleaned = 0
  const completion = createExtensionLinkCompletion({}, () => cleaned++)

  t.is(destroyExtensionLinkCompletion(completion), true)
  t.is(destroyExtensionLinkCompletion(completion), false)
  expectCode(t, () => takeExtensionLinkCompletion(completion), 'ERR_REPLAY')
  t.is(cleaned, 1)
})
