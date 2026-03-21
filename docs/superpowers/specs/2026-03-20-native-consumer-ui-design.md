# PearTube Native Consumer UI Design

Date: 2026-03-20
Branch: `codex/native-desktop-host-skeleton`
Status: Draft approved in chat, written for review

## Summary

PearTube should add a real macOS-first consumer interface on top of the shared host and protocol seam that now sits underneath both mobile and desktop. The first native UI milestone is not full product parity. It is a usable browse, search, detail, and playback experience that proves the app can behave like a native Mac client while keeping backend truth in Bare.

The interface should feel like a desktop media browser, not a mobile port. It should lean into selection, panes, keyboard flow, and persistent playback rather than route stacks or tab-first navigation.

## Goals

- Deliver a real native macOS consumer UI backed by the shared host and protocol layers.
- Keep backend truth in Bare and presentation state in Swift.
- Support a first-class global search flow in the native shell.
- Support real inline playback with `AVPlayer`.
- Establish a layout and interaction model that can scale to more PearTube surfaces later.

## Non-Goals

- Full parity with the current mobile or legacy desktop UI in the first milestone.
- Replacing the mobile UI stack in this phase.
- Shipping Studio, Library, and Settings at full fidelity immediately.
- Recreating routing and state logic in Swift that already belongs in the shared backend.
- Adding OTA-specific behavior in this branch.

## Design Principles

- Native first: the app should look and behave like a Mac media client.
- Host owns truth: P2P state, search, browse data, playback URL resolution, and content semantics stay in Bare.
- Swift owns presentation: split view state, focus, selection, inline player chrome, keyboard shortcuts, and local formatting stay in the native shell.
- Search is global: the first search milestone is global search across discovered content, not scoped channel search.
- Playback stays anchored: users should be able to keep playing a selected video while browsing adjacent content.

## Layout

The app should use a three-pane macOS layout.

- Left sidebar: app sections and persistent host status.
- Center content pane: the active collection for the selected section or search query.
- Right detail pane: selected video or channel detail, with playback inline at the top.

Recommended visual direction:

- Tone: quiet cinema
- Background: deep charcoal with subtle tonal separation between panes
- Emphasis: warm coral/orange for active playback and primary actions
- Typography: strong headline hierarchy with quieter metadata and diagnostics

Primary sidebar sections:

- Home
- Subscriptions
- Library
- Studio
- Settings

Search should live in the toolbar, not as a separate full-screen route. Entering a query shifts the center pane into search mode while preserving the rest of the shell structure.

## Interaction Model

The native shell should be selection-driven, not route-driven.

- Sidebar selection chooses the current content model.
- Center pane selection drives the right detail pane.
- The right pane always reflects the current selection.
- Playback starts in the right pane and can remain active while selection changes elsewhere.

Keyboard and pointer behavior:

- Single click selects a result and updates the detail pane.
- Double click or `Return` starts playback for the selected video.
- Arrow keys move through center-pane selections.
- `Cmd-F` focuses the global search field.
- `Esc` clears search focus first, then clears the query if focus is already clear.

Initial section behavior:

- `Home`: discovered or featured videos from the shared browse snapshot.
- `Subscriptions`: subscribed channels and videos filtered from shared backend data.
- `Library`: lightweight saved or local surface at first, not full parity.
- `Studio`: placeholder shell in the first usability milestone.
- `Settings`: native preferences and host diagnostics.

## Content Surfaces

### Home

The center pane shows the main browse feed with native rows or cards optimized for pointer and keyboard navigation. Each result should expose thumbnail, title, channel, runtime, and a small amount of secondary metadata.

### Global Search

Typing in the toolbar should call `globalSearchVideos(query, topK)` through the shared protocol. The center pane should switch to a results surface with:

- a visible search state
- results count or empty state
- loading and retry behavior
- selection continuity into the right pane

The first milestone only needs global video search. Channel-scoped or mixed-entity search can come later.

### Detail Pane

The detail pane should show:

- inline player region at the top
- video title
- channel attribution
- runtime and other metadata
- summary or description
- tags or lightweight metadata chips
- host or playback status when useful

If the current selection is a channel-derived item, the shell can use `getChannelMeta(...)` and `listVideos(...)` to enrich the right pane without moving that logic into Swift.

### Playback

Playback should use `AVPlayer` and a resolved blob or local URL from the shared host. The native shell should handle:

- loading state while playback URL resolves
- inline playback errors
- retry action
- a stable player region that does not collapse during nearby selection changes

The first milestone does not need a detached player window, Picture in Picture, or advanced playback queue management.

## Data Boundary

The native shell should depend on a small RPC contract over the shared protocol layer.

Required backend calls for the first milestone:

- `bootstrap`
- `refreshBrowse`
- `globalSearchVideos(query, topK)`
- `getChannelMeta(channelKey, publicBeeKey?)`
- `listVideos(channelKey, publicBeeKey?, limit)`
- `resolvePlayback(channelKey, publicBeeKey?, videoId)`

Bare should continue to own:

- browse aggregation
- subscription filtering
- search semantics
- channel and video lookup
- playback URL construction
- identity, storage, swarm, and replication logic

Swift should own:

- toolbar query state
- pane sizing and navigation state
- selection and focus
- result grouping and formatting for presentation
- native player presentation and error display

## Native View Model Shape

The UI should consume a thin native-friendly model instead of raw backend records wherever practical.

Recommended shape:

```ts
type NativeVideoSummary = {
  id: string
  title: string
  channelName: string
  channelKey: string
  publicBeeKey?: string | null
  durationSeconds?: number | null
  thumbnailUrl?: string | null
  summary?: string | null
  tags?: string[]
}

type NativeBrowseSnapshot = {
  home: NativeVideoSummary[]
  subscriptions: NativeVideoSummary[]
  blobServerPort?: number | null
}

type NativePlaybackTarget = {
  url: string
  mimeType?: string | null
}
```

This shaping can happen in the shared protocol layer so the Swift app does not have to understand every backend-specific record format.

## Implementation Order

### 1. Real Search-First Shell

Replace placeholder center-pane content with real Home, Subscriptions, and toolbar-driven global Search views backed by the shared host.

### 2. Real Detail Pane

Replace sample right-pane content with real metadata and selection-backed detail rendering.

### 3. Real Playback

Wire `AVPlayer` to resolved playback URLs with inline loading and error states.

### 4. Native Polish

Add keyboard behavior, pane resizing polish, empty states, diagnostics, and settings refinement.

## Verification

This design should be considered implemented only when:

- the native app boots against the shared host with no mock browse data
- Home renders real backend-fed content
- toolbar search returns and displays real global results
- selecting a result updates the right pane with real metadata
- pressing play resolves a real playback URL and starts `AVPlayer`
- the app remains usable when search returns no results or playback resolution fails

## Risks

- Search and browse payloads may still be too backend-shaped for a clean native UI, which would require a thin shared shaping layer.
- Playback resolution and player lifetime may surface assumptions that currently live in the React UI.
- A macOS-first shell can drift into desktop-specific semantics if the protocol contract is not kept shared and disciplined.

## Recommendation

Implement the native UI around a three-pane macOS-first shell with toolbar-driven global search, real center-pane collections, a real right detail pane, and inline `AVPlayer` playback. Keep all semantic data work in Bare and make Swift a disciplined consumer of the shared protocol.
