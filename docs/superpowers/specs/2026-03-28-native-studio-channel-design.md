# PearTube Native Studio and Channel Design

Date: 2026-03-28
Branch: `codex/native-desktop-host-skeleton`
Status: Draft approved in chat, written for review

## Summary

PearTube Native should stop treating creator workflows as a side effect of the browse feed. The current macOS shell can create an identity, publish the active channel, and upload a video through the host, but those actions are buried inside generic section UI and snapshot refreshes. The next milestone should introduce two purpose-built native surfaces:

- a real `Studio` workspace for single-screen creator flow
- a dedicated `Channel` page for both viewer browsing and owner management

This milestone should preserve the current top-level native navigation and sidecar host architecture. The change is about product structure and targeted data flow, not a new router or a rewritten backend.

## Goals

- Deliver a proper single-screen native creator flow in `Studio`.
- Deliver a first-class native `Channel` page for both owner and viewer use cases.
- Keep upload initiation fast: pick a file, start uploading immediately, edit details afterward.
- Reuse existing backend capabilities where they already exist.
- Add only the minimum new bridge and state surface needed for native parity.
- Keep browse snapshots for browse surfaces and use targeted RPC for creator and channel detail workflows.

## Non-Goals

- Rebuilding the entire desktop app navigation system.
- Turning the app into a wizard-driven upload flow.
- Replacing the existing watch page or comments system in this milestone.
- Full moderation tooling beyond the owner actions required for channel and upload management.
- Reworking mobile or Pear React UI in this milestone.

## Current State

The native desktop shell already has useful building blocks:

- top-level section navigation in [ContentView.swift](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/ContentView.swift)
- shared browse snapshot state in [AppState.swift](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/App/AppState.swift)
- feed rendering in [FeedListView.swift](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/FeedListView.swift)
- watch page playback, channel attribution, comments, and reactions in [VideoDetailView.swift](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/VideoDetailView.swift)
- native host commands for identity creation, upload, publish, subscribe, comments, and reactions in [HostBridgeService.swift](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift) and [NativeBridgeRPC.swift](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/NativeBridgeRPC.swift)

The gaps are product-level:

- `Studio` is still rendered through the generic feed surface instead of a creator workspace.
- Channel browsing is scattered across feed cards and watch-page attribution instead of having a dedicated screen.
- Upload is currently a thin `NSOpenPanel -> upload RPC -> snapshot refresh` action with no real in-app flow.
- The native bridge does not yet expose the full owner edit surface needed for native channel and video management.

## Recommended Approach

Keep the current section-based shell, but promote `Studio` and `Channel` into dedicated native surfaces backed by targeted RPC.

This is the recommended approach because it improves the user-facing model without introducing more architectural change than the current native app needs. `Home`, `Subscriptions`, `Library`, and `Diagnostics` can continue to use browse snapshots. `Studio` and `Channel` should not. Creator and identity workflows need richer state, direct actions, and better progress reporting than snapshots are designed to provide.

## Alternatives Considered

### 1. Lightweight retrofit of the current feed surface

Add more cards and controls to [FeedListView.swift](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/FeedListView.swift) for upload, publish, and owner edits.

This is the lowest-effort option, but it keeps the app trapped in a generic list-first architecture. It would feel bolted on and would make future creator work harder.

### 2. Purpose-built Studio and Channel surfaces

Keep the current shell and top navigation, but give `Studio` its own dedicated creator screen and add a dedicated full-page `Channel` screen.

This is the recommended option. It matches the user’s requested single-screen creator flow, preserves the current native shell, and uses clearer boundaries for browse, watch, and creator workflows.

### 3. Full navigation and routing reshape

Make channels a first-class routing concept, split Studio/Channel/Library into a larger page model, and rework the whole shell around it.

This is a reasonable future direction, but it is too large for the next milestone and would delay shipping a good native creator experience.

## Design Principles

- Native creator flow: the app should feel like a Mac creator client, not a port of a mobile upload wizard.
- Fast to first upload: selecting a file should start the upload immediately.
- Edit after upload: title, description, category, and thumbnail can be refined once the asset is in the channel.
- One canonical channel surface: channel identity and channel browsing should converge on a single page.
- Host owns content truth: upload, channel metadata, subscription state, and content records stay in Bare.
- Swift owns presentation: drafts, selection, page state, progress display, and desktop interactions stay in the native shell.

## Screen Model

The native app should use three content modes:

- `Browse mode`
  - existing section-based surfaces for `Home`, `Subscriptions`, `Library`, `Diagnostics`
- `Studio mode`
  - a dedicated creator workspace entered from the `Studio` tab
- `Channel mode`
  - a dedicated channel page entered from video cards, watch-page channel attribution, and Studio

This does **not** require a full router. The current `AppState` can evolve to track:

- current section
- watch-page selection
- channel-page selection
- page mode or mutually exclusive detail state

The native shell should keep one clear rule:

- browse pages show collections
- watch pages show one video
- channel pages show one creator
- Studio shows creator workflows for the active identity

## Studio Design

`Studio` should become a dedicated single-screen creator workspace composed of five stacked areas.

### 1. Channel Status Card

If no identity exists:

- prominent `Create Channel` CTA
- suggested default name from current identity logic
- short explanation that upload and publishing unlock after creation

If an identity exists:

- avatar
- channel name
- description preview
- published/unpublished state
- quick actions:
  - `Edit Channel`
  - `Publish Channel` when unpublished
  - `Open Channel`

### 2. Upload Composer

The top of the workspace should expose a large upload entry surface:

- click to choose a video file
- drag and drop onto the Studio surface

Once a file is selected:

- upload starts immediately
- Studio renders a live upload card with:
  - filename
  - status
  - progress bar
  - percent
  - speed / ETA when available

This is the largest functional gap in the native app today. The host already supports upload; the missing piece is a proper native flow around it.

### 3. Post-Upload Details Editor

After a successful upload, Studio should focus the uploaded video in a details editor.

Fields:

- title
- description
- category
- thumbnail picker

This editor should save changes without requiring a re-upload. It should be usable for both the just-uploaded video and existing uploads selected from the recent uploads list.

### 4. Recent Uploads / Owner Video List

Studio should show the active channel’s videos in a creator-oriented list or grid with quick actions:

- open/watch
- edit metadata
- set or replace thumbnail
- remove video

This list is the owner-facing native equivalent of the current React Studio video management area. It should not be treated as just another feed section.

### 5. Empty and Failure States

Studio should show creator-specific empty states:

- no identity: create channel
- identity but no uploads: upload prompt
- unpublished channel: publish guidance

Failures should stay local to the workspace:

- upload failure keeps the selected file card visible and offers retry / choose another file
- metadata save failure keeps the draft intact
- publish failure stays attached to the channel status card

## Channel Page Design

The native app should add a dedicated `ChannelDetailView` with one structure that adapts to both viewer and owner roles.

### Header

Always show:

- avatar
- channel name
- secondary identity line
- description or about preview
- lightweight stats:
  - video count
  - subscribe state
  - owner badge when the channel is the active identity

Actions differ by role:

- viewer mode:
  - `Subscribe` / `Subscribed`
- owner mode:
  - `Edit Channel`
  - `Publish Channel` when unpublished
  - `Upload Video`
  - optionally `Open in Studio`

### Body

The body should use a segmented control:

- `Videos`
- `About`

`Videos` tab:

- same fixed thumbnail shell rules as the rest of the native app
- viewer affordances: open/watch
- owner affordances:
  - edit metadata
  - set thumbnail
  - remove video

`About` tab:

- expanded description
- ownership or publish-state context when relevant
- optional diagnostic identity details later, but not first priority

### Entry Points

The app should open the channel page consistently from:

- channel avatar/name in browse cards
- channel avatar/name in watch page
- Studio `Open Channel`

The watch page should not become the place where users manage their whole channel identity. Channel-level actions belong on the channel page or Studio.

## Data Boundary

Browse snapshots should continue to power browse surfaces. `Studio` and `Channel` should use targeted host calls.

### Existing Native-Ready Capabilities

Already present in the native bridge or host layer:

- create active identity
- upload video
- publish active channel
- subscribe / unsubscribe
- comments and reactions

### Required Native Surface Additions

The native bridge should expose targeted commands for:

- `getChannelMeta`
- `listChannelVideos`
- `updateChannel`
- `updateChannelAvatar`
- `setVideoThumbnailFromFile`
- `updateVideoMetadata`
- `removeVideo`

The host/backend already has several of these operations on the React/Pear side. This milestone is about exposing them cleanly to the Swift shell and shaping responses for native use.

### Upload Progress Events

The native shell also needs an event for live upload state:

- `uploadProgress`

Without that event, Studio can only refresh snapshots after the fact, which is not enough for a real creator workflow.

## Native State Shape

`AppState` should expand with targeted view state rather than folding everything into the existing section catalog.

Recommended additions:

- page mode or equivalent mutually exclusive state:
  - browse
  - watch
  - channel
- selected channel key
- channel detail payload:
  - metadata
  - videos
  - loading/error state
  - owner/viewer mode
- Studio payload:
  - active upload state
  - selected upload for editing
  - channel edit draft
  - video metadata draft

This should stay presentation-oriented. Bare remains the source of truth for channels, videos, uploads, and subscriptions.

## Interaction Model

### Studio

- selecting a file begins upload immediately
- successful upload selects the new video in the details editor
- editing metadata is save-based, not wizard-driven
- drag-and-drop and picker selection should use the same underlying upload path

### Channel Page

- selecting a channel anywhere in the app opens the same channel screen
- owner mode reveals management controls inline
- viewer mode remains browse-first
- subscribe state updates without kicking the user out of the channel page

## Error Handling

Studio and Channel pages should not depend only on global app-level errors.

### Studio Errors

- picker canceled: no error
- upload failed: inline upload-card error with retry
- metadata save failed: keep draft, show inline field or form error
- publish failed: error attached to channel status card

### Channel Page Errors

- metadata or video load failure: stay on the channel page with retry
- subscription failure: keep page loaded and show local action error
- destructive owner actions:
  - confirm before `Remove Video`
  - keep the user on the same page after success

### Offline / Host State

- disable upload and edit actions while host is booting or unavailable
- when last-known channel data exists, prefer stale-but-visible content with a stale-state indicator over a blank page

## Testing

### State and Logic Tests

- Studio state transitions:
  - no identity -> create identity
  - upload start / progress / success / failure
  - post-upload selection
  - metadata draft persistence on save failure
- Channel page state transitions:
  - load success / failure
  - owner mode vs viewer mode
  - subscribe toggle result

### Bridge Tests

- new RPC codecs for:
  - channel metadata and videos
  - owner edit actions
  - upload progress events

### Manual Verification

- create channel
- upload video
- edit metadata after upload
- set thumbnail
- publish channel
- open channel from browse
- open channel from watch page
- open channel from Studio
- subscribe from another creator’s channel
- remove an owned video from Studio and Channel page

## Implementation Notes

- `StudioView` and `ChannelDetailView` should be new native surfaces rather than large branches inside [FeedListView.swift](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/FeedListView.swift).
- The current top navigation and sidecar host lifecycle should remain intact.
- The design should align with recent native desktop work already landed in this branch:
  - sidecar-first host transport
  - portrait-aware playback
  - fixed thumbnail shells
  - watch-page comments and reactions

## Verification Criteria

This design should be considered implemented only when:

- `Studio` is a dedicated creator workspace instead of a generic feed section
- a user can create a channel, pick a video, see live upload progress, and edit metadata afterward without leaving Studio
- a user can open a dedicated native channel page from multiple entry points
- channel pages behave differently for owner and viewer roles without duplicating screens
- owner actions for channel and video editing complete through the native shell
- failures remain local to Studio or Channel instead of collapsing back into generic browse errors
