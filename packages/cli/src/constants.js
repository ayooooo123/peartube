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
// Refuse new ingestion (discovery mirroring, archive imports) once free disk on
// the storage volume drops below this floor, so the relay stops growing before
// it crashes the process with ENOSPC. 0 disables the floor.
export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024

export const DEFAULT_COMPANION_CONFIG = {
  enabled: false,
  transport: 'unix',
  socketPath: null,
  host: '127.0.0.1',
  port: 8175,
  client: 'mediastorm',
  sharedSecret: '',
  maxBodyBytes: 1024 * 1024,
  maxClockSkewMs: 30_000,
  maxNonces: 4096,
  sourceOrigin: null,
  sourceClient: 'peartube-companion',
  sourceSharedSecret: '',
  sourceChunkBytes: 4 * 1024 * 1024,
  sourceRequestTimeoutMs: 20_000,
}

export const DEFAULT_DISCOVERY_MAX_CHANNELS = 0
export const DEFAULT_DISCOVERY_MAX_CHANNELS_PER_OWNER = 0

export const MAX_SEED_PIN_CONCURRENT = 64
export const MAX_SEED_PIN_TRUSTED_CLIENTS = 256
export const DEFAULT_SEED_PIN_CONFIG = {
  enabled: true,
  maxBytes: 536870912000,
  maxConcurrent: 2,
  retentionDays: 30,
  trustedClients: []
}

export const RELAY_CATALOG_FILENAME = 'relay-catalog.json'
export const RELAY_STATUS_FILENAME = 'relay-status.json'
export const RELAY_CREATORS_FILENAME = 'relay-creators.json'
export const RELAY_CLASSIFICATION_FILENAME = 'relay-classification.json'
export const RELAY_SETTINGS_FILENAME = 'relay-settings.json'
export const RELAY_TRUSTED_CLIENTS_FILENAME = 'relay-trusted-clients.json'

export const DEFAULT_TMDB_BASE_URL = 'https://api.themoviedb.org/3'
export const DEFAULT_TMDB_LANGUAGE = 'en-US'

export const DEFAULT_CLASSIFICATION_CONFIG = {
  tmdb: {
    enabled: false,
    apiKey: '',
    baseUrl: DEFAULT_TMDB_BASE_URL,
    language: DEFAULT_TMDB_LANGUAGE
  }
}

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
    maxBytes: DEFAULT_MAX_BYTES,
    minFreeBytes: DEFAULT_MIN_FREE_BYTES
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
  seedPin: DEFAULT_SEED_PIN_CONFIG,
  retention: {
    protectPrivate: true,
    protectAllowlist: true
  },
  network: {
    announce: true,
    bootstrap: 'default',
    trustedRelayKeys: []
  },
  companion: DEFAULT_COMPANION_CONFIG,
  archive: DEFAULT_ARCHIVE_CONFIG,
  classification: DEFAULT_CLASSIFICATION_CONFIG,
  logging: {
    level: 'info'
  }
}
