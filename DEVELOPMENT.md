# PearTube Development Guide

PearTube development centers on the universal backend contract:

```text
client shell -> @peartube/platform -> @peartube/host -> @peartube/backend
```

Keep backend-facing changes in that shared path unless a limitation is truly runtime-specific.

## Daily Setup

First-time setup, platform toolchains, and troubleshooting live in
[SETUP.md](./SETUP.md). Day to day you need:

```bash
nvm use
npm run install:all
```

Run `npm run bundle:backend` after backend, schema, or mobile runtime changes
that affect the BareKit bundle.

## Root Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start Expo dev server |
| `npm run ios` | Prepare backend bundle/frameworks/pods and run iOS |
| `npm run android` | Prepare backend bundle, Android prebuild, and run Android |
| `npm run desktop` | Build and launch Electrobun desktop |
| `npm run desktop:build` | Build Electrobun web and worker assets |
| `npm run desktop:start` | Launch the built Electrobun app |
| `npm run schema:full` | Regenerate JS schema output |
| `npm run typecheck` | Typecheck `packages/platform` |
| `npm test` | Run spec, backend, and host tests |
| `npm run lint:changed` | Lint changed files |

## Package Focus

| Package | Common commands |
| --- | --- |
| `packages/spec` | `npm test --prefix packages/spec`, `npm run gen:schema --prefix packages/spec` |
| `packages/backend` | `npm test --prefix packages/backend`, `npm run test:watch --prefix packages/backend` |
| `packages/host` | `npm test --prefix packages/host` |
| `packages/platform` | `npm run typecheck --prefix packages/platform` |
| `packages/app` | `npm run bundle:backend --prefix packages/app`, `npm run desktop:build --prefix packages/app`, `npm run desktop:smoke --prefix packages/app` |
| `packages/cli` | `npm test --prefix packages/cli`, `npm run build:standalone --prefix packages/cli` |

## Schema Workflow

The schema source of truth is `packages/spec/schema.cjs`.

```bash
npm run schema:full
npm test --prefix packages/spec
```

`schema:full` regenerates JS HRPC/schema output under `packages/spec/spec/`.

After adding or changing an RPC method:

- Update `packages/spec/schema.cjs`.
- Run `npm run schema:full`.
- Expose the behavior through `@peartube/backend`, `@peartube/host`, and `@peartube/platform` as needed.
- Rebuild mobile and desktop generated bundles if the runtime entrypoints depend on the change.

## Backend And RPC Notes

- `packages/host/src/contracts.js` owns `PROTOCOL_VERSION`.
- `packages/host/src/start-host.js` owns host lifecycle startup.
- `packages/backend/src/backend-entry.js` creates the universal backend, registers shared handlers, starts the core, and emits readiness.
- `packages/backend/src/hrpc-handlers.js` is the central shared HRPC handler registry.
- `packages/host/src/create-client.js` validates readiness and groups app-facing methods into namespaces such as `system`, `feed`, `channel`, `video`, `watch`, `transfer`, `search`, and `shell`.
- `packages/platform/src/rpc.shared.ts` is the common app-facing bridge used by platform-specific runners.

Network empty states should use `system.getSwarmStatus()` diagnostics instead of generic "no content" copy.

## Mobile Notes

- Mobile runs exactly one Bare worklet: the backend at `packages/app/backend/index.mjs`, packed to `packages/app/backend.bundle.js`. Cast transcoding runs inside it through `@peartube/backend/transcode/cast-transcoder`; do not add a second worklet for it.
- The downloader worker bundle is generated alongside the backend bundle and runs as a thread of that same worklet.
- `bare-link` links every addon reachable from `packages/app`, with no filter. `scripts/prune-bare-addons.mjs` reads the `linked:` specifiers out of the packed bundles and deletes the rest — per-ABI `.so` files on Android, `.xcframework` directories on iOS. Gradle runs it after the bare-kit link task; the `Podfile` `pre_install` hook runs the linker and then the prune, because CocoaPods never runs a `:path` pod's `prepare_command`.
- iOS addons come from `react-native-bare-kit` alone. There is no second, separately versioned addon source: the committed `prebuilds/` tree and its `BareAddons` pod shipped stale duplicates (`bare-os` 3.6.2 beside 3.9.1, and so on) and are gone.

```bash
npm run bundle:backend
```

## Electrobun Desktop Notes

- Main desktop uses an Expo web export hosted in Electrobun.
- The desktop worker source is `packages/app/workers/desktop/index.ts`.
- The packed worker artifact is `packages/app/desktop-build/build/workers/core/index.bundle`.
- `packages/app/scripts/build-desktop-bundle.mjs` verifies that packed `@peartube/*` source matches the live workspace.
- `npm run desktop:smoke --prefix packages/app` boots the packed worker through `pear-runtime` to catch native addon load regressions.

Do not restore `pear run` or `global.Pear.run` paths; the local desktop shell embeds `pear-runtime`. Mobile OTA payloads are real and assembled by `npm run ota`, but `pear stage`/`pear seed` run by hand — no workflow performs them. Desktop staging is deliberately unimplemented: `npm run desktop:stage` prints exactly what is missing and exits non-zero.

## Relay Notes

- Relay code lives in `packages/cli`; shared P2P behavior stays in `packages/backend`.
- The root `docker-compose.relay.yml` runs the relay with archive UI and authenticated companion configuration.
- `docker-compose.local-relay.yml` adds a local filesystem mirror volume.
- Generic client integration uses bounded `/api/v2` provider search, resolution, acquisition, policy, publication, and capability-scoped stream routes. Do not restore full-catalog scans, direct bearer URLs, or a second backend.
- S3-compatible block storage is the only cloud offload path. Do not add provider-specific whole-file uploads beside the verified block store.

```bash
npm test --prefix packages/cli
docker compose -f docker-compose.relay.yml up -d
```

## Verification Guidance

Use focused checks while iterating, then run the broader command before handing off a cross-package change:

```bash
npm run lint:changed
npm run typecheck
npm test
```

For platform work, add the matching build/smoke command:

```bash
npm run desktop:build
npm run desktop:smoke --prefix packages/app
npm run build:android:apk
```

## Troubleshooting

**iOS pod install fails.**

```bash
cd packages/app/ios && rm -rf Pods Podfile.lock && pod install --repo-update
```

**A desktop change does nothing.** Look for a `.web.tsx` variant shadowing the component you edited; Metro resolves `.web.tsx` for desktop and `.tsx` for mobile.

**Backend never connects on mobile.** `packages/app/backend.bundle.js` has to exist. Rebuild with `npm run bundle:backend`.

**Desktop reports "No handler registered".** Rebuild and relaunch: `npm run desktop:build && npm run desktop`. Shared HRPC handlers are wired in `packages/backend/src/backend-entry.js`.

**Desktop worker dies with `dlopen(...index.bundle/node_modules/bare-os/...) errno=20` (ENOTDIR).** A native addon got embedded in the bundle. `dlopen` needs a real file, and `index.bundle/...` treats the bundle *file* as a directory. bare-pack must run with `--offload-addons` so prebuilds land beside the bundle and resolve as `index.bundle/../<pkg>/…`; `desktop:ecopy` then ships that addon tree into the `.app`. Both are wired in `build-desktop-bundle.mjs`. Force a rebuild with `PEARTUBE_FORCE_DESKTOP_BUNDLE=1 npm run desktop:bundle`.

**Desktop worker reports "does not provide an export named 'X'".** A stale artifact, not a code bug. `desktop:start` recompiles the worker, re-bundles, and rebuilds the launcher, so it cannot run a stale main. If the spawn log still shows `index.mjs` instead of `index.bundle`, the checkout predates the merged pipeline.


