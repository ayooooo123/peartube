// A node that asks for a fixed peer port and does not get it must say so. dht-rpc reads a port as the range
// [port, port + 5) and then takes any free port without an error, so a port forward would point at nothing and
// nothing would tell the owner. Another socket holds the port the first node asks for; the second node asks for a
// free port and must stay quiet.
// The result is written to desktop/target/e2e/peer-port-fallback-result.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-peer-port-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const SAID = /^Requested peer port (\d+); listening on (\d+)$/

// The first truthy value of fn, or its last value once ms have passed: the caller asserts on it.
async function poll (fn, ms) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value || Date.now() > end) return value
    await sleep(100)
  }
}

// A UDP socket on a free port of every interface, the address dht-rpc binds by default.
function bindUdp () {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    socket.once('error', reject)
    socket.bind(0, '0.0.0.0', () => resolve({ socket, port: socket.address().port }))
  })
}

test('a node that does not get its fixed peer port says which port it got', { timeout: 120_000 }, async () => {
  const testnet = await createTestnet(3)
  const lines = []
  const nodes = []
  const result = { clash: null, quiet: null }
  const consoleError = console.error
  let held = null
  const open = async dhtPort => {
    const node = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, dhtPort })
    nodes.push(node)
    return node
  }
  console.error = line => { lines.push(line) }
  try {
    held = await bindUdp()
    const clash = await open(held.port)
    const line = await poll(() => lines.find(l => typeof l === 'string' && SAID.test(l)), 10_000)
    const listening = clash.swarm.dht.localAddress()?.port
    result.clash = { requested: held.port, listening, line: line ?? null }
    assert.ok(line, 'the node said which port it got')
    const [requested, bound] = SAID.exec(line).slice(1).map(Number)
    assert.equal(requested, held.port, 'the line names the port the node asked for')
    assert.equal(bound, listening, 'the line names the port the node listens on')
    assert.notEqual(bound, held.port, 'the node did not get the port that another socket held')

    // A free port: the node gets it and says nothing. Another process can take the port between the check and the
    // bind, so a node that got another port is closed and the case runs again.
    let quiet = false
    for (let attempt = 1; attempt <= 3 && !quiet; attempt++) {
      const probe = await bindUdp()
      await new Promise(resolve => probe.socket.close(resolve))
      lines.length = 0
      const node = await open(probe.port)
      const local = await poll(() => node.swarm.dht.localAddress(), 10_000)
      assert.ok(local, 'the node bound a peer port')
      if (local.port !== probe.port) {
        await node.close()
        continue
      }
      await sleep(2_000)
      result.quiet = { requested: probe.port, listening: local.port, attempt, lines: lines.map(String) }
      assert.deepEqual(lines.filter(l => String(l).startsWith('Requested peer port')), [], 'a node that got its port said nothing')
      quiet = true
    }
    assert.ok(quiet, 'no node got the port that it requested in 3 tries')
  } finally {
    console.error = consoleError
    const artifactDir = join('desktop', 'target', 'e2e')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'peer-port-fallback-result.json'), JSON.stringify(result, null, 2))
    for (const node of nodes.reverse()) await node.close().catch(() => {})
    held?.socket.close()
    await testnet.destroy()
  }
})
