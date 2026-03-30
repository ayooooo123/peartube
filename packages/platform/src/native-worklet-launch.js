/**
 * @typedef {{
 *   start: (...args: any[]) => void
 * }} WorkletLike
 */

/**
 * @param {WorkletLike} worklet
 * @param {{
 *   backendPath: string,
 *   backendSource: string,
 *   workletId: string,
 *   launchArgs: string[]
 * }} options
 * @returns {'file' | 'source'}
 */
export function launchNativeWorklet(worklet, {
  backendPath,
  backendSource,
  workletId,
  launchArgs,
}) {
  if (backendPath) {
    worklet.start(backendPath, launchArgs)
    return 'file'
  }

  if (backendSource) {
    worklet.start(workletId, backendSource, launchArgs)
    return 'source'
  }

  throw new Error('Missing backend worklet launch input')
}
