# PearTube Development Guide

## Architecture Overview

PearTube is a P2P video streaming app with:
- **Mobile**: React Native (Expo) + `react-native-bare-kit` for P2P backend
- **Desktop**: Pear Runtime (Electron-based) with `pear-electron` + `pear-bridge`
- **Shared**: P2P backend runs in a Bare worklet/worker on both platforms

## Package Manager Setup

This monorepo uses **pnpm** with special configuration for Pear Runtime compatibility.

### Key Configuration (`.npmrc`)

```ini
shamefully-hoist=true
node-linker=hoisted
public-hoist-pattern[]=*
```

This hoists all packages to the root `node_modules` for:
1. Pear Runtime's Bare module resolver (doesn't follow pnpm symlinks)
2. iOS CocoaPods path resolution

### Desktop Exception

The desktop app (`apps/desktop`) uses **npm** instead of pnpm because Pear's Bare runtime requires a flat `node_modules` structure that even hoisted pnpm doesn't fully provide.

```bash
# Desktop dependencies are installed separately:
cd apps/desktop
npm install --legacy-peer-deps
```

## Running the Apps

### Mobile (iOS)

```bash
# From monorepo root:
pnpm run ios

# Or from apps/mobile:
npx expo run:ios
```

### Desktop (Pear Runtime)

```bash
# From monorepo root:
pnpm run dev:desktop

# Or from apps/desktop:
npm run dev      # Builds web export + runs Pear
npm run preview  # Runs without building (faster iteration)
```

## After Reinstalling Dependencies

If you reinstall `node_modules` (e.g., after `pnpm install`), you need to:

### 1. Reinstall Desktop Dependencies
```bash
cd apps/desktop
npm install --legacy-peer-deps
```

### 2. Regenerate iOS Pods
```bash
cd apps/mobile/ios
pod install
```

## Native Addons (iOS)

The mobile app uses native addons for P2P functionality (sodium-native, rocksdb-native, etc.). These are pre-built as XCFrameworks in `apps/mobile/Frameworks/` and vendored via `BareAddons.podspec`.

### Rebuilding Native Addons

If you need to rebuild (e.g., after updating bare-* packages):

```bash
cd apps/mobile
./scripts/build-addons.sh      # Builds device + simulator frameworks
./scripts/create-xcframeworks.sh  # Combines into XCFrameworks
cd ios && pod install
```

## Key Technical Details

### Pear Desktop Configuration

The `apps/desktop/package.json` pear config:

```json
{
  "pear": {
    "name": "peartube",
    "type": "desktop",
    "pre": "pear-electron/pre",  // Auto-discovers assets from HTML
    "gui": { ... },
    "stage": {
      "entrypoints": ["/index.html"],
      "ignore": [...]
    }
  }
}
```

- `pre: pear-electron/pre` - Scans HTML for script tags, auto-configures `assets.ui`
- `stage.entrypoints` - Entry points for bundling

### Mobile Bare Worklet

The P2P backend runs in a Bare worklet via `react-native-bare-kit`:
- Bundle: `apps/mobile/backend.bundle` (created by `bare-pack --linked`)
- Native addons: XCFrameworks in `apps/mobile/Frameworks/`
- IPC: Simple message passing between React Native and Bare worklet

### Workspace Structure

```
peartube/
├── apps/
│   ├── desktop/     # Pear Runtime app (uses npm)
│   └── mobile/      # Expo/React Native app
├── packages/
│   ├── shared/      # Shared utilities
│   └── ui/          # Shared UI components
├── node_modules/    # Hoisted dependencies (pnpm)
├── pnpm-workspace.yaml
└── .npmrc           # pnpm config with hoisting
```

## Troubleshooting

### "MODULE_NOT_FOUND" in Pear Desktop

Pear's Bare runtime can't resolve pnpm's symlinked modules. Solution:
- Use npm for `apps/desktop` (already configured)
- Ensure `.npmrc` has `node-linker=hoisted`

### "ADDON_NOT_FOUND" on iOS

Native addons not found in Bare worklet. Solution:
- Rebuild XCFrameworks: `./scripts/build-addons.sh && ./scripts/create-xcframeworks.sh`
- Run `pod install`
- Ensure bundle matches framework versions: `npm run bundle:backend`

### iOS Build Path Errors

After reinstalling node_modules, CocoaPods may have stale paths. Solution:
```bash
cd apps/mobile/ios && pod install
```

### Version Mismatch (bundle vs frameworks)

If you see errors like "expected bare-fs.4.5.1 but found 4.5.2":
```bash
cd apps/mobile
npm run bundle:backend  # Rebuilds bundle with current versions
```
