/**
 * Video Upload Module
 *
 * Handles video uploads to Hyperblobs with progress tracking.
 * Works with both file paths (desktop) and buffers/streams (mobile).
 *
 * Architecture:
 * - Video bytes are stored in the channel's shared Hyperblobs instance
 * - Video metadata is stored in channel HyperDB via channel.addVideo()
 * - Blob IDs (4 numbers: blockOffset, blockLength, byteOffset, byteLength) are stored in metadata
 */

import crypto from 'hypercore-crypto';
import b4a from 'b4a';
import { parseBlobId } from './blob-utils.js';

import { probeMp4File, probeMp4Buffer, isMp4MimeType } from './mp4-playback-probe.js';
import { saveBlobPlaybackProfile } from './blob-playback-profile.js';
import { MEDIA_COORDINATE_SHAPES, episodeWorkIdentifier, normalizeContentDetails } from './channel/structured-content.js';
import {
  ARTWORK_RENDITION_PURPOSES,
  createImmutableRenditionWriter,
  createBufferSourceReader,
  createFileSourceReader,
  createSourceReader,
  createPublicationManifest,
  createRenditionDescriptor,
  createStaticAssetManifest,
  encodePublicationManifest,
} from './assets/index.js';
import {
  createEntityReference,
  createMediaClaim,
  describeMedia,
  encodeMediaClaimEnvelope,
} from './media-graph/index.js';
import {
  PUBLISHER_LIMITS,
  PUBLISHER_RECORD_TYPES,
  toHex,
} from './publisher/canonical.js';
import {
  decodePublisherCatalogFrame,
  encodePublisherCatalogFrame,
} from './publisher/catalog-view.js';

// A publication batch is one PUBLICATION operation followed by its claims. The
// claim set is not fixed: an episode also carries collection structure and
// membership claims, so the batch length travels in the frame header instead of
// being asserted as a constant.
const MIN_IMMUTABLE_PUBLICATION_OPERATION_COUNT = 3;
const MAX_IMMUTABLE_PUBLICATION_OPERATION_COUNT = 8;
const IMMUTABLE_PUBLICATION_FRAME_VERSION = 1;
const IMMUTABLE_PUBLICATION_FRAME_HEADER_BYTES = 2;
const IMMUTABLE_PUBLICATION_FRAME_LENGTH_BYTES = 4;
const MAX_IMMUTABLE_PUBLICATION_FRAMES_BYTES =
  IMMUTABLE_PUBLICATION_FRAME_HEADER_BYTES +
  MAX_IMMUTABLE_PUBLICATION_OPERATION_COUNT *
    (IMMUTABLE_PUBLICATION_FRAME_LENGTH_BYTES + PUBLISHER_LIMITS.maxOperationBytes);

/**
 * Detect MIME type from file magic bytes
 * Simple implementation without external dependencies for Bare runtime compatibility
 * @param {Buffer} buffer - First few KB of file data
 * @returns {string} Detected MIME type or fallback
 */
function detectMimeType(buffer) {
  if (!buffer || buffer.length < 12) {
    return 'video/mp4';
  }

  // Check for ftyp box (MP4/MOV/3GP/M4V)
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    // Read the brand (4 bytes after 'ftyp')
    const brand = b4a.toString(buffer.subarray(8, 12), 'utf-8');
    console.log('[Upload] Detected ftyp brand:', brand);

    if (brand.startsWith('qt')) return 'video/quicktime';
    if (brand.startsWith('3g')) return 'video/3gpp';
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') return 'video/x-m4v';
    return 'video/mp4'; // Default for isom, mp41, mp42, etc.
  }

  // Check for EBML header (WebM/MKV)
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    // Look for DocType element to distinguish WebM from MKV
    // DocType starts with 0x42 0x82, followed by size and string
    const headerStr = b4a.toString(buffer.subarray(0, Math.min(64, buffer.length)), 'utf-8');
    if (headerStr.includes('webm')) {
      console.log('[Upload] Detected WebM from EBML header');
      return 'video/webm';
    }
    if (headerStr.includes('matroska')) {
      console.log('[Upload] Detected Matroska (MKV) from EBML header');
      return 'video/x-matroska';
    }
    // Default to MKV for EBML without clear doctype
    return 'video/x-matroska';
  }

  // Check for RIFF (AVI/WAVE)
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    // Check for AVI at offset 8
    if (buffer[8] === 0x41 && buffer[9] === 0x56 && buffer[10] === 0x49 && buffer[11] === 0x20) {
      console.log('[Upload] Detected AVI from RIFF header');
      return 'video/x-msvideo';
    }
  }

  // Check for FLV
  if (buffer[0] === 0x46 && buffer[1] === 0x4C && buffer[2] === 0x56) {
    console.log('[Upload] Detected FLV');
    return 'video/x-flv';
  }

  // Check for MPEG
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01) {
    if (buffer[3] === 0xBA || buffer[3] === 0xB3) {
      console.log('[Upload] Detected MPEG');
      return 'video/mpeg';
    }
  }

  // Check for Ogg
  if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    console.log('[Upload] Detected Ogg container');
    return 'video/ogg';
  }

  console.log('[Upload] Could not detect MIME type from magic bytes, defaulting to video/mp4');
  return 'video/mp4';
}

/**
 * Bounding descriptive metadata is shared with the read paths that replay these
 * claims, so it lives beside the media graph rather than here. Re-exported
 * because `@peartube/backend/upload` is where callers already reach for it.
 */
export { describeMedia }

export function getPlaybackSupportForMimeType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'video/mp4' || normalized === 'video/webm') {
    return { availability: 'playable', playbackSupport: 'direct' };
  }
  return { availability: 'playable', playbackSupport: 'unverified-container' };
}

/**
 * Get file extension for a MIME type
 * @param {string} mimeType - MIME type
 * @returns {string} File extension without dot
 */
function getExtensionForMime(mimeType) {
  const mimeToExt = {
    'video/mp4': 'mp4',
    'video/x-m4v': 'm4v',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/mpeg': 'mpg',
    'video/3gpp': '3gp',
    'video/3gpp2': '3g2',
    'video/x-flv': 'flv',
    'video/ogg': 'ogv',
  };
  return mimeToExt[mimeType] || 'mp4';
}

/**
 * @typedef {import('./channel/multi-writer-channel.js').MultiWriterChannel} MultiWriterChannel
 * @typedef {import('./types.js').StorageContext} StorageContext
 * @typedef {import('./types.js').VideoMetadata} VideoMetadata
 */

function normalizeVideoMetadata(options, videoId) {
  const title = options.title;
  const sourceFileName = options.sourceFileName;
  const description = options.description;
  const providedMimeType = options.mimeType;
  const duration = options.duration;
  const thumbnail = options.thumbnail;
  const thumbnailUrl = options.thumbnailUrl;
  const thumbnailBlobId = options.thumbnailBlobId;
  const thumbnailBlobsCoreKey = options.thumbnailBlobsCoreKey;
  const thumbnailMimeType = options.thumbnailMimeType;
  const category = options.category;
  const width = options.width;
  const height = options.height;
  const contentKind = options.contentKind;
  const sourceProvider = options.sourceProvider;
  const sourceVideoId = options.sourceVideoId;
  const identityUrl = options.identityUrl;
  const sourceCreatorId = options.sourceCreatorId;
  const sourceCreatorUrl = options.sourceCreatorUrl;
  const sourcePublishedAt = options.sourcePublishedAt;
  const mediaProvider = options.mediaProvider;
  const mediaId = options.mediaId;
  const seasonNumber = options.seasonNumber;
  const episodeNumber = options.episodeNumber;
  const originalAirDate = options.originalAirDate;
  const provenanceVersion = options.provenanceVersion;
  const publicationState = options.publicationState;
  const contentFingerprint = options.contentFingerprint;
  const importIdentityKey = options.importIdentityKey;
  const importClaimantId = options.importClaimantId;
  const seriesId = options.seriesId;
  const seriesTitle = options.seriesTitle;
  const expectedEpisodeCount = options.expectedEpisodeCount;
  const artwork = options.artwork;

  const metadata = normalizeContentDetails({
    id: videoId,
    contentKind,
    sourceProvider,
    sourceVideoId,
    identityUrl,
    sourceCreatorId,
    sourceCreatorUrl,
    sourcePublishedAt,
    mediaProvider,
    mediaId,
    seasonNumber,
    episodeNumber,
    originalAirDate,
    thumbnailUrl,
    artwork,
    provenanceVersion,
    publicationState,
    contentFingerprint,
    importIdentityKey,
    importClaimantId
  });
  Object.assign(metadata, {
    title: String(title || ''),
    description: String(description || ''),
    mimeType: providedMimeType,
    duration,
    thumbnail,
    category: String(category || ''),
    width: width === undefined ? 0 : width,
    height: height === undefined ? 0 : height
  });
  if (sourceFileName !== undefined && sourceFileName !== null) {
    if (typeof sourceFileName !== 'string' || !/^[^/\\]{1,255}$/.test(sourceFileName)) {
      throw new Error('sourceFileName must be a bounded non-empty string');
    }
    metadata.sourceFileName = sourceFileName;
  }
  if (thumbnailBlobId !== undefined) metadata.thumbnailBlobId = thumbnailBlobId;
  if (thumbnailBlobsCoreKey !== undefined) metadata.thumbnailBlobsCoreKey = thumbnailBlobsCoreKey;
  if (thumbnailMimeType !== undefined) metadata.thumbnailMimeType = thumbnailMimeType;
  if (seriesId !== undefined) {
    if (typeof seriesId !== 'string' || seriesId.length < 1 || b4a.byteLength(seriesId) > 512) {
      throw new Error('seriesId must be a bounded non-empty string');
    }
    metadata.seriesId = seriesId;
  }
  if (seriesTitle !== undefined) {
    if (typeof seriesTitle !== 'string' || seriesTitle.length < 1 || b4a.byteLength(seriesTitle) > 512) {
      throw new Error('seriesTitle must be a bounded non-empty string');
    }
    metadata.seriesTitle = seriesTitle;
  }
  if (expectedEpisodeCount !== undefined) {
    if (!Number.isSafeInteger(expectedEpisodeCount) || expectedEpisodeCount < 0 || expectedEpisodeCount > 100000) {
      throw new Error('expectedEpisodeCount must be between 0 and 100000');
    }
    metadata.expectedEpisodeCount = expectedEpisodeCount;
  }
  return metadata;
}

function buildVideoMetadata(metadata, blobResult, channel, fileSize, mimeType) {
  const playbackSupport = getPlaybackSupportForMimeType(mimeType);
  Object.assign(metadata, {
    mimeType: String(mimeType || 'video/mp4'),
    size: fileSize,
    uploadedAt: Date.now(),
    uploadedBy: channel.localWriterKeyHex,
    blobId: blobResult.id,
    // An immutable publication names its own rendition core; a legacy
    // hyperblobs upload lives in the channel's blob core.
    blobsCoreKey: blobResult.blobsCoreKey || channel.blobsKeyHex,
    availability: playbackSupport.availability,
    playbackSupport: playbackSupport.playbackSupport
  });
  return metadata;
}

// The poster's identity label: a stable digest of what the publisher claims
// these bytes are, not a merkle root.
function posterTreeHash(entry, blob) {
  return b4a.toString(
    crypto.hash(b4a.from([
      String(entry.blobsCoreKey || ''),
      String(entry.blobId || ''),
      String(entry.mimeType || ''),
      String(blob.byteLength)
    ].join('\n'))),
    'hex'
  )
}

const catalogWriteQueues = new WeakMap();

async function serializeCatalogWrite(catalog, task) {
  const previous = catalogWriteQueues.get(catalog) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  catalogWriteQueues.set(catalog, gate);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (catalogWriteQueues.get(catalog) === gate) catalogWriteQueues.delete(catalog);
  }
}

function markUploadCommitState(error, state) {
  const target = error && typeof error === 'object' ? error : new Error(String(error || 'Upload failed'));
  try {
    Object.defineProperty(target, state, { value: true, configurable: false, enumerable: false });
  } catch {
    target[state] = true;
  }
  return target;
}

function stagedRollbackPendingError(error, rollbackError) {
  // The rollback message alone hides WHY the upload was being rolled back, and
  // that original error is usually the actionable one. Carry both.
  const rollbackMessage = rollbackError?.message || rollbackError || 'staged metadata could not be deleted';
  const causeMessage = error?.message || (error ? String(error) : '');
  const pending = new Error(
    causeMessage
      ? `Upload rollback is pending: ${rollbackMessage} (rolling back after: ${causeMessage})`
      : `Upload rollback is pending: ${rollbackMessage}`,
    { cause: error },
  );
  return markUploadCommitState(pending, 'uploadRollbackPending');
}

function isAcceptedCatalogReceipt(receipt) {
  return receipt?.accepted === true;
}

function isExplicitlyRejectedCatalogReceipt(receipt) {
  return receipt?.accepted === false &&
    typeof receipt.rejectionCode === 'string' &&
    receipt.rejectionCode.length > 0;
}

async function catalogOperationsAreRejected(catalog, operations) {
  if (typeof catalog?.getOperationReceipt !== 'function') return false;
  try {
    const receipts = await Promise.all(operations.map(operation => {
      const operationId = operation?.recordId || operation?.transitionId;
      if (!operationId) throw new Error('operation id unavailable');
      return catalog.getOperationReceipt(operationId);
    }));
    return receipts.every(isExplicitlyRejectedCatalogReceipt);
  } catch {
    return false;
  }
}

async function appendImmutablePublication(catalog, signedOperations) {
  let receipts;
  try {
    receipts = await catalog.appendBatchAndConfirm(signedOperations);
  } catch (error) {
    if (!await catalogOperationsAreRejected(catalog, signedOperations)) {
      throw markUploadCommitState(error, 'uploadCommitUncertain');
    }
    throw error;
  }
  const complete = Array.isArray(receipts) && receipts.length === signedOperations.length;
  if (complete && receipts.every(isAcceptedCatalogReceipt)) return receipts;

  const error = new Error('Publisher catalog rejected upload projection');
  if (!complete || !receipts.every(isExplicitlyRejectedCatalogReceipt)) {
    throw markUploadCommitState(error, 'uploadCommitUncertain');
  }
  throw error;
}

// What a failed upload is allowed to undo is exactly what it added.
//
// A legacy hyperblobs-backed upload appended blocks to the channel's own blob
// core, and those blocks belong to it alone, so clearing them is correct.
//
// An immutable publication appended nothing: playback points at the rendition
// core, which is CONTENT-ADDRESSED and therefore shared by every publication of
// identical bytes. Clearing it would delete the archived asset out from under
// whichever other publication still serves it, so it is left untouched and only
// the staged metadata this upload wrote is removed by the caller.
async function rollbackUploadedBlob(channel, blobResult) {
  if (blobResult?.shared === true) return;
  if (!channel?.blobs || typeof channel.blobs.clear !== 'function') {
    throw new Error('Upload rollback is unavailable');
  }
  await channel.blobs.clear(blobResult);
}

function storedBlobResult(metadata, channel) {
  const parts = String(metadata?.blobId || '').split(':').map(Number);
  if (parts.length !== 4 ||
      parts.some(value => !Number.isSafeInteger(value) || value < 0) ||
      parts[1] < 1 ||
      parts[3] < 1) {
    throw new Error('pending upload blob reference is invalid');
  }
  const coreKey = metadata?.blobsCoreKey ? String(metadata.blobsCoreKey) : '';
  if (coreKey && !/^[0-9a-f]{64}$/i.test(coreKey)) {
    throw new Error('pending upload blob core key is invalid');
  }
  return {
    id: String(metadata.blobId),
    blockOffset: parts[0],
    blockLength: parts[1],
    byteOffset: parts[2],
    byteLength: parts[3],
    // Any core that is not the channel's own blob core is a rendition core this
    // upload does not own. Never clear it.
    shared: Boolean(coreKey) && coreKey.toLowerCase() !== String(channel?.blobsKeyHex || '').toLowerCase()
  };
}

async function reconcilePendingUpload(channel, metadata) {
  if (typeof channel?.deleteVideo !== 'function') {
    throw stagedRollbackPendingError(null, new Error('staged metadata deletion is unavailable'));
  }
  let blobResult;
  try {
    blobResult = storedBlobResult(metadata, channel);
  } catch (error) {
    throw stagedRollbackPendingError(null, error);
  }
  try {
    await rollbackUploadedBlob(channel, blobResult);
  } catch (error) {
    throw stagedRollbackPendingError(null, error);
  }
  try {
    await channel.deleteVideo(metadata.id);
  } catch (error) {
    throw stagedRollbackPendingError(null, error);
  }
}
function publisherOperationIdHex(operation) {
  const id = b4a.from(operation?.recordId || operation?.transitionId || []);
  if (id.byteLength !== 32) throw new Error('catalog operation id unavailable');
  return b4a.toString(id, 'hex');
}

function encodeImmutablePublicationFrames(signedOperations, operationIds) {
  const operationCount = Array.isArray(signedOperations) ? signedOperations.length : 0;
  if (operationCount < MIN_IMMUTABLE_PUBLICATION_OPERATION_COUNT ||
      operationCount > MAX_IMMUTABLE_PUBLICATION_OPERATION_COUNT ||
      !Array.isArray(operationIds) ||
      operationIds.length !== operationCount) {
    throw new Error('immutable publication operation batch is out of bounds');
  }
  // One publication, then its claims.
  const expectedTypes = signedOperations.map((_, index) => index === 0
    ? PUBLISHER_RECORD_TYPES.PUBLICATION
    : PUBLISHER_RECORD_TYPES.CLAIM);
  const frames = signedOperations.map((operation, index) => {
    const frame = encodePublisherCatalogFrame(operation);
    if (frame.byteLength === 0 || frame.byteLength > PUBLISHER_LIMITS.maxOperationBytes) {
      throw new Error('immutable publication operation frame is out of bounds');
    }
    const decoded = decodePublisherCatalogFrame(frame);
    if (decoded.recordType !== expectedTypes[index] ||
        publisherOperationIdHex(decoded) !== operationIds[index] ||
        !b4a.equals(encodePublisherCatalogFrame(decoded), frame)) {
      throw new Error('immutable publication operation frame does not match its persisted identity');
    }
    return frame;
  });
  const byteLength = IMMUTABLE_PUBLICATION_FRAME_HEADER_BYTES +
    frames.reduce((total, frame) => total + IMMUTABLE_PUBLICATION_FRAME_LENGTH_BYTES + frame.byteLength, 0);
  if (byteLength > MAX_IMMUTABLE_PUBLICATION_FRAMES_BYTES) {
    throw new Error('immutable publication operation frames exceed their byte limit');
  }
  const encoded = b4a.allocUnsafe(byteLength);
  encoded[0] = IMMUTABLE_PUBLICATION_FRAME_VERSION;
  encoded[1] = operationCount;
  let offset = IMMUTABLE_PUBLICATION_FRAME_HEADER_BYTES;
  for (const frame of frames) {
    const length = frame.byteLength;
    encoded[offset] = length >>> 24;
    encoded[offset + 1] = length >>> 16;
    encoded[offset + 2] = length >>> 8;
    encoded[offset + 3] = length;
    offset += IMMUTABLE_PUBLICATION_FRAME_LENGTH_BYTES;
    encoded.set(frame, offset);
    offset += length;
  }
  return b4a.toString(encoded, 'hex');
}

function decodeImmutablePublicationFrames(publication) {
  const operationIds = immutablePublicationOperations(publication);
  const hex = publication?.operationFramesHex;
  if (typeof hex !== 'string' || hex.length === 0 ||
      hex.length > MAX_IMMUTABLE_PUBLICATION_FRAMES_BYTES * 2 ||
      !/^(?:[0-9a-f]{2})+$/.test(hex)) {
    throw new Error('uncertain upload operation frames are unavailable');
  }
  const encoded = b4a.from(hex, 'hex');
  const operationCount = encoded.byteLength >= IMMUTABLE_PUBLICATION_FRAME_HEADER_BYTES ? encoded[1] : 0;
  if (encoded.byteLength < IMMUTABLE_PUBLICATION_FRAME_HEADER_BYTES ||
      encoded[0] !== IMMUTABLE_PUBLICATION_FRAME_VERSION ||
      operationCount < MIN_IMMUTABLE_PUBLICATION_OPERATION_COUNT ||
      operationCount > MAX_IMMUTABLE_PUBLICATION_OPERATION_COUNT ||
      operationIds.length !== operationCount) {
    throw new Error('uncertain upload operation frame header is invalid');
  }
  // One publication, then its claims.
  const expectedTypes = Array.from({ length: operationCount }, (_, index) => index === 0
    ? PUBLISHER_RECORD_TYPES.PUBLICATION
    : PUBLISHER_RECORD_TYPES.CLAIM);
  const frames = new Array(operationCount);
  let offset = IMMUTABLE_PUBLICATION_FRAME_HEADER_BYTES;
  for (let index = 0; index < frames.length; index++) {
    if (offset + IMMUTABLE_PUBLICATION_FRAME_LENGTH_BYTES > encoded.byteLength) {
      throw new Error('uncertain upload operation frame is truncated');
    }
    const length = encoded[offset] * 0x1000000 +
      encoded[offset + 1] * 0x10000 +
      encoded[offset + 2] * 0x100 +
      encoded[offset + 3];
    offset += IMMUTABLE_PUBLICATION_FRAME_LENGTH_BYTES;
    if (length < 1 || length > PUBLISHER_LIMITS.maxOperationBytes ||
        offset + length > encoded.byteLength) {
      throw new Error('uncertain upload operation frame length is invalid');
    }
    const frame = encoded.subarray(offset, offset + length);
    offset += length;
    const decoded = decodePublisherCatalogFrame(frame);
    if (decoded.recordType !== expectedTypes[index] ||
        publisherOperationIdHex(decoded) !== operationIds[index] ||
        !b4a.equals(encodePublisherCatalogFrame(decoded), frame)) {
      throw new Error('uncertain upload operation frame does not match its persisted identity');
    }
    frames[index] = frame;
  }
  if (offset !== encoded.byteLength) {
    throw new Error('uncertain upload operation frames contain trailing bytes');
  }
  return frames;
}


function immutablePublicationOperations(publication) {
  const operationIds = publication?.operationIds;
  if (!Array.isArray(operationIds) ||
      operationIds.length < MIN_IMMUTABLE_PUBLICATION_OPERATION_COUNT ||
      operationIds.length > MAX_IMMUTABLE_PUBLICATION_OPERATION_COUNT ||
      operationIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))) {
    throw new Error('uncertain upload operation identities are unavailable');
  }
  return operationIds;
}
function isMissingCatalogReceipt(receipt) {
  return receipt !== null &&
    typeof receipt === 'object' &&
    !Array.isArray(receipt) &&
    receipt.accepted === false &&
    Object.keys(receipt).length === 1;
}


function uncertainCommitError(publication, message = 'Upload catalog commit requires reconciliation') {
  const error = markUploadCommitState(new Error(message), 'uploadCommitUncertain');
  error.reconciliationRequired = true;
  error.reconciliation = {
    publicationId: publication.publicationId,
    manifestId: publication.manifestId,
    renditionId: publication.renditionId,
    assetId: publication.assetId,
    coreKey: publication.coreKey,
    operationIds: immutablePublicationOperations(publication),
  };
  return error;
}

async function resolvePersistedPublisherCatalog(catalogRegistry, publisherId) {
  if (!catalogRegistry) throw new Error('publisher catalog registry is unavailable');
  if (typeof publisherId !== 'string' || !/^[0-9a-f]{64}$/.test(publisherId)) {
    throw new Error('persisted publisher identity is unavailable');
  }
  const publisherIdBytes = b4a.from(publisherId, 'hex');
  if (typeof catalogRegistry.resolve === 'function') {
    const binding = await catalogRegistry.resolve(publisherIdBytes);
    const resolvedId = b4a.from(binding?.publisherId || []);
    if (binding?.catalog && resolvedId.byteLength === 32 && b4a.equals(resolvedId, publisherIdBytes)) {
      return binding.catalog;
    }
  }
  const bindings = await catalogRegistry.getWritableBindings?.();
  const binding = bindings?.find(candidate => {
    const id = b4a.from(candidate?.publisherId || []);
    return id.byteLength === 32 && b4a.equals(id, publisherIdBytes);
  });
  if (!binding?.catalog) throw new Error('persisted publisher catalog is unavailable');
  return binding.catalog;
}
async function finalizeAcceptedPublication(metadata, runtime = {}) {
  const publication = metadata?.immutablePublication;
  immutablePublicationOperations(publication);
  await runtime.verifiedQueryView?.refresh?.({
    publisherIds: [publication.manifest.body.publisherId],
  });
  const rendition = publication.manifest?.body?.renditions?.find(
    candidate => candidate.renditionId === publication.renditionId,
  );
  if (!rendition) throw new Error('Persisted upload rendition is unavailable');
  if (typeof runtime.scopedNetwork?.retainAuthorizedRendition === 'function') {
    const retention = await runtime.scopedNetwork.retainAuthorizedRendition({
      manifest: publication.manifest,
      renditionId: publication.renditionId,
      ownerId: publication.publicationId,
      retentionClass: runtime.retentionClass,
      start: 0,
      end: rendition.core.length,
    });
    if (retention?.status !== 'retained' && retention?.status !== 'already-retained') {
      throw new Error('upload retention was not acquired');
    }
  }
  const announcement = await runtime.scopedNetwork?.publishLocalPublisherCatalog?.({
    publisherId: publication.publisherId,
    retentionClass: runtime.retentionClass,
  });
  // A publisher that already has a live binding is re-announced rather than
  // announced from scratch: 'refreshed' keeps the existing locator alive and
  // 'rebound' replaces it. Both mean the catalog is discoverable, so only an
  // unrecognised status is a failure.
  if (announcement?.status &&
      announcement.status !== 'published' &&
      announcement.status !== 'refreshed' &&
      announcement.status !== 'rebound') {
    throw new Error(`publisher catalog was not announced: ${announcement.status}`);
  }
  if (typeof runtime.finalizeMetadata !== 'function') {
    throw new Error('published metadata update is unavailable');
  }
  const published = { ...metadata, publicationState: 'published' };
  await runtime.finalizeMetadata(published);
  Object.assign(metadata, published);
}


async function reconcileUncertainUpload(channel, metadata, runtime = {}) {
  const publication = metadata?.immutablePublication;
  const operationIds = immutablePublicationOperations(publication);
  let catalog;
  let receipts;
  try {
    catalog = await resolvePersistedPublisherCatalog(runtime.catalogRegistry, publication.publisherId);
    if (typeof catalog.getOperationReceipt !== 'function') throw new Error('catalog receipt lookup is unavailable');
    receipts = await Promise.all(operationIds.map(id => catalog.getOperationReceipt(b4a.from(id, 'hex'))));
  } catch (error) {
    throw uncertainCommitError(publication, error?.message);
  }
  let accepted = receipts.every(isAcceptedCatalogReceipt);
  if (!accepted && receipts.every(isMissingCatalogReceipt)) {
    try {
      const frames = decodeImmutablePublicationFrames(publication);
      await appendImmutablePublication(catalog, frames);
      accepted = true;
    } catch (error) {
      throw uncertainCommitError(publication, error?.message);
    }
  }
  if (accepted) {
    try {
      await finalizeAcceptedPublication(metadata, {
        ...runtime,
        finalizeMetadata: value => {
          if (typeof channel.updateVideo !== 'function') {
            throw new Error('published metadata update is unavailable');
          }
          return channel.updateVideo(metadata.id, value, {
            syncPublic: true,
            commitAfterPublicSync: true,
          });
        },
      });
    } catch (error) {
      throw uncertainCommitError(publication, error?.message);
    }
    return 'accepted';
  }
  if (receipts.every(isExplicitlyRejectedCatalogReceipt)) {
    metadata.publicationState = 'replicationPending';
    await channel.updateVideo?.(metadata.id, metadata, { syncPublic: false });
    await reconcilePendingUpload(channel, metadata);
    return 'rejected';
  }
  throw uncertainCommitError(publication);
}


function assertUploadNotCancelled(signal) {
  if (signal?.aborted) throw new Error('static asset write cancelled');
}

function completedUploadResult(videoId, metadata) {
  const publication = metadata.immutablePublication;
  if (!publication) return { success: true, videoId, metadata };
  return {
    success: true,
    videoId,
    metadata,
    publicationId: publication.publicationId,
    manifestId: publication.manifestId,
    renditionId: publication.renditionId,
    assetId: publication.assetId,
    coreKey: publication.coreKey,
    manifest: publication.manifest
  };
}
// Cover art is referenced by a blob the publisher already stored, so the bytes
// are read back from that blob and written as a static asset of their own.
// Artwork whose bytes cannot be read is left out rather than published as a
// reference no peer could verify.
async function collectArtworkSources(channel, metadata) {
  const entries = Array.isArray(metadata.artwork) ? metadata.artwork : [];
  if (entries.length === 0 || typeof channel?.blobs?.get !== 'function') return [];
  const sources = [];
  for (const entry of entries) {
    if (!ARTWORK_RENDITION_PURPOSES.has(String(entry?.role || ''))) continue;
    const blob = parseBlobId(String(entry.blobId || ''));
    if (!blob) continue;
    let bytes = null;
    try {
      bytes = await channel.blobs.get(blob);
    } catch {
      bytes = null;
    }
    if (!bytes?.byteLength) continue;
    sources.push({
      role: String(entry.role),
      mimeType: entry.mimeType,
      blobId: String(entry.blobId),
      reader: createBufferSourceReader(bytes, {
        mimeType: String(entry.mimeType || 'image/jpeg')
      })
    });
  }
  return sources;
}


async function prepareImmutablePublication(metadata, runtime = {}) {
  const { catalogRegistry, deviceKeyPair } = runtime;
  if (!catalogRegistry || !deviceKeyPair?.publicKey || !deviceKeyPair?.secretKey) return null;
  const bindings = runtime.publisherId
    ? [await catalogRegistry.resolve(runtime.publisherId)]
    : await catalogRegistry.getWritableBindings();
  if (!Array.isArray(bindings) || bindings.length !== 1) {
    throw new Error(bindings?.length ? 'Upload publisher catalog is ambiguous' : 'No admitted publisher catalog is available');
  }
  const binding = bindings[0];
  const catalog = binding?.catalog;
  const publisherId = b4a.from(binding?.publisherId || []);
  if (publisherId.byteLength !== 32 || !catalog?.writable ||
      typeof catalog.getAuthorizationState !== 'function' ||
      typeof catalog.createLocalOperation !== 'function' ||
      typeof catalog.appendBatchAndConfirm !== 'function') {
    throw new Error('Upload publisher catalog is unavailable');
  }

  assertUploadNotCancelled(runtime.signal);
  const renditionWriter = createImmutableRenditionWriter({
    store: runtime.store,
    reader: runtime.reader,
    resume: runtime.resume || false,
    signal: runtime.signal,
    offload: runtime.offload || null
  });
  await renditionWriter.initialize();
  const durationSeconds = Number(metadata.duration);
  const renditionWrite = await renditionWriter.writeRendition({
    purpose: 'original',
    format: String(metadata.mimeType || 'application/octet-stream'),
    durationMs: Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.round(durationSeconds * 1000)
      : 1
  });
  // Cover art rides the manifest, so it has to be a real asset like the media:
  // a v2 rendition descriptor only accepts a static prologue core, not a blob
  // range borrowed from the channel's blob core.
  const artworkWrites = [];
  const artworkSources = (await runtime.createArtworkSources?.()) || [];
  for (const artwork of artworkSources) {
    assertUploadNotCancelled(runtime.signal);
    artworkWrites.push({
      role: artwork.role,
      blobId: artwork.blobId,
      write: await renditionWriter.writeRendition({
        purpose: artwork.role,
        format: String(artwork.mimeType || 'image/jpeg'),
        reader: artwork.reader,
        durationMs: 1
      })
    });
  }
  return { catalog, publisherId, renditionWrite, artworkWrites };
}

function finalizePreparedRendition(prepared, mimeType) {
  if (!prepared) return;
  const write = prepared.renditionWrite;
  write.descriptor = createRenditionDescriptor({
    purpose: write.descriptor.purpose,
    format: String(mimeType || write.descriptor.format || 'application/octet-stream'),
    core: write.staticAsset,
    segmentIndex: write.segmentIndex
  });
}

// Playback for an immutable publication resolves against the rendition core
// itself. Hyperblobs has no per-blob framing — hyperblobs/lib/streams.js
// BlobReadStream reads raw core.get(i) for i in [blockOffset, blockOffset +
// blockLength) and slices by byteOffset/byteLength — so the finished rendition
// core IS already a valid hyperblobs blob spanning its whole length. Copying it
// into channel.blobs would have meant a second, full-size, never-offloaded
// local copy of every archived title, which capped archive size at the volume
// regardless of block offload.
//
// `blockMap` is deliberately absent: hyperblobs/index.js:173 only builds a
// block map when the id carries one, and building it fetches EVERY block
// (409,600 reads for a 100 GiB title at the 256 KiB asset block size).
function staticPlaybackBlobRef(prepared) {
  const asset = prepared.renditionWrite.descriptor.core;
  const blockLength = Number(asset.length);
  const byteLength = Number(asset.byteLength);
  if (!Number.isSafeInteger(blockLength) || blockLength < 1 ||
      !Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new Error('rendition core has no playable extent');
  }
  if (typeof asset.key !== 'string' || !/^[0-9a-f]{64}$/.test(asset.key)) {
    throw new Error('rendition core key is unavailable');
  }
  return {
    id: `0:${blockLength}:0:${byteLength}`,
    blockOffset: 0,
    blockLength,
    byteOffset: 0,
    byteLength,
    blobsCoreKey: asset.key,
    // The rendition core is content-addressed, so two publications of identical
    // bytes resolve to the SAME core. Nothing about this upload owns it, and
    // rollback must never clear it.
    shared: true
  };
}


async function *readWholeSource(reader, description, signal) {
  let offset = 0;
  while (offset < description.byteLength) {
    const length = Math.min(reader.maxReadBytes, description.byteLength - offset);
    yield* reader.open({ offset, length, signal });
    offset += length;
  }
  if (description.byteLength === 0) {
    yield* reader.open({ offset: 0, length: 0, signal });
  }
}

// The fallback for a one-shot stream with no immutable publication behind it:
// no publisher catalog means no rendition core and no block offload to put
// blocks in, so the bytes go into the channel's blob core. Still never a file —
// chunks are forwarded as they arrive — but this copy IS title-sized, which is
// why `uploadFromStream` is only worth reaching for when offload is configured.
//
// The first 4100 bytes are the only ones kept, so the MIME type is still read
// off the magic bytes instead of trusted from the caller.
async function writeStreamedPlaybackBlob(channel, source, signal, onProgress, expectedBytes) {
  if (!channel?.blobs || typeof channel.blobs.createWriteStream !== 'function') {
    throw new Error('Channel blob stream is unavailable');
  }
  const total = Number.isFinite(expectedBytes) && expectedBytes > 0 ? Math.floor(expectedBytes) : 0;
  const writeStream = channel.blobs.createWriteStream();
  const completed = new Promise((resolve, reject) => {
    writeStream.once('error', reject);
    writeStream.once('close', () => {
      const id = writeStream.id;
      resolve({ id: `${id.blockOffset}:${id.blockLength}:${id.byteOffset}:${id.byteLength}`, ...id });
    });
  });
  const head = [];
  let headBytes = 0;
  let byteLength = 0;
  let lastProgressUpdate = Date.now();
  try {
    for await (const chunk of source) {
      assertUploadNotCancelled(signal);
      const bytes = b4a.isBuffer(chunk) ? chunk : b4a.from(chunk);
      if (headBytes < 4100) {
        const slice = bytes.subarray(0, Math.min(4100 - headBytes, bytes.byteLength));
        head.push(slice);
        headBytes += slice.byteLength;
      }
      if (!writeStream.write(bytes)) {
        await new Promise((resolve, reject) => {
          writeStream.once('drain', resolve);
          writeStream.once('error', reject);
        });
      }
      byteLength += bytes.byteLength;
      const currentTime = Date.now();
      if (onProgress && currentTime - lastProgressUpdate > 500) {
        onProgress(
          total > 0 ? Math.min(99, Math.round((byteLength / total) * 100)) : 0,
          byteLength,
          total > 0 ? total : byteLength,
          { speed: 0, eta: 0 }
        );
        lastProgressUpdate = currentTime;
      }
    }
    assertUploadNotCancelled(signal);
    writeStream.end();
    return { blobResult: await completed, byteLength, header: b4a.concat(head) };
  } catch (error) {
    if (typeof writeStream.destroy === 'function') writeStream.destroy(error);
    else writeStream.end();
    await completed.catch(() => {});
    throw error;
  }
}

async function maybeAttachImmutablePublication(metadata, prepared, runtime = {}) {
  if (!prepared) return metadata;
  const { scopedNetwork, deviceKeyPair } = runtime;
  const { catalog, publisherId } = prepared;
  const rendition = prepared.renditionWrite.descriptor;

  return serializeCatalogWrite(catalog, async () => {
  const currentTime = runtime.now();
  const authorization = await catalog.getAuthorizationState();
  const signerKey = b4a.toString(deviceKeyPair.publicKey, 'hex');
  const writer = authorization?.writers?.find(candidate => candidate.signerKey === signerKey);
  if (!writer || writer.revocation || writer.expiresAt < currentTime ||
      !writer.capabilities?.includes('publish') || !writer.capabilities?.includes('claim') ||
      !catalog.localSignerKey || !b4a.equals(catalog.localSignerKey, deviceKeyPair.publicKey)) {
    throw new Error('Local device is not currently authorized to publish and claim');
  }
  const firstSequence = writer.lastAcceptedSequence + 1;
  if (!Number.isSafeInteger(firstSequence) || firstSequence < writer.firstAcceptedSequence) {
    throw new Error('Publisher writer sequence is unavailable');
  }
  assertUploadNotCancelled(runtime.signal);
  // The rendition descriptor is the one the caller already wrote (prepared),
  // so the publication describes exactly the bytes that landed.
  const coreKey = toHex(rendition.core.key, 32);
  // Cover art is part of the publication, not a side channel: a relay that
  // seeds this movie holds the poster too, and a consumer fetches it over the
  // same authorized asset path as the video. Nothing has to leave the swarm.
  // The descriptors were written as static assets alongside the media, so the
  // manifest names cores a peer can actually be authorized for.
  const posterRenditions = []
  const posterProvenance = []
  for (const artwork of Array.isArray(prepared.artworkWrites) ? prepared.artworkWrites : []) {
    const posterRendition = artwork.write?.descriptor
    if (!posterRendition) continue
    posterRenditions.push(posterRendition)
    posterProvenance.push({
      type: 'artwork',
      role: artwork.role,
      videoId: metadata.id,
      blobId: artwork.blobId ? String(artwork.blobId) : null,
      assetId: posterRendition.core.assetId,
      coreKey: toHex(posterRendition.core.key, 32),
      renditionId: posterRendition.renditionId
    })
  }
  const manifest = createPublicationManifest({
    publisherId,
    sequence: firstSequence,
    title: metadata.title || metadata.id,
    sourceFileName: metadata.sourceFileName || null,
    description: metadata.description || null,
    renditions: [rendition, ...posterRenditions],
    provenance: [{
      type: 'upload',
      videoId: metadata.id,
      blobId: metadata.blobId || null,
      assetId: rendition.core.assetId,
      coreKey,
      renditionId: rendition.renditionId,
      ...(metadata.blobId ? {} : { start: 0, end: rendition.core.length })
    }, ...posterProvenance],
    keyPair: deviceKeyPair,
    signedAt: currentTime
  });
  const episodic = metadata.contentKind === 'episode' &&
    Number.isSafeInteger(metadata.seasonNumber) &&
    Number.isSafeInteger(metadata.episodeNumber);
  // Two people uploading the same film are describing one work, and the entity
  // id is a hash of what it is named by. Keyed on the uploader and the upload's
  // own id, every copy was a separate title forever - four Wedding Crashers
  // cards, none of them a source for the others. A provider identity is the
  // one name both uploads already agree on, so it decides the entity and
  // 'issuer-native' stays the fallback for titles no catalogue knows.
  //
  // Which authority may name which kind of work, and the coordinate shape that
  // pairing takes, is one shared table. Reading it here is what lets a title
  // arrive under TMDB, TVDB or MusicBrainz through this one path instead of
  // through a provider name spelled separately into every gate. A kind the
  // table does not name, or one missing an ordinal the table requires, takes
  // no coordinates at all rather than a guessed one.
  const coordinateShape = MEDIA_COORDINATE_SHAPES[metadata.contentKind] || null;
  const coordinated = Boolean(
    coordinateShape &&
    metadata.mediaId &&
    coordinateShape.providers.includes(metadata.mediaProvider) &&
    coordinateShape.ordinals.every(ordinal => Number.isSafeInteger(metadata[ordinal]))
  );
  const providerId = coordinated ? String(metadata.mediaId) : null;
  // Every authority numbers its kinds in separate spaces, and an episode
  // upload carries its show's id, so the shape has to say which is meant.
  const workIdentifier = episodic
    ? episodeWorkIdentifier(providerId, metadata.seasonNumber, metadata.episodeNumber)
    : `${metadata.contentKind}:${providerId}`;
  const subjectRef = providerId
    ? createEntityReference({
        entityKind: 'work',
        namespace: metadata.mediaProvider,
        normalizedIdentifier: workIdentifier
      })
    : createEntityReference({
        entityKind: 'work',
        namespace: 'issuer-native',
        issuerRootKey: publisherId,
        issuerLocalId: metadata.id
      });
  const collectionRef = !episodic
    ? null
    : providerId
      ? createEntityReference({
          entityKind: 'collection',
          namespace: metadata.mediaProvider,
          normalizedIdentifier: `show:${providerId}`
        })
      : createEntityReference({
          entityKind: 'collection',
          namespace: 'issuer-native',
          issuerRootKey: publisherId,
          issuerLocalId: metadata.seriesId || `series:${metadata.id}`
        });
  const claims = [
    createMediaClaim({
      claimType: 'EntityMetadataClaim',
      subjectRefs: [subjectRef],
      payload: {
        title: metadata.title || metadata.id,
        ...(metadata.sourceFileName ? { sourceFileName: metadata.sourceFileName } : {}),
        description: metadata.description || null,
        publicationId: manifest.publicationId,
        // say it; 'movie' stays the fallback for uploads no table describes.
        presentationKind: coordinateShape ? metadata.contentKind : 'movie',
        // Artwork travels with the metadata claim: a consumer has no metadata
        // provider credentials of its own, so a publisher that knows the cover
        // has to say so or every catalog renders as blank placeholders.
        ...(Array.isArray(metadata.artwork) && metadata.artwork.length > 0
          ? { artwork: metadata.artwork }
          : {}),
        // The same reasoning covers the rest of what a viewer reads before
        // pressing play. A consumer cannot look a title up, so a year, plot,
        // runtime, or genre that stays with the publisher is a year, plot,
        // runtime, or genre nobody downstream will ever see.
        ...describeMedia(runtime.mediaMetadata),
        ...(episodic
          ? {
              collectionRef,
              seasonNumber: metadata.seasonNumber,
              episodeNumber: metadata.episodeNumber
            }
          : {})
      },
      confidence: 1000,
      issuerSequence: firstSequence + 1,
      policyEpoch: writer.admissionPolicyEpoch,
      keyPair: deviceKeyPair,
      signedAt: currentTime
    }),
    ...(episodic ? [
      createMediaClaim({
        claimType: 'EntityMetadataClaim',
        subjectRefs: [collectionRef],
        payload: {
          title: metadata.seriesTitle || metadata.title || metadata.seriesId,
          presentationKind: 'series',
          publicationId: manifest.publicationId
        },
        confidence: 1000,
        issuerSequence: firstSequence + 2,
        policyEpoch: writer.admissionPolicyEpoch,
        keyPair: deviceKeyPair,
        signedAt: currentTime
      }),
      createMediaClaim({
        claimType: 'CollectionStructureClaim',
        subjectRefs: [collectionRef],
        payload: {
          collectionRef,
          collectionRole: 'series',
          expectedSlots: metadata.expectedEpisodeCount || 0,
          publicationId: manifest.publicationId
        },
        confidence: 1000,
        issuerSequence: firstSequence + 3,
        policyEpoch: writer.admissionPolicyEpoch,
        keyPair: deviceKeyPair,
        signedAt: currentTime
      }),
      createMediaClaim({
        claimType: 'CollectionMembershipClaim',
        subjectRefs: [collectionRef, subjectRef],
        payload: {
          collectionRef,
          memberRef: subjectRef,
          memberRole: 'episode',
          publicationId: manifest.publicationId,
          position: {
            season: metadata.seasonNumber,
            episode: metadata.episodeNumber
          }
        },
        confidence: 1000,
        issuerSequence: firstSequence + 4,
        policyEpoch: writer.admissionPolicyEpoch,
        keyPair: deviceKeyPair,
        signedAt: currentTime
      })
    ] : []),
    createMediaClaim({
      claimType: 'AvailabilityObservation',
      subjectRefs: [subjectRef],
      payload: {
        publicationId: manifest.publicationId,
        renditionId: rendition.renditionId,
        availabilityStatus: 'available'
      },
      confidence: 1000,
      issuerSequence: firstSequence + (episodic ? 5 : 2),
      policyEpoch: writer.admissionPolicyEpoch,
      keyPair: deviceKeyPair,
      signedAt: currentTime
    })
  ];
  const manifestPayload = encodePublicationManifest(manifest);
  const operations = [{
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    sequence: firstSequence,
    body: {
      publicationId: b4a.from(manifest.publicationId, 'hex'),
      manifestId: b4a.from(manifest.body.manifestId, 'hex'),
      payload: manifestPayload
    }
  }, ...claims.map((claim, index) => ({
    recordType: PUBLISHER_RECORD_TYPES.CLAIM,
    sequence: firstSequence + index + 1,
    body: {
      claimId: b4a.from(claim.claimId, 'hex'),
      claimType: claim.body.claimType,
      payload: encodeMediaClaimEnvelope(claim.envelope)
    }
  }))];
  const signedOperations = [];
  for (const candidate of operations) {
    const signed = await catalog.createLocalOperation({
      ...candidate,
      policyEpoch: writer.admissionPolicyEpoch,
      signedAt: currentTime
    });
    assertUploadNotCancelled(runtime.signal);
    signedOperations.push(signed);
  }
  assertUploadNotCancelled(runtime.signal);
  const operationIds = signedOperations.map(publisherOperationIdHex);
  const operationFramesHex = encodeImmutablePublicationFrames(signedOperations, operationIds);
  metadata.immutablePublication = {
    publicationId: manifest.publicationId,
    manifestId: manifest.body.manifestId,
    renditionId: rendition.renditionId,
    assetId: rendition.core.assetId,
    coreKey: toHex(rendition.core.key, 32),
    publisherId: manifest.body.publisherId,
    sequence: firstSequence,
    entityRef: subjectRef.entityId,
    collectionRef: collectionRef?.entityId || null,
    claimIds: claims.map(claim => claim.claimId),
    operationIds,
    operationFramesHex,
    manifest
  };
  Object.assign(metadata, {
    publication: {
      publicationId: manifest.publicationId,
      manifestId: manifest.body.manifestId,
      renditionId: rendition.renditionId,
      assetId: rendition.core.assetId,
      coreKey: toHex(rendition.core.key, 32),
      publisherId: manifest.body.publisherId,
      sequence: firstSequence,
      metadataClaimId: claims[0].claimId,
      availabilityClaimId: claims[1].claimId,
      publicationOperationId: operationIds[0],
      metadataClaimOperationId: operationIds[1],
      availabilityClaimOperationId: operationIds[2],
      manifestHex: b4a.toString(manifestPayload, 'hex'),
    },
    publicationOperationFramesHex: operationFramesHex,
  });
  metadata.publicationState = 'commitUncertain';
  let metadataStaged = false;
  try {
    if (typeof runtime.stageMetadata === 'function') {
      await runtime.stageMetadata(metadata);
      metadataStaged = true;
    }
    assertUploadNotCancelled(runtime.signal);
    await appendImmutablePublication(catalog, signedOperations);
  } catch (error) {
    if (error?.uploadCommitUncertain === true) {
      throw uncertainCommitError(metadata.immutablePublication, error.message);
    }
    if (metadataStaged || typeof runtime.stageMetadata === 'function') {
      metadata.publicationState = 'replicationPending';
      try {
        await runtime.markRollbackPending?.(metadata);
        await runtime.rollbackMetadata?.(metadata);
      } catch (rollbackError) {
        throw stagedRollbackPendingError(error, rollbackError);
      }
      throw markUploadCommitState(error, 'uploadRollbackCompleted');
    }
    throw error;
  }
  try {
    await finalizeAcceptedPublication(metadata, runtime);
  } catch (error) {
    throw uncertainCommitError(metadata.immutablePublication, error?.message);
  }
  // Announcing a catalog only tells peers the title exists. A consumer finds
  // the bytes on the asset scope for the rendition, and until the publisher
  // joins that scope there is nobody there to answer: the catalog syncs, every
  // source reads as awaiting replication, and no cover ever arrives.
  //
  // finalizeAcceptedPublication already held the media rendition, so retaining
  // it again here would only duplicate the request. What is left is the cover
  // published alongside it, which needs its own scope for the same reason.
  for (const posterRendition of posterRenditions) {
    try {
      await scopedNetwork?.retainAuthorizedRendition?.({
        manifest,
        renditionId: posterRendition.renditionId,
        entityRef: subjectRef.entityId,
        publicationId: manifest.publicationId,
        retentionClass: runtime.retentionClass,
        start: 0,
        end: posterRendition.core.length
      });
    } catch (error) {
      // A publisher that cannot serve the cover yet still published; the
      // catalog entry is committed and retention is retried by the lifecycle.
      console.log('[Upload] Cover is not being served yet:', error?.message);
    }
  }
  return metadata;
  });
}

/**
 * @typedef {Object} UploadOptions
 * @property {string} title - Video title
 * @property {string} [description] - Video description
 * @property {string} [mimeType] - MIME type (defaults to video/mp4)
 * @property {number} [duration] - Video duration in seconds
 * @property {string} [thumbnail] - Thumbnail blob ID
 * @property {string} [thumbnailUrl] - Persistable thumbnail source URL
 * @property {string} [thumbnailBlobId] - Thumbnail Hyperblobs ID
 * @property {string} [thumbnailBlobsCoreKey] - Thumbnail blobs core key
 * @property {string} [thumbnailMimeType] - Thumbnail MIME type
 * @property {string} [category] - Video category
 * @property {'contribution-cache'|'archive-pin'} [retentionClass] - Explicit retention role for public serving
 * @property {number} [width] - Video width in pixels
 * @property {number} [height] - Video height in pixels
 * @property {string} [contentKind] - Structured content kind
 * @property {string} [sourceProvider] - Source provider
 * @property {string} [sourceVideoId] - Stable source video ID
 * @property {string} [identityUrl] - Normalized canonical source URL
 * @property {string} [sourceCreatorId] - Stable source creator ID
 * @property {string} [sourceCreatorUrl] - Canonical source creator URL
 * @property {number} [sourcePublishedAt] - Source publication timestamp
 * @property {string} [mediaProvider] - Media metadata provider
 * @property {string} [mediaId] - Stable media provider ID
 * @property {number} [seasonNumber] - Season number
 * @property {number} [episodeNumber] - Episode number
 * @property {string} [seriesId] - Canonical local series identifier
 * @property {string} [seriesTitle] - Authenticated series title
 * @property {number} [expectedEpisodeCount] - Expected collection member count
 * @property {number} [originalAirDate] - Original air date timestamp
 * @property {string} [provenanceVersion] - Metadata resolver version
 * @property {string} [publicationState] - Private/public publication state
 * @property {string} [contentFingerprint] - Stable content fingerprint
 * @property {string} [importIdentityKey] - Normalized import identity
 * @property {string} [importClaimantId] - Import claim contender ID
 * @property {string} [publisherId] - Publisher catalog identity
 * @property {string} [resumeId] - Stable durable ingest job identifier
 * @property {AbortSignal} [signal] - Upload cancellation signal
 */

/**
 * @typedef {Object} UploadResult
 * @property {boolean} success - Whether upload succeeded
 * @property {string} [videoId] - Generated video ID
 * @property {VideoMetadata} [metadata] - Video metadata
 * @property {string} [publicationId] - Published catalog record ID
 * @property {string} [manifestId] - Published v2 manifest ID
 * @property {string} [renditionId] - Published original rendition ID
 * @property {string} [assetId] - Canonical immutable asset ID
 * @property {string} [coreKey] - Canonical readonly Hypercore key
 * @property {Object} [manifest] - Signed v2 publication manifest
 * @property {string} [error] - Error message if failed
 */

/**
 * @callback ProgressCallback
 * @param {number} progress - Progress percentage (0-100)
 * @param {number} bytesWritten - Bytes written so far
 * @param {number} totalBytes - Total bytes to write
 * @param {Object} [stats] - Additional stats for better progress display
 * @param {number} [stats.speed] - Current speed in bytes/sec
 * @param {number} [stats.eta] - Estimated time remaining in seconds
 */

/**
 * Create video upload manager
 *
 * @param {Object} deps
 * @param {StorageContext} deps.ctx - Storage context
 * @returns {Object} Upload manager API
 */
export function createUploadManager({
  ctx,
  catalogRegistry = null,
  verifiedQueryView = null,
  scopedNetwork = null,
  deviceKeyPair = null,
  now = () => Date.now()
}) {
  // The storage context owns the one block-offload capability used by both the
  // read wrapper and the asset writer.
  const blockOffload = ctx?.blockOffload ?? null;
  // Resumable ingest needs both a bounded offloader and durable staging.
  const resumableIngest = typeof blockOffload?.createOffloader === 'function' &&
    typeof blockOffload?.createStagingStore === 'function';
  const publicationRuntime = { catalogRegistry, verifiedQueryView, scopedNetwork, deviceKeyPair, store: ctx?.store, offload: blockOffload, now };

  async function resolveAuthorizedPublisher(publisherId) {
    if (!catalogRegistry || !deviceKeyPair?.publicKey || !deviceKeyPair?.secretKey) return null;
    const publisherBuffer = typeof publisherId === 'string'
      ? (/^[0-9a-f]{64}$/i.test(publisherId) ? b4a.from(publisherId, 'hex') : null)
      : (b4a.isBuffer(publisherId) || (publisherId instanceof Uint8Array)) && publisherId.byteLength === 32 ? b4a.from(publisherId) : null;
    if (!publisherBuffer) return null;
    let binding = null;
    try {
      binding = await catalogRegistry.resolve(publisherBuffer);
    } catch {
      return null;
    }
    const catalog = binding?.catalog;
    if (!catalog?.writable || typeof catalog.getAuthorizationState !== 'function' ||
        typeof catalog.createLocalOperation !== 'function' || typeof catalog.appendBatchAndConfirm !== 'function') {
      return null;
    }
    const authorization = await catalog.getAuthorizationState();
    const signerKey = b4a.toString(deviceKeyPair.publicKey, 'hex');
    const writer = authorization?.writers?.find(candidate => candidate.signerKey === signerKey);
    const currentTime = now();
    if (!writer || writer.revocation || writer.expiresAt < currentTime ||
        !writer.capabilities?.includes('publish') || !writer.capabilities?.includes('claim') ||
        !catalog.localSignerKey || !b4a.equals(catalog.localSignerKey, deviceKeyPair.publicKey)) {
      return null;
    }
    return { binding, catalog };
  }

  async function getAuthorizedPublisherIds() {
    if (!catalogRegistry || typeof catalogRegistry.getWritableBindings !== 'function') return []
    const bindings = await catalogRegistry.getWritableBindings()
    const authorized = []
    for (const binding of bindings || []) {
      const publisherId = b4a.toString(b4a.from(binding?.publisherId || []), 'hex')
      if (publisherId.length !== 64) continue
      if (await resolveAuthorizedPublisher(publisherId)) authorized.push(publisherId)
    }
    return authorized.sort()
  }

  function acquisitionPublicationKey(acquisitionId) {
    if (typeof acquisitionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(acquisitionId)) {
      throw new Error('Acquisition id is invalid')
    }
    return `acquisition/publication/v1/${acquisitionId}`
  }

  async function getAcquiredPublication({ acquisitionId, publisherId = null, asset = null, resolution = null } = {}) {
    if (typeof ctx?.metaDb?.get !== 'function') return null
    const key = acquisitionPublicationKey(acquisitionId)
    const value = (await ctx.metaDb.get(key))?.value
    const stored = value?.publication
    if (value?.schemaVersion === 1 && (publisherId === null || value.publisherId === publisherId) &&
        stored && ['publicationId', 'manifestId', 'renditionId', 'assetId'].every(field =>
          typeof stored[field] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(stored[field]))) {
      return { ...stored }
    }
    if (!verifiedQueryView || typeof verifiedQueryView.getEntity !== 'function' || !publisherId || !asset?.assetId) return null
    const media = resolution?.mediaContext || {}
    const coordinateShape = MEDIA_COORDINATE_SHAPES[media.kind] || null
    const episodic = media.kind === 'episode' && Number.isSafeInteger(media.season) && Number.isSafeInteger(media.episode)
    const coordinated = Boolean(
      coordinateShape &&
      typeof media.identifier === 'string' &&
      coordinateShape.providers.includes(media.namespace) &&
      coordinateShape.ordinals.every(ordinal => Number.isSafeInteger(
        ordinal === 'seasonNumber' ? media.season : ordinal === 'episodeNumber' ? media.episode : media[ordinal]
      ))
    )
    const workIdentifier = episodic && coordinated
      ? episodeWorkIdentifier(media.identifier, media.season, media.episode)
      : `${media.kind || 'movie'}:${media.identifier}`
    const subjectRef = coordinated
      ? createEntityReference({ entityKind: 'work', namespace: media.namespace, normalizedIdentifier: workIdentifier })
      : createEntityReference({ entityKind: 'work', namespace: 'issuer-native', issuerRootKey: publisherId, issuerLocalId: acquisitionId })
    const entity = await verifiedQueryView.getEntity({ entityKind: 'work', entityId: subjectRef.entityId })
    for (const candidate of entity?.publications || []) {
      if (candidate.publisherId && candidate.publisherId !== publisherId) continue
      const manifest = candidate.manifest || await verifiedQueryView.getManifest({ publicationId: candidate.publicationId })
      const rendition = manifest?.body?.renditions?.find(entry => entry?.core?.assetId === asset.assetId)
      if (!manifest || !rendition) continue
      const recovered = {
        publicationId: candidate.publicationId,
        manifestId: candidate.manifestId || manifest.body?.manifestId,
        renditionId: rendition.renditionId,
        assetId: asset.assetId
      }
      if (!Object.values(recovered).every(entry => typeof entry === 'string' && entry)) continue
      await ctx.metaDb.put(key, { schemaVersion: 1, publisherId, publication: recovered })
      return recovered
    }
    return null
  }

  async function publishAcquiredAsset({
    acquisitionId,
    publisherId,
    asset,
    source = {},
    resolution = {},
    retentionClass = 'contribution-cache',
    signal
  } = {}) {
    const existing = await getAcquiredPublication({ acquisitionId, publisherId, asset, resolution });
    if (existing) {
      if (existing.assetId !== asset?.assetId) throw new Error('Acquisition publication asset does not match');
      return existing;
    }
    const authorized = await resolveAuthorizedPublisher(publisherId);
    if (!authorized) throw new Error('Local device is not currently authorized to publish and claim');
    const core = createStaticAssetManifest({
      treeHash: asset?.treeHash,
      blockLength: asset?.length,
      byteLength: asset?.byteLength,
      blockSize: asset?.blockSize
    });
    if (core.assetId !== asset?.assetId || b4a.toString(core.key, 'hex') !== asset?.key) {
      throw new Error('Acquired asset identity is invalid');
    }
    const mimeType = typeof source?.mimeType === 'string' && source.mimeType ? source.mimeType : 'application/octet-stream';
    const durationMs = Number.isSafeInteger(source?.durationMs) && source.durationMs > 0 ? source.durationMs : 1;
    const rendition = createRenditionDescriptor({
      purpose: 'original',
      format: mimeType,
      durationMs,
      core
    });
    const media = resolution?.mediaContext || {};
    const metadata = {
      id: acquisitionId,
      title: typeof resolution?.title === 'string' && resolution.title ? resolution.title : acquisitionId,
      sourceFileName: typeof resolution?.sourceFileName === 'string' && resolution.sourceFileName ? resolution.sourceFileName : null,
      description: null,
      duration: durationMs / 1000,
      contentKind: typeof media.kind === 'string' && media.kind ? media.kind : 'movie',
      mediaProvider: typeof media.namespace === 'string' ? media.namespace : null,
      mediaId: typeof media.identifier === 'string' ? media.identifier : null,
      seasonNumber: Number.isSafeInteger(media.season) ? media.season : null,
      episodeNumber: Number.isSafeInteger(media.episode) ? media.episode : null
    };
    const published = await maybeAttachImmutablePublication(metadata, {
      catalog: authorized.catalog,
      publisherId: b4a.from(authorized.binding.publisherId),
      renditionWrite: { descriptor: rendition },
      artworkWrites: []
    }, {
      ...publicationRuntime,
      publisherId,
      retentionClass,
      signal,
      // Acquired assets have no legacy channel metadata row to finalize. Their
      // durable publication mapping is written below after the signed catalog
      // commit succeeds.
      finalizeMetadata: async () => {}
    });
    const publication = published?.immutablePublication;
    if (!publication) throw new Error('Acquired asset publication did not commit');
    const result = {
      publicationId: publication.publicationId,
      manifestId: publication.manifestId,
      renditionId: publication.renditionId,
      assetId: publication.assetId
    };
    if (typeof ctx?.metaDb?.put !== 'function') throw new Error('Acquisition publication repository is unavailable');
    await ctx.metaDb.put(acquisitionPublicationKey(acquisitionId), {
      schemaVersion: 1,
      publisherId,
      publication: result
    });
    return result;
  }

  async function retractAcquiredPublication({ publicationId, publisherId = null } = {}) {
    if (!publicationId) throw new Error('publicationId is required');
    let authorized = null;
    if (publisherId) {
      authorized = await resolveAuthorizedPublisher(publisherId);
    } else {
      const authorizedIds = await getAuthorizedPublisherIds();
      for (const id of authorizedIds) {
        const candidate = await resolveAuthorizedPublisher(id);
        if (candidate) {
          authorized = candidate;
          break;
        }
      }
    }
    if (!authorized) throw new Error('Local device is not currently authorized to publish and claim');
    const { catalog } = authorized;
    const authorization = await catalog.getAuthorizationState();
    const signerKey = b4a.toString(deviceKeyPair.publicKey, 'hex');
    const writer = authorization?.writers?.find(candidate => candidate.signerKey === signerKey);
    if (!writer || writer.revocation || writer.expiresAt < now() ||
        !writer.capabilities?.includes('publish') || !writer.capabilities?.includes('claim') ||
        !catalog.localSignerKey || !b4a.equals(catalog.localSignerKey, deviceKeyPair.publicKey)) {
      throw new Error('Local device is not currently authorized to publish and claim');
    }
    const firstSequence = writer.lastAcceptedSequence + 1;
    if (!Number.isSafeInteger(firstSequence) || firstSequence < writer.firstAcceptedSequence) {
      throw new Error('Publisher writer sequence is unavailable');
    }
    const targetId = typeof publicationId === 'string'
      ? (/^[0-9a-f]{64}$/i.test(publicationId) ? b4a.from(publicationId, 'hex') : b4a.from(publicationId))
      : b4a.from(publicationId);
    const operation = {
      recordType: PUBLISHER_RECORD_TYPES.RETRACTION,
      sequence: firstSequence,
      body: {
        targetType: 'publication',
        targetId,
        reason: b4a.from('deleted by operator')
      }
    };
    const signed = await catalog.createLocalOperation({
      ...operation,
      policyEpoch: writer.admissionPolicyEpoch,
      signedAt: now()
    });
    const receipts = await catalog.appendBatchAndConfirm([signed]);
    if (!Array.isArray(receipts) || receipts.length !== 1 || receipts[0]?.accepted !== true) {
      throw new Error(`Publisher catalog did not accept retraction: ${receipts?.[0]?.code || 'rejected'}`);
    }
    const publisherHex = b4a.toString(authorized.binding.publisherId, 'hex');
    await verifiedQueryView?.refresh?.({
      publisherIds: [publisherHex],
    });
    return { done: true, publicationId: b4a.toString(targetId, 'hex') };
  }
  /**
   * Probe the uploaded MP4 for its playback profile (moov position +
   * keyframe index) and persist it for range prioritization at playback
   * time. Header-only parse — no transcoding, no decoding. Best-effort:
   * uploads must never fail or slow down because probing did.
   */
  async function persistPlaybackProfile(channel, blobId, mimeType, probe) {
    if (!isMp4MimeType(mimeType)) return
    try {
      const profile = await probe()
      if (!profile) return
      const saved = await saveBlobPlaybackProfile(
        ctx,
        { blobsCoreKey: channel.blobsKeyHex, blobId },
        profile
      )
      if (saved) {
        console.log(
          '[Upload] Playback profile saved:',
          'moov:', profile.moovPosition,
          'keyframes:', profile.keyframeOffsets.length,
          'maxGopMs:', profile.maxGopMs ?? 'n/a'
        )
      }
    } catch (err) {
      console.log('[Upload] Playback probe skipped:', err?.message || err)
    }
  }

  return {
    async hasPublisherAuthority({ publisherId } = {}) {
      return (await resolveAuthorizedPublisher(publisherId)) !== null;
    },

    publishAcquiredAsset,
    retractAcquiredPublication,
    getAuthorizedPublisherIds,
    getAcquiredPublication,
    /**
     * Upload video from a file path (desktop)
     * Requires fs module to be passed in for platform compatibility
     *
     * @param {MultiWriterChannel} channel - Target channel
     * @param {string} filePath - Path to video file
     * @param {UploadOptions} options - Upload options
     * @param {Object} fs - File system module (bare-fs or node fs)
     * @param {ProgressCallback} [onProgress] - Progress callback
     * @returns {Promise<UploadResult>}
     */
    async uploadFromPath(channel, filePath, options, fs, onProgress) {
      let blobResult = null;
      let immutableCommitConfirmed = false;
      let prepared = null;
      try {
        if (!channel.blobs) {
          throw new Error('Channel blobs not initialized');
        }

        // Honor a caller-supplied deterministic video id so crash-safe importers
        // can reconcile an existing private draft instead of duplicating the upload.
        const providedVideoId = typeof options.videoId === 'string' && /^[0-9a-f]{1,64}$/i.test(options.videoId)
          ? options.videoId
          : null
        if (providedVideoId && typeof channel.getVideo === 'function') {
          const existing = await channel.getVideo(providedVideoId).catch(() => null)
          if (existing?.publicationState === 'commitUncertain') {
            const outcome = await reconcileUncertainUpload(channel, existing, {
              ...publicationRuntime,
              publisherId: options.publisherId,
              signal: options.signal,
            });
            if (outcome === 'accepted') {
              return { ...completedUploadResult(providedVideoId, existing), reused: true };
            }
          } else if (existing?.publicationState === 'replicationPending') {
            await reconcilePendingUpload(channel, existing);
          } else if (existing) {
            return { ...completedUploadResult(providedVideoId, existing), reused: true };
          }
        }
        const videoId = providedVideoId || b4a.toString(crypto.randomBytes(16), 'hex');
        const metadata = normalizeVideoMetadata(options, videoId);
        const uploadControl = {
          publisherId: options.publisherId,
          retentionClass: options.retentionClass,
          signal: options.signal
        };
        assertUploadNotCancelled(uploadControl.signal);

        const stat = fs.statSync(filePath);
        let fileSize = stat.size;
        let mimeType;
        const startTime = Date.now();
        const publicationReader = catalogRegistry && deviceKeyPair
          ? createFileSourceReader({
              fs,
              path: filePath,
              mimeType: String(metadata.mimeType || 'application/octet-stream')
            })
          : null;

        prepared = await prepareImmutablePublication(metadata, {
          ...publicationRuntime,
          ...uploadControl,
          reader: publicationReader,
          createArtworkSources: () => collectArtworkSources(channel, metadata)
        });
        if (prepared) {
          fileSize = prepared.renditionWrite.descriptor.core.byteLength;
          const firstBlock = fileSize > 0 ? await prepared.renditionWrite.core.get(0) : b4a.alloc(0);
          mimeType = detectMimeType(firstBlock.subarray(0, Math.min(4100, firstBlock.byteLength))) ||
            metadata.mimeType ||
            'video/mp4';
          finalizePreparedRendition(prepared, mimeType);
          blobResult = staticPlaybackBlobRef(prepared);
          await prepared.renditionWrite.core.close();
        } else {
          const headerSize = Math.min(4100, fileSize);
          let headerBuffer;
          if (fs.createReadStream) {
            headerBuffer = await new Promise((resolve, reject) => {
              const chunks = [];
              const stream = fs.createReadStream(filePath, { start: 0, end: headerSize - 1 });
              stream.on('data', chunk => chunks.push(chunk));
              stream.on('end', () => resolve(b4a.concat(chunks)));
              stream.on('error', reject);
            });
          } else {
            const fd = fs.openSync(filePath, 'r');
            headerBuffer = b4a.alloc(headerSize);
            fs.readSync(fd, headerBuffer, 0, headerSize, 0);
            fs.closeSync(fd);
          }
          mimeType = detectMimeType(headerBuffer) || metadata.mimeType || 'video/mp4';
          let bytesWritten = 0;
          let lastProgressUpdate = Date.now();
          blobResult = await new Promise((resolve, reject) => {
            const writeStream = channel.blobs.createWriteStream();
            const readStream = fs.createReadStream(filePath);
            readStream.on('data', (chunk) => {
              bytesWritten += chunk.length;
              const currentTime = Date.now();
              if (onProgress && (currentTime - lastProgressUpdate > 500 || bytesWritten === fileSize)) {
                const progress = Math.round((bytesWritten / fileSize) * 100);
                const elapsed = (currentTime - startTime) / 1000;
                const speed = elapsed > 0 ? bytesWritten / elapsed : 0;
                const remaining = fileSize - bytesWritten;
                onProgress(progress, bytesWritten, fileSize, {
                  speed,
                  eta: speed > 0 ? remaining / speed : 0
                });
                lastProgressUpdate = currentTime;
              }
            });
            readStream.on('error', reject);
            writeStream.on('error', reject);
            writeStream.on('close', () => {
              const id = writeStream.id;
              resolve({ id: `${id.blockOffset}:${id.blockLength}:${id.byteOffset}:${id.byteLength}`, ...id });
            });
            readStream.pipe(writeStream);
          });
        }

        onProgress?.(100, fileSize, fileSize, { speed: 0, eta: 0 });
        const totalTime = (Date.now() - startTime) / 1000;
        const avgSpeed = totalTime > 0 ? fileSize / totalTime : 0;
        console.log(`[Upload] Transfer complete in ${totalTime.toFixed(1)}s (avg ${(avgSpeed / 1024 / 1024).toFixed(2)} MB/s)`);

        buildVideoMetadata(metadata, blobResult, channel, fileSize, mimeType);
        await maybeAttachImmutablePublication(metadata, prepared, {
          ...publicationRuntime,
          publisherId: options.publisherId,
          mediaMetadata: options.mediaMetadata,
          ...uploadControl,
          stageMetadata: value => channel.addVideo(value, { syncPublic: false }),
          markRollbackPending: value => channel.updateVideo?.(value.id, value, { syncPublic: false }),
          rollbackMetadata: async value => {
            await rollbackUploadedBlob(channel, blobResult);
            if (typeof channel.deleteVideo !== 'function') throw new Error('staged metadata deletion is unavailable');
            await channel.deleteVideo(value.id);
          },
          finalizeMetadata: value => {
            if (typeof channel.updateVideo !== 'function') {
              throw new Error('published metadata update is unavailable');
            }
            return channel.updateVideo(value.id, value, {
              syncPublic: true,
              commitAfterPublicSync: true,
            });
          }
        });
        immutableCommitConfirmed = Boolean(metadata.immutablePublication);
        if (!prepared) {
          await persistPlaybackProfile(channel, blobResult.id, mimeType, () => probeMp4File(fs, filePath, { fileSize }));
        }

        if (!prepared) {
          await channel.addVideo(metadata, {
            syncPublic: metadata.publicationState !== 'replicationPending'
          });
        }

        console.log('[Upload] Complete:', videoId, 'blobId:', blobResult.id, 'blobsCore:', metadata.blobsCoreKey?.slice(0, 16), 'keyLen:', metadata.blobsCoreKey?.length);

        return completedUploadResult(videoId, metadata);
      } catch (err) {
        let failure = err;
        if (prepared?.renditionWrite?.core && !prepared.renditionWrite.core.closed) {
          try {
            await prepared.renditionWrite.core.close();
          } catch { /* best-effort staged rendition close after path upload failure */ }
        }
        if (blobResult && !immutableCommitConfirmed &&
            failure?.uploadCommitSucceeded !== true &&
            failure?.uploadCommitUncertain !== true &&
            failure?.uploadRollbackCompleted !== true &&
            failure?.uploadRollbackPending !== true) {
          try {
            await rollbackUploadedBlob(channel, blobResult);
          } catch {
            failure = new Error('Upload failed and rollback could not be completed');
          }
        }
        console.error('[Upload] Failed:', failure.message);
        return {
          success: false,
          error: failure.message,
          ...(failure?.uploadCommitUncertain === true
            ? { commitUncertain: true, reconciliationRequired: true, reconciliation: failure.reconciliation }
            : {}),
          ...(failure?.uploadRollbackPending === true ? { rollbackPending: true } : {})
        };
      }
    },

    /**
     * Upload video from a buffer (mobile)
     *
     * @param {MultiWriterChannel} channel - Target channel
     * @param {Buffer} buffer - Video data buffer
     * @param {UploadOptions} options - Upload options
     * @param {ProgressCallback} [onProgress] - Progress callback
     * @returns {Promise<UploadResult>}
     */
    async uploadFromBuffer(channel, buffer, options, onProgress) {
      let blobResult = null;
      let immutableCommitConfirmed = false;
      let prepared = null;
      try {
        if (!channel.blobs) {
          throw new Error('Channel blobs not initialized');
        }

        const providedVideoId = typeof options.videoId === 'string' && /^[0-9a-f]{1,64}$/i.test(options.videoId)
          ? options.videoId
          : null;
        if (providedVideoId && typeof channel.getVideo === 'function') {
          const existing = await channel.getVideo(providedVideoId).catch(() => null);
          if (existing?.publicationState === 'commitUncertain') {
            const outcome = await reconcileUncertainUpload(channel, existing, {
              ...publicationRuntime,
              publisherId: options.publisherId,
              signal: options.signal,
            });
            if (outcome === 'accepted') {
              return { ...completedUploadResult(providedVideoId, existing), reused: true };
            }
          } else if (existing?.publicationState === 'replicationPending') {
            await reconcilePendingUpload(channel, existing);
          } else if (existing) {
            return { ...completedUploadResult(providedVideoId, existing), reused: true };
          }
        }
        const videoId = providedVideoId || b4a.toString(crypto.randomBytes(16), 'hex');
        const metadata = normalizeVideoMetadata(options, videoId);
        const uploadControl = {
          publisherId: options.publisherId,
          retentionClass: options.retentionClass,
          signal: options.signal
        };
        assertUploadNotCancelled(uploadControl.signal);
        const publicationReader = catalogRegistry && deviceKeyPair
          ? createBufferSourceReader(buffer, {
              mimeType: String(metadata.mimeType || 'application/octet-stream')
            })
          : null;
        prepared = await prepareImmutablePublication(metadata, {
          ...publicationRuntime,
          ...uploadControl,
          reader: publicationReader,
          createArtworkSources: () => collectArtworkSources(channel, metadata)
        });
        let fileSize;
        let mimeType;
        if (prepared) {
          fileSize = prepared.renditionWrite.descriptor.core.byteLength;
          const firstBlock = fileSize > 0 ? await prepared.renditionWrite.core.get(0) : b4a.alloc(0);
          mimeType = detectMimeType(firstBlock.subarray(0, Math.min(4100, firstBlock.byteLength))) ||
            metadata.mimeType ||
            'video/mp4';
          finalizePreparedRendition(prepared, mimeType);
          blobResult = staticPlaybackBlobRef(prepared);
          await prepared.renditionWrite.core.close();
        } else {
          fileSize = buffer.length;
          const headerBuffer = buffer.subarray(0, Math.min(4100, fileSize));
          mimeType = detectMimeType(headerBuffer) || metadata.mimeType || 'video/mp4';
          blobResult = await channel.putBlob(buffer);
        }
        // The bytes landed in the rendition core, not in a second blob copy, so
        // completion is reported here for both shapes.
        onProgress?.(100, fileSize, fileSize, { speed: 0, eta: 0 });

        buildVideoMetadata(metadata, blobResult, channel, fileSize, mimeType);
        await maybeAttachImmutablePublication(metadata, prepared, {
          ...publicationRuntime,
          publisherId: options.publisherId,
          mediaMetadata: options.mediaMetadata,
          ...uploadControl,
          stageMetadata: value => channel.addVideo(value, { syncPublic: false }),
          markRollbackPending: value => channel.updateVideo?.(value.id, value, { syncPublic: false }),
          rollbackMetadata: async value => {
            await rollbackUploadedBlob(channel, blobResult);
            if (typeof channel.deleteVideo !== 'function') throw new Error('staged metadata deletion is unavailable');
            await channel.deleteVideo(value.id);
          },
          finalizeMetadata: value => {
            if (typeof channel.updateVideo !== 'function') {
              throw new Error('published metadata update is unavailable');
            }
            return channel.updateVideo(value.id, value, {
              syncPublic: true,
              commitAfterPublicSync: true,
            });
          }
        });
        immutableCommitConfirmed = Boolean(metadata.immutablePublication);
        if (!prepared) {
          await persistPlaybackProfile(channel, blobResult.id, mimeType, () => probeMp4Buffer(buffer));
        }

        if (!prepared) {
          await channel.addVideo(metadata, {
            syncPublic: metadata.publicationState !== 'replicationPending'
          });
        }

        console.log('[Upload] Complete:', videoId, 'blobId:', blobResult.id, 'blobsCore:', metadata.blobsCoreKey?.slice(0, 16), 'keyLen:', metadata.blobsCoreKey?.length);

        return completedUploadResult(videoId, metadata);
      } catch (err) {
        let failure = err;
        if (prepared?.renditionWrite?.core && !prepared.renditionWrite.core.closed) {
          try {
            await prepared.renditionWrite.core.close();
          } catch { /* best-effort staged rendition close after buffer upload failure */ }
        }
        if (blobResult && !immutableCommitConfirmed &&
            failure?.uploadCommitSucceeded !== true &&
            failure?.uploadCommitUncertain !== true &&
            failure?.uploadRollbackCompleted !== true &&
            failure?.uploadRollbackPending !== true) {
          try {
            await rollbackUploadedBlob(channel, blobResult);
          } catch {
            failure = new Error('Upload failed and rollback could not be completed');
          }
        }
        console.error('[Upload] Failed:', failure.message);
        return {
          success: false,
          error: failure.message,
          ...(failure?.uploadCommitUncertain === true
            ? { commitUncertain: true, reconciliationRequired: true, reconciliation: failure.reconciliation }
            : {}),
          ...(failure?.uploadRollbackPending === true ? { rollbackPending: true } : {})
        };
      }
    },

    /**
     * Upload video from a SourceReader.
     *
     * The reader owns source identity, exact length, range semantics,
     * cancellation, and cleanup. Resumable readers use durable staging when
     * block offload provides it; one-shot readers are consumed exactly once.
     *
     * @param {MultiWriterChannel} channel - Target channel
     * @param {Object} reader - Strict SourceReader contract
     * @param {UploadOptions} options - Upload options
     * @param {ProgressCallback} [onProgress] - Progress callback
     * @returns {Promise<UploadResult>}
     */
    async uploadFromStream(channel, reader, options, onProgress) {
      let blobResult = null;
      let immutableCommitConfirmed = false;
      let prepared = null;
      let sourceReader = null;
      try {
        if (!channel.blobs) {
          throw new Error('Channel blobs not initialized');
        }
        if (!reader) throw new Error('Upload stream SourceReader is required');

        const providedVideoId = typeof options.videoId === 'string' && /^[0-9a-f]{1,64}$/i.test(options.videoId)
          ? options.videoId
          : null;
        if (providedVideoId && typeof channel.getVideo === 'function') {
          const existing = await channel.getVideo(providedVideoId).catch(() => null);
          if (existing?.publicationState === 'commitUncertain') {
            const outcome = await reconcileUncertainUpload(channel, existing, {
              ...publicationRuntime,
              publisherId: options.publisherId,
              signal: options.signal,
            });
            if (outcome === 'accepted') {
              return { ...completedUploadResult(providedVideoId, existing), reused: true };
            }
          } else if (existing?.publicationState === 'replicationPending') {
            await reconcilePendingUpload(channel, existing);
          } else if (existing) {
            return { ...completedUploadResult(providedVideoId, existing), reused: true };
          }
        }
        const videoId = providedVideoId || b4a.toString(crypto.randomBytes(16), 'hex');
        const metadata = normalizeVideoMetadata(options, videoId);
        const uploadControl = {
          publisherId: options.publisherId,
          retentionClass: options.retentionClass,
          signal: options.signal
        };
        assertUploadNotCancelled(uploadControl.signal);
        sourceReader = createSourceReader(reader);
        const description = await sourceReader.describe({ signal: uploadControl.signal });
        const resume = sourceReader.resumable && resumableIngest && options.resumeId
          ? { id: options.resumeId }
          : false;
        prepared = await prepareImmutablePublication(metadata, {
          ...publicationRuntime,
          ...uploadControl,
          reader: sourceReader,
          resume,
          createArtworkSources: () => collectArtworkSources(channel, metadata)
        });
        let fileSize;
        let mimeType;
        if (prepared) {
          fileSize = prepared.renditionWrite.descriptor.core.byteLength;
          const firstBlock = fileSize > 0 ? await prepared.renditionWrite.core.get(0) : b4a.alloc(0);
          mimeType = detectMimeType(firstBlock.subarray(0, Math.min(4100, firstBlock.byteLength))) ||
            metadata.mimeType ||
            'video/mp4';
          finalizePreparedRendition(prepared, mimeType);
          blobResult = staticPlaybackBlobRef(prepared);
          await prepared.renditionWrite.core.close();
        } else {
          const opened = readWholeSource(sourceReader, description, uploadControl.signal);
          const streamed = await writeStreamedPlaybackBlob(
            channel,
            opened,
            uploadControl.signal,
            onProgress,
            description.byteLength
          );
          await sourceReader.close();
          blobResult = streamed.blobResult;
          fileSize = streamed.byteLength;
          mimeType = detectMimeType(streamed.header) || description.mimeType || metadata.mimeType || 'video/mp4';
        }
        onProgress?.(100, fileSize, fileSize, { speed: 0, eta: 0 });

        buildVideoMetadata(metadata, blobResult, channel, fileSize, mimeType);
        await maybeAttachImmutablePublication(metadata, prepared, {
          ...publicationRuntime,
          publisherId: options.publisherId,
          mediaMetadata: options.mediaMetadata,
          ...uploadControl,
          stageMetadata: value => channel.addVideo(value, { syncPublic: false }),
          markRollbackPending: value => channel.updateVideo?.(value.id, value, { syncPublic: false }),
          rollbackMetadata: async value => {
            await rollbackUploadedBlob(channel, blobResult);
            if (typeof channel.deleteVideo !== 'function') throw new Error('staged metadata deletion is unavailable');
            await channel.deleteVideo(value.id);
          },
          finalizeMetadata: value => {
            if (typeof channel.updateVideo !== 'function') {
              throw new Error('published metadata update is unavailable');
            }
            return channel.updateVideo(value.id, value, {
              syncPublic: true,
              commitAfterPublicSync: true,
            });
          }
        });
        immutableCommitConfirmed = Boolean(metadata.immutablePublication);
        // No playback profile: probing an MP4 needs the moov atom, which can
        // sit at the end of the file, and the bytes are gone by now. A profile
        // is a range-prioritization hint, so its absence costs nothing but a
        // colder first seek.

        if (!prepared) {
          await channel.addVideo(metadata, {
            syncPublic: metadata.publicationState !== 'replicationPending'
          });
        }

        console.log('[Upload] Complete:', videoId, 'blobId:', blobResult.id, 'blobsCore:', metadata.blobsCoreKey?.slice(0, 16), 'keyLen:', metadata.blobsCoreKey?.length);

        return completedUploadResult(videoId, metadata);
      } catch (err) {
        let failure = err;
        if (sourceReader) await sourceReader.close(err).catch(() => {});
        if (prepared?.renditionWrite?.core && !prepared.renditionWrite.core.closed) {
          try {
            await prepared.renditionWrite.core.close();
          } catch { /* best-effort staged rendition close after stream upload failure */ }
        }
        if (blobResult && !immutableCommitConfirmed &&
            failure?.uploadCommitSucceeded !== true &&
            failure?.uploadCommitUncertain !== true &&
            failure?.uploadRollbackCompleted !== true &&
            failure?.uploadRollbackPending !== true) {
          try {
            await rollbackUploadedBlob(channel, blobResult);
          } catch {
            failure = new Error('Upload failed and rollback could not be completed');
          }
        }
        console.error('[Upload] Failed:', failure.message);
        return {
          success: false,
          error: failure.message,
          ...(failure?.uploadCommitUncertain === true
            ? { commitUncertain: true, reconciliationRequired: true, reconciliation: failure.reconciliation }
            : {}),
          ...(failure?.uploadRollbackPending === true ? { rollbackPending: true } : {})
        };
      }
    },

    /**
     * Set video thumbnail from a buffer
     *
     * @param {MultiWriterChannel} channel - Target channel
     * @param {string} videoId - Video ID
     * @param {Buffer} buffer - Image data buffer
     * @param {string} [mimeType='image/jpeg'] - Image MIME type
     * @returns {Promise<{success: boolean, thumbnailBlobId?: string, error?: string}>}
     */
    async setThumbnailFromBuffer(channel, videoId, buffer, mimeType = 'image/jpeg') {
      try {
        if (!channel.blobs) {
          throw new Error('Channel blobs not initialized');
        }

        // Store thumbnail in Hyperblobs
        const blobResult = await channel.putBlob(buffer);
        console.log('[Upload] Thumbnail saved, blobId:', blobResult.id);

        // Update video metadata with thumbnail info using updateVideo method
        await channel.updateVideo(videoId, {
          thumbnailBlobId: blobResult.id,
          thumbnailBlobsCoreKey: channel.blobsKeyHex,
          thumbnailMimeType: mimeType
        });
        console.log('[Upload] Updated video metadata with thumbnail');

        return {
          success: true,
          thumbnailBlobId: blobResult.id
        };
      } catch (err) {
        console.error('[Upload] Set thumbnail failed:', err.message);
        return { success: false, error: err.message };
      }
    },

    /**
     * Delete a video from the channel
     * Note: In Hyperblobs, the actual blob data cannot be deleted (it's content-addressed),
     * but removing the metadata makes the blob unreferenced.
     *
     * @param {MultiWriterChannel} channel - Target channel
     * @param {string} videoId - Video ID to delete
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async deleteVideo(channel, videoId) {
      try {
        await channel.deleteVideo(videoId);
        console.log('[Upload] Deleted:', videoId);
        return { success: true };
      } catch (err) {
        console.error('[Upload] Delete failed:', err.message);
        return { success: false, error: err.message };
      }
    }
  };
}
