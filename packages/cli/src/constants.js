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

// The largest range a granted ingest asks the source callback for, and the
// ceiling the relay enforces on a configured one. This is a timeout budget
// rather than a throughput knob: `open()` in companion/source-client.js arms
// ONE `sourceRequestTimeoutMs` timer across a whole range response — headers
// and body — so a range has to finish inside it, upstream session
// establishment included. Cold establishment against a debrid origin measures
// ~8 s, leaving ~12 s of body under the 20 s default, which 16 MiB clears at
// any sustained rate above 1.4 MB/s — an order of magnitude below the ~26 MB/s
// the CDN actually serves. 32 MiB would not clear it on a degraded link.
//
// The same figure is what a failed range costs to re-read, and what a
// concurrent ingest holds resident: one range while its body arrives, two with
// the one-range read-ahead in archive-manager's granted source.
export const MAX_SOURCE_CHUNK_BYTES = 16 * 1024 * 1024

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
  sourceChunkBytes: MAX_SOURCE_CHUNK_BYTES,
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
// Block offload moves media block DATA to an object store and keeps the merkle
// tree and bitfield on local disk, so a relay can archive a title far larger
// than its volume. Off by default: it is an operator decision that makes every
// served block depend on a third party being reachable.
export const DEFAULT_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES = 2 * 1024 * 1024 * 1024
export const DEFAULT_ARCHIVE_S3_CONFIG = {
  endpoint: '',
  bucket: '',
  region: 'us-east-1',
  accessKeyId: '',
  secretAccessKey: '',
  prefix: '',
  enabled: true,
  forcePathStyle: false,
  offload: false,
  offloadWindowBytes: DEFAULT_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES
}

// Which object store backs block offload, and the config section that
// configures it. Three named backends behind one switch — an operator picks a
// name, and the section of that name holds its credentials and its window.
// `s3` is the default because it is the only backend that existed before, so a
// relay that was already offloading to a bucket keeps exactly the behaviour it
// had without naming a provider at all.
export const ARCHIVE_OFFLOAD_PROVIDER_SECTIONS = {
  s3: 's3',
  'google-drive': 'googleDrive',
  mega: 'mega'
}
export const ARCHIVE_OFFLOAD_PROVIDERS = Object.keys(ARCHIVE_OFFLOAD_PROVIDER_SECTIONS)
export const DEFAULT_ARCHIVE_OFFLOAD_PROVIDER = 's3'

// Drive's OAuth exchange stays outside the relay, the way SigV4 signing does:
// the operator supplies an access token the same way they supply a bucket key.
// Drive's API hosts are operator-supplied and deliberately have no default
// anywhere in this source tree. The anti-centralization guard rejects a remote
// origin in production source, and it is right to: a relay that ships pointing
// at somebody's service is not permissionless, however convenient the default.
// An operator running against Drive itself sets filesEndpoint to Drive's v3
// files API and uploadEndpoint to its upload counterpart; the values belong in
// their config file, not in ours.
export const DEFAULT_ARCHIVE_GOOGLE_DRIVE_CONFIG = {
  accessToken: '',
  folderId: '',
  prefix: '',
  filesEndpoint: '',
  uploadEndpoint: '',
  offload: false,
  offloadWindowBytes: DEFAULT_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES
}

// Mega's session id (`sid`), likewise: turning an email and password into one
// needs AES and RSA that the universal backend does not have, so the credential
// exchange is the operator's, not the relay's. `apiUrl` is left empty to mean
// Mega's own endpoint.
export const DEFAULT_ARCHIVE_MEGA_CONFIG = {
  session: '',
  folder: '',
  prefix: '',
  apiUrl: '',
  offload: false,
  offloadWindowBytes: DEFAULT_ARCHIVE_S3_OFFLOAD_WINDOW_BYTES
}
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
  maxDirectDownloadBytes: 0,
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
  // Which of the sections below backs block offload.
  provider: DEFAULT_ARCHIVE_OFFLOAD_PROVIDER,
  s3: DEFAULT_ARCHIVE_S3_CONFIG,
  googleDrive: DEFAULT_ARCHIVE_GOOGLE_DRIVE_CONFIG,
  mega: DEFAULT_ARCHIVE_MEGA_CONFIG,
  uiEnabled: false,
  uiHost: '127.0.0.1',
  uiPort: 8174,
  // The machine API's catalog and stream routes on a non-loopback bind. Off by
  // default: a relay is not asked to serve its media to a network by accident.
  apiOpen: false
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
