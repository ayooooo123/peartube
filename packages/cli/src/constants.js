export const RELAY_COMMAND = 'peartube-relay'
export const RELAY_COMPAT_COMMAND = 'peartube-peer'

export const RELAY_MODE_PRIVATE = 'private'
export const RELAY_MODE_PUBLIC = 'public'

export const RELAY_POLICY_ALLOWLIST = 'allowlist'
export const RELAY_POLICY_DISCOVERY = 'discovery'

export const VALID_MODES = [RELAY_MODE_PRIVATE, RELAY_MODE_PUBLIC]
export const VALID_POLICIES = [RELAY_POLICY_ALLOWLIST, RELAY_POLICY_DISCOVERY]

export const DEFAULT_STORAGE_PATH = './peartube-relay'
export const DEFAULT_MAX_BYTES = 100000 * 1024 * 1024

export const DEFAULT_DISCOVERY_MAX_CHANNELS = 500
export const DEFAULT_DISCOVERY_MAX_CHANNELS_PER_OWNER = 20

export const RELAY_CATALOG_FILENAME = 'relay-catalog.json'
export const RELAY_STATUS_FILENAME = 'relay-status.json'

export const RETENTION_PRIORITY = {
  discovery: 1,
  allowlist: 2,
  private: 3
}

export const DEFAULT_RELAY_CONFIG = {
  mode: RELAY_MODE_PUBLIC,
  policy: RELAY_POLICY_DISCOVERY,
  storage: {
    path: DEFAULT_STORAGE_PATH,
    maxBytes: DEFAULT_MAX_BYTES
  },
  admission: {
    channels: [],
    owners: []
  },
  discovery: {
    enabled: true,
    maxChannels: DEFAULT_DISCOVERY_MAX_CHANNELS,
    maxChannelsPerOwner: DEFAULT_DISCOVERY_MAX_CHANNELS_PER_OWNER
  },
  retention: {
    protectPrivate: true,
    protectAllowlist: true
  },
  network: {
    announce: true,
    bootstrap: 'default'
  },
  logging: {
    level: 'info'
  }
}
