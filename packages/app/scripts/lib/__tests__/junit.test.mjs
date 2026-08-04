import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeJunit } from '../junit.mjs'

const XML = `<testsuites>
  <testsuite tests="3" failures="1" skipped="1" errors="0">
    <testcase name="boots"/>
    <testcase name="tabs"><failure>bad</failure></testcase>
    <testcase name="player"><skipped/></testcase>
  </testsuite>
</testsuites>`

test('counts pass/fail/skip and gate', () => {
  const s = summarizeJunit(XML)
  assert.deepEqual({ tests: s.tests, failures: s.failures, skipped: s.skipped }, { tests: 3, failures: 1, skipped: 1 })
  assert.equal(s.ok, false)
})

test('all-pass gate is ok', () => {
  const s = summarizeJunit('<testsuites><testsuite tests="1" failures="0" skipped="0" errors="0"><testcase name="x"/></testsuite></testsuites>')
  assert.equal(s.ok, true)
})

test('errors also fail the gate', () => {
  const s = summarizeJunit('<testsuite tests="1" failures="0" errors="1" skipped="0"></testsuite>')
  assert.equal(s.ok, false)
})
