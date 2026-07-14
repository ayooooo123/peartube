import test from 'brittle'
import b4a from 'b4a'

import {
  NegativeControlDialer,
  NegativeControlListener,
  runNegativeControlCli
} from './namespace/negative-control.js'

function fixture(result = true) {
  const calls = []
  const socket = {
    bind(port, host) {
      calls.push(['bind', port, host])
    },
    async send(payload, port, host) {
      calls.push(['send', b4a.from(payload), port, host])
      if (result instanceof Error) throw result
      return result
    },
    async close() {
      calls.push(['close'])
    }
  }
  const adapter = {
    creates: 0,
    create() {
      this.creates++
      return { createSocket: () => socket }
    }
  }
  return { calls, adapter }
}

function dialer(adapter) {
  return new NegativeControlDialer({
    bind: { host: '10.203.77.2', port: 48_300 },
    target: { host: '10.203.77.9', port: 48_200 },
    payload: b4a.alloc(32, 0xa7),
    adapter
  })
}

test('negative control is inert until explicitly invoked and closes exact UDX ownership', async (t) => {
  const { calls, adapter } = fixture()
  const control = dialer(adapter)
  t.is(adapter.creates, 0)
  t.is(control.invocations, 0)
  t.is(await control.dial(), true)
  t.is(control.invocations, 1)
  t.is(adapter.creates, 1)
  t.alike(calls, [
    ['bind', 48_300, '10.203.77.2'],
    ['send', b4a.alloc(32, 0xa7), 48_200, '10.203.77.9'],
    ['close']
  ])
  t.is(await control.close(), true)
  t.is(await control.close(), false)
  await t.exception.all(() => control.dial(), /Route is unavailable/)
})

test('negative control counts failed attempts and closes on false or rejected sends', async (t) => {
  for (const result of [false, new Error('injected send failure')]) {
    const { calls, adapter } = fixture(result)
    const control = dialer(adapter)
    await t.exception.all(() => control.dial(), /Route is unavailable/)
    t.is(control.invocations, 1)
    t.alike(calls.at(-1), ['close'])
    await control.close()
  }
})

test('negative control listener proves the decoy received the exact source probe', async (t) => {
  let receive = null
  let timer = null
  const calls = []
  const socket = {
    on(event, listener) {
      t.is(event, 'message')
      receive = listener
    },
    bind(port, host) {
      calls.push(['bind', port, host])
    },
    async close() {
      calls.push(['close'])
    }
  }
  const listener = new NegativeControlListener({
    bind: { host: '10.203.77.9', port: 48_200 },
    expectedSourceHost: '10.203.77.2',
    payload: b4a.alloc(32, 0xa7),
    adapter: { create: () => ({ createSocket: () => socket }) },
    schedule(callback, delay) {
      timer = { callback, delay }
      return timer
    },
    cancel(handle) {
      t.is(handle, timer)
      timer = null
    },
    timeout: 1_000
  })
  t.is(await listener.start(), true)
  t.alike(calls, [['bind', 48_200, '10.203.77.9']])
  t.is(timer.delay, 1_000)
  const received = listener.wait()
  receive(b4a.alloc(32, 0xa7), { host: '10.203.77.2', port: 48_300, family: 4 })
  t.alike(await received, { bytes: 32, sourcePort: 48_300 })
  t.is(timer, null)
  t.is(await listener.close(), true)
  t.alike(calls.at(-1), ['close'])
})

test('negative control listener closes partial ownership and rejects wait on start failure', async (t) => {
  t.timeout(100)
  const calls = []
  const listener = new NegativeControlListener({
    bind: { host: '10.203.77.9', port: 48_200 },
    expectedSourceHost: '10.203.77.2',
    payload: b4a.alloc(32, 0xa7),
    adapter: {
      create: () => ({
        createSocket: () => ({
          on() {},
          bind() {
            throw new Error('injected bind failure')
          },
          async close() {
            calls.push('close')
          }
        })
      })
    },
    schedule: setTimeout,
    cancel: clearTimeout,
    timeout: 1_000
  })
  await t.exception(listener.start(), /Route is unavailable/)
  await t.exception(listener.wait(), /Route is unavailable/)
  t.alike(calls, ['close'])
})

test('negative control CLI emits bounded readiness, receipt, and send records', async (t) => {
  const payload = b4a.alloc(32, 0xa7)
  const payloadHex = b4a.toString(payload, 'hex')
  const sent = fixture()
  const sendOutput = []
  await runNegativeControlCli({
    argv: ['dial', '10.203.77.2', '48300', '10.203.77.9', '48200', payloadHex],
    stdout: { write: (value) => sendOutput.push(value) },
    adapter: sent.adapter
  })
  t.alike(sendOutput, ['{"event":"sent","invocations":1}\n'])

  let receive = null
  let timer = null
  const listenOutput = []
  const socket = {
    on(_event, listener) {
      receive = listener
    },
    bind() {},
    async close() {}
  }
  await runNegativeControlCli({
    argv: ['listen', '10.203.77.9', '48200', '10.203.77.2', payloadHex],
    stdout: {
      write(value) {
        listenOutput.push(value)
        if (value.includes('ready')) {
          receive(payload, { host: '10.203.77.2', port: 48_300, family: 4 })
        }
      }
    },
    adapter: { create: () => ({ createSocket: () => socket }) },
    schedule(callback, delay) {
      timer = { callback, delay }
      return timer
    },
    cancel(handle) {
      t.is(handle, timer)
      timer = null
    }
  })
  t.alike(listenOutput, [
    '{"event":"ready"}\n',
    '{"event":"received","bytes":32,"sourcePort":48300}\n'
  ])
})
