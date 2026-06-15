# Relay Offload Anchor — Design Spec

Status: proposed (follow-up to the upload-offload feature on
`claude/storage-threshold-tracking-6o75g9`).

## Background

Upload offload (`packages/backend/src/upload-offload.js`) lets a user free the
local bytes of their own uploaded video once a **full copy is provably held
elsewhere**. Eligibility is satisfied by any of:

- a **relay** full copy (durable anchor), or
- an **own-device** full copy (durable anchor), or
- at least `minFullCopyPeers` (default 2) independent live full copies.

The own-device anchor is wired: each device records the Hyperswarm/Noise key it
replicates under in its channel writer record (`swarmKeyHex`), and
`api.getOwnDeviceSwarmKeys()` reads them back so a connected blob peer can be
recognised as one of the user's devices.

The **relay anchor is not yet auto-wired**. `getKnownDurableRelayKeys()` returns
keys from an optional `ctx.trustedRelayKeys` list (a host can populate it), but
there is **no automatic, client-side discovery** of the relay's swarm key. This
spec defines that discovery.

## Goal

A client should learn, with reasonable trust, the swarm/Noise public key(s) of
the always-on relay/blind peer(s) seeding the public network, so that a single
relay full copy can satisfy offload eligibility (bypassing the ≥2-live-peers
threshold). The relay key must be the **same identifier** that appears as a blob
core peer's `remotePublicKey` (it is: the relay's `blindPeer.publicKey` /
`ctx.swarm.keyPair.publicKey` is its Noise key).

## Current state (relevant facts)

- The relay is a Holepunch blind peer. Its swarm key is
  `relay-blind-peer.js` → `publicKey = toHexKey(blindPeer.publicKey ||
  ctx.swarm?.keyPair?.publicKey)`. It is **persisted per node** (`swarm-key.json`)
  so it is stable across restarts.
- The relay joins the canonical network topic and runs the **public-feed gossip
  protocol** (`public-feed.js`), a single protomux channel
  (`protocol: PROTOCOL_NAME`) whose messages are plain JSON (`encoding: c.json`)
  dispatched by a `type` field (`SUBMIT_CHANNEL`, `HAVE_FEED`, `NEED_FEED`,
  `FEED_RESPONSE`, `AVAILABILITY_HINT_REQUEST/RESPONSE`).
- Because the channel is `c.json`, **adding a new message type needs no schema
  regeneration** and is ignored by peers that don't handle it — additive and
  backward-compatible.

## Design

### 1. `RELAY_ANNOUNCE` gossip message

Add one feed message type, sent by a node that is running as a relay/blind peer:

```js
{
  type: 'RELAY_ANNOUNCE',
  relayKey: '<64-hex noise/swarm public key>',  // === remotePublicKey on replication
  caps: ['mirror'],                              // capability tags (extensible)
  ts: <ms epoch>,                                // freshness, last-writer-wins
  sig: '<hex>'                                   // optional; see Trust model
}
```

- **Emit:** when the relay's blind-peer surface starts (`createRelayBlindPeer`
  succeeds), the relay sets a flag/value on `ctx` (e.g. `ctx.relayAnnounce = {
  relayKey, caps }`). On every feed channel `onopen`, and on a slow periodic
  re-broadcast (~5 min), `PublicFeed` sends `RELAY_ANNOUNCE` to connected peers
  if `ctx.relayAnnounce` is set. Re-gossip is **not** required (unlike
  `SUBMIT_CHANNEL`) — clients learn directly from the relay they connect to,
  which avoids a forged-relay amplification vector.
- **Receive:** `handleMessage` adds an `else if (msg.type === 'RELAY_ANNOUNCE')`
  branch that validates and records the key (below).

### 2. Trust model (important)

A naive "any peer can claim to be a relay" is unsafe: a malicious peer could
announce its own key as a relay so the client offloads after seeing only that
one peer hold a copy — then the peer disconnects and the upload is lost. Two
mitigations, in increasing strength:

- **A — connection-bound (minimum, ship first):** only accept a
  `RELAY_ANNOUNCE` whose `relayKey` **equals the announcing connection's
  `remotePublicKey`**. This proves the announcer *is* the key it claims (it
  controls that Noise identity), so when that same key later appears holding a
  full blob copy, it is genuinely the node we vetted. This does **not** prove the
  node is *durable* — a hostile node can still self-declare — so pair it with:
- **B — operator allowlist (recommended for "bypass ≥2 with a single copy"):**
  gate the *single-copy bypass* on the relay key also being present in a trusted
  set — `ctx.trustedRelayKeys` (already supported) and/or a small signed
  allowlist shipped with the app / published on the feed by a network key. An
  un-allowlisted `RELAY_ANNOUNCE` may still **count as one redundancy peer**
  (it's a real connected full-copy holder) but must not by itself be treated as a
  standalone durable anchor.

Net rule:

| Relay key source                            | Effect on eligibility                    |
|---------------------------------------------|------------------------------------------|
| `ctx.trustedRelayKeys` (operator config)    | standalone durable anchor                |
| Signed network allowlist (optional, future) | standalone durable anchor                |
| `RELAY_ANNOUNCE`, connection-bound only     | counts toward ≥2 redundancy, **not** a standalone anchor |

This keeps the safety property intact: a single unauthenticated party can never
cause an eviction.

### 3. Persistence

- Maintain an in-memory `Map<relayKeyHex, { caps, ts, source }>` on `PublicFeed`
  (or a small dedicated `RelayRegistry`).
- Persist allowlisted/seen relay keys to disk (reuse the `known-peers.js`
  pattern) so the anchor survives restarts and is available before the relay
  reconnects. Expire entries not re-announced within a TTL (e.g. 24h) to avoid
  trusting a decommissioned relay forever.

### 4. Wiring to offload

- `getKnownDurableRelayKeys()` returns the union of:
  - `ctx.trustedRelayKeys` (existing), and
  - persisted relay keys whose `source` qualifies as a **standalone anchor**
    (config/allowlist), per the trust table.
- Connection-bound-only relay keys are surfaced separately (e.g.
  `getRedundancyRelayKeys()`), and `collectFullCopyPeers` / the assessment count
  them only toward the redundancy threshold. (Concretely: they need no special
  handling — they already appear as ordinary `fullCopyKeys`, so the default ≥2
  path covers them. Only the *standalone-anchor* set needs the relay tag.)

So in practice, **phase 1 requires no change to the eligibility math**: a
connection-bound relay is just another live full-copy peer. The relay *tag* only
matters for the single-copy bypass, which stays gated on `trustedRelayKeys`.

## Security considerations

- **Forged relay:** mitigated by connection-binding (A) + allowlist gating of the
  bypass (B). Worst case for an un-allowlisted announcer: it counts as one of the
  two required redundancy peers — identical to today's behaviour for any peer.
- **Replay / stale:** `ts` + last-writer-wins + TTL expiry; a relay that goes
  away stops re-announcing and ages out.
- **Amplification:** no re-gossip of `RELAY_ANNOUNCE`; clients trust only the
  relay they directly connect to.
- **Privacy:** announces only a public swarm key the relay already exposes by
  connecting; no new information leak.

## Testing plan

- **Unit (pure, runnable in CI/node):**
  - `RELAY_ANNOUNCE` accepted only when `relayKey === connection.remotePublicKey`
    (reject mismatch).
  - Registry TTL expiry and last-writer-wins on `ts`.
  - `getKnownDurableRelayKeys()` returns config + allowlisted keys, and
    **excludes** connection-bound-only keys.
  - Eligibility: an allowlisted relay full copy → eligible alone; a
    connection-bound relay full copy alone → NOT eligible (needs the 2nd peer).
    (Extends `upload-offload.test.mjs`.)
- **Integration (needs corestore + swarm, on-device/CI):**
  - Two-node: relay announces, client records, client offloads an upload whose
    only other full copy is the relay (with the relay in `trustedRelayKeys`).
  - Negative: non-relay peer announces a forged relay key; client does not grant
    a standalone anchor.

## Rollout

1. **Phase 1 (low risk):** add `RELAY_ANNOUNCE` (emit + connection-bound receive +
   in-memory registry). No eligibility-math change — relays count as redundancy
   peers. Operators still use `ctx.trustedRelayKeys` for the single-copy bypass.
2. **Phase 2:** persist the registry (known-peers-style) + TTL; expose a
   standalone-anchor set sourced from config/allowlist.
3. **Phase 3 (optional):** a signed network allowlist published on the feed so the
   single-copy bypass works without per-host config.

## Files touched (estimate)

- `packages/backend/src/relay-blind-peer.js` — set `ctx.relayAnnounce` on start.
- `packages/backend/src/public-feed.js` — emit on `onopen` + periodic; handle
  `RELAY_ANNOUNCE` with connection-binding; registry.
- `packages/backend/src/known-peers.js` (or a new `relay-registry.js`) —
  persistence + TTL.
- `packages/backend/src/api.js` — `getKnownDurableRelayKeys()` reads config +
  standalone-anchor registry keys.
- Tests: `upload-offload.test.mjs` (eligibility), new `relay-registry.test.mjs`.
