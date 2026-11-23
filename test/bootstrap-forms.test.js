// A bootstrap node in the apps' settings form (src/app-settings.js) and in the relay's settings (src/settings.js) is
// a form that dht-rpc reads: `host:port`, or `ip@host:port` to try that address first. It is kept as written.
// Anything else is refused, and an IPv6 address says why: dht-rpc splits a node on ':' and keeps two parts, so a saved
// IPv6 node would stop the node from starting. Both modules use one rule, so every form runs against both.
// Pure: a settings file in a temporary folder, no node, no sockets.
// Writes desktop/target/e2e/bootstrap-forms-result.json.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeAppSettings } from '../src/app-settings.js'
import { createSettings } from '../src/settings.js'

const root = new URL('..', import.meta.url).pathname
const forms = {}
after(() => {
  mkdirSync(join(root, 'desktop/target/e2e'), { recursive: true })
  writeFileSync(join(root, 'desktop/target/e2e/bootstrap-forms-result.json'), JSON.stringify({ forms, finishedAt: new Date().toISOString() }, null, 2) + '\n')
})

// One update of the relay's settings, on a settings file in a temporary folder.
function relayUpdate (patch) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-bootstrap-forms-'))
  try { return createSettings(dir, {}).update(patch).settings } finally { rmSync(dir, { recursive: true, force: true }) }
}

const takers = {
  'the apps\' settings form': nodes => normalizeAppSettings({ bootstrap: nodes }).bootstrap,
  'the relay\'s settings': nodes => relayUpdate({ bootstrap: nodes }).bootstrap.value
}

// Each form is a test of its own, so a run that gets one wrong names it.
for (const [who, bootstrapOf] of Object.entries(takers)) {
  const seen = forms[who] = {}

  for (const node of ['node.example:49737', '1.2.3.4:49737', '1.2.3.4@node.example:49737']) {
    test(`${who}: the bootstrap node ${node} is kept as written`, () => {
      assert.deepEqual(bootstrapOf([node]), [node])
      seen[node] = 'kept'
    })
  }

  test(`${who}: an empty bootstrap list is accepted`, () => {
    assert.deepEqual(bootstrapOf([]), [])
    seen['(empty list)'] = 'kept'
  })

  for (const node of ['[::1]:49737', '::1:49737', '[node.example]:49737']) {
    test(`${who}: the bootstrap node ${node} is refused, and the message names IPv6`, () => {
      assert.throws(() => bootstrapOf([node]), /IPv6 addresses are not supported/)
      seen[node] = 'refused, IPv6'
    })
  }

  // Refused as well, and not blamed on IPv6.
  for (const node of ['node.example', 'node.example:0', 'node.example:65536', 'node example:49737']) {
    test(`${who}: the bootstrap node "${node}" is refused as not host:port`, () => {
      assert.throws(() => bootstrapOf([node]), /^(?!.*IPv6).*host:port/)
      seen[node] = 'refused'
    })
  }
}

// The Soulseek server is another rule (`hostport`): it keeps taking an IPv6 host.
test('the relay\'s settings still accept an IPv6 host for the Soulseek server', () => {
  assert.equal(relayUpdate({ slskServer: '[::1]:2271' }).slskServer.value, '[::1]:2271')
  forms['slskServer [::1]:2271'] = 'kept'
})
