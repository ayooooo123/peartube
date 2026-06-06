import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

const ACTIVE_RELAY_PEERS = [
  '1be1b0d6001e11b862da4eb36a1c84124c1b4ebead9da9ea499e2d8f8677c0a2',
  '77988ca37c0557f3d5f34a432fe032a17f655a3f05fffc1d947bb9586905baa8',
  'b731d9808cfd70b7590a8e1bcb0e70b247ce1188aaf74d3590cee408170389d5',
  '99f9f7e8f106d2b10fb0f7b4e17fa6999013a15bf38e1274dc147e124d58866f',
  '3f7cca83302adb4c12eed4220933aaf412b190feb37c826241c4e145d651e2bd',
  'cc77c3a0c306567d02fbc309d296f8fd4f308057fb426411e95bc91c69c3c093',
  '6125ee5e5a7db69921c2092a60ba69e2d7caa7ad305f1f6b5da1973d6e3906c8',
  'b58303c2bdf3273ae839f87e412c3ef1fa95717bc7abd5d34fd6a5ddae53de5c',
]

const RETIRED_RELAY_PEERS = [
  '9890785d1a1b5af8e4bfba0f585f54272b6951e3dc0fdc43a30ed73f1d740f13',
  'd10f6fbdae2d8e439cf9b6e29cbb42199fff101a8e707345eb455faab92e7d7a',
  '8cdc6bc7d9d1bfe99644d06dee042023c54d55af178cfa12bf778fe51f01152a',
  '43f48db991cc40002ebd9661239b49e83c1d6b41c86b06b94a57925d00e5ab05',
]

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('native root ships current relay peers into the mobile backend worklet', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.match(source, /MOBILE_RELAY_PEERS/)
  assert.match(source, /network:\s*\{\s*relayPeers:\s*MOBILE_RELAY_PEERS\s*\}/)
  assert.match(source, /swarmOptions:\s*\{\s*knownPeers:\s*MOBILE_RELAY_PEERS\s*\}/)

  for (const peer of ACTIVE_RELAY_PEERS) {
    assert.match(source, new RegExp(peer), `missing active relay peer ${peer}`)
  }

  for (const peer of RETIRED_RELAY_PEERS) {
    assert.doesNotMatch(source, new RegExp(peer), `retired relay peer should not ship ${peer}`)
  }
})
