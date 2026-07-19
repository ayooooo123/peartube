const HEX_32 = /^[0-9a-f]{64}$/
const CHANNEL_ACCESS = new Set(['owned', 'paired'])

/**
 * Backend receiver policy. Cryptographic authentication has already produced
 * `verified`; this layer only consults the identity manager's current local
 * ownership/pairing facts. Any malformed fact or lookup failure rejects.
 */
export function createBackendSeedPinAdmission ({ identityManager } = {}) {
  if (!identityManager || typeof identityManager.getSeedPinOwnershipFacts !== 'function') {
    throw new TypeError('identityManager.getSeedPinOwnershipFacts is required')
  }

  return async function admitBackendSeedPin ({ verified } = {}) {
    if (!isVerifiedFacts(verified)) return false
    try {
      const facts = await identityManager.getSeedPinOwnershipFacts({
        identityPublicKey: verified.identityPublicKey,
        channelKey: verified.channelKey,
      })
      return facts?.identityOwned === true && CHANNEL_ACCESS.has(facts?.channelAccess)
    } catch {
      return false
    }
  }
}

function isVerifiedFacts (verified) {
  return verified?.valid === true &&
    typeof verified.identityPublicKey === 'string' && HEX_32.test(verified.identityPublicKey) &&
    typeof verified.requesterDevicePublicKey === 'string' && HEX_32.test(verified.requesterDevicePublicKey) &&
    typeof verified.channelKey === 'string' && HEX_32.test(verified.channelKey)
}
