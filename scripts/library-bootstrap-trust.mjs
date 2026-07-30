#!/usr/bin/env node
// First-run trust bootstrap for the PearTube publisher agent.
//
// The agent and HiveRelay (Blindspark) run side by side but with separate
// Corestores and separate trust. Two things must happen exactly once before
// durability delegation works end-to-end:
//
//   1. The relay's PUBLIC key is copied into the agent's
//      `trust.durableRelayKeys` so a client that fetches from the relay treats
//      it as a standalone durable anchor (the upload-offload path).
//   2. The operator approves the agent's publisher key once in the relay's
//      review queue (accept-mode `review`). After that the agent's requests
//      auto-accept — this script cannot do that step (it is an operator action
//      in the Blindspark dashboard), it prints the exact instruction.
//
// This script performs step 1 and prints the dashboard instruction for step 2.
// It is intentionally side-effect-light and idempotent: re-running just
// re-prints the current state.
//
// Usage:
//   node library-bootstrap-trust.mjs --relay http://hiverelay:9100
//   node library-bootstrap-trust.mjs --relay http://127.0.0.1:9100 \
//       --config /var/lib/peartube-relay/peartube-relay.yml
//
// Spec: docs/superpowers/specs/2026-07-24-peartube-seeder-spec.md (Phase 2)

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import process from 'node:process'

function parseArgs(argv) {
  const flags = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--relay') { flags.relay = next; i++ }
    else if (arg === '--config') { flags.config = next; i++ }
    else if (arg === '--json') { flags.json = true }
    else if (arg === '--help' || arg === '-h') { flags.help = true }
  }
  return flags
}

function printHelp() {
  console.log([
    'library-bootstrap-trust — wire first-run trust between the PearTube agent and HiveRelay',
    '',
    'Usage:',
    '  node library-bootstrap-trust.mjs --relay <url> [--config <path>] [--json]',
    '',
    'Options:',
    '  --relay <url>      HiveRelay management API URL (e.g. http://hiverelay:9100)',
    '  --config <path>    Agent config to update (default: PEARTUBE_CONFIG or peartube-relay.yml)',
    '  --json             Emit machine-readable JSON instead of the human walkthrough',
    '',
    'What it does:',
    '  1. Fetches the relay public key from /.well-known/hiverelay.json',
    '  2. Injects it into the agent config under trust.durableRelayKeys',
    '  3. Prints the one-time operator-approval step for the Blindspark dashboard'
  ].join('\n'))
}

async function fetchRelayInfo(relayUrl) {
  const wellKnown = `${relayUrl.replace(/\/+$/, '')}/.well-known/hiverelay.json`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  if (timer.unref) timer.unref()
  try {
    const res = await fetch(wellKnown, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`relay returned HTTP ${res.status}`)
    const body = await res.json().catch(() => null)
    if (!body) throw new Error('relay returned no JSON body')
    return body
  } finally {
    clearTimeout(timer)
  }
}

function readConfig(path) {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

// Minimal, surgical config patch: add/replace the trust.durableRelayKeys list.
// We do not parse-and-reserialize YAML here (the agent's own config loader is
// the authority); we only insert a block that the loader understands. If a
// block exists we replace it; otherwise we append.
function patchConfigTrustKeys(configText, keyHex) {
  const block = `trust:\n  durableRelayKeys:\n    - "${keyHex}"\n`
  if (!configText) return block

  const trustRegex = /^trust:[\s\S]*?(?=^\S)/m
  if (trustRegex.test(configText)) {
    return configText.replace(trustRegex, block)
  }
  return `${configText.trimEnd()}\n\n${block}`
}

async function main() {
  const flags = parseArgs(process.argv)
  if (flags.help) { printHelp(); return }
  if (!flags.relay) {
    console.error('error: --relay <url> is required (the HiveRelay management API URL)')
    printHelp()
    process.exit(2)
  }

  const info = await fetchRelayInfo(flags.relay)
  // HiveRelay advertises its identity in several possible fields; accept any.
  // HiveRelay capability docs use `pubkey` (hex); older drafts used publicKey/swarmKey.
  const relayKey = info.pubkey || info.publicKey || info.swarmKey || info.identityKey || info.key
  if (!relayKey || typeof relayKey !== 'string') {
    console.error('error: relay did not advertise a public key in /.well-known/hiverelay.json')
    console.error('available fields:', Object.keys(info).join(', ') || '(none)')
    process.exit(1)
  }

  const configPath = flags.config || process.env.PEARTUBE_CONFIG || 'peartube-relay.yml'
  const existing = readConfig(configPath)
  const patched = patchConfigTrustKeys(existing || '', relayKey)

  if (configPath && configPath !== '-') {
    writeFileSync(configPath, patched)
  }

  const report = {
    relay: flags.relay,
    relayPublicKey: relayKey,
    configPath,
    configPatched: Boolean(configPath && configPath !== '-'),
    approvalStep: {
      where: `${flags.relay} dashboard (Blindspark)`,
      action: `Approve the PearTube agent publisher key in the review queue once.`,
      effect: 'After approval, set HIVERELAY_ACCEPT_MODE=allowlist with the agent key so later seed requests auto-accept.'
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log([
    '✓ Relay public key fetched:',
    `    ${relayKey.slice(0, 16)}…${relayKey.slice(-8)}`,
    '',
    existing
      ? `✓ Patched trust.durableRelayKeys in ${configPath}`
      : `✓ Wrote trust block to ${configPath} (new)`,
    '',
    'Remaining manual step (one-time):',
    `  1. Open the Blindspark dashboard: ${flags.relay}`,
    '  2. Find the PearTube agent seed request in the review queue and approve it.',
    '  3. (Recommended) add the agent publisher key to the relay allowlist so',
    '     later seed requests auto-accept, then set HIVERELAY_ACCEPT_MODE=allowlist.',
    '',
    'Next: restart the agent and run `peartube-relay library scan`.',
    'Items will move pending-approval → durable as the relay confirms custody.'
  ].join('\n'))
}

main().catch((err) => {
  console.error(`bootstrap-trust failed: ${err?.message || String(err)}`)
  process.exit(1)
})
