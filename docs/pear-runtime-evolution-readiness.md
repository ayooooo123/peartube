# Pear Evolution Readiness

Source: https://pears.com/news/pear-evolution/

## What changed

Pear CLI's app runtime path, `pear run`, is deprecated and scheduled for removal around the end of June 2026. The replacement model is:

- keep Pear CLI focused on deployment and release tooling;
- embed `pear-runtime` inside the desktop application shell;
- launch Bare workers through `PearRuntime.run()` / `pear.run()` instead of `global.Pear.run` from `pear run`;
- use an `upgrade` field in the deployed app package metadata for P2P OTA updates;
- package deployment output from `pear build`, then release/sign with the newer Pear CLI production flow (`pear provision`, `pear multisig`, and eventually `pear install`).

Pear also notes a mobile equivalent, `pear-mobile`, is planned but not public/stable yet. PearTube mobile should stay on BareKit until that runtime is available and proven.

## PearTube current state

PearTube is already off the dead path for the main desktop shell:

- desktop shell: Electrobun/Bun, not `pear run`;
- runtime dependency: `pear-runtime` in `packages/app/package.json`;
- worker launch: `packages/app/src/bun/index.ts` calls `PearRuntime.run(workerPath, [storagePath])`;
- worker IPC: `packages/app/workers/desktop/index.ts` uses `Bare.IPC`;
- CI: `.github/workflows/build-desktop.yml` builds the Electrobun desktop artifact.

That means the immediate article-driven action is documentation and release-flow cleanup, not a runtime rewrite.

## Remaining gaps

1. Historical plans and handoff docs may still contain old `pear run`, `pear-src`, or `pear/build` examples. Prefer the active root docs (`README.md`, `QUICKSTART.md`, `SETUP.md`, `DEVELOPMENT.md`, `DEV_STATUS.md`, and `ARCHITECTURE.md`) for current commands.
2. Root `desktop:stage` / `desktop:release` scripts intentionally throw because Pear OTA staging/release is not wired yet. Treat Pear OTA deployment as not wired until a dedicated release plan adds a real build/provision/multisig flow.
3. No committed `upgrade`/Pear app-drive release metadata exists for the Electrobun artifact. Do not claim Pear OTA updates work yet.
4. Mobile should not migrate to `pear-mobile` until Holepunch publishes a stable module and API docs.

## Operational stance

- Use `npm run desktop` / `npm run desktop:build` for local Electrobun desktop work.
- Keep Android/iOS on Expo + BareKit.
- Avoid reintroducing `pear run` or `global.Pear.run` in new desktop code.
- If production desktop OTA becomes a priority, create a separate release PR that adds app metadata, `pear build` output shaping, release signing/provisioning commands, and CI artifact verification.
