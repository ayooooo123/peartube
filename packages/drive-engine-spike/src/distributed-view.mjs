import { Duplex } from 'node:stream'
import DistributedDrive from 'distributed-drive'

export async function createDistributedView(...drives) {
  const view = new DistributedDrive(...drives)
  await view.ready()
  return view
}

export function connectDistributedViews(leftView, rightView) {
  const [left, right] = nodeDuplexPair()
  const leftPeer = leftView.addPeer(left)
  const rightPeer = rightView.addPeer(right)

  return function disconnect() {
    try { leftPeer.destroy?.() } catch {}
    try { rightPeer.destroy?.() } catch {}
    try { left.destroy?.() } catch {}
    try { right.destroy?.() } catch {}
  }
}

export async function listEntries(view, prefix = '/') {
  const entries = []
  for await (const entry of view.list(prefix)) entries.push(entry)
  return entries
}

export async function readJsonFromView(view, filename) {
  const buf = await view.get(filename)
  if (!buf) return null
  return JSON.parse(buf.toString('utf8'))
}

function nodeDuplexPair() {
  let left
  let right

  left = new Duplex({
    write(chunk, _encoding, callback) {
      setImmediate(() => right.push(chunk))
      callback()
    },
    final(callback) {
      setImmediate(() => right.push(null))
      callback()
    },
    read() {}
  })

  right = new Duplex({
    write(chunk, _encoding, callback) {
      setImmediate(() => left.push(chunk))
      callback()
    },
    final(callback) {
      setImmediate(() => left.push(null))
      callback()
    },
    read() {}
  })

  return [left, right]
}
