import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const cliRoot = path.resolve(import.meta.dirname, '..')
const packagesRoot = path.resolve(cliRoot, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(cliRoot, relativePath), 'utf8')
}

test('CLI depends on the minimal host contracts subpath for the canonical protocol version', () => {
  const cliPackage = JSON.parse(read('package.json'))
  const hostPackage = JSON.parse(fs.readFileSync(path.join(packagesRoot, 'host/package.json'), 'utf8'))

  assert.equal(cliPackage.dependencies['@peartube/host'], 'file:../host')
  assert.equal(hostPackage.exports['./contracts'], './src/contracts.js')

  for (const relativePath of ['src/add/runtime.js', 'src/runtime.js']) {
    const source = read(relativePath)
    assert.match(source, /import \{ PROTOCOL_VERSION \} from '@peartube\/host\/contracts'/)
    assert.match(source, /expectedProtocolVersion:\s*PROTOCOL_VERSION/)
    assert.match(source, /createBackendContext/)
    assert.doesNotMatch(source, /from '@peartube\/host'/, `${relativePath} must not eagerly load the host root`)
  }
})
