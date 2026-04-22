# bare-rpc-swift — PearTube fork

Vendored fork of [`holepunchto/bare-rpc-swift`](https://github.com/holepunchto/bare-rpc-swift) with the `RPC` type converted from a plain `class` to a Swift `actor`.

## Why the fork exists

Upstream's `RPC` class owns mutable state (`pending`, `pendingResponseStreams`, `incomingStreams`, `outgoingStreams`, `buffer`, `nextId`) without any synchronization. In the PearTube native desktop app this state is touched from two threads:

- **Writers**: `request()` calls originate from `@MainActor` callers but hop to the Swift cooperative pool because `HRPC` is non-isolated — `pending[id] = continuation` ends up running on `com.apple.root.user-initiated-qos.cooperative`.
- **Removers**: `receive()` is dispatched via `DispatchQueue.main.async`, so `dispatchFrame()` → `pending.removeValue(...)` runs on the main thread.

The result was a `Dictionary._Variant.setValue` data race and a reproducible `EXC_BAD_ACCESS` during the feed view (many concurrent thumbnail RPCs + many responses). The ad-hoc `RPCGate` in `HostBridgeService.swift` serialized writers against each other but could not cover the write↔remove cross-thread race.

## What changed vs. upstream

- `public class RPC` → `public actor RPC` — all mutable state is actor-isolated.
- `delegate: RPCDelegate?` is now `get`-only; use `setDelegate(_:)` to mutate.
- Added `RPC.sendNonisolated(_:)` so `OutgoingStream` writers and `IncomingRequest.reply/reject` can push frames without an actor hop (send path only reads the weak delegate box, never actor state).
- `IncomingRequest.createResponseStream()` is now `async` because it has to register an outgoing stream on the actor.
- `RPCDelegate` now requires `Sendable`.
- Platforms bumped to macOS 14 / iOS 17 to align with the PearTube target deployment.

`reply()` and `reject()` on `IncomingRequest` remain **sync** by design — they route through `sendNonisolated`, so every `req.reply(...)` and `req.reject(...)` call in generated HRPC handler plumbing still compiles unchanged.

## Upstreaming plan

The actor conversion is potentially contributable upstream. Once the dust settles, reach out to Holepunch — the delta is small (~50 lines net) and doesn't change the wire protocol.
