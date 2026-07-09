# Chromecast Device Discovery Repair Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shared backend reliably discover IPv4 Chromecast devices by listening on the mDNS multicast port and resolving DNS-SD records across packets.

**Architecture:** Extract bounded DNS wire parsing into `cast/mdns.js`. Keep `DeviceDiscoverer` responsible for its injected/cancellable UDP lifecycle, a Chromecast-specific record cache, and event emission from diffs of the merged public device view. Preserve the RPC and UI shape, while correcting `CastContext` so removing a manual collision can reveal the still-discovered device.

**Tech Stack:** JavaScript ES modules, Bare Runtime, `bare-dgram`/`udx-native`, `bare-events`, Brittle, Node `assert`.

**Spec:** `docs/superpowers/specs/2026-07-09-chromecast-device-discovery-design.md`

---

## File Structure

- Create `packages/backend/src/cast/mdns.js`: mDNS constants, multicast PTR query encoding, bounded DNS response parsing, DNS-name normalization, and IPv4 ordering.
- Modify `packages/backend/src/cast/discovery.js`: injected socket lifecycle, exported internal record-cache helpers, Chromecast resolution, merged public-device reconciliation, and manual/discovered ownership.
- Modify `packages/backend/src/cast/index.js`: keep `CastContext`'s mirror synchronized when removing a manual collision reveals a discovered device.
- Create `packages/backend/test/cast-mdns.test.mjs`: synthetic DNS wire-format and malformed-RDATA tests.
- Create `packages/backend/test/cast-discovery.test.mjs`: fake-socket lifecycle, cross-packet resolution, TTL-zero, collision, and event tests.
- Create `packages/backend/test/cast-context-discovery.test.mjs`: `CastContext` forwarding and manual-collision regression.

No schema, protocol, app handler, Android, or UI file changes.

## Chunk 1: Wire Parsing, Lifecycle, and Record Resolution

### Task 1: Extract and harden the mDNS wire parser

**Files:**
- Create: `packages/backend/src/cast/mdns.js`
- Modify: `packages/backend/src/cast/discovery.js:12-208,348-355`
- Create: `packages/backend/test/cast-mdns.test.mjs`
- Create: `packages/backend/test/cast-discovery.test.mjs`

- [ ] **Step 1: Write failing wire-format tests**

In `cast-mdns.test.mjs`, define local `dnsName`, `record`, `response`,
`srvData`, and `txtData` builders. Add these exact cases:

```js
test('buildQuery creates one multicast PTR question without QU', () => {
  const packet = buildQuery('_googlecast._tcp.local.')
  assert.equal(packet.readUInt16BE(4), 1)
  assert.equal(packet.readUInt16BE(packet.length - 4), DNS_TYPE.PTR)
  assert.equal(packet.readUInt16BE(packet.length - 2), 1)
})

test('parseResponse decodes all Chromecast DNS-SD record types', () => {
  const parsed = parseResponse(response([
    record(SERVICE, DNS_TYPE.PTR, dnsName(INSTANCE)),
    record(INSTANCE, DNS_TYPE.SRV, srvData(8009, TARGET)),
    record(INSTANCE, DNS_TYPE.TXT, txtData({ fn: 'Kitchen TV', md: 'Chromecast' })),
    record(TARGET, DNS_TYPE.A, Buffer.from([192, 168, 1, 25])),
  ]))
  assert.equal(parsed.records[0].ptr, normalizeDnsName(INSTANCE))
  assert.equal(parsed.records[1].name, normalizeDnsName(INSTANCE))
  assert.equal(parsed.records[1].target, normalizeDnsName(TARGET))
  assert.equal(parsed.records[1].port, 8009)
  assert.deepEqual(parsed.records[2].txt, { fn: 'Kitchen TV', md: 'Chromecast' })
  assert.equal(parsed.records[3].address, '192.168.1.25')
})

test('parseResponse rejects invalid packet framing and compression loops', () => {
  assert.equal(parseResponse(Buffer.alloc(11)), null)
  assert.equal(parseResponse(pointerLoopResponse()), null)
  assert.equal(parseResponse(truncatedRecordResponse()), null)
})

test('parseResponse ignores malformed typed RDATA and continues with later records', () => {
  const parsed = parseResponse(response([
    record(INSTANCE, DNS_TYPE.SRV, truncatedEmbeddedNameSrvData()),
    record(TARGET, DNS_TYPE.A, Buffer.from([192, 168, 1, 25])),
  ]))
  assert.equal(parsed.records.length, 2)
  assert.equal(parsed.records[0].target, undefined)
  assert.equal(parsed.records[1].address, '192.168.1.25')
})

test('normalizes names and orders IPv4 addresses numerically', () => {
  assert.equal(normalizeDnsName('Kitchen.LOCAL.'), 'kitchen.local')
  assert.ok(compareIpv4('192.168.1.2', '192.168.1.10') < 0)
})
```

`pointerLoopResponse()` points an owner name at its own pointer offset.
`truncatedRecordResponse()` advertises RDATA beyond the packet. The malformed
SRV helper has a valid record boundary but an unterminated target name inside
that RDATA.

- [ ] **Step 2: Run RED**

Run `npx brittle test/cast-mdns.test.mjs` from `packages/backend`.

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/cast/mdns.js`.

- [ ] **Step 3: Implement `cast/mdns.js`**

Export:

```js
export const MDNS_ADDRESS = '224.0.0.251'
export const MDNS_PORT = 5353
export const DNS_TYPE = Object.freeze({ A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 })
export function normalizeDnsName(name) { /* lowercase, remove one trailing dot */ }
export function compareIpv4(left, right) { /* compare four numeric octets */ }
export function buildQuery(serviceName) { /* one PTR/IN question, no QU bit */ }
export function parseResponse(buffer) { /* behavior below */ }
```

Use a private bounded `decodeName(buffer, offset, inlineLimit)` that:

- checks label, pointer-byte, and pointer-target bounds;
- permits a compression pointer to target elsewhere in the whole message;
- prevents uncompressed label bytes from crossing `inlineLimit` (the record's
  RDATA end for embedded PTR/SRV names);
- rejects label lengths over 63 and more than 32 pointer jumps.

`parseResponse` returns `null` for invalid packet framing, question/owner-name
corruption, or a record whose declared RDATA exceeds the packet. Once the
record boundary is known, malformed PTR/SRV/TXT typed data leaves that parsed
record without its typed fields and continues from the declared RDATA end.
Return one ordered `records` array spanning answer, authority, and additional
sections. Every record retains `name`, `type`, `class`, `ttl`, `rdata`, and
`dataKey` (RDATA hex). Normalize every decoded owner, PTR, and SRV target name
before returning it, so packet-local and cached comparisons are consistently
case-insensitive.

- [ ] **Step 4: Adapt the existing handler without changing behavior**

Import the new helpers into `discovery.js`, re-export `MDNS_ADDRESS` and
`MDNS_PORT`, delete the old parser, and change only:

```js
const allRecords = response.records
```

Keep its current same-packet resolution until Task 3. In
`cast-discovery.test.mjs`, add one complete-packet state regression that calls
`_handleMessage(packet)` on an idle discoverer and asserts `getDevices()`
contains the expected device. This proves the parser API migration did not
disable existing discovery; it does not assert events while idle.

- [ ] **Step 5: Run GREEN**

Run:

```bash
npx brittle test/cast-mdns.test.mjs test/cast-discovery.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/cast/mdns.js packages/backend/src/cast/discovery.js packages/backend/test/cast-mdns.test.mjs packages/backend/test/cast-discovery.test.mjs
git commit -m "fix(cast): harden mDNS wire parsing"
```

### Task 2: Add a cancellable multicast socket lifecycle and test fixture

**Files:**
- Modify: `packages/backend/src/cast/discovery.js:213-343,397-437`
- Modify: `packages/backend/test/cast-discovery.test.mjs`

- [ ] **Step 1: Add deterministic fakes and failing lifecycle tests**

Define `FakeSocket extends EventEmitter`. It records create options, bind/send/
close calls, group membership, and exposes test-controlled `listen()` and
`fail(error)` methods. Define `flushMicrotasks()` as a bounded loop of four
`await Promise.resolve()` calls; do not poll real timers.

Create `createLifecycleFixture(socketQueue)` which injects:

```js
new DeviceDiscoverer({
  loadDgram: async () => ({ createSocket: (options) => {
    createOptions.push(options)
    return socketQueue.shift()
  }}),
  setInterval: (fn, delay) => { timers.push({ fn, delay }); return timers.length },
  clearInterval: (id) => clearedTimers.push(id),
})
```

Add independent tests asserting:

1. `start()` creates `{ type: 'udp4', reuseAddress: true }`, binds exactly
   `[5353, '0.0.0.0']`, then after `listen()` joins `224.0.0.251`, sends exactly
   one no-QU query, and installs one 5000ms timer.
2. Two concurrent `start()` calls share the same in-flight promise; calling
   `start()` once running creates no second socket.
3. `stop()` while starting resolves (does not reject) the pending start,
   closes the old socket, and ignores its late `listening` and `error` events;
   a subsequent start with a second socket succeeds.
4. Separate load, create, bind, and membership failures make `start()` resolve
   after cleanup, leave `isRunning() === false`, retain a manual device, and
   allow a successful second start.
5. A running socket error drops membership, clears the timer, closes the
   socket, returns idle, and permits a successful retry.
6. Repeated `stop()` calls produce only one drop/close and remain harmless.
7. An old generation's late error after a new generation is running does not
   close or otherwise alter the new socket.

- [ ] **Step 2: Run RED**

Run `npx brittle test/cast-discovery.test.mjs` from `packages/backend`.

Expected: FAIL because constructor injection and lifecycle state do not exist,
the socket binds port 0, and a stopped pending start does not settle.

- [ ] **Step 3: Implement precise lifecycle semantics**

Change the constructor to `constructor(dependencies = {})` with defaults for
`loadDgram`, `setInterval`, and `clearInterval`. Add `idle|starting|running|
stopping`, a monotonically increasing generation, `_startPromise`, and a
`_settleStart` cancellation hook.

Make `start()` a non-`async` method so concurrent callers receive the identical
stored promise. It always resolves: success reaches `running`; startup failure
or cancellation completes cleanup and reaches `idle`, preserving manual mode.
Running calls return an already-resolved promise without creating resources.

`_startMdns(generation)` assigns the one socket before binding and returns a
promise whose guarded settle functions are stored for `stop()`. It binds
`MDNS_PORT` on `0.0.0.0`. The listening callback verifies generation/state,
requires `socket._socket.addMembership`, joins the group, sends one standard
multicast query, installs one interval, and resolves. Missing membership is a
startup failure, not a degraded success.

`stop()` invalidates the generation before invoking `_settleStart`, transitions
through `stopping`, clears the injected timer, drops only owned membership,
nulls owned fields, tolerates a promise-returning `close()`, and ends idle.
Socket errors during starting settle that start through the same cleanup path;
errors while running invalidate and clean up without automatic retry. Every
callback checks both generation and socket identity. `isRunning()` is true in
`starting` or `running`.

- [ ] **Step 4: Run GREEN**

Run `npx brittle test/cast-mdns.test.mjs test/cast-discovery.test.mjs`.

Expected: PASS with no pending tests, real timers, or unhandled rejections.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/cast/discovery.js packages/backend/test/cast-discovery.test.mjs
git commit -m "fix(cast): listen on the multicast discovery socket"
```

### Task 3: Accumulate and resolve Chromecast records across packets

**Files:**
- Modify: `packages/backend/src/cast/discovery.js:213-395`
- Modify: `packages/backend/test/cast-discovery.test.mjs`

- [ ] **Step 1: Write failing cache and resolution tests**

Export narrow module-internal test seams from `discovery.js`:

```js
createDiscoveryRecordCache()
applyDiscoveryRecord(cache, record)
buildDiscoveredDevices(cache)
```

They are not re-exported by `cast/index.js` or `@peartube/backend`.

First test `applyDiscoveryRecord` directly with records produced by
`parseResponse`, then use an active discoverer from Task 2's fake lifecycle for
events. Add exact cases:

- Feed A(`kitchen.local`), TXT(instance), SRV(instance -> kitchen.local:8009),
  then PTR(service -> instance) as four packets. Assert zero devices until the
  PTR, then one `deviceFound` and the exact public device.
- Advertise Kitchen -> `kitchen.local` and Office -> `office.local`; put A
  records in reversed order. Assert Kitchen uses `192.168.1.25` and Office uses
  `192.168.1.40` through their SRV targets.
- Add A `192.168.1.20` then `192.168.1.9` for one target. Assert `.9` is selected
  by numeric ordering.
- Replay a complete response. Assert `deviceFound` remains one and no
  `deviceChanged` occurs.
- Feed a complete `_airplay._tcp.local` chain. Assert no cast device.

- [ ] **Step 2: Run RED**

Run `npx brittle test/cast-discovery.test.mjs`.

Expected: FAIL because records are still joined packet-locally and the cache
helpers do not exist.

- [ ] **Step 3: Implement record application and device construction**

`createDiscoveryRecordCache()` returns PTR instance set, SRV/TXT maps, and an
A-address set per target. `applyDiscoveryRecord` normalizes all names and:

- accepts PTR only when owner equals `_googlecast._tcp.local`;
- stores/replaces one SRV and TXT record per instance;
- stores every A address in a set per target;
- ignores records missing their typed field;
- temporarily ignores TTL-zero records, whose exact deletion behavior is added
  test-first in Task 4.

`buildDiscoveredDevices(cache)` sorts PTR instances, follows PTR -> SRV -> A,
selects the numerically lowest IPv4, applies name preference `fn`, `md`, then
decoded instance label, and aggregates by endpoint ID. The first sorted
instance is the representative for a shared endpoint.

Change `_handleMessage()` to snapshot the public device map, apply every
parsed record, rebuild discovered devices, and reconcile once per packet.
Implement the common reconciler now: build `after` by copying discovered
devices and overlaying any existing manual devices, replace `_devices`, then
while active emit removed IDs first followed by added or field-changed devices.
Compare `id`, `name`, `host`, `port`, `protocol`, and `manual`. Task 4 keeps this
algorithm and adds goodbye semantics plus routes manual mutations through it.

- [ ] **Step 4: Run GREEN**

Run `npx brittle test/cast-mdns.test.mjs test/cast-discovery.test.mjs`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/cast/discovery.js packages/backend/test/cast-discovery.test.mjs
git commit -m "fix(cast): resolve DNS-SD records across packets"
```

## Chunk 2: Public Reconciliation and Integration

### Task 4: Reconcile goodbyes, collisions, and `CastContext`

**Files:**
- Modify: `packages/backend/src/cast/discovery.js:345-505`
- Modify: `packages/backend/src/cast/index.js:76-140`
- Modify: `packages/backend/test/cast-discovery.test.mjs`
- Create: `packages/backend/test/cast-context-discovery.test.mjs`

- [ ] **Step 1: Write failing record-set and public-event tests**

Using the active fake fixture, add these exact sequences and assertions:

1. Resolve Kitchen with TXT `fn=Kitchen`, clear observed events, apply TXT
   `fn=Kitchen TV`; assert one `deviceChanged`, no found/lost, same ID.
2. Resolve target with A `.20`, clear events, add lower A `.9`; assert events
   are exactly `deviceLost('192.168.1.20:8009')`, then
   `deviceFound({ id: '192.168.1.9:8009', ... })`.
3. Cache A `.9` and `.20`, then TTL-zero A `.9`; assert transition to `.20`.
   Repeat stale goodbye `.9`; assert no event.
4. Replace SRV target A with target B, then send a stale TTL-zero goodbye for
   target A; assert B remains. Send matching goodbye for B; assert lost.
5. Replace TXT `fn=Old` with `fn=New`; a stale TTL-zero `fn=Old` does nothing;
   matching TTL-zero `fn=New` falls back to the instance label and emits one
   changed event.
6. Resolve two instances to one endpoint. Goodbye the first PTR: no lost.
   Goodbye the second PTR: exactly one lost.
7. Resolve discovered endpoint `.20`, then add manual devices at both the `.20`
   ID and prospective lower `.9` ID. Assert `.20` changes to `manual: true` and
   `.9` is added manually. Clear events; change hidden discovered TXT, add lower
   discovered address `.9`, and goodbye its PTR. Assert no events because both
   old and new discovered endpoint IDs are masked, and both manual devices
   remain.
8. With a colliding discovered entry still cached, remove the manual entry;
   assert one `deviceChanged` reveals the discovered representation. Without a
   cached discovered entry, removal emits one `deviceLost`.
9. `clearDevices()` emits one lost per merged public ID and empties all manual,
   DNS cache, instance-resolution, and discovered stores.

- [ ] **Step 2: Write the failing `CastContext` collision test**

In `cast-context-discovery.test.mjs`, instantiate `CastContext`, feed a complete
discovered packet through `context._discoverer._handleMessage()`, add a manual
device with the same endpoint, remove it, and assert:

```js
assert.equal(context.getDevices().length, 1)
assert.equal(context.getDevice(ID).manual, undefined)
assert.equal(context.getDevice(ID).name, 'Discovered TV')
```

This must fail because current `CastContext.removeManualDevice()` deletes its
local mirror after the discoverer's synchronous reveal event.

- [ ] **Step 3: Run RED**

Run:

```bash
npx brittle test/cast-discovery.test.mjs test/cast-context-discovery.test.mjs
```

Expected: FAIL on TTL-zero semantics, hidden collision events, and the context
mirror assertion.

- [ ] **Step 4: Implement merged-view reconciliation**

Keep `_manualDevices` and `_discoveredDevices` separate. Build the public map by
copying discovered entries then overlaying manual entries. For every mutation,
snapshot before and compute after once. Emit from the public diff only while
discovery is active: removed IDs first, then added/changed IDs. Compare `id`,
`name`, `host`, `port`, `protocol`, and `manual`. Hidden discovered changes
therefore emit nothing.

Extend `applyDiscoveryRecord` with the Task 4 RED-tested TTL-zero behavior.
Delete only a semantically matching normalized PTR instance, SRV target/port,
sorted TXT key/value set, or exact A address. Do not compare raw `dataKey`,
because equivalent compressed and uncompressed RDATA encodings can differ.

Route `addManualDevice`, `removeManualDevice`, and `clearDevices` through the
same reconciler. Clearing removes every record store as well as both device
ownership maps.

In `CastContext.removeManualDevice(deviceId)`, remove the unconditional local
delete. After asking the discoverer to remove the manual entry, read the now-
visible device from `this._discoverer.getDevices()`: set it in the context map
if present, otherwise delete. This is correct whether discovery is active
(events fire synchronously) or idle (no events fire).

- [ ] **Step 5: Run GREEN**

Run:

```bash
npx brittle test/cast-mdns.test.mjs test/cast-discovery.test.mjs test/cast-context-discovery.test.mjs
```

Expected: PASS with exact event counts/order.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/cast/discovery.js packages/backend/src/cast/index.js packages/backend/test/cast-discovery.test.mjs packages/backend/test/cast-context-discovery.test.mjs
git commit -m "fix(cast): reconcile discovered and manual devices"
```

### Task 5: Verify integration and hardware handoff

**Files:**
- Verify: `packages/app/backend/mobile-cast.mjs`
- Verify: `packages/app/workers/desktop/index.ts`
- Verify: `packages/app/android/app/src/main/java/com/peartube/app/PeartubeNetworkDiscovery.kt`

- [ ] **Step 1: Run all focused cast tests**

```bash
npx brittle test/cast-mdns.test.mjs test/cast-discovery.test.mjs test/cast-context-discovery.test.mjs test/playback-compat.test.mjs
```

Run from `packages/backend`. Expected: PASS.

- [ ] **Step 2: Run the full backend suite**

Run `npm test --prefix packages/backend` from the repository root.

Expected: PASS without new unhandled socket/timer warnings.

- [ ] **Step 3: Run app integration regressions**

```bash
node --test packages/app/backend/lazy-cast-handlers.test.mjs
node --test packages/app/tests/android-physical-discovery-regression.test.mjs
```

Expected: PASS, proving lazy cast handler registration and Android application-
owned multicast-lock wiring remain intact.

- [ ] **Step 4: Run type checking**

Run `npm run typecheck` from the repository root.

Expected: PASS. If unrelated pre-existing failures occur, record their exact
paths and confirm none refer to the changed cast files.

- [ ] **Step 5: Inspect the final diff**

```bash
git diff --check main...HEAD
git status --short
git diff --stat main...HEAD
```

Expected: no whitespace errors; only design/plan docs, the mDNS module, cast
discovery/context, and focused tests appear; worktree is clean.

- [ ] **Step 6: Record physical Android verification as a handoff if unavailable**

When an Android phone and Chromecast are available on the same Wi-Fi, open the
existing picker and verify the device appears without manual IP entry, then
background/foreground the app and refresh once. If hardware is not attached to
this environment, report this exact smoke test as the only remaining manual
verification; automated completion must not claim that physical discovery was
observed.
