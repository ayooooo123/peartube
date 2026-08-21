# Backend diagrams

Two kinds of thing live here, and mixing them up is what makes documentation useless:

- **Explainers** — follow one thing through the system. Read these to *understand* it.
- **References** — exact field layouts and constants. Read these when you already understand it and
  need the byte offsets.

Every label is traced to code. No diagram here describes a plan.

Built with [`diagram-design`](https://github.com/cathrynlavery/diagram-design). Validate with that
skill's `lint-skin.py` and `self_check.py`.

## Explainers — start here

| Diagram | Answers |
|---|---|
| [`one-video.html`](one-video.html) | What actually happens between picking a file and it playing on someone else's device? |
| [`one-device-joins.html`](one-device-joins.html) | How does a second device get access to a channel from a short code? |
| [`one-request-refused.html`](one-request-refused.html) | What stops a hostile peer, and why does a friendly one eventually get refused too? |
| [`../architecture.html`](../architecture.html) | What are the pieces, and how do four shells share one backend? |

**Read `one-video` first.** It is the whole system as a single story, and it names where every
subsystem sits, so the references below have somewhere to attach.

## References

| Diagram | Answers |
|---|---|
| [`peer-frame.html`](peer-frame.html) | Exact byte layout of a scoped-network peer frame |

## Glossary of terms that only exist in this codebase

- **Peer frame** — one message sent directly between two PearTube peers, defined in
  `network/frame.js`, used only by `network/scoped-runtime.js`. It is *not* Hypercore replication
  traffic; Hypercore handles its own. This is the envelope for PearTube's own requests, and its 14
  type names say what they are: `locator`, `probe`, `asset-block-{request,proof,chunk,unavailable}`,
  `archive-{request,pledge,challenge,challenge-proof}`,
  `archive-block-{request,proof,chunk,unavailable}`.
- **Purpose** — which of six topic roles a frame belongs to: bootstrap, publisher, asset, live,
  archive, archive-discovery. It is a routing tag, not a message type.
- **Scoped network** — the layer that owns peer frames: one session per peer per purpose, with
  admission control and a negotiated frame ceiling.
- **Pledge** — an archivist's signed promise to keep specific byte ranges until a deadline. A promise
  only; the audit loop is what turns it into evidence.
- **Seed pin** — a request asking a peer to keep seeding something durably, authorised by an
  attestation bound to the live connection's Noise key.

## Conventions

- **One accent per diagram**, chosen deliberately. In `one-video` it marks the single step that is
  PearTube's own code rather than a Holepunch primitive.
- **Mono is for technical content** — offsets, constants, module names. Never decoration.
- **Captions carry the non-obvious fact**, not a restatement of the picture.
- **Honest labels.** Where the code disagrees with its own naming, the diagram says so. See
  `CLEANUP_PLAN.md` at the repo root.

## Not yet drawn

Listed so the gap is visible rather than implied. Verified facts in hand for the first three:

- Playback read path — 16 MiB max priority span, 15 s priority timeout, 10 s finding-peers lease
- Seed-pin exchange — 256 KiB frames; `seed-pin/auth.js:371` verifies with `expectedIdentity` **and**
  `expectedDevice: remotePublicKey`
- Personal store `apply`, including the determinism defect
- Discovery records and topic derivation
- Schema codegen — 4,207-line source to 45,261 generated lines across JS and Swift
