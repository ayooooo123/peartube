# GPUI Memory Reduction Patches (Cross-Platform Desktop)

This document specifies the renderer and core patches for `gpui-pre` (`0.3.9`) that reduce GPUI's memory usage by 80% to 95% during 4K video playback and by 75% to 85% in active desktop views on macOS, Windows, and Linux.

All line references below were audited against `gpui-pre-0.3.9`, `gpui-pre-apple-0.3.9`, `gpui-pre-macos-0.3.9`, `gpui-pre-windows-0.3.9`, and `gpui-pre-wgpu-0.3.9`.

## 1. Suspend the GPUI Overlay Surface While Video HUD Controls Are Hidden

At 4K (`3840 x 2160`, `BGRA8Unorm` = `33.2 MB` per surface) or 5K (`5120 x 2880` = `59.0 MB` per surface), a transparent GPUI overlay holds 3 full-resolution drawables (`~100 MB` at 4K, `~177 MB` at 5K) even when every pixel is transparent during video playback.

- **Public API (`gpui-pre/src/window.rs`, `gpui-pre/src/platform.rs`):**
  - Add `PlatformWindow::set_overlay_suspended(&self, suspended: bool)` and forward it from `Window::set_overlay_suspended(&mut self, suspended: bool)`.
  - Call `window.set_overlay_suspended(true)` in `desktop/src/play.rs` when `has_picture() && !controls_shown()`, and `window.set_overlay_suspended(false)` as soon as pointer movement, keyboard input, or a menu wakes the HUD.
- **macOS (`gpui-pre-macos/src/window.rs`, `gpui-pre-apple/src/metal_renderer.rs`):**
  - When suspended: stop the `CVDisplayLink`, set `CAMetalLayer.setHidden(true)`, set `drawable_size` to `(0, 0)`, drop `path_intermediate_texture` and `path_intermediate_msaa_texture`, and clear `InstanceBufferPool`. Keep `GPUIView` attached so AppKit still delivers mouse and keyboard events.
  - When resumed: restore `drawable_size`, unhide the `CAMetalLayer`, and request one frame.
  - Side benefit: hiding the transparent `CAMetalLayer` lets macOS WindowServer promote the underlying `AVSampleBufferDisplayLayer` to hardware Direct-to-Display scanout.
- **Windows (`gpui-pre-windows/src/directx_renderer.rs`):**
  - When suspended: unbind `comp_visual` from `DirectComposition`, release `render_target` and path textures, and call `swap_chain.ResizeBuffers(2, 1, 1, ...)`.
  - Keep video in a dedicated `DirectComposition` YUV `IDXGISwapChain1` (`DXGI_FORMAT_NV12` / `P010`) stacked below GPUI's visual.
- **Linux / Wayland (`gpui-pre-wgpu/src/wgpu_renderer.rs`, `gpui-pre-linux/src/linux/wayland/window.rs`):**
  - When suspended: transition `RendererState::Ready` to `RendererState::Unconfigured` (dropping the configured swapchain while keeping pipelines) and call `resources.invalidate_intermediate_textures()`.
  - Keep video in a `wl_subsurface` backed by `zwp_linux_dmabuf_v1` (`NV12` / `P010`) and `wp_viewporter` stacked below GPUI's surface.

## 2. Reduce Default Swapchain Depth From 3 to 2

Desktop UI windows do not need triple-buffered game swapchains. Dropping from 3 buffers to 2 saves `33.2 MB` at 4K (`59 MB` at 5K) whenever UI is visible:

- **macOS Metal (`gpui-pre-apple/src/metal_renderer.rs:183`):** change `layer.set_maximum_drawable_count(3)` to `layer.set_maximum_drawable_count(2)`.
- **Windows DX11 (`gpui-pre-windows/src/directx_renderer.rs:1695`):** change `const BUFFER_COUNT: usize = 3` to `2`.
- **Linux / WGPU (`gpui-pre-wgpu/src/wgpu_renderer.rs:456`):** change `desired_maximum_frame_latency: 2` to `1`.

## 3. Allocate Intermediate Path Textures Lazily and Tightly

All three desktop renderers allocate full-viewport path render targets unconditionally, even when `scene.paths` is empty:

- **macOS Metal (`gpui-pre-apple/src/metal_renderer.rs:443-479`):** `update_path_intermediate_textures` allocates a full-viewport `BGRA8Unorm` texture (`33.2 MB` at 4K) on every resize, plus a `4x` MSAA texture (`132.7 MB` `StorageModePrivate` on Intel Macs; `Memoryless` on Apple Silicon).
- **Windows DX11 (`gpui-pre-windows/src/directx_renderer.rs:1372-1375, 1454`):** allocates both `path_intermediate_texture` (`33.2 MB`) and `4x` `path_intermediate_msaa_texture` (`132.7 MB`) unconditionally (`165.9 MB` at 4K).
- **Linux / WGPU (`gpui-pre-wgpu/src/wgpu_renderer.rs:1383-1437`):** calls `ensure_intermediate_textures(size)` on every `render_frame`, allocating both `path_intermediate` and `4x` `path_msaa` (`165.9 MB` at 4K).

Patch for all three backends:
1. Remove eager allocation from resize and frame entry; allocate only inside the `PrimitiveBatch::Paths` branch when `!paths.is_empty()`.
2. Size the texture to the clipped union bounding box of `scene.paths` rounded up to 64 px tiles instead of the full viewport.
3. Track `frames_without_paths: u32`; drop both intermediate textures after 60 frames with no paths or immediately on `set_overlay_suspended(true)`.

## 4. Shrink GPU Instance Buffers and Core CPU Arenas

- **GPU instance buffers:**
  - `gpui-pre-apple/src/metal_renderer.rs:63, 103-107, 1548-1572` starts at `2 MiB`, doubles up to `256 MiB`, and pushes released buffers back forever.
  - `gpui-pre-wgpu/src/wgpu_renderer.rs:1280, 2064-2101` starts at `2 MiB` and doubles up to `256 MiB` without shrinking.
  - Patch: start at `256 KiB`, cap `InstanceBufferPool::buffers` length to `2`, and reset back to `256 KiB` after 60 frames whose peak write size stays below `25%` of capacity.
- **Element arena (`gpui-pre/src/arena.rs:150-158`, `gpui-pre/src/window.rs:345`):**
  - `Arena::new(1024 * 1024)` never frees overflow `1 MiB` chunks in `force_clear()`.
  - Patch: use `256 KiB` chunks, call `self.chunks.truncate(1)` in `force_clear()` when `self.current_chunk_index == 0`, and shrink `self.elements` when its capacity exceeds `4x` the high-water mark of the last 60 frames.
- **Double-buffered `Frame`, `Scene`, and `TaffyLayoutEngine`:**
  - `gpui-pre/src/window.rs:1122-1148`, `gpui-pre/src/scene.rs:57-69`, and `gpui-pre/src/taffy.rs:55-60` only call `.clear()` and never shrink backing capacities.
  - `gpui-pre/src/scene.rs:102-139` stores every primitive twice (in its typed `Vec` and in `paint_operations: Vec<PaintOperation>`).
  - Patch: store compact `(PrimitiveKind, u32)` indices in `paint_operations` instead of cloning full `Primitive` structs, and expose `Window::trim_memory(&mut self)` to shrink `rendered_frame`, `next_frame`, `Scene`, and `TaffyLayoutEngine` on route changes and playback start.

## 5. Bound and Evict the Texture Atlas

- `gpui-pre/src/platform.rs:1771-1827` (`AtlasState`) keeps every glyph and SVG tile in `tiles_by_key` for the lifetime of the window.
- `metal_atlas.rs:129-132`, `wgpu_atlas.rs:188-191`, and `directx_atlas.rs:164-166` allocate minimum `1024 x 1024` pages (`1 MB` monochrome, `4 MB` color).
- Patch:
  1. Lower `DEFAULT_ATLAS_SIZE` from `1024 x 1024` to `512 x 512` (`256 KB` mono, `1 MB` color).
  2. Store a `last_used_frame: u64` counter per tile in `AtlasState` and enforce a configurable byte ceiling (for example, `12 MB` total) with LRU eviction when inserting new tiles.
  3. On WGPU (`wgpu_atlas.rs:256-265`), upload directly or reuse a single staging buffer instead of allocating a fresh `Vec<u8>` per upload.

## 6. Flush `CVMetalTextureCache` When Using `surface()` on macOS

- `gpui-pre-apple/src/metal_renderer.rs:368-384, 1224-1266` creates `core_video_texture_cache` and wraps `CVPixelBuffer` planes into Metal textures during `draw_surfaces`, but never calls `CVMetalTextureCacheFlush`.
- Patch: call `CVMetalTextureCache::flush(&self.core_video_texture_cache, 0)` after committing any command buffer that drew one or more `PaintSurface` primitives so CoreVideo releases decoded 4K `CVPixelBuffer`s promptly.
