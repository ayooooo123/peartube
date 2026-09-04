# Catalog scale v2

## Decision

Catalog sync v2 is a framed, resumable suffix protocol over the publisher
Autobase view's causal journal. `Autobase.apply` remains the authoritative
deterministic reducer and Hyperbee remains the materialized view. The serving
cursor walks accepted journal records in linearized apply order rather than the
operation-id index. Pages are still byte-trimmed below the 64 KiB peer frame.

The follower durably journals each verified causal page before advancing its
cursor. Intermediate pages defer the materialized-view rebuild; the terminal
page performs one deterministic reduction of the accumulated suffix. A process
restart therefore resumes at the last committed operation without retaining a
catalog-sized JavaScript array. A newer head in the same catalog epoch extends
the journal and reuses the cursor, so a new title transfers only its suffix.

This combines the native Autobase linearized journal with snapshot/diff and a
small sync subprotocol. Separate authority cores were rejected because they
introduce cross-core atomicity and availability problems. A second follower
Autobase was rejected because accepted-page transport cannot safely recreate
the producer's writer feeds and causal clocks. Full signed snapshots were
rejected as the steady-state mechanism because they retransmit O(N) state for
one title; the existing signed head remains the completion commitment.

## Invariants and bounds

- A follower never journals data before its causal authority: the server reads
  the producer's append-only causal journal, whose genesis and admission
  precede writer data.
- A cursor is persisted only after its page is verified and journaled.
- Page memory is at most 64 records and less than 63 KiB encoded. There is no
  whole-catalog session buffer. Session admission remains capped at 4,096
  records, 4 MiB, 128 pages, and 8,192 verification-work units.
- Initial transfer is O(N) records and O(ceil(N/64)) round trips. Materializing
  a completed initial or resumed walk performs one O(N) deterministic rebuild,
  rather than one rebuild per page. A normal new-title sync transfers O(changes)
  records and performs one O(N) checkpoint rebuild; it never creates O(N²)
  churn. Incremental Hyperbee checkpoint application is a future optimization,
  not a correctness dependency.
- Operation IDs authenticate record identity but never define causal order.
- The terminal reconstructed head and authorization digest must equal the
  signed advertised head or the walk fails closed.

## Versioning and migration

Scoped network `PROTOCOL_MAJOR` is 3, catalog page payloads are version 2, and
the host `PROTOCOL_VERSION` is 10. Protocol-major separation changes discovery
topics and handshake validation, so a v3 follower and the running v0.2.40/v2
relay do not exchange catalog frames; they fail closed instead of interpreting
hash pages as causal pages. Persisted v1 sync cursors are deliberately ignored.

Migration is a coordinated image rollout: keep v0.2.40 serving its v2 mesh,
publish the v3 image, move seed/relay instances to v3, then move clients. During
the overlap the meshes are isolated and old clients retain their last verified
local views. Once enough v3 relays are available, retire v0.2.40. No catalog
re-seed is required: publishers derive causal pages from their existing journal.

## Risks

Cursor lookup currently scans the bounded journal to find an operation ID;
adding an ordinal-to-operation Hyperbee index would reduce server seek cost.
Authority conflicts and root rotation still use the full deterministic reducer,
which is intentional because they can change authorization of earlier records.
The journal cap remains a product capacity limit and should be raised only with
storage and abuse-budget review.
