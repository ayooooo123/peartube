/**
 * Shared RPC command definitions between React Native UI and Bare backend
 * bare-rpc requires numeric command IDs
 */

export const RPC = {
  // Identity
  CREATE_IDENTITY: 0,
  GET_IDENTITY: 1,

  // Channel
  GET_CHANNEL: 2,
  UPDATE_CHANNEL: 3,

  // Videos
  LIST_VIDEOS: 4,
  GET_VIDEO_URL: 5,
  GET_VIDEO_DATA: 6,

  // Upload
  UPLOAD_VIDEO: 7,

  // Subscriptions
  SUBSCRIBE_CHANNEL: 8,
  UNSUBSCRIBE_CHANNEL: 9,
  LIST_SUBSCRIPTIONS: 10,

  // Discovery
  JOIN_CHANNEL: 11,

  // Public Feed (P2P Discovery)
  GET_PUBLIC_FEED: 12,
  REFRESH_FEED: 13,
  SUBMIT_TO_FEED: 14,
  HIDE_CHANNEL: 15,
  GET_CHANNEL_META: 16,

  // Debug
  GET_SWARM_STATUS: 17,

  // Video prefetch (background download all blocks for seeking)
  PREFETCH_VIDEO: 18,

  // Seeding (distributed content availability)
  GET_SEEDING_STATUS: 19,
  SET_SEEDING_CONFIG: 20,
  PIN_CHANNEL: 21,
  UNPIN_CHANNEL: 22,
  GET_PINNED_CHANNELS: 23,

  // Video stats (real-time P2P status)
  GET_VIDEO_STATS: 24,

  // Thumbnails and extended metadata
  GET_VIDEO_THUMBNAIL: 25,
  GET_VIDEO_METADATA: 26,
  SET_VIDEO_THUMBNAIL: 27,

  // Events from backend
  EVENT_READY: 100,
  EVENT_ERROR: 101,
  EVENT_UPLOAD_PROGRESS: 102,
  EVENT_FEED_UPDATE: 103,
  EVENT_LOG: 104,  // Backend log forwarding
  EVENT_VIDEO_STATS: 105,  // P2P video download progress
}
