import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')

function readFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function workflowHeader(workflow) {
  const marker = '\npermissions:'
  const index = workflow.indexOf(marker)
  assert.notEqual(index, -1, 'workflow should declare permissions after trigger block')
  return workflow.slice(0, index)
}

test('app build workflows only run on relevant main-path changes or manual dispatch', () => {
  const workflows = [
    ['build-mobile', readFile('.github/workflows/build-mobile.yml')],
    ['build-desktop', readFile('.github/workflows/build-desktop.yml')],
  ]

  for (const [name, workflow] of workflows) {
    const header = workflowHeader(workflow)

    assert.doesNotMatch(
      header,
      /pull_request:/,
      `${name} should not build apps for pull requests`,
    )
    assert.doesNotMatch(
      header,
      /schedule:/,
      `${name} should not run scheduled app builds`,
    )
    assert.match(
      header,
      /push:\s*\n\s*branches:\s*\[main\]/,
      `${name} should build after relevant merges into main`,
    )
    assert.doesNotMatch(
      header,
      /push:[\s\S]*tags:/,
      `${name} should not run redundant app builds when release tags are cut`,
    )
    assert.match(
      header,
      /paths:\s*\n(?:\s*- '[^']+'\s*\n)+/,
      `${name} should limit main builds with path filters`,
    )
    assert.match(
      header,
      /workflow_dispatch:/,
      `${name} should still allow manual dispatch`,
    )
  }
})

test('expensive desktop and iOS release workflows are manual-only', () => {
  const workflows = [
    ['release-desktop', readFile('.github/workflows/release-desktop.yml')],
    ['release-ios', readFile('.github/workflows/release-ios.yml')],
  ]

  for (const [name, workflow] of workflows) {
    const header = workflowHeader(workflow)

    assert.doesNotMatch(
      header,
      /push:/,
      `${name} should not run automatically on tags`,
    )
    assert.match(
      header,
      /workflow_dispatch:/,
      `${name} should remain available for manual releases`,
    )
  }
})
