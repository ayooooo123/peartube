export const RELAY_COMMAND = 'peartube-relay'

export const RELAY_MODE_PRIVATE = 'private'
export const RELAY_MODE_PUBLIC = 'public'

export const RELAY_POLICY_ALLOWLIST = 'allowlist'
export const RELAY_POLICY_DISCOVERY = 'discovery'

export const VALID_MODES = [RELAY_MODE_PRIVATE, RELAY_MODE_PUBLIC]
export const VALID_POLICIES = [RELAY_POLICY_ALLOWLIST, RELAY_POLICY_DISCOVERY]

export const DEFAULT_STORAGE_PATH = './peartube-relay'
export const DEFAULT_MAX_BYTES = 100000 * 1024 * 1024

export const DEFAULT_DISCOVERY_MAX_CHANNELS = 0
export const DEFAULT_DISCOVERY_MAX_CHANNELS_PER_OWNER = 0

export const RELAY_CATALOG_FILENAME = 'relay-catalog.json'
export const RELAY_STATUS_FILENAME = 'relay-status.json'

export const RETENTION_PRIORITY = {
  discovery: 1,
  allowlist: 2,
  private: 3
}

export const ARCHIVE_TYPE_YOUTUBE = 'youtube'
export const ARCHIVE_TYPE_RUMBLE = 'rumble'
export const VALID_ARCHIVE_TYPES = [ARCHIVE_TYPE_YOUTUBE, ARCHIVE_TYPE_RUMBLE]

export const DEFAULT_ARCHIVE_POLL_SECONDS = 3600
export const DEFAULT_ARCHIVE_FORMAT = 'bv*+ba/b'
export const DEFAULT_ARCHIVE_MAX_ITEMS = 50
export const DEFAULT_ARCHIVE_MAX_RETRIES = 3
export const DEFAULT_ARCHIVE_BUDGET_RESERVE_PERCENT = 5
export const DEFAULT_ARCHIVE_YT_DLP_PATH = 'yt-dlp'
export const DEFAULT_ARCHIVE_FFMPEG_PATH = ''
export const DEFAULT_ARCHIVE_JS_RUNTIME = ''
export const DEFAULT_ARCHIVE_YT_DLP_EXTRA_ARGS = []
export const DEFAULT_ARCHIVE_YT_DLP_RETRY_EXTRA_ARGS = []
export const DEFAULT_LOCAL_MIRROR_POLL_SECONDS = 30

export const DEFAULT_ARCHIVE_CONFIG = {
  enabled: false,
  poll: DEFAULT_ARCHIVE_POLL_SECONDS,
  format: DEFAULT_ARCHIVE_FORMAT,
  tmpPath: null,
  ytDlpPath: DEFAULT_ARCHIVE_YT_DLP_PATH,
  ffmpegPath: DEFAULT_ARCHIVE_FFMPEG_PATH,
  cookiesPath: null,
  jsRuntime: DEFAULT_ARCHIVE_JS_RUNTIME,
  ytDlpExtraArgs: DEFAULT_ARCHIVE_YT_DLP_EXTRA_ARGS,
  ytDlpRetryExtraArgs: DEFAULT_ARCHIVE_YT_DLP_RETRY_EXTRA_ARGS,
  maxRetries: DEFAULT_ARCHIVE_MAX_RETRIES,
  budgetReservePercent: DEFAULT_ARCHIVE_BUDGET_RESERVE_PERCENT,
  maxItems: DEFAULT_ARCHIVE_MAX_ITEMS,
  sources: [],
  localMirror: {
    enabled: false,
    path: null,
    poll: DEFAULT_LOCAL_MIRROR_POLL_SECONDS,
    channelName: 'Local Drive Mirror',
    description: '',
    recursive: true,
    maxFiles: DEFAULT_ARCHIVE_MAX_ITEMS
  },
  uiEnabled: false,
  uiHost: '127.0.0.1',
  uiPort: 8174
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
    seedDiscovered: true,
    maxChannels: DEFAULT_DISCOVERY_MAX_CHANNELS,
    maxChannelsPerOwner: DEFAULT_DISCOVERY_MAX_CHANNELS_PER_OWNER
  },
  retention: {
    protectPrivate: true,
    protectAllowlist: true
  },
  network: {
    announce: true,
    bootstrap: 'default',
    blindPeer: true,
    trustedBlindPeerClients: []
  },
  archive: DEFAULT_ARCHIVE_CONFIG,
  logging: {
    level: 'info'
  }
}
