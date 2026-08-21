# Backend diagrams

One overview, then a deep dive per subsystem. Each diagram is a self-contained HTML file that opens
offline, plus a PNG for embedding. Every label is traced to code — no diagram describes a plan.

Built with [`diagram-design`](https://github.com/cathrynlavery/diagram-design). Regenerate a PNG by
opening the HTML and exporting the `<svg>`; validate with that skill's `lint-skin.py` and
`self_check.py`.

## Start here

| Diagram | Answers | Type |
|---|---|---|
| [`../architecture.html`](../architecture.html) | What are the pieces and how do four shells share one backend? | Architecture |

## Deep dives

| Diagram | Answers | Type |
|---|---|---|
| [`peer-frame.html`](peer-frame.html) | What is actually on the wire between two peers, byte for byte? | Data model |

## Reading order

The overview names the four storage primitives and the transport. The deep dives open one box each.
If you only read two, read the overview and `peer-frame` — the frame is where the protocol claims
become concrete.

## Conventions

- **One accent per diagram.** The coral element is the thing to look at first, and it is chosen
  deliberately: the generated contract in the overview, the declared length in the frame.
- **Mono is for technical content** — offsets, constants, encodings. Never decoration.
- **Captions carry the non-obvious fact**, not a restatement of the picture.
- **Honest labels.** Where the code disagrees with its own naming, the diagram says so rather than
  flattering the design. See `CLEANUP_PLAN.md` at the repo root for the audit those notes come from.

## Not yet drawn

Deliberately listed so the gap is visible rather than implied. Each needs its facts verified against
code first:

- Playback sparse read path — `blob-playback-service.js`, `blob-range-priority.js`
  (16 MiB max priority span, 15 s priority timeout, 10 s finding-peers lease)
- Admission control lifecycle — `network/admission.js`, as a state machine
- Seed-pin durability exchange — `seed-pin/*`, including the attestation bound to the live Noise key
- Upload and publish pipeline — `upload.js` through manifest signing and catalog announce
- Channel and device enrolment — `channel/pairer.js` over `blind-pairing`
- Personal store `apply` — `personal/personal-store.js`, including the determinism defect
- Discovery records and topics — `discovery/*`, `network/topics.js`
- Schema codegen — one 4,207-line source to 45,261 generated lines across JS and Swift
