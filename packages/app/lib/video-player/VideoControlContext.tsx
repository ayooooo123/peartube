/**
 * VideoControlContext - DEPRECATED
 *
 * This file is kept only for the playbackActiveEmitter export.
 * The Provider and hooks have been removed as they were never mounted.
 */

// Export for subscribers (used by _layout.tsx and _layout.web.tsx).
// Semantics: true whenever an in-app local video session is open and the app
// should keep networking warm. This is intentionally broader than "currently
// playing" because PiP/background transitions can briefly pause transport.
export const playbackActiveEmitter = {
  isActive: false,
  set(active: boolean) { this.isActive = active },
}
