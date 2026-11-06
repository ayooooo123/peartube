#!/usr/bin/env bare
// One-off, with the relay stopped: rebuild this node's channel view from its oplog with the current apply.
// usage: bare bin/rebuild-view.js <storage> [channelHex] [--check | --rollback]
//   --check     only reports the view as it is, changes nothing
//   --rollback  points the view back at the tree recorded in <storage>/rebuild-view.backup.json
import 'bare-process/global'
import { rebuildView } from '../src/rebuild-view.js'

const args = process.argv.slice(2)
const check = args.includes('--check')
const rollback = args.includes('--rollback')
const [storage, channel] = args.filter(a => !a.startsWith('--'))
if (!storage) {
  console.error('usage: bare bin/rebuild-view.js <storage> [channelHex] [--check]')
  process.exit(2)
}
try {
  const summary = await rebuildView({ storage, channel, check, rollback, log: line => console.log(JSON.stringify(line)) })
  console.log(JSON.stringify({ msg: rollback ? 'rebuild-view rollback done' : check ? 'rebuild-view check done' : 'rebuild-view done', ...summary }))
  process.exit(0)
} catch (err) {
  console.error(JSON.stringify({ msg: 'rebuild-view failed', error: err?.message || String(err) }))
  process.exit(1)
}
