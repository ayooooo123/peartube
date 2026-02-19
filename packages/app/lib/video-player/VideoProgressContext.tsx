/**
 * VideoProgressContext - DEPRECATED
 *
 * This file is kept for backward compatibility but the Provider and hooks
 * have been removed as they were never mounted.
 */

// Placeholder exports to prevent import errors
export function useVideoProgressContext() {
  throw new Error('useVideoProgressContext is deprecated and no longer available')
}

export function useVideoProgressContextOptional() {
  return null
}
