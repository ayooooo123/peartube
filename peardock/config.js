/**
 * Centralized configuration constants
 */

export const CONFIG = {
  // Stats collection
  STATS: {
    INTERVAL_MS: 2000,              // Base stats collection interval
    ACTIVE_INTERVAL_MS: 1000,        // Interval for active containers
    IDLE_INTERVAL_MS: 5000,          // Interval for idle containers
    CACHE_TTL_MS: 1000,              // Stats cache TTL
    SMOOTHING_FACTOR: 0.2,           // Stats smoothing factor
  },

  // UI updates
  UI: {
    DEBOUNCE_MS: 300,                // Debounce time for UI updates
    SKELETON_LOADER_DELAY: 200,      // Delay before showing skeleton
    ALERT_DURATION_MS: 5000,         // Alert display duration
  },

  // Connection
  CONNECTION: {
    TIMEOUT_MS: 30000,               // Connection timeout
    RECONNECT_DELAY_MS: 5000,        // Reconnect delay
    HEALTH_CHECK_INTERVAL_MS: 10000,  // Health check interval
  },

  // Container operations
  CONTAINER: {
    MAX_NAME_LENGTH: 63,
    MIN_NAME_LENGTH: 1,
    MAX_IMAGE_LENGTH: 255,
    OPERATION_TIMEOUT_MS: 60000,     // Operation timeout
  },

  // Terminal
  TERMINAL: {
    MIN_HEIGHT: 150,
    MAX_HEIGHT_RATIO: 0.9,          // Max height as ratio of window
    SCROLLBACK_LINES: 10000,
    HISTORY_SIZE: 1000,
  },

  // Storage
  STORAGE: {
    COOKIE_SIZE_LIMIT: 4000,         // 4KB cookie limit
    CONNECTIONS_KEY: 'peardock_connections',
    USE_LOCALSTORAGE_KEY: 'peardock_use_localstorage',
    TEMPLATES_KEY: 'peardock_templates',
  },

  // Docker command validation
  DOCKER: {
    MAX_COMMAND_LENGTH: 500,
    ALLOWED_COMMANDS: [
      'ps', 'images', 'volumes', 'networks', 'info', 'version',
      'logs', 'inspect', 'stats', 'top', 'diff', 'port',
      'history', 'search', 'events', 'system', 'help'
    ],
    BLOCKED_COMMANDS: [
      'exec', 'run', 'create', 'start', 'stop', 'restart', 'kill',
      'rm', 'rmi', 'prune', 'build', 'commit', 'push', 'pull',
      'tag', 'load', 'save', 'import', 'export', 'cp', 'update'
    ],
  },

  // Status codes
  STATUS: {
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    ERROR: 'error',
  },

  // Error codes
  ERROR_CODES: {
    RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
    INVALID_INPUT: 'INVALID_INPUT',
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    OPERATION_TIMEOUT: 'OPERATION_TIMEOUT',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  },
};





