# Architecture Improvements Roadmap

## Current State (Dec 2024)

Desktop has begun consolidation:
- `apps/desktop/src/state/appStore.tsx` - Shared state via React context + useReducer
- `apps/desktop/src/platform/desktopAdapter.ts` - Platform abstraction interface

Mobile still uses separate contexts per concern (`_layout.tsx`, `VideoPlayerContext.tsx`).

---

## Priority 1: Shared Data Layer

### Problem
Channel/video loading, subscriptions, and feed fetching are duplicated across screens and platforms.

### Solution
Extract a shared store that holds:
- `identity` - User's channel identity
- `channels` - Known channels with metadata
- `subscriptions` - Subscribed channels
- `publicFeed` - P2P discovered channels
- `videosByChannel` - Cached video lists per channel

**Actions exposed:**
```typescript
interface AppActions {
  loadIdentity(): Promise<void>
  loadVideos(channelKey: string): Promise<Video[]>
  subscribe(channelKey: string): Promise<void>
  upload(file: File, metadata: VideoMetadata): Promise<Video>
  prefetchVideo(channelKey: string, path: string): Promise<string> // returns URL
}
```

**Desktop:** Already started with `appStore.tsx` - expand to include actions.
**Mobile:** Migrate from scattered `useApp()` + `useVideoPlayerContext()` to unified store.

---

## Priority 2: Platform Adapter Interface

### Problem
Desktop uses Pear IPC + worker-client.js; mobile uses RN/Expo with different APIs for file picking, storage, notifications.

### Solution
Define a small adapter interface implemented per platform:

```typescript
interface PlatformAdapter {
  // File operations
  pickVideoFile(): Promise<File | null>
  pickImageFile(): Promise<File | null>
  getStoragePath(): string

  // System
  notify(message: string, type?: 'info' | 'error' | 'success'): void
  openExternal(url: string): void
  shareContent(title: string, url: string): void

  // Platform info
  isDesktop: boolean
  isMobile: boolean
  platform: 'pear-macos' | 'pear-windows' | 'ios' | 'android' | 'web'
}
```

**Desktop:** `desktopAdapter.ts` (already started - uses browser `<input type="file">`)
**Mobile:** `mobileAdapter.ts` (wraps expo-image-picker, expo-sharing, etc.)

---

## Priority 3: Routing Normalization

### Problem
- Desktop: Manual `state.view` string switching
- Mobile: React Navigation/Expo Router with file-based routes

Different navigation semantics cause bugs (unmatched routes, back button behavior).

### Solution

**Desktop:** Add lightweight hash router (wouter or custom)
```typescript
// Routes map to existing views
const routes = {
  '/': 'home',
  '/watch/:channelKey/:videoId': 'watch',
  '/studio': 'studio',
  '/channel/:key': 'channel',
  '/settings': 'settings',
}
```

**Mobile:** Keep Expo Router, but align route names/params:
```
app/(tabs)/index.tsx        -> '/'
app/video/[id].tsx          -> '/watch/:channelKey/:videoId'
app/(tabs)/studio.tsx       -> '/studio'
app/channel/[key].tsx       -> '/channel/:key'
app/(tabs)/settings.tsx     -> '/settings'
```

---

## Priority 4: P2P Playback Hook

### Problem
Desktop watch page manually prefetches and polls stats; mobile has different pattern. Logic is duplicated and divergent.

### Solution
Shared hook that encapsulates P2P video loading:

```typescript
interface P2PVideoState {
  url: string | null
  status: 'idle' | 'prefetching' | 'ready' | 'error'
  stats: { downloaded: number; total: number; peers: number } | null
  error: Error | null
}

function useP2PVideo(channelKey: string, videoPath: string): P2PVideoState & {
  start(): void
  cancel(): void
}
```

Platform-specific media element renders the URL; logic stays consistent.

---

## Priority 5: Error/Empty State Handling

### Problem
Identity/drive not set leads to upload/playback failures with inconsistent error handling.

### Solution
Centralize gating in shared provider:
- Block upload/play actions until identity is ready
- Surface uniform "create channel first" prompt on both platforms
- Consistent error boundaries and retry logic

```typescript
function useRequireIdentity() {
  const { identity, loading } = useAppStore()

  if (loading) return { ready: false, reason: 'loading' }
  if (!identity) return { ready: false, reason: 'no-identity' }
  return { ready: true, identity }
}
```

---

## Priority 6: Layout & Design System

### Problem
Components like Sidebar/Header are desktop-specific; cards and text styles are shared but can drift.

### Solution
- Keep two shells: `DesktopShell`, `MobileShell`
- Maximize reuse of content blocks: `VideoCard`, `ChannelCard`, `FeedList`, `PlayerPane`
- Single source for design tokens:

```typescript
// packages/shared/design-tokens.ts
export const tokens = {
  colors: {
    bg: '#0e0e10',
    bgSecondary: '#1f1f23',
    primary: '#9147ff',
    text: '#efeff1',
    textMuted: '#adadb8',
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 4, md: 8, lg: 12 },
}
```

---

## Priority 7: Bundling/Entry Consistency

### Problem
Desktop glues scripts into index.html via inject-pear-bar.js; mobile uses Expo bundling. Pear-specific hacks accumulate.

### Solution
Single desktop entry JS that:
1. Bootstraps Pear runtime
2. Injects React app (no script tags in HTML beyond the bundle)
3. Registers platform adapters (worker client, file picker shim)

```javascript
// desktop/src/entry.ts
import { initPearRuntime } from './platform/pear'
import { desktopAdapter } from './platform/desktopAdapter'
import { renderApp } from './App'

async function main() {
  await initPearRuntime()
  registerAdapter(desktopAdapter)
  renderApp(document.getElementById('root'))
}
main()
```

---

## Priority 8: Testing/Mock Adapters

### Problem
Can't render app in browser without Pear/RN for quick UI iteration.

### Solution
Add mock adapters layer:

```typescript
// packages/shared/mocks/mockAdapter.ts
export const mockAdapter: PlatformAdapter = {
  pickVideoFile: async () => new File([''], 'test.mp4', { type: 'video/mp4' }),
  notify: console.log,
  openExternal: console.log,
  isDesktop: true,
  isMobile: false,
  platform: 'web',
}

// Mock RPC that returns fixture data
export const mockRPC = createMockRPC(fixtures)
```

Enable with env flag: `MOCK_PLATFORM=true npm run dev`

---

## Implementation Order

| Phase | Task | Effort | Impact |
|-------|------|--------|--------|
| 1 | Finish desktop appStore + actions | Low | High |
| 2 | Create mobile appStore (mirror desktop) | Medium | High |
| 3 | Define PlatformAdapter interface in shared package | Low | Medium |
| 4 | Implement mobileAdapter.ts | Medium | Medium |
| 5 | Add hash router to desktop | Low | Medium |
| 6 | Extract useP2PVideo hook | Medium | High |
| 7 | Centralize error/identity gating | Low | High |
| 8 | Move design tokens to shared package | Low | Low |
| 9 | Refactor desktop entry (remove HTML script injection) | Medium | Medium |
| 10 | Add mock adapters for testing | Low | Medium |

---

## File Structure Target

```
packages/
  shared/
    src/
      store/
        appStore.ts        # Platform-agnostic state + actions interface
        types.ts           # Identity, Video, Channel types
      hooks/
        useP2PVideo.ts     # P2P playback controller
        useRequireIdentity.ts
      platform/
        adapter.ts         # PlatformAdapter interface
      design/
        tokens.ts          # Colors, spacing, radius
      mocks/
        mockAdapter.ts
        fixtures.ts

apps/
  desktop/
    src/
      platform/
        desktopAdapter.ts  # Implements PlatformAdapter
        pear.ts            # Pear runtime init
      store/
        index.ts           # Re-exports shared store + desktop-specific actions

  mobile/
    lib/
      platform/
        mobileAdapter.ts   # Implements PlatformAdapter
      store/
        index.ts           # Re-exports shared store + mobile-specific actions
```
