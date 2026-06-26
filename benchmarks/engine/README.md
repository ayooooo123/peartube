# Engine benchmark suite

Cross-engine benchmark for evaluating a `BARE_ENGINE` swap in
`react-native-bare-kit` / `bare-kit`. The default engine is **V8** (`libjs`),
which is ~60 MB of the Android `libbare-kit.so`. Swapping it for a smaller
engine (QuickJS via `libqjs`/`libmqjs`, JerryScript via `libjerry`, or
JavaScriptCore via `libjsc`) can cut the native library by an order of magnitude
— but those engines are slower interpreters and may diverge on behaviour, so a
swap must be de-risked on **PearTube's real hot paths** before shipping.

This suite measures exactly that. It is **pure JS with zero dependencies and no
native addons**, so it runs identically under every engine. Heavy crypto/IO
(sodium-native, bare-ffmpeg, …) lives in native C and does **not** change with
the engine, so it is intentionally excluded — what changes is interpreter speed
on protocol framing, hashing, feed logic and serialization.

## What it measures

Real in-repo code (imported when available):
- `feed-hydration.js` — `getVisibleSeededFeedEntries`, `getMissingChannelMetaRequests`,
  and the playback-ready filter (which hits the `/^[a-f0-9]{64}$/i` key regex).

Synthetic mirrors of cost centers (always run):
- FNV canonical hashing (feed-change detection, à la backend `hash-utils`)
- varint + length-prefixed frame round-trip (HRPC wire path)
- `JSON.stringify`/`parse` of a feed snapshot (cache persistence)
- 32-byte key hex encode/decode (constant across the hypercore stack)
- sort + `Set` dedup (feed ordering)

Every workload returns a **content-sensitive** result that is checksummed, so
two engines can be proven to compute the *same* output.

## Run it

```bash
mkdir -p benchmarks/engine/results

# Baseline — V8, via node (or `bare` built with libjs):
node benchmarks/engine/run.mjs --label v8 --out benchmarks/engine/results/v8.json

# Candidates — a `bare` binary built with each engine you want to test:
bare benchmarks/engine/run.mjs --label qjs   --out benchmarks/engine/results/qjs.json
bare benchmarks/engine/run.mjs --label jerry --out benchmarks/engine/results/jerry.json
bare benchmarks/engine/run.mjs --label jsc   --out benchmarks/engine/results/jsc.json

# Compare (first file = baseline):
node benchmarks/engine/compare.mjs \
  benchmarks/engine/results/v8.json \
  benchmarks/engine/results/qjs.json \
  benchmarks/engine/results/jerry.json
```

`--scale N` multiplies the working-set size for longer runs.

## How to read it

- **`x` (slowdown factor)** — candidate latency ÷ baseline. `1.00x` = parity;
  `3.00x` = three times slower. A **geometric-mean slowdown** is printed at the
  end.
- **`ok` column** — `OK` if the candidate's output checksum matches the V8
  baseline, `DIFF` if not. **Any `DIFF` is a correctness divergence** and
  `compare.mjs` exits non-zero. That matters more than speed: it means the
  engine produced a different result on real PearTube logic, and must be
  investigated before the swap ships.

## Caveat

This is the JS-engine slice only. It does **not** capture engine startup time,
memory footprint, GC/FinalizationRegistry timing (which hypercore relies on for
cleanup), or end-to-end P2P replication throughput. Use it as the fast first
gate; follow with an on-device cold-start + replication soak test on the
candidate engine before committing to the `BARE_ENGINE` change.
