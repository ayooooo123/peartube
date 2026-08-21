# Backend diagrams

Two kinds of thing live here, and mixing them up is what makes documentation useless:

- **Explainers** — follow one thing through the system. Read these to *understand* it.
- **References** — exact field layouts and constants. Read these when you already understand it and
  need the byte offsets.

Every label is traced to code. No diagram here describes a plan.

Built with [`diagram-design`](https://github.com/cathrynlavery/diagram-design). Validate with that
skill's `lint-skin.py` and `self_check.py`.

## Explainers

Read in this order. Each one is a single story, and together they cover the backend.

| Diagram | Answers |
|---|---|
| [`one-video.html`](one-video.html) | What happens between picking a file and it playing on someone else's device? |
| [`one-seek.html`](one-seek.html) | How does a video stream peer-to-peer when the player only speaks HTTP? |
| [`one-device-joins.html`](one-device-joins.html) | How does a second device get access to a channel from a short code? |
| [`one-request-refused.html`](one-request-refused.html) | What stops a hostile peer, and why does a friendly one eventually get refused too? |
| [`one-pledge-audited.html`](one-pledge-audited.html) | If a stranger promises to store your video, how do you know they kept it? |
| [`one-op-applied.html`](one-op-applied.html) | Why do two peers replaying the same log end up with different data? |
| [`../architecture.html`](../architecture.html) | What are the pieces, and how do four shells share one backend? |

**Start with `one-video`.** It is the whole system as one story and names where every subsystem sits,
so the others have somewhere to attach.

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
  archive, archive-discovery. A routing tag, not a message type.
- **Scoped network** — the layer that owns peer frames: one session per peer per purpose, with
  admission control and a negotiated frame ceiling.
- **Pledge** — an archivist's signed promise to keep specific byte ranges until a deadline. A promise
  only; the audit loop is what turns it into evidence.
- **Seed pin** — a request asking a peer to keep seeding something durably, authorised by an
  attestation bound to the live connection's Noise key.
- **Playback profile** — the keyframe index and moov position for a blob, so a seek can fetch the
  right blocks instead of walking the file.

## What drawing these found

Three defects surfaced from having to name every arrow, all recorded in `CLEANUP_PLAN.md`:

- Admission budgets are lifetime quotas, not rate limits — `messages` and `bytes` are never given
  back, and `refillPerTick` is declared and never read. (`one-request-refused`)
- The channel invite grants read access plus a roster row, not write authority — so the roster is not
  an authorisation. (`one-device-joins`)
- `apply` in the personal store is non-deterministic — randomness and wall clock feed the view key.
  (`one-op-applied`)

## Conventions

- **One accent per diagram**, chosen deliberately. In `one-video` it marks the single step that is
  PearTube's own code rather than a Holepunch primitive.
- **Mono is for technical content** — offsets, constants, module names. Never decoration.
- **Captions carry the non-obvious fact**, not a restatement of the picture.
- **Honest labels.** Where the code disagrees with its own naming, the diagram says so.

## Not yet drawn

- Discovery records and topic derivation
- Schema codegen — 4,207-line source to 45,261 generated lines across JS and Swift
