/**
 * Channel Operation Schema Validation
 *
 * Validates Autobase operations against Hyperschema definitions.
 * Provides runtime validation for channel ops before they're applied.
 */

const CURRENT_SCHEMA_VERSION = 1

/**
 * Validate a channel operation against its schema
 * @param {Object} op - Operation object to validate
 * @returns {{valid: boolean, error?: string}}
 */
export function validateOp(op) {
  if (!op || typeof op !== 'object') {
    return { valid: false, error: 'Operation must be an object' }
  }

  if (!op.type || typeof op.type !== 'string') {
    return { valid: false, error: 'Operation must have a type field' }
  }

  // Set default schema version if not present (backward compatibility)
  if (op.schemaVersion === undefined || op.schemaVersion === null) {
    op.schemaVersion = CURRENT_SCHEMA_VERSION
  }

  // Route to specific validator based on op type
  const typeValidators = {
    'update-channel': validateUpdateChannel,
    'add-video': validateAddVideo,
    'update-video': validateUpdateVideo,
    'delete-video': validateDeleteVideo,
    'add-writer': validateAddWriter,
    'upsert-writer': validateUpsertWriter,
    'remove-writer': validateRemoveWriter,
    'add-invite': validateAddInvite,
    'delete-invite': validateDeleteInvite,
    'add-comment': validateAddComment,
    'add-reaction': validateAddReaction,
    'remove-reaction': validateRemoveReaction,
    'hide-comment': validateHideComment,
    'remove-comment': validateRemoveComment,
    'add-vector-index': validateAddVectorIndex,
    'log-watch-event': validateLogWatchEvent,
    'migrate-schema': validateMigrateSchema
  }

  const validator = typeValidators[op.type]
  if (!validator) {
    // Unknown op types are allowed for forward compatibility
    return { valid: true }
  }

  return validator(op)
}

function validateUpdateChannel(op) {
  // All fields are optional except type
  if (op.key !== undefined && typeof op.key !== 'string') {
    return { valid: false, error: 'update-channel.key must be a string' }
  }
  if (op.name !== undefined && typeof op.name !== 'string') {
    return { valid: false, error: 'update-channel.name must be a string' }
  }
  if (op.description !== undefined && typeof op.description !== 'string') {
    return { valid: false, error: 'update-channel.description must be a string' }
  }
  if (op.avatar !== undefined && typeof op.avatar !== 'string') {
    return { valid: false, error: 'update-channel.avatar must be a string' }
  }
  if (op.updatedAt !== undefined && typeof op.updatedAt !== 'number') {
    return { valid: false, error: 'update-channel.updatedAt must be a number' }
  }
  if (op.updatedBy !== undefined && typeof op.updatedBy !== 'string') {
    return { valid: false, error: 'update-channel.updatedBy must be a string' }
  }
  if (op.createdAt !== undefined && typeof op.createdAt !== 'number') {
    return { valid: false, error: 'update-channel.createdAt must be a number' }
  }
  if (op.createdBy !== undefined && typeof op.createdBy !== 'string') {
    return { valid: false, error: 'update-channel.createdBy must be a string' }
  }
  return { valid: true }
}

function validateAddVideo(op) {
  if (!op.id || typeof op.id !== 'string') {
    return { valid: false, error: 'add-video.id is required and must be a string' }
  }
  if (!op.title || typeof op.title !== 'string') {
    return { valid: false, error: 'add-video.title is required and must be a string' }
  }
  if (op.description !== undefined && typeof op.description !== 'string') {
    return { valid: false, error: 'add-video.description must be a string' }
  }
  if (op.path !== undefined && typeof op.path !== 'string') {
    return { valid: false, error: 'add-video.path must be a string' }
  }
  if (op.duration !== undefined && typeof op.duration !== 'number') {
    return { valid: false, error: 'add-video.duration must be a number' }
  }
  if (op.thumbnail !== undefined && typeof op.thumbnail !== 'string') {
    return { valid: false, error: 'add-video.thumbnail must be a string' }
  }
  if (op.blobDriveKey !== undefined && typeof op.blobDriveKey !== 'string') {
    return { valid: false, error: 'add-video.blobDriveKey must be a string' }
  }
  if (op.mimeType !== undefined && typeof op.mimeType !== 'string') {
    return { valid: false, error: 'add-video.mimeType must be a string' }
  }
  if (op.size !== undefined && typeof op.size !== 'number') {
    return { valid: false, error: 'add-video.size must be a number' }
  }
  if (op.uploadedAt !== undefined && typeof op.uploadedAt !== 'number') {
    return { valid: false, error: 'add-video.uploadedAt must be a number' }
  }
  if (op.uploadedBy !== undefined && typeof op.uploadedBy !== 'string') {
    return { valid: false, error: 'add-video.uploadedBy must be a string' }
  }
  if (op.category !== undefined && typeof op.category !== 'string') {
    return { valid: false, error: 'add-video.category must be a string' }
  }
  if (op.views !== undefined && typeof op.views !== 'number') {
    return { valid: false, error: 'add-video.views must be a number' }
  }
  return { valid: true }
}

function validateUpdateVideo(op) {
  if (!op.id || typeof op.id !== 'string') {
    return { valid: false, error: 'update-video.id is required and must be a string' }
  }
  if (op.title !== undefined && typeof op.title !== 'string') {
    return { valid: false, error: 'update-video.title must be a string' }
  }
  if (op.description !== undefined && typeof op.description !== 'string') {
    return { valid: false, error: 'update-video.description must be a string' }
  }
  if (op.thumbnail !== undefined && typeof op.thumbnail !== 'string') {
    return { valid: false, error: 'update-video.thumbnail must be a string' }
  }
  if (op.category !== undefined && typeof op.category !== 'string') {
    return { valid: false, error: 'update-video.category must be a string' }
  }
  if (op.updatedAt !== undefined && typeof op.updatedAt !== 'number') {
    return { valid: false, error: 'update-video.updatedAt must be a number' }
  }
  if (op.updatedBy !== undefined && typeof op.updatedBy !== 'string') {
    return { valid: false, error: 'update-video.updatedBy must be a string' }
  }
  return { valid: true }
}

function validateDeleteVideo(op) {
  if (!op.id || typeof op.id !== 'string') {
    return { valid: false, error: 'delete-video.id is required and must be a string' }
  }
  return { valid: true }
}

function validateAddWriter(op) {
  if (!op.keyHex || typeof op.keyHex !== 'string') {
    return { valid: false, error: 'add-writer.keyHex is required and must be a string' }
  }
  if (op.role !== undefined && typeof op.role !== 'string') {
    return { valid: false, error: 'add-writer.role must be a string' }
  }
  if (op.deviceName !== undefined && typeof op.deviceName !== 'string') {
    return { valid: false, error: 'add-writer.deviceName must be a string' }
  }
  if (op.addedAt !== undefined && typeof op.addedAt !== 'number') {
    return { valid: false, error: 'add-writer.addedAt must be a number' }
  }
  if (op.blobDriveKey !== undefined && typeof op.blobDriveKey !== 'string') {
    return { valid: false, error: 'add-writer.blobDriveKey must be a string' }
  }
  return { valid: true }
}

function validateUpsertWriter(op) {
  if (!op.keyHex || typeof op.keyHex !== 'string') {
    return { valid: false, error: 'upsert-writer.keyHex is required and must be a string' }
  }
  if (op.role !== undefined && typeof op.role !== 'string') {
    return { valid: false, error: 'upsert-writer.role must be a string' }
  }
  if (op.deviceName !== undefined && typeof op.deviceName !== 'string') {
    return { valid: false, error: 'upsert-writer.deviceName must be a string' }
  }
  if (op.addedAt !== undefined && typeof op.addedAt !== 'number') {
    return { valid: false, error: 'upsert-writer.addedAt must be a number' }
  }
  if (op.blobDriveKey !== undefined && typeof op.blobDriveKey !== 'string') {
    return { valid: false, error: 'upsert-writer.blobDriveKey must be a string' }
  }
  return { valid: true }
}

function validateRemoveWriter(op) {
  if (!op.keyHex || typeof op.keyHex !== 'string') {
    return { valid: false, error: 'remove-writer.keyHex is required and must be a string' }
  }
  if (op.ban !== undefined && typeof op.ban !== 'boolean') {
    return { valid: false, error: 'remove-writer.ban must be a boolean' }
  }
  return { valid: true }
}

function validateAddInvite(op) {
  if (!op.idHex || typeof op.idHex !== 'string') {
    return { valid: false, error: 'add-invite.idHex is required and must be a string' }
  }
  if (!op.inviteZ32 || typeof op.inviteZ32 !== 'string') {
    return { valid: false, error: 'add-invite.inviteZ32 is required and must be a string' }
  }
  if (op.publicKeyHex !== undefined && typeof op.publicKeyHex !== 'string') {
    return { valid: false, error: 'add-invite.publicKeyHex must be a string' }
  }
  if (op.expires !== undefined && typeof op.expires !== 'number') {
    return { valid: false, error: 'add-invite.expires must be a number' }
  }
  if (op.createdAt !== undefined && typeof op.createdAt !== 'number') {
    return { valid: false, error: 'add-invite.createdAt must be a number' }
  }
  return { valid: true }
}

function validateDeleteInvite(op) {
  if (!op.idHex || typeof op.idHex !== 'string') {
    return { valid: false, error: 'delete-invite.idHex is required and must be a string' }
  }
  return { valid: true }
}

function validateAddComment(op) {
  if (!op.videoId || typeof op.videoId !== 'string') {
    return { valid: false, error: 'add-comment.videoId is required and must be a string' }
  }
  if (!op.commentId || typeof op.commentId !== 'string') {
    return { valid: false, error: 'add-comment.commentId is required and must be a string' }
  }
  if (!op.text || typeof op.text !== 'string') {
    return { valid: false, error: 'add-comment.text is required and must be a string' }
  }
  // Comment length validation (5000 chars max)
  if (op.text.length > 5000) {
    return { valid: false, error: 'add-comment.text must be 5000 characters or less' }
  }
  if (!op.authorKeyHex || typeof op.authorKeyHex !== 'string') {
    return { valid: false, error: 'add-comment.authorKeyHex is required and must be a string' }
  }
  if (op.timestamp !== undefined && typeof op.timestamp !== 'number') {
    return { valid: false, error: 'add-comment.timestamp must be a number' }
  }
  if (op.parentId !== undefined && op.parentId !== null && typeof op.parentId !== 'string') {
    return { valid: false, error: 'add-comment.parentId must be a string or null' }
  }
  return { valid: true }
}

function validateAddReaction(op) {
  if (!op.videoId || typeof op.videoId !== 'string') {
    return { valid: false, error: 'add-reaction.videoId is required and must be a string' }
  }
  if (!op.reactionType || typeof op.reactionType !== 'string') {
    return { valid: false, error: 'add-reaction.reactionType is required and must be a string' }
  }
  if (!op.authorKeyHex || typeof op.authorKeyHex !== 'string') {
    return { valid: false, error: 'add-reaction.authorKeyHex is required and must be a string' }
  }
  if (op.timestamp !== undefined && typeof op.timestamp !== 'number') {
    return { valid: false, error: 'add-reaction.timestamp must be a number' }
  }
  return { valid: true }
}

function validateRemoveReaction(op) {
  if (!op.videoId || typeof op.videoId !== 'string') {
    return { valid: false, error: 'remove-reaction.videoId is required and must be a string' }
  }
  if (!op.authorKeyHex || typeof op.authorKeyHex !== 'string') {
    return { valid: false, error: 'remove-reaction.authorKeyHex is required and must be a string' }
  }
  return { valid: true }
}

function validateHideComment(op) {
  if (!op.videoId || typeof op.videoId !== 'string') {
    return { valid: false, error: 'hide-comment.videoId is required and must be a string' }
  }
  if (!op.commentId || typeof op.commentId !== 'string') {
    return { valid: false, error: 'hide-comment.commentId is required and must be a string' }
  }
  if (!op.moderatorKeyHex || typeof op.moderatorKeyHex !== 'string') {
    return { valid: false, error: 'hide-comment.moderatorKeyHex is required and must be a string' }
  }
  return { valid: true }
}

function validateRemoveComment(op) {
  if (!op.videoId || typeof op.videoId !== 'string') {
    return { valid: false, error: 'remove-comment.videoId is required and must be a string' }
  }
  if (!op.commentId || typeof op.commentId !== 'string') {
    return { valid: false, error: 'remove-comment.commentId is required and must be a string' }
  }
  if (op.moderatorKeyHex !== undefined && typeof op.moderatorKeyHex !== 'string') {
    return { valid: false, error: 'remove-comment.moderatorKeyHex must be a string' }
  }
  if (op.authorKeyHex !== undefined && typeof op.authorKeyHex !== 'string') {
    return { valid: false, error: 'remove-comment.authorKeyHex must be a string' }
  }
  // Must have either moderatorKeyHex or authorKeyHex
  if (!op.moderatorKeyHex && !op.authorKeyHex) {
    return { valid: false, error: 'remove-comment must have either moderatorKeyHex or authorKeyHex' }
  }
  return { valid: true }
}

function validateAddVectorIndex(op) {
  if (!op.videoId || typeof op.videoId !== 'string') {
    return { valid: false, error: 'add-vector-index.videoId is required and must be a string' }
  }
  if (op.vector !== undefined && typeof op.vector !== 'string') {
    return { valid: false, error: 'add-vector-index.vector must be a string' }
  }
  if (op.text !== undefined && typeof op.text !== 'string') {
    return { valid: false, error: 'add-vector-index.text must be a string' }
  }
  if (op.metadata !== undefined && typeof op.metadata !== 'string') {
    return { valid: false, error: 'add-vector-index.metadata must be a string' }
  }

  // Abuse controls / bounds
  // - vectors should be compact (Float32Array base64, 384 dims = 1536 bytes)
  // - text/metadata should be bounded to prevent view bloat / DoS
  if (op.vector) {
    // Base64 length bound (defensive; 1536 bytes -> 2048 chars, give some headroom)
    if (op.vector.length > 8192) {
      return { valid: false, error: 'add-vector-index.vector too large' }
    }
    try {
      const buf = Buffer.from(op.vector, 'base64')
      if (buf.length !== 384 * 4) {
        return { valid: false, error: 'add-vector-index.vector wrong byte length' }
      }
    } catch {
      return { valid: false, error: 'add-vector-index.vector invalid base64' }
    }
  }

  if (op.text && op.text.length > 20000) {
    return { valid: false, error: 'add-vector-index.text too long' }
  }
  if (op.metadata && op.metadata.length > 20000) {
    return { valid: false, error: 'add-vector-index.metadata too long' }
  }
  return { valid: true }
}

function validateLogWatchEvent(op) {
  if (!op.videoId || typeof op.videoId !== 'string') {
    return { valid: false, error: 'log-watch-event.videoId is required and must be a string' }
  }
  if (op.channelKey !== undefined && typeof op.channelKey !== 'string') {
    return { valid: false, error: 'log-watch-event.channelKey must be a string' }
  }
  if (op.watcherKeyHex !== undefined && typeof op.watcherKeyHex !== 'string') {
    return { valid: false, error: 'log-watch-event.watcherKeyHex must be a string' }
  }
  if (op.duration !== undefined && typeof op.duration !== 'number') {
    return { valid: false, error: 'log-watch-event.duration must be a number' }
  }
  if (op.completed !== undefined && typeof op.completed !== 'boolean') {
    return { valid: false, error: 'log-watch-event.completed must be a boolean' }
  }
  if (op.timestamp !== undefined && typeof op.timestamp !== 'number') {
    return { valid: false, error: 'log-watch-event.timestamp must be a number' }
  }
  return { valid: true }
}

function validateMigrateSchema(op) {
  if (typeof op.schemaVersion !== 'number') {
    return { valid: false, error: 'migrate-schema.schemaVersion is required and must be a number' }
  }
  if (typeof op.fromVersion !== 'number') {
    return { valid: false, error: 'migrate-schema.fromVersion is required and must be a number' }
  }
  if (typeof op.toVersion !== 'number') {
    return { valid: false, error: 'migrate-schema.toVersion is required and must be a number' }
  }
  if (op.migratedAt !== undefined && typeof op.migratedAt !== 'number') {
    return { valid: false, error: 'migrate-schema.migratedAt must be a number' }
  }
  return { valid: true }
}
