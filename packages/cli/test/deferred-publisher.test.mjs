import test from 'brittle'

import { createDeferredPublisher } from '../src/archive-manager.js'

// Regression for the startup race: the relay web console starts before the
// network-bound runtime, so an archive upload can call the publisher before it
// is bound. It must WAIT for readiness — a thrown "still starting" error marks
// the job failed and runJob's finally-cleanup deletes the uploaded temp file,
// permanently losing the upload.

test('early publisher calls wait for bind instead of throwing', async (t) => {
  const { publisher, bind } = createDeferredPublisher()

  let settled = false
  const call = publisher
    .ensureAnonymousChannel({ channelName: 'Grouped Show' })
    .then((value) => { settled = true; return value })

  await new Promise((resolve) => setTimeout(resolve, 20))
  t.absent(settled, 'the call is still pending before the publisher is bound')

  const calls = []
  bind({
    async ensureAnonymousChannel (args) {
      calls.push(args)
      return { channelKey: 'chan', publicBeeKey: 'bee' }
    }
  })

  const result = await call
  t.ok(settled, 'the call resolves once the publisher is bound')
  t.is(result.channelKey, 'chan')
  t.is(result.publicBeeKey, 'bee')
  t.alike(calls, [{ channelName: 'Grouped Show' }], 'arguments are forwarded verbatim')
})

test('calls after bind resolve immediately through the real publisher', async (t) => {
  const { publisher, bind } = createDeferredPublisher()
  bind({
    async importVideo () { return { success: true, videoId: 'vid' } },
    async ensureAnonymousChannel () { return {} },
    async publishChannel () { return { success: true } },
    async seedChannel () { return {} }
  })

  const imported = await publisher.importVideo({ title: 'Pilot' })
  t.is(imported.videoId, 'vid')
})

test('bind validates its input and rejects a second bind', (t) => {
  const gate = createDeferredPublisher()
  t.exception(() => gate.bind(null), /requires a publisher/)
  gate.bind({ async ensureAnonymousChannel () { return {} } })
  t.exception(() => gate.bind({ async ensureAnonymousChannel () { return {} } }), /already bound/)
})
