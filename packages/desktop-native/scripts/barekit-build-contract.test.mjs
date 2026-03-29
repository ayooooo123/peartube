import fs from 'fs'
import path from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

const packageRoot = path.resolve(import.meta.dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8')
}

test('default desktop build does not hard-require BareKit at compile time', () => {
  const projectYml = read('project.yml')
  const embeddedSession = read('Sources/Support/EmbeddedBareKitSession.swift')
  const bareKitTests = read('Tests/BareKitIntegrationTests.swift')

  assert.doesNotMatch(
    projectYml,
    /SWIFT_OBJC_BRIDGING_HEADER/,
    'default desktop build should not require a BareKit bridging header'
  )
  assert.doesNotMatch(
    projectYml,
    /-framework BareKit/,
    'default desktop build should not hard-link BareKit'
  )
  assert.match(
    embeddedSession,
    /#if PEARTUBE_ENABLE_EMBEDDED_BAREKIT/,
    'embedded BareKit session should be compile-gated'
  )
  assert.match(
    bareKitTests,
    /#if PEARTUBE_ENABLE_EMBEDDED_BAREKIT/,
    'BareKit integration tests should be compile-gated'
  )
})
