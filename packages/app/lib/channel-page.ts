/**
 * Shared channel-page load helpers used by both the native and web channel
 * screens. The screens diverge in routing, avatar picking, and rendering, but
 * both race the channel-meta/video RPCs against the same soft timeout so a slow
 * peer can't hang the page — that race lives here so the two stay in sync.
 */

export const CHANNEL_PAGE_RPC_TIMEOUT_MS = 4500

export type ChannelPageTimeoutResult = { timedOut: true }

export function withChannelPageTimeout<T>(
  promise: Promise<T>,
  ms = CHANNEL_PAGE_RPC_TIMEOUT_MS,
): Promise<T | ChannelPageTimeoutResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.finally(() => {
      if (timeout) clearTimeout(timeout)
    }),
    new Promise<ChannelPageTimeoutResult>((resolve) => {
      timeout = setTimeout(() => resolve({ timedOut: true }), ms)
    }),
  ])
}

export function isTimedOutResult(result: unknown): result is ChannelPageTimeoutResult {
  return Boolean(result && typeof result === 'object' && (result as any).timedOut === true)
}
