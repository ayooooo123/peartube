import test from 'brittle'
import Hyperswarm from 'hyperswarm'
import { setTimeout as delay } from 'node:timers/promises'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'

async function until(predicate) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('peer connection timed out')
    await delay(20)
  }
}

test('configured endpoint authenticates its peer and follows network pause/resume', async t => {
  const server = new Hyperswarm({ bootstrap: [] })
  const client = new Hyperswarm({ bootstrap: [] })
  let runtime
  t.teardown(async () => {
    await runtime?.close()
    await Promise.all([client.destroy(), server.destroy()])
  })
  await server.listen()
  const port = server.dht.io.serverSocket.address().port
  runtime = createScopedNetworkRuntime({
    swarm: client,
    store: {},
    bootstrapEnabled: false,
    peerAddresses: [{ publicKey: server.keyPair.publicKey.toString('hex'), host: '127.0.0.1', port }],
    initialNetworkPolicy: { networkEnabled: false },
  })
  await runtime.start()
  await delay(100)
  t.is(server.connections.size, 0, 'a configured endpoint does not override disabled networking')

  await runtime.applyNetworkPolicy({ networkEnabled: true, uploadPermission: 'disabled' })
  await until(() => client.connections.size === 1)
  const connection = [...client.connections][0]
  t.alike(connection.remotePublicKey, server.keyPair.publicKey, 'the LAN endpoint completes Noise authentication as the configured peer')

  await runtime.applyNetworkPolicy({ networkEnabled: false, uploadPermission: 'disabled' })
  connection.destroy()
  for (const socket of server.connections) socket.destroy()
  await until(() => client.connections.size === 0 && server.connections.size === 0)
  await delay(200)
  t.is(server.connections.size, 0, 'network pause releases the explicit connection interest')

  await runtime.applyNetworkPolicy({ networkEnabled: true, uploadPermission: 'disabled' })
  await until(() => client.connections.size === 1)
  t.alike([...client.connections][0].remotePublicKey, server.keyPair.publicKey, 'resume reconnects with the same authenticated identity')
})

test('configured peer endpoints reject malformed addresses before networking', t => {
  const swarm = { join() {} }
  const publicKey = 'ab'.repeat(32)
  for (const entry of [
    { publicKey, host: '10.0.0.999', port: 49737 },
    { publicKey: 'not-a-key', host: '127.0.0.1', port: 49737 },
    { publicKey, host: '127.0.0.1', port: 0 },
  ]) {
    t.exception(() => createScopedNetworkRuntime({ swarm, peerAddresses: [entry] }))
  }
})
