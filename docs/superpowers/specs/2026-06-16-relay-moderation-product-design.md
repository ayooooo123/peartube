# Relay Moderation-First Product Design

> Status: product design plan
> Date: 2026-06-16
> Supersedes v1 sequencing in `docs/superpowers/plans/2026-06-15-relay-non-knowledge-implementation.md`.
> Keeps the relay non-knowledge design as a v2/v3 role, not the first product bet.

## Summary

PearTube still needs a public feed. Removing public metadata from the first
relay product would make discovery, browsing, search, and creator growth feel
broken. The v1 relay product should therefore be honest about what it is:

- a **public index / relay-cache** for public PearTube content;
- an **archiver** when the operator deliberately imports and republishes
  content;
- not a true non-knowledge relay when it stores public feed metadata.

The product answer to unwanted public metadata is moderation, posture labeling,
alerts, and operator controls. The true `blind-relay` role remains valuable, but
it is a separate later role: encrypted bytes only, no public feed, no keys, no
metadata index.

## Product Principle

Do not collapse all operator concerns into one "relay" label.

```text
public-index     = knows public metadata, powers discovery, needs moderation
relay-cache      = caches/seeds public content from discovery, bounded by policy
archiver         = publisher role, deliberate content selection
blind-relay      = future role, encrypted bytes only, no metadata or keys
```

If a node stores titles, previews, thumbnails, and maps them to core keys, it is
an indexer. That is fine for public discovery, but the product must not describe
it as non-knowledge.

## Target Users

### Cautious Volunteer Operator

Runs a Docker relay to help the network but does not want surprises.

Needs:
- clear statement of what the node stores;
- conservative defaults;
- alerts when new content starts consuming disk;
- blocklists and allowlists;
- easy shutdown or quarantine of unwanted public metadata/cache entries.

### Community Index Operator

Runs a public discovery node for a community, creator network, or topic.

Needs:
- public feed uptime;
- publisher trust controls;
- report review queue;
- blocklist import/export;
- trending/storage abuse alerts.

### Archive Publisher

Runs `archive` or local mirror intentionally.

Needs:
- clear publisher liability posture;
- source-level job controls;
- archive status and failure alerts;
- separation from opportunistic relay-cache state.

### Future Privacy-Focused Operator

Only wants encrypted-byte conduit behavior.

Needs:
- a future `blind-relay` mode that does not join the public feed;
- a one-sentence promise: "stores encrypted blocks by opaque key; stores no
  content metadata or keys."

## V1 Product Scope

### Keep Public Discovery

Public feed remains a first-class product surface. It can store:

- channel names;
- video titles/descriptions;
- preview manifests;
- thumbnails or thumbnail refs;
- public signed descriptors;
- public availability hints.

This role is not non-knowledge. The UI/CLI should label it as a public metadata
role.

### Add Moderation and Alerts

Moderation is the first product investment. It directly addresses the real
operator fear: inadvertently hosting or amplifying unwanted public metadata or
cached media.

### Make Roles Explicit

Every status output and Docker example should show the node posture:

```json
{
  "roles": ["public-index", "relay-cache"],
  "posture": {
    "storesPublicMetadata": true,
    "storesMediaCache": true,
    "storesArchivePublisherContent": false,
    "storesDecryptionKeys": false,
    "nonKnowledgeRelay": false
  }
}
```

## Non-Goals for V1

- Do not remove public feed.
- Do not make all public discovery encrypted/key-gated.
- Do not add key gossip.
- Do not store decryption keys on relays, even temporarily.
- Do not claim public-index nodes are non-knowledge.
- Do not build panic-wipe or raid-triggered deletion.
- Do not remove or quarantine `archive`; it remains a publisher workflow.

## Operator Modes

### Public Index + Relay Cache (Default Network Helper)

Recommended for operators who want to help discovery and availability.

```yaml
PEARTUBE_NODE_ROLES: public-index,relay-cache
PEARTUBE_DISCOVERY_ENABLED: "true"
PEARTUBE_DISCOVERY_SEED_DISCOVERED: "true"
PEARTUBE_MODERATION_MODE: report-and-alert
PEARTUBE_ARCHIVE_ENABLED: "false"
```

Behavior:
- joins public feed;
- stores public metadata;
- caches/seeds public content within quota;
- applies moderation rules before indexing or cache admission;
- emits alerts for unusual or blocked content.

### Curated Public Index

Recommended for cautious operators who still want public metadata.

```yaml
PEARTUBE_NODE_ROLES: public-index,relay-cache
PEARTUBE_POLICY: allowlist
PEARTUBE_ADMISSION_CHANNELS: channelKey1,channelKey2
PEARTUBE_ADMISSION_OWNERS: ownerKey1
PEARTUBE_MODERATION_MODE: enforce
```

Behavior:
- indexes only configured channels/owners;
- rejects discovered public content by default;
- still offers public UX for curated content.

### Archive Publisher

Recommended only when the operator deliberately chooses sources.

```yaml
PEARTUBE_NODE_ROLES: archiver,public-index,relay-cache
PEARTUBE_ARCHIVE_ENABLED: "true"
PEARTUBE_ARCHIVE_SOURCES: https://youtube.com/@example
```

Behavior:
- operator is publisher for archived content;
- archive entries are marked separately from relay-cache entries;
- archive jobs trigger publisher-role alerts.

### Future Blind Relay

Not v1 default.

```yaml
PEARTUBE_NODE_ROLES: blind-relay
PEARTUBE_DISCOVERY_ENABLED: "false"
PEARTUBE_PUBLIC_INDEX: "false"
PEARTUBE_STORE_KEYS: "false"
```

Behavior:
- announces relay capability;
- accepts encrypted opaque core refs;
- stores no public metadata and no keys;
- serves encrypted blocks only.

## Moderation Model

### Moderation Lists

V1 should support lists by:

- `channelKey`;
- `ownerKey`;
- `videoId`;
- `blobsCoreKey`;
- source URL/domain for archive jobs;
- descriptor hash or public feed entry hash.

Each list entry has:

```json
{
  "targetType": "channelKey",
  "target": "hex-or-string",
  "action": "block|quarantine|allow|watch",
  "reason": "operator supplied text",
  "createdAt": 0,
  "expiresAt": 0,
  "source": "local|imported|report"
}
```

### Actions

`allow`
: Explicitly permits indexing/caching in allowlist or curated mode.

`watch`
: Allows content but raises alerts and exposes it in review surfaces.

`quarantine`
: Hides from public feed output, stops new seeding/cache admission, keeps enough
  local audit state for the operator to review what happened. It is not a
  panic-wipe.

`block`
: Rejects future indexing/cache admission and hides current public feed output.
  Media cache cleanup follows normal explicit cache eviction rules.

### Quarantine Semantics

Quarantine is a moderation state, not evidence destruction.

It should:
- stop new public announcements from the node;
- prevent new cache fills for that target;
- keep a minimal local audit record;
- tell the operator what action triggered it;
- require explicit operator action to unblock.

It should not:
- delete data because of a raid or investigation trigger;
- pretend already-gossiped public metadata never existed;
- silently wipe archive publisher content.

## Alert Model

Alerts are operator-facing events with severity, category, target, and suggested
action.

```json
{
  "id": "alert-id",
  "severity": "info|warning|critical",
  "category": "posture|moderation|storage|archive|network",
  "targetType": "channelKey",
  "target": "hex-or-string",
  "summary": "New unknown publisher is consuming cache",
  "createdAt": 0,
  "acknowledgedAt": 0,
  "suggestedActions": ["watch", "quarantine", "block"]
}
```

### Required Alerts

Posture:
- node is running public-index and therefore stores public metadata;
- node is running archiver and therefore publishing selected content;
- node combines public-index and future blind-relay roles.

Moderation:
- blocklisted target appears in public feed gossip;
- watched target appears or starts trending;
- report threshold exceeded;
- quarantine applied.

Storage:
- one owner/channel exceeds percentage of cache budget;
- cache fills unusually quickly;
- eviction pressure is high;
- archive job would crowd out relay-cache budget.

Archive:
- archive job created from public URL;
- archive source starts importing many items;
- archive job fails repeatedly;
- archive publishes a new channel/video.

Network:
- public feed has peers but no accepted entries;
- relay-cache is serving no content despite discovery enabled;
- known bad or blocked source is repeatedly reappearing.

## Operator Surfaces

### CLI Status

`peartube-relay status` should lead with posture.

Example:

```text
roles: public-index,relay-cache
posture: stores public metadata; stores public media cache; stores no keys
moderation: 2 blocked, 1 quarantined, 4 watched
alerts: 1 critical, 3 warnings
storage: 42GB / 100GB
archive: disabled
```

JSON status includes full machine-readable posture, moderation summary, and
latest alerts.

### Archive Web UI

The existing archive UI becomes the natural operator dashboard. V1 additions:

- Posture banner.
- Alerts list.
- Moderation review queue.
- Block/watch/quarantine buttons.
- Cache/storage pressure chart.
- Archive publisher section stays clearly separate.

### Docker Compose

Examples should show posture-first configuration:

```yaml
services:
  peartube-public-relay:
    image: ghcr.io/ayooooo123/peartube-relay:latest
    environment:
      PEARTUBE_NODE_ROLES: public-index,relay-cache
      PEARTUBE_MODERATION_MODE: report-and-alert
      PEARTUBE_DISCOVERY_ENABLED: "true"
      PEARTUBE_DISCOVERY_SEED_DISCOVERED: "true"
      PEARTUBE_ARCHIVE_ENABLED: "false"
      PEARTUBE_STORAGE_MAX_BYTES: 107374182400
```

## Report Flow

V1 can keep reports local to each operator.

```text
viewer/operator report -> local moderation queue -> operator action
```

Report payload:

```json
{
  "targetType": "channel|video|owner|blobCore|feedEntry",
  "target": "id-or-key",
  "reason": "spam|abuse|copyright|malware|other",
  "comment": "optional text",
  "createdAt": 0,
  "reporter": "local|remote"
}
```

Remote signed reports can come later. V1 should not depend on global moderation
consensus.

## Data Boundaries

### Public Index State

May persist plaintext public metadata. This is expected and should be labeled.

### Relay Cache State

May persist which public channels/videos are cached today. V1 moderation-first
does not try to make this fully non-knowledge, but it should avoid unnecessary
self-authored "I serve this video" network claims when easy.

### Archive State

May persist named source URLs, job logs, and published metadata. This is
publisher state and should remain separate from relay-cache state.

### Future Blind Relay State

Must persist only opaque encrypted-byte operational state. This is out of v1
moderation scope.

## Product Copy

Use honest operator language:

- "Public index: stores public channel/video metadata for discovery."
- "Relay cache: stores public media cache within your limits."
- "Archive: you are the publisher for imported content."
- "Blind relay: encrypted blocks only, no metadata or keys." (future role)

Avoid:

- "anonymous relay";
- "private relay" for public-index nodes;
- "non-knowledge" for nodes storing public metadata;
- "safe" as a legal promise.

## Rollout Plan

### Phase 1: Posture and Role Clarity

Goal: operators know what they are running.

Deliver:
- `PEARTUBE_NODE_ROLES`;
- posture fields in status JSON;
- posture banner in archive UI;
- Docker examples split into public relay, curated relay, archive publisher;
- docs explaining public-index vs relay-cache vs archiver vs future blind-relay.

### Phase 2: Local Blocklists and Quarantine

Goal: operators can stop unwanted public metadata/cache admission.

Deliver:
- moderation list store;
- config/env imports for block/allow/watch lists;
- admission checks before public feed indexing and relay cache seeding;
- quarantine state in catalog/status;
- CLI commands to add/remove/list moderation entries.

### Phase 3: Alerts

Goal: operators notice risky or surprising behavior.

Deliver:
- alert event store;
- status summary;
- archive UI alerts list;
- threshold alerts for storage spikes, unknown owners, repeated reports, archive
  imports, and blocked-target reappearance;
- acknowledge/resolve actions.

### Phase 4: Review Queue and Operator Dashboard

Goal: moderation becomes usable without tailing logs.

Deliver:
- report/review queue in archive UI;
- one-click watch/quarantine/block;
- target detail page with channel/video/core refs and current cache status;
- exportable moderation/audit log.

### Phase 5: Public Metadata Hygiene

Goal: reduce unnecessary self-authored metadata claims without breaking public
feed UX.

Deliver:
- remove or reduce relay-authored `relayServing` claims where possible;
- distinguish publisher-authored public metadata from relay cache state;
- keep public feed powered by publisher descriptors and indexer state, not cache
  self-promotion.

### Phase 6: Revisit Blind Relay

Goal: add the stronger encrypted-byte role only after the public operator product
is stable.

Deliver later:
- encrypted blob refs;
- no public feed join;
- no key storage;
- no plaintext metadata;
- optional relay-to-relay opaque core gossip.

## Success Metrics

Operator comprehension:
- status clearly identifies node posture;
- Docker examples make role choices obvious.

Moderation effectiveness:
- blocklisted content is not indexed or newly cached;
- quarantined content disappears from this node's public output;
- operators can identify why a target was admitted.

Operational health:
- public feed still works;
- playback availability does not regress from moderation changes;
- cache admission remains bounded by policy;
- archive jobs remain explicit and separated.

Trust:
- docs do not overclaim non-knowledge for public-index nodes;
- future blind-relay mode has a clean, separate product promise.

## Risks and Tradeoffs

### Moderation Is Not Non-Knowledge

Moderation assumes the node can know enough to block or quarantine public
metadata. That is acceptable for public-index nodes, but the product must be
honest.

### Public Metadata Can Still Be Unwanted

Blocklists and alerts reduce surprise; they do not prevent all unwanted content
from arriving before the operator has rules.

### Correlation Remains Possible

If public metadata maps a video to a core key elsewhere, someone can correlate a
relay-cache node serving that core with the public index. This is not solved by
moderation.

### Too Many Modes Can Confuse Operators

Use three v1 product labels only: `public-index`, `relay-cache`, `archiver`.
Keep `blind-relay` documented as future/separate until it is real.

## Decision

Proceed with a moderation-first relay product:

1. Keep public feed.
2. Make node roles/posture explicit.
3. Add blocklists, quarantine, alerts, and dashboard surfaces.
4. Keep archive as a clear publisher role.
5. Defer key gossip and true blind relay to later phases.
