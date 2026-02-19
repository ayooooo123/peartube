/**
 * VideoControlContext - DEPRECATED
 *
 * This file is kept only for the playbackActiveEmitter export.
 * The Provider and hooks have been removed as they were never mounted.
 */

// Export for subscribers (used by _layout.tsx and _layout.web.tsx)
export const playbackActiveEmitter = {
  isActive: false,
  set(active: boolean) { this.isActive = active },
}
