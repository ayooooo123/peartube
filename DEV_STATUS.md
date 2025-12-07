# Development Status

## Current Status: Working

Both mobile and desktop platforms are functional:

| Platform | Status | Command |
|----------|--------|---------|
| iOS | ✅ Working | `npm run ios` |
| Android | ⏳ Pending | `npm run android` |
| Pear Desktop | ✅ Working | `npm run pear` |

## Recent Changes

### Unified App Consolidation (2025-12-07)

Merged `packages/mobile` and `packages/desktop` into single `packages/app`:

- **Before**: Separate mobile and desktop packages with duplicated code
- **After**: Single unified app serving iOS, Android, and Pear Desktop

Key changes:
1. Renamed `packages/mobile` → `packages/app`
2. Created `pear-src/` directory with desktop assets
3. Added pear build scripts to package.json
4. Removed duplicate xcframeworks that conflicted with react-native-bare-kit
5. Deleted `packages/desktop`

### Platform RPC Wiring (2025-12-06)

Unified RPC layer across mobile and desktop:
- Single `@peartube/spec` HRPC schema
- Platform abstraction via `@peartube/platform`
- BareKit on mobile, pear-run on desktop

## Package Structure

```
packages/
├── app/              # Unified app (iOS, Android, Pear)
├── backend/          # Backend business logic
├── backend-core/     # P2P primitives (hypercore, etc)
├── core/             # Shared types
├── platform/         # Platform abstraction
├── rpc/              # RPC client/server
├── spec/             # HRPC schema
└── ui/               # Shared UI components
```

## Build Commands

```bash
# Mobile
npm run ios              # Run iOS app
npm run bundle:backend   # Bundle mobile worklet

# Desktop
npm run pear             # Build and run Pear
npm run pear:build       # Build Pear only
```

## Known Issues

None currently.

## Next Steps

1. Implement video player with HLS streaming
2. Add channel creation UI
3. Implement video upload
4. Add Android support

---

**Last Updated**: 2025-12-07
