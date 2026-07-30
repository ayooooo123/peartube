# PearTube Home-Media Seeder — Operator Quickstart

Turn selected media folders into always-available PearTube channels. Your NAS
keeps them online for the audience you choose (your devices, or public) —
without uploading a personal library to any company server.

This guide covers **Phase 2**: the agent + a co-installed HiveRelay on a single
host (Docker / appliance). For the full design, see
[`docs/superpowers/specs/2026-07-24-peartube-seeder-spec.md`](superpowers/specs/2026-07-24-peartube-seeder-spec.md).

## What you need

- Docker (+ Compose), or an appliance that runs compose (Umbrel/StartOS/Unraid).
- A folder of videos you want to seed (read-only mount).
- ~10 GB free for HiveRelay's durable copy + agent state.

## One-line model

```
your media (read-only) → peartube-relay / peartube-seeder (publisher agent) → HiveRelay (durable copy)
                                                                              ↑ opaque keys only
```

The CLI binary is also available as `peartube-seeder` (same entrypoint as `peartube-relay`).

### App pairing (Phase 3 adapter)

When the archive WebUI / control port is up, the agent exposes:

| Method | Path |
|--------|------|
| status | `GET /library/status` |
| scan | `POST /library/scan` |
| confirm public folder | `POST /library/confirm` `{ "folderPath": "…" }` |
| unseed | `POST /library/unseed` `{ "target": "…" }` |
| verify durability | `POST /library/verify` |

Paired PearTube apps call the matching HRPC methods (`library-status`, `library-scan`, …). The host backend proxies to the agent when `PEARTUBE_LIBRARY_AGENT_URL` is set (e.g. `http://127.0.0.1:8174`).

The agent owns meaning (folders, channels, audience, inventory). HiveRelay owns
availability (it holds a durable copy of the published cores). The relay never
learns what "video" or "channel" means — it receives opaque core keys through
its generic seed-request surface.

## 1. Bring up the stack

```bash
# Point PEARTUBE_MEDIA at the folder you want to seed.
PEARTUBE_MEDIA=/mnt/media docker compose -f docker-compose.library.yml up -d
```

Two services come up:
- `peartube-relay` — the publisher agent (scans `/media`, imports, publishes).
- `hiverelay` — Blindspark, the durable relay (management API + dashboard on
  port `9100`).

By default the agent runs in **private** mode and seeds to itself until the
relay trust is wired (items show `self-only`).

## 2. Wire first-run trust (one-time)

The agent and relay run with separate trust. Two one-time actions:

```bash
# Step A (automated): copy the relay's public key into the agent's trust set.
docker compose -f docker-compose.library.yml exec peartube-relay \
  node /app/scripts/library-bootstrap-trust.mjs --relay http://hiverelay:9100
```

This fetches the relay's public key and writes it into the agent's
`trust.durableRelayKeys` so clients treat the relay as a standalone durable
anchor.

```text
Step B (manual, one approval): open the Blindspark dashboard (http://<host>:9100)
and approve the PearTube agent's seed request in the review queue once.
```

After approval, add the agent's publisher key to the relay allowlist and set
`HIVERELAY_ACCEPT_MODE=allowlist` so later seed requests auto-accept. Restart
both services.

## 3. Scan and watch the inventory

```bash
docker compose -f docker-compose.library.yml exec peartube-relay \
  /peartube-relay library scan

# Human-readable inventory:
docker compose -f docker-compose.library.yml exec peartube-relay \
  /peartube-relay library status

# Machine-readable (for dashboards):
docker compose -f docker-compose.library.yml exec peartube-relay \
  /peartube-relay library status --json
```

Items move through states:
```
imported → published → pending-approval → durable
                                     ↘ self-only (relay absent/unreachable)
```

`durable` is only recorded after the relay returns an explicit accept token —
an empty 2xx is treated as "not durable" and the item keeps self-seeding.

## 4. Make a folder public (optional)

Public is **opt-in with a typed confirmation gate** — it is never the default,
and `confirmed: true` can't be implied by the global `mode`.

```bash
# The typed confirmation that unlocks publishing a public folder:
docker compose -f docker-compose.library.yml exec peartube-relay \
  /peartube-relay library confirm /media/PublicMovies
```

Only after confirmation does the agent announce the channel on the public feed.

## 5. Unseed (recall availability)

Unseed is a ship-gate feature — it must work for public content, or the agent
would re-seed it next tick. It runs in a strict order: retract from the feed,
withdraw the relay request, stop local seeding, clear seeded blobs, mark
`unseeded`. **Originals are never touched** (read-only mounts; the agent never
issues an `unlink` under `/media`).

```bash
# Unseed one video, a whole channel, or everything in a folder:
docker compose -f docker-compose.library.yml exec peartube-relay \
  /peartube-relay library unseed /media/PublicMovies/vacation.mp4 --json
```

Honest limit (documented in the spec): unseed stops *availability*; it cannot
recall bytes already fetched by third parties.

## 6. Verify durability

"Available" must be observable, not asserted. The agent spot-checks the relay
every `verifyIntervalHours` (default 24h); you can run it now:

```bash
docker compose -f docker-compose.library.yml exec peartube-relay \
  /peartube-relay library verify --json
```

Failures flip `lastVerifyOk` and surface in `library status`.

## Honesty notes

- **"Private" means your paired devices, not LAN-only.** PearTube LAN discovery
  is not built; pairing works over the DHT and needs internet.
- **No relay → self-only.** If HiveRelay is absent or unreachable, the agent
  keeps seeding itself and says so. Nothing breaks; durability just isn't
  delegated.
- **Friends/invite sharing is deferred** (v1.1+, pending a read-capability
  layer on the blind substrate). Don't expect per-friend access control in v1.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Items stuck at `self-only` | Relay not detected. Check `PEARTUBE_HIVERELAY_ENDPOINT` and that the relay container is up; `detect()` re-probes after a TTL. |
| Items stuck at `pending-approval` | You haven't approved the agent in the Blindspark dashboard yet (Step 2B). This is normal, not an error. |
| `awaitingPublicConfirmation` | A public folder needs `library confirm <path>` (Step 4). |
| Inventory re-imports on restart | Should not happen — fingerprints are persisted. If it does, the inventory file was quarantined; check the agent log for a corrupt-file warning. |
| Quota not enforced | Donation-toggle eviction needs `CacheManager.enforceQuota` wired (Phase 1, ship-gate). Library content is always protected from eviction. |
