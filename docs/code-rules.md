# Code rules

This file gives the one way to do the work that this repository does again and again. Each section says what to do, why, and which fault the rule prevents. CI checks the rules that a machine can check. A reviewer judges the rest.

## How CI checks the rules

The workflow `.github/workflows/code-rules.yml` runs on every pull request.

- `ast-grep test` runs the rule tests in `ast-grep/tests/`. Each test has the faulty code as an invalid case.
- `scripts/ci/ast_grep_changed.py` runs `ast-grep scan` with the rules in `ast-grep/rules/`. It fails when a match touches a line that the pull request adds or changes. Matches on lines that the pull request does not touch do not fail. When you change such a line, fix the match in the same pull request.
- `scripts/ci/test_guard.py` fails when a pull request weakens a test (see [Test changes](#test-changes)).
- `ci.yml` runs `npm run lint` (oxlint) and the tests. Each job has a time limit (`timeout-minutes`).

Every ast-grep rule is an error. To run the rules on your machine, use `ast-grep test` and `ast-grep scan` in the repository root.

If a match is correct code, put a comment on the line before it: `// ast-grep-ignore: <rule-id> -- <reason>`. A reviewer judges the reason.

## Machine-checked rules

### stop-all-settled

- **The one way:** stop or close a group with `await Promise.allSettled(items.map(async item => item.stop()))`. The async callback turns a throw into a rejection, so every stop starts. Then report every rejected reason, for example with `new AggregateError(reasons, message)`, so that no reason is lost.
- **Why:** `Promise.all` rejects at the first failed stop while the other stops still run, so the caller goes on too early. A callback that throws before it returns a promise ends `map()`, so the later stops never start.
- **Fault:** [pull request 581](https://github.com/ayooooo123/peartube/pull/581). The plugin host's `close()` in `src/mirror.js` ran `await Promise.all([...plugins.values()].map(p => p.stop?.()))`. When one stop rejected, `close()` rejected while an earlier stop was still running, the relay closed its node too early, and `traffic.stop()` did not run. This code is still on main; [pull request 585](https://github.com/ayooooo123/peartube/pull/585) replaces it.
- **Check:** ast-grep rule `stop-all-settled`, outside test code. It flags `Promise.all` over an array with a stop call, or over a `map` whose callback stops its item in its body, in a `return`, or in a statement of its own. It does not see a stop inside `try`, `if` or a loop, and it cannot see the content of a variable, so `Promise.all(closing)` is not checked.

### close-error-dropped

- **The one way:** in the stop path of a process (`bin/`), catch the error of each close, keep it, go on to close the rest, and then make the stop fail with it, so that the process exits 1 and says why. The node close in `stop()` of `bin/relay.js` shows the form: `try { await node?.close() } catch (err) { closeFailure = ... }`.
- **Why:** when a stop path drops the error of a close, the process exits 0 while a store or a plugin is still open, and nobody learns why.
- **Fault:** [pull request 586](https://github.com/ayooooo123/peartube/pull/586). Before it, `stop()` ran `await node?.close().catch(() => {})`. On SIGTERM, a failed node close was lost, and the relay exited 0 with the store still open. The same check found that the closes of the plugin host and the cast host still drop their errors on main.
- **Check:** ast-grep rule `close-error-dropped`, in `bin/`. It flags a `.catch` on a `close`, `stop` or `destroy` call whose handler does nothing (`() => {}`, `() => null`, `noop`), and an empty `catch` around such a call. It does not check `src/`, where the same form occurs 61 times; a reviewer judges those.

## The one way for recurring work

### Open, close and shutdown

- **The one way:** `bin/relay.js` owns the node. `shutdown()` runs once (the `shuttingDown` flag): it starts the kill timer, closes the API, stops the guard, waits for an open in flight, runs `stop()`, and exits 1 when the stop failed. `stop()` closes the parts in a fixed order: the plugin host, the cast stack, the acquirer, then the node. A node whose close failed may still hold the store open, so `stop()` rejects with that failure then and on every later call.
- **Why:** a second open of the same store fails with `File descriptor could not be locked`. An exit 0 after a failed close hides an open store from the service manager.
- **Fault:** [pull request 586](https://github.com/ayooooo123/peartube/pull/586) (see `close-error-dropped`); [pull request 585](https://github.com/ayooooo123/peartube/pull/585): when a restart and SIGTERM overlapped, the relay exited 0 and never closed its node.
- **Check:** `close-error-dropped` and `stop-all-settled` check two forms. A reviewer judges the order and the overlap of restart and shutdown, because a pattern cannot see an order in time.

### Restart

- **The one way:** opens, reopens and live setting changes run one at a time through `serial` (`bin/relay.js`; `worklet/worker.js` has its own). A restart runs `reopen()` (`stop()`, then `start()`) inside one `serial` step, and `serial` refuses new work once shutdown has begun. After a failed node close, no reopen opens a node on the same storage in this process; the caller gets the reason.
- **Why:** two opens that overlap, or an open after a failed close, open the same store twice.
- **Fault:** [pull request 586](https://github.com/ayooooo123/peartube/pull/586). After a failed node close, a restart tried to open the same storage again and answered 400 `File descriptor could not be locked`.
- **Check:** a reviewer judges this, with the tests in `test/relay-close-failure.test.js`.

### Timeouts and waits

- **The one way:** every wait on a peer, a child process or a plugin has a limit: `Promise.race` with a timer, and `clearTimeout` in `finally` (see the source search in `src/mirror.js`), or a helper such as `within` in `src/node/blobs.js`. Report a failure before slow cleanup, so that a kill timer cannot end the process first.
- **Why:** a wait with no limit hangs the caller when a peer does not answer. A report that waits for cleanup is lost when the kill timer fires.
- **Fault:** [pull request 586](https://github.com/ayooooo123/peartube/pull/586). Shutdown waits for the private guard before it writes the close failure to stderr, so the 3-second kill timer can fire first. This is still on main.
- **Check:** a reviewer judges this.

### Spawning and stopping tasks and child processes

- **The one way:** a task or a child process that lives as long as the relay belongs to the code that stops it, and that code checks the shutdown flag before it starts anything new. A plugin that a stop interrupts marks its work as stopped at once.
- **Why:** work that starts after shutdown began keeps writing (an import, a guard process) while the process exits.
- **Fault:** [pull request 585](https://github.com/ayooooo123/peartube/pull/585). A SIGTERM during plugin loading still ran a backfill that wrote to `mirror-watch.json` before the stop. A pending `privateGuardPort` change starts a guard after shutdown (also on main).
- **Check:** a reviewer judges this.

### Locks and waits on yourself

- **The one way:** JavaScript has no locks here; `serial` orders the work. A plugin never waits for the close of its own host from inside its `stop()`, because the host waits for that stop.
- **Why:** a wait on yourself never ends.
- **Fault:** [pull request 585](https://github.com/ayooooo123/peartube/pull/585). A plugin that ran `await host.close()` inside its stop waited for itself, and cleanup never ran.
- **Check:** a reviewer judges this.

### Errors

- **The one way:** keep the error object. Turn it into text only at the edge, with `reasonOf(err)` in `bin/relay.js`, which also handles a value that cannot be read. Report every reason of a group (`AggregateError`). An HTTP request that started a change answers with the error of that change.
- **Why:** `String(reason)` throws on an object without a prototype, and the reasons are then lost.
- **Fault:** [pull request 585](https://github.com/ayooooo123/peartube/pull/585). The plugin host turned each reason into text; a rejection without a prototype gave `TypeError: Cannot convert object to primitive value`, and both reasons were lost. [Pull request 586](https://github.com/ayooooo123/peartube/pull/586): a reason that could not be read and a synchronous throw from `node.close()` were lost on main.
- **Check:** `stop-all-settled` and `close-error-dropped` check two forms. A reviewer judges the rest.

### Sorting

- **The one way:** a sort comparison returns a number for every pair and is consistent: compare numbers with `a - b` only when neither can be `NaN`, and compare text with `localeCompare`.
- **Why:** an inconsistent comparison gives an order that changes between engines.
- **Fault:** none found in the last checks.
- **Check:** none.

### Waits and isolation in tests

- **The one way:** a test waits for a condition with a deadline and a message, not for a fixed time. A test that asserts a count switches off what it does not test, for example LAN discovery (the iOS tests take `-peartube-lan false`). A test asserts the result that the change is about, not only that something happened.
- **Why:** a fixed wait is too short on a slow runner, a test that is not isolated sees peers on the local network, and a weak assertion passes on broken code.
- **Fault:** [pull request 598](https://github.com/ayooooo123/peartube/pull/598) (open): a test waits 120 s for a result that the app asks for only during 60 s, and a test does not switch off LAN discovery. [Pull request 588](https://github.com/ayooooo123/peartube/pull/588): a test asserted only that a pass lasted 45 s or more. [Pull request 586](https://github.com/ayooooo123/peartube/pull/586): a test proved that there was no second plugin host, not that `start` was never called.
- **Check:** a reviewer judges this. `scripts/ci/test_guard.py` flags a removed or changed assertion.

### Test changes

- **The one way:** do not weaken a test to make it pass. Do not remove a test or an assertion, loosen an assertion, add a skip (`test.skip`, `{ skip: true }`, `.only`, `@Ignore`, `XCTSkip`), make a time limit in a test longer, or change how tests run (CI test commands, a longer or removed `timeout-minutes`). If a test is wrong, change it and give the reason in the pull request text. The guard still fails, and a person decides at merge time.
- **Why:** a weaker test passes on broken code, and nobody sees the change unless a person reads every test diff.
- **Fault:** [pull request 590](https://github.com/ayooooo123/peartube/pull/590). A revision made the plain Android e2e run follow the relay with LAN discovery off; on main the same command ran with it on. In peartube-native, [pull request 11](https://github.com/ayooooo123/peartube-native/pull/11) removed a storage test, and [pull request 31](https://github.com/ayooooo123/peartube-native/pull/31) added its new test with `#[ignore]`.
- **Check:** `scripts/ci/test_guard.py` fails the pull request. It reads the test files (`test/`, `*.test.js`, Kotlin `src/test` and `src/androidTest`, Swift `*Tests/`), the test lines of `package.json`, and the test commands and time limits of the workflows. It cannot tell a correct change from a weakening, so it fails on every removed or changed assertion; a change of spaces, line breaks or a last comma does not count. It flags the faults of pull requests 11 and 31 in peartube-native. Here it flags two changes: [pull request 581](https://github.com/ayooooo123/peartube/pull/581) changed `assert.equal((await second.run).ingested, 300)` to `assert.ok((await second.run).ingested >= 300, ...)` (the check of that pull request judged the change correct, so a person would accept it at merge time), and [pull request 598](https://github.com/ayooooo123/peartube/pull/598) (open) adds an `XCTSkip` to `ios/UITests/ParityTests.swift`. The guard does not read `android/e2e.mjs`, which checks with `throw` and not with assertions, so it does not see the fault of pull request 590. A reviewer judges such a change.

### Module boundaries

- **The one way:** `src/protocol.js` and `src/apply.js` hold what peers and the apps agree on. Everything may import them, and they import no PearTube code. `bin/relay.js` puts the parts together.
- **Why:** the apps and the Rust engine read the same rules; a rule that depends on relay code cannot be shared.
- **Fault:** none found in the last checks.
- **Check:** none yet.
