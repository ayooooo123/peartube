# Relay console design direction

Agreed with JD on 2026-08-27. This replaces the single-scroll archive page.

PearTube is a decentralized debrid provider. The console is the operator surface of a
debrid node, so the object it manages is a **release**: one archived file, with its own
bytes, its own residency, and its own proof that other devices hold it. A **work** is a
grouping of releases, not a row.

## Decisions

| Question | Decision |
|---|---|
| Audience | Operator running a node. Viewers use the app. |
| Primary object | Release (file). |
| Layout | Dense sortable table. |
| Grouping | Flat rows with a Work column and a group-by toggle. |
| Scope | One table for everything, with a state column and filter chips. |
| Liveness | Poll every few seconds. |
| Scale | Hundreds of releases; server-side paging and search. |
| Detail | Right-side drawer on row click. |
| Artwork | None in the console. |
| Keyboard | `/` focuses search, Escape clears. |
| Destructive actions | Confirm dialog naming the release and its backup count. |
| Bulk | Checkbox selection with a bulk action bar. |

## Routes

Real navigation, not anchor jumps.

- `/` → **Releases**. The table. The only page an operator needs open.
- `/discover` → TMDB search and the archive submission forms.
- `/creators` → tracked creators and unseeded targets.
- `/settings` → device authorization, TMDB key, S3 status, storage policy.

## The table

Default order answers *what should I do?* before *what do I have?*:
active transfers, then retryable failures, then completed by recency.

Columns, all sortable. Presence, reachability and durability are three different
facts with three different sources, and the relay contract forbids merging them:

1. **File** — the name the archival source gave it. Falls back to the release id when the
   source named nothing. Never a path, never the work's title.
2. **Work** — title plus coordinates (`S02E07`, year). Blank when the work is unidentified.
3. **Size** — *presence*. The length the signed manifest claims. A `*` marks a release no
   catalog entry names yet, where the length is only what the source reported.
4. **Progress** — this relay's accepted bytes against that claimed length. A catalogued
   release this relay never fetched has no progress at all, not 100%.
5. **State** — queued, acquiring, verifying, publishing, seeding, failed, cancelled.
6. **Reach** — *current reachability*. `complete/independent` peers from the media catalog's
   availability assessment (`availabilityResponse` in `api/media-graph.js`), with state,
   observation time, expiry and reason codes on hover. Absent when nothing assessed it:
   unknown reach is not zero reach.
7. **Backups** — *durability*. Independent archivists holding fresh proof.
8. **Residency** — *local bytes*, and only where they are proven: an acquisition record on
   this relay with accepted bytes, or a local range probe that finds the required ranges in
   the core. Local, Partial, Transferring, Unproven, None. A catalogue entry alone is
   `Unproven`. Proven over the whole shelf before the query runs, so the column sorts and the
   header counts the same values.
9. **Age** — last update, relative.

Search is one free-text box matching file name, work title and coordinates, alongside
filter chips for state and retention. Filters and sort persist in the URL.

## Row actions

| Action | Backing today | Gap |
|---|---|---|
| Cancel | `service.cancelAcquisition` | none |
| Play / copy link | `/play/<candidateRef>` for loopback binds | none |
| Force re-seed | `runtime.requestArchiveMirror` | not exposed on the console |
| Retry | resubmit path exists for relay-owned uploads | a remote-granted source needs a fresh grant from its issuer; the button must say so rather than fail silently |
| Delete release | `api.deleteSource`, guarded by offload evidence | not exposed on the relay service |
| Pin / unpin | retention class is fixed at request time | needs a retention-change API |

Bulk selection applies the same verbs to the current filter. Every destructive action
confirms with the release name and how many other devices hold it.

## Detail drawer

Opens on row click, no route change:

- identity: work, coordinates, publication, manifest, rendition and asset ids;
- residency: local bytes, offloaded bytes, S3 prefix, restore count;
- durability: archivists, last proof, pledge state;
- acquisition: state history and error codes from the event log;
- actions: the same verbs as the row.

## Header

Persistent, one row: active transfers, failures needing attention, releases held, local
disk used against limit, S3 offloaded bytes, peers connected, bytes served.

## Rules

- Every number is measured. No rate or ETA until the acquisition service exposes sampled
  throughput; a lifetime average is not a rate.
- Absent facts render as absent, never as zero.
- Vocabulary is the operator's: release, work, backup, residency, retention.
- The console never invents a title. An unnamed release shows its file name, then its id.

## Shipped on 2026-08-27

`packages/cli/src/release-console-ui.js` renders the console; `packages/cli/src/archive-console.js`
projects the rows (`releasesView`) and answers the queries (`queryReleases`).

- `/` is the table: search, state chips, retention filter, sortable columns, group-by-work,
  checkbox selection, bulk cancel, detail drawer, `/` search focus and Escape.
- `/releases.json` is the same query as JSON; `/releases.html` returns only rows and is what
  the four-second poll fetches, so the page and the poll can never render different tables.
- `/discover`, `/creators` and `/settings` are real routes. The all-in-one page is deleted,
  along with the shelf cards, the transfer list and the helpers only they used.
- Header reads: releases, catalogued, active, failed, unbacked, unproven, peers, held. Held is
  bytes this relay can still prove: the full length of a release with local residency plus the
  accepted bytes of a transfer in flight. A failed attempt's partial bytes are not counted —
  the relay does not report how much of a dead attempt it kept, and a guess would be a claim.
- Residency is proven, never inferred. Two proofs count: an acquisition record on this relay
  with accepted bytes, and a local range probe (`api.getLocalRangeResidency` →
  `core.has(start, end)` over the rendition's required ranges) run for the rows on the visible
  page and cached for 30s. Catalog availability and `candidateRef` are explicitly not proofs:
  the first is evidence about peers, the second comes from an index search. `offlinePlayable`
  looks like the right signal but nothing calls `recordLocalRanges`, so it is structurally
  always false and is not read.
- Known gap: the probe reads the local bitfield. On a relay with S3 block offload on, an
  evicted block is restored from the bucket on read, so a local miss is not proof the relay
  cannot serve it. Such rows say exactly that instead of claiming loss. Per-release offload
  residency needs a per-core proof the offload layer does not expose yet.
- Verified live: the two catalogued titles this relay serves probe `0 of 1` ranges on the
  volume — it holds ~91 MB locally against a 6.4 GB catalog — and read `Unproven` with the
  offload caveat, where the old UI claimed `Local` at `100%`.

Still missing their APIs, and therefore absent from the UI rather than faked: force re-seed,
retry of a remote-granted source, delete release, pin/unpin.

## Follow-ups shipped on 2026-08-27

- **Coordinates were never projected.** The media catalog emitted no `mediaCoordinates`, so every
  relay reader of that field was dead: no season or episode in the console, no TMDB discover
  match, and no `candidateRef`, which quietly removed playback links from catalogued rows.
  `listEntities` now carries a work's signed external references and the catalog projects them
  (`show:<mediaId>:s<season>:e<episode>` → season and episode; a plain reference → film or show
  with its year; no reference → no coordinate). The Work column reads `Lanterns · S01E02`.
- **Cancel and clear.** `manager.cancel` is a no-op on a finished job, so the old button looked
  broken. Cancel now applies only to running work and reports refusals with their reason; a new
  durable `store.forget` clears a finished record with its event log and idempotency index, and
  refuses anything still running. The bulk bar's old `Clear` (which cleared the selection) is
  `Deselect`.
