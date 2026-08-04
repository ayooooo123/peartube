import { PROTECTED_DRM_SYSTEMS, TEST_ONLY_DRM_SYSTEMS } from '../access/protected-rendition.js'

/**
 * Can this device play this protected source at all?
 *
 * Protected media is public opaque ciphertext plus a public descriptor naming
 * the DRM system whose platform CDM can license it. Nothing in this module
 * touches a content key, a license, or a provider credential — there is no
 * parameter here that could carry one. The only question is whether the
 * platform on this device implements the named system, and the only answer is
 * the capability list the host injected.
 *
 * Asking it here, before anything else, is what keeps an unplayable protected
 * title from costing a download: `DRM_UNSUPPORTED` is decided from the public
 * descriptor and the device alone, so no asset scope is joined and no session is
 * authorized for a rendition this device could never decode.
 */

const RECOGNISED_DRM_SYSTEMS = new Set(PROTECTED_DRM_SYSTEMS)
const TEST_DRM_SYSTEMS = new Set(TEST_ONLY_DRM_SYSTEMS)
const NO_DRM_SUPPORT = new Set()

export function normalizeDrmSystemName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * The DRM systems this device claims, reduced to the ones that exist.
 *
 * A name outside the known vocabulary is dropped rather than trusted, so a
 * capability list nobody recognises supports nothing. ClearKey is a
 * deterministic test/dev system with no real CDM behind it: a device only
 * claims it when the caller also injects `allowClearKeyForTests`, which
 * production wiring never does.
 */
export function supportedDrmSystems(capabilities = {}) {
  const declared = capabilities?.drmSystems
  if (!Array.isArray(declared) || declared.length === 0) return NO_DRM_SUPPORT
  const allowClearKey = capabilities.allowClearKeyForTests === true
  const supported = new Set()
  for (const entry of declared) {
    const name = normalizeDrmSystemName(entry)
    if (RECOGNISED_DRM_SYSTEMS.has(name)) supported.add(name)
    else if (allowClearKey && TEST_DRM_SYSTEMS.has(name)) supported.add(name)
  }
  return supported.size === 0 ? NO_DRM_SUPPORT : supported
}

/**
 * `DRM_UNSUPPORTED` when this device cannot play this source, otherwise null.
 *
 * Fails closed on purpose. No capability list, an unrecognised one, or a source
 * that says it is protected without naming a system all mean "this device
 * cannot play this", never "assume it can" — an optimistic guess here spends
 * bandwidth on ciphertext that can only end in a playback error.
 *
 * A public source carries no `drmSystem` and is not marked protected, so it
 * never reaches the capability check: device DRM capability cannot change the
 * outcome for public media in either direction.
 */
export function drmRejectionCode(source = {}, capabilities = {}) {
  const declared = normalizeDrmSystemName(source.drmSystem)
  if (source.protected !== true && declared.length === 0) return null
  if (declared.length === 0) return 'DRM_UNSUPPORTED'
  return supportedDrmSystems(capabilities).has(declared) ? null : 'DRM_UNSUPPORTED'
}

/**
 * The same question asked of a signed rendition descriptor instead of a
 * projected source. Reading protection off the descriptor in one place is why
 * the selector and the asset session can never disagree about what a manifest
 * says.
 */
export function renditionDrmRejectionCode(rendition, capabilities = {}) {
  const encryption = rendition?.encryption
  if (encryption == null) return null
  return drmRejectionCode({ protected: true, drmSystem: encryption.drmSystem }, capabilities)
}
