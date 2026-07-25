export const DEFAULT_NETWORK_POLICY = Object.freeze({
  uploadPermission: 'manual',
  meteredNetwork: 'pause-network',
  backgroundMode: 'local-only',
  diskCeilingBytes: 5 * 1024 * 1024 * 1024,
  uploadCeilingBytes: 0,
  retentionMode: 'none',
  followedPublishers: [],
  followedIndexes: [],
  trustedModerationFeeds: [],
  aiAnalysis: 'disabled',
})

const ENUMS = {
  uploadPermission: new Set(['disabled', 'manual', 'enabled']),
  meteredNetwork: new Set(['pause-network', 'local-only', 'allow']),
  backgroundMode: new Set(['pause-network', 'local-only', 'allow']),
  retentionMode: new Set(['none', 'local-pin', 'archive-pledges']),
  aiAnalysis: new Set(['disabled', 'local-only', 'enabled']),
}

function boundedList(value, name) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${name} must be bounded list`)
  return value.map(item => String(item)).filter(Boolean)
}

function boundedBytes(value, name) {
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${name} must be nonnegative safe integer`)
  return next
}
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function decodeBoundedList(value, name) {
  let parsed
  try {
    parsed = JSON.parse(String(value))
  } catch {
    throw new Error(`${name} must be valid JSON`)
  }
  return boundedList(parsed, name)
}

function decodeNetworkPolicyPatch(input = {}) {
  const patch = { ...input }
  const listFields = [
    ['followedPublishersJson', 'followedPublishers'],
    ['followedIndexesJson', 'followedIndexes'],
    ['trustedModerationFeedsJson', 'trustedModerationFeeds'],
  ]
  for (const [wireName, policyName] of listFields) {
    if (input[wireName] != null) patch[policyName] = decodeBoundedList(input[wireName], policyName)
    delete patch[wireName]
  }
  if (input.diskCeilingBytesPresent === true && !hasOwn(input, 'diskCeilingBytes')) patch.diskCeilingBytes = 0
  if (input.uploadCeilingBytesPresent === true && !hasOwn(input, 'uploadCeilingBytes')) patch.uploadCeilingBytes = 0
  delete patch.diskCeilingBytesPresent
  delete patch.uploadCeilingBytesPresent
  return patch
}

function networkPolicyWireFields(policy) {
  return {
    uploadPermission: policy.uploadPermission,
    meteredNetwork: policy.meteredNetwork,
    backgroundMode: policy.backgroundMode,
    diskCeilingBytes: policy.diskCeilingBytes,
    uploadCeilingBytes: policy.uploadCeilingBytes,
    retentionMode: policy.retentionMode,
    followedPublishersJson: JSON.stringify(policy.followedPublishers),
    followedIndexesJson: JSON.stringify(policy.followedIndexes),
    trustedModerationFeedsJson: JSON.stringify(policy.trustedModerationFeeds),
    aiAnalysis: policy.aiAnalysis,
  }
}

export function normalizeNetworkPolicy(input = {}, base = DEFAULT_NETWORK_POLICY) {
  const policy = { ...base }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (input[key] !== undefined) {
      if (!allowed.has(input[key])) throw new Error(`invalid ${key}`)
      policy[key] = input[key]
    }
  }
  if (input.diskCeilingBytes !== undefined) policy.diskCeilingBytes = boundedBytes(input.diskCeilingBytes, 'diskCeilingBytes')
  if (input.uploadCeilingBytes !== undefined) policy.uploadCeilingBytes = boundedBytes(input.uploadCeilingBytes, 'uploadCeilingBytes')
  for (const key of ['followedPublishers', 'followedIndexes', 'trustedModerationFeeds']) {
    if (input[key] !== undefined) policy[key] = boundedList(input[key], key)
  }
  return policy
}

export function createPolicyApi({ store = new Map(), onPolicyChange = null } = {}) {
  const key = 'network-policy:v1'
  const read = () => store.get?.(key) || DEFAULT_NETWORK_POLICY
  const write = async policy => {
    if (typeof store.set === 'function') store.set(key, policy)
    else if (typeof store.put === 'function') await store.put(key, policy)
  }
  return {
    async getNetworkPolicy() {
      const policy = read()
      return { success: true, policy, ...networkPolicyWireFields(policy) }
    },
    async setNetworkPolicy(input = {}) {
      try {
        const policy = normalizeNetworkPolicy(decodeNetworkPolicyPatch(input), read())
        await write(policy)
        onPolicyChange?.(policy)
        return { success: true, policy }
      } catch (err) {
        return { success: false, errorCode: 'INVALID_POLICY', error: err?.message || String(err) }
      }
    },
  }
}
