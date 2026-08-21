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
import { MEDIA_COORDINATE_SHAPES, normalizeContentDetails } from './channel/structured-content.js';
import {
  createImmutableRenditionWriter,
  createPublicationManifest,
  createRenditionDescriptor,
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
} from './publisher/canonical.js';
import {
  decodePublisherCatalogFrame,
  encodePublisherCatalogFrame,
} from './publisher/catalog-view.js';

const IMMUTABLE_PUBLICATION_OPERATION_COUNT = 3;
const IMMUTABLE_PUBLICATION_FRAME_VERSION = 1;
const IMMUTABLE_PUBLICATION_FRAME_HEADER_BYTES = 2;
const IMMUTABLE_PUBLICATION_FRAME_LENGTH_BYTES = 4;
const MAX_IMMUTABLE_PUBLICATION_FRAMES_BYTES =
  IMMUTABLE_PUBLICATION_FRAME_HEADER_BYTES +
  IMMUTABLE_PUBLICATION_OPERATION_COUNT *
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
    blobsCoreKey: channel.blobsKeyHex,
    availability: playbackSupport.availability,
    playbackSupport: playbackSupport.playbackSupport
  });
  return metadata;
}

function hashUploadFallback(metadata, blobResult, channel, fileSize) {
  return b4a.toString(crypto.hash(b4a.from(JSON.stringify({
    blobsCoreKey: channel.blobsKeyHex,
    blobId: blobResult.id,
    fileSize,
    fingerprint: metadata.contentFingerprint || null
  }))), 'hex');
}

// The poster's identity label, mirroring uploadTreeHash for video: a stable
// digest of what the publisher claims these bytes are, not a merkle root.
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

function uploadTreeHash(metadata, blobResult, channel, fileSize) {
  const fingerprint = typeof metadata.contentFingerprint === 'string' ? metadata.contentFingerprint : '';
  if (/^sha256:[0-9a-f]{64}$/i.test(fingerprint)) return fingerprint.slice(7).toLowerCase();
  return hashUploadFallback(metadata, blobResult, channel, fileSize);
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
  const pending = new Error(
    `Upload rollback is pending: ${rollbackError?.message || rollbackError || 'staged metadata could not be deleted'}`,
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

async function rollbackUploadedBlob(channel, blobResult) {
  if (!channel?.blobs || typeof channel.blobs.clear !== 'function') {
    throw new Error('Upload rollback is unavailable');
  }
  await channel.blobs.clear(blobResult);
}

function storedBlobResult(metadata) {
  const parts = String(metadata?.blobId || '').split(':').map(Number);
  if (parts.length !== 4 ||
      parts.some(value => !Number.isSafeInteger(value) || value < 0) ||
      parts[1] < 1 ||
      parts[3] < 1) {
    throw new Error('pending upload blob reference is invalid');
  }
  return {
    id: String(metadata.blobId),
    blockOffset: parts[0],
    blockLength: parts[1],
    byteOffset: parts[2],
    byteLength: parts[3]
  };
}

async function reconcilePendingUpload(channel, metadata) {
  if (typeof channel?.deleteVideo !== 'function') {
    throw stagedRollbackPendingError(null, new Error('staged metadata deletion is unavailable'));
  }
  if (metadata?.blobsCoreKey && metadata.blobsCoreKey !== channel.blobsKeyHex) {
    throw stagedRollbackPendingError(null, new Error('pending upload belongs to another blob core'));
  }
  let blobResult;
  try {
    blobResult = storedBlobResult(metadata);
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
  if (!Array.isArray(signedOperations) ||
      signedOperations.length !== IMMUTABLE_PUBLICATION_OPERATION_COUNT ||
      !Array.isArray(operationIds) ||
      operationIds.length !== IMMUTABLE_PUBLICATION_OPERATION_COUNT) {
    throw new Error('immutable publication operation batch must contain exactly three frames');
  }
  const expectedTypes = [
    PUBLISHER_RECORD_TYPES.PUBLICATION,
    PUBLISHER_RECORD_TYPES.CLAIM,
    PUBLISHER_RECORD_TYPES.CLAIM,
  ];
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
  encoded[1] = IMMUTABLE_PUBLICATION_OPERATION_COUNT;
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
  if (encoded.byteLength < IMMUTABLE_PUBLICATION_FRAME_HEADER_BYTES ||
      encoded[0] !== IMMUTABLE_PUBLICATION_FRAME_VERSION ||
      encoded[1] !== IMMUTABLE_PUBLICATION_OPERATION_COUNT) {
    throw new Error('uncertain upload operation frame header is invalid');
  }
  const expectedTypes = [
    PUBLISHER_RECORD_TYPES.PUBLICATION,
    PUBLISHER_RECORD_TYPES.CLAIM,
    PUBLISHER_RECORD_TYPES.CLAIM,
  ];
  const frames = new Array(IMMUTABLE_PUBLICATION_OPERATION_COUNT);
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
  if (!Array.isArray(operationIds) || operationIds.length !== 3 ||
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
  await runtime.mediaCatalogProjection?.rebuild?.();
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
  if (announcement?.status && announcement.status !== 'published') {
    throw new Error('publisher catalog was not announced');
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
    source: runtime.createSource?.(),
    signal: runtime.signal
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
  return { catalog, publisherId, renditionWrite };
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

async function writeStaticPlaybackBlob(channel, prepared, signal, onProgress) {
  if (!channel?.blobs || typeof channel.blobs.createWriteStream !== 'function') {
    throw new Error('Channel blob stream is unavailable');
  }
  const { core, descriptor } = prepared.renditionWrite;
  const writeStream = channel.blobs.createWriteStream();
  const completed = new Promise((resolve, reject) => {
    writeStream.once('error', reject);
    writeStream.once('close', () => {
      const id = writeStream.id;
      resolve({ id: `${id.blockOffset}:${id.blockLength}:${id.byteOffset}:${id.byteLength}`, ...id });
    });
  });
  try {
    let bytesWritten = 0;
    for (let index = 0; index < descriptor.core.length; index++) {
      assertUploadNotCancelled(signal);
      const block = await core.get(index);
      assertUploadNotCancelled(signal);
      if (!writeStream.write(block)) {
        await new Promise((resolve, reject) => {
          writeStream.once('drain', resolve);
          writeStream.once('error', reject);
        });
      }
      bytesWritten += block.byteLength;
      onProgress?.(
        Math.round((bytesWritten / descriptor.core.byteLength) * 100),
        bytesWritten,
        descriptor.core.byteLength,
        { speed: 0, eta: 0 }
      );
    }
    assertUploadNotCancelled(signal);
    writeStream.end();
    return await completed;
  } catch (error) {
    if (typeof writeStream.destroy === 'function') writeStream.destroy(error);
    else writeStream.end();
    await completed.catch(() => {});
    throw error;
  }
}

async function maybeAttachImmutablePublication(metadata, prepared, runtime = {}) {
  if (!prepared) return metadata;
  const { mediaCatalogProjection, scopedNetwork, deviceKeyPair } = runtime;
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
  const blockOffset = Number(blobResult.blockOffset || 0);
  const blockLength = Number(blobResult.blockLength || 1);
  if (!Number.isSafeInteger(blockOffset) || blockOffset < 0 || !Number.isSafeInteger(blockLength) || blockLength < 1) {
    throw new Error('Uploaded blob range is invalid');
  }
  const rendition = createRenditionDescriptor({
    purpose: 'original',
    format: String(mimeType || metadata.mimeType || 'video/mp4'),
    core: {
      key: channel.blobsKeyHex,
      length: blockOffset + blockLength,
      treeHash: uploadTreeHash(metadata, blobResult, channel, fileSize),
      byteLength: fileSize
    }
  });
  // Cover art is part of the publication, not a side channel: a relay that
  // seeds this movie holds the poster too, and a consumer fetches it over the
  // same authorized asset path as the video. Nothing has to leave the swarm.
  const posterRenditions = []
  const posterProvenance = []
  for (const entry of Array.isArray(metadata.artwork) ? metadata.artwork : []) {
    if (entry?.role !== 'poster') continue
    if (entry.blobsCoreKey !== channel.blobsKeyHex) continue
    const blob = parseBlobId(String(entry.blobId || ''))
    if (!blob) continue
    const posterRendition = createRenditionDescriptor({
      purpose: 'poster',
      format: String(entry.mimeType || 'image/jpeg'),
      core: {
        key: channel.blobsKeyHex,
        length: blob.blockOffset + blob.blockLength,
        treeHash: posterTreeHash(entry, blob),
        byteLength: blob.byteLength
      }
    })
    posterRenditions.push(posterRendition)
    posterProvenance.push({
      type: 'artwork',
      role: 'poster',
      videoId: metadata.id,
      blobId: String(entry.blobId),
      coreKey: channel.blobsKeyHex,
      renditionId: posterRendition.renditionId,
      start: blob.blockOffset,
      end: blob.blockOffset + blob.blockLength
    })
    break
  }
  const manifest = createPublicationManifest({
    publisherId,
    sequence: firstSequence,
    title: metadata.title || metadata.id,
    description: metadata.description || null,
    renditions: [rendition, ...posterRenditions],
    provenance: [{
      type: 'upload',
      videoId: metadata.id,
      blobId: blobResult.id,
      assetId: rendition.core.assetId,
      coreKey: channel.blobsKeyHex,
      renditionId: rendition.renditionId,
      start: blockOffset,
      end: blockOffset + blockLength
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
    ? `show:${providerId}:s${metadata.seasonNumber}:e${metadata.episodeNumber}`
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
        description: metadata.description || null,
        publicationId: manifest.publicationId,
        // A recording is not a film. Where the coordinate table names the kind,
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
    coreKey: rendition.core.key,
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
    publicationId: manifest.publicationId,
    manifestId: manifest.body.manifestId,
    renditionId: rendition.renditionId,
    assetId: rendition.core.assetId,
    coreKey: rendition.core.key,
    publisherId: manifest.body.publisherId,
    publicationSequence: firstSequence,
    metadataClaimId: claims[0].claimId,
    availabilityClaimId: claims[1].claimId,
    publicationOperationId: operationIds[0],
    metadataClaimOperationId: operationIds[1],
    availabilityClaimOperationId: operationIds[2],
    publicationManifestHex: b4a.toString(manifestPayload, 'hex'),
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
  // source reads as awaiting replication, and no cover ever arrives. Holding
  // its own publication is what makes a publisher a source for it, and the
  // runtime retains the cover published alongside it in the same step.
  try {
    await scopedNetwork?.retainAuthorizedRendition?.({
      manifest,
      renditionId: rendition.renditionId,
      entityRef: subjectRef.entityId,
      publicationId: manifest.publicationId
    });
  } catch (error) {
    // A publisher that cannot serve yet still published; the catalog entry is
    // committed and retention is retried by the runtime's own lifecycle.
    console.log('[Upload] Publication is not being served yet:', error?.message);
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
  mediaCatalogProjection = null,
  scopedNetwork = null,
  deviceKeyPair = null,
  now = () => Date.now()
}) {
  const publicationRuntime = { catalogRegistry, mediaCatalogProjection, scopedNetwork, deviceKeyPair, store: ctx?.store, now };
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

        prepared = await prepareImmutablePublication(metadata, {
          ...publicationRuntime,
          ...uploadControl,
          createSource: () => fs.createReadStream(filePath)
        });
        if (prepared) {
          fileSize = prepared.renditionWrite.descriptor.core.byteLength;
          const firstBlock = fileSize > 0 ? await prepared.renditionWrite.core.get(0) : b4a.alloc(0);
          mimeType = detectMimeType(firstBlock.subarray(0, Math.min(4100, firstBlock.byteLength))) ||
            metadata.mimeType ||
            'video/mp4';
          finalizePreparedRendition(prepared, mimeType);
          blobResult = await writeStaticPlaybackBlob(channel, prepared, uploadControl.signal, onProgress);
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

        console.log('[Upload] Complete:', videoId, 'blobId:', blobResult.id, 'blobsCore:', channel.blobsKeyHex?.slice(0, 16), 'keyLen:', channel.blobsKeyHex?.length);

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
        prepared = await prepareImmutablePublication(metadata, {
          ...publicationRuntime,
          ...uploadControl,
          createSource: () => [buffer]
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
          blobResult = await writeStaticPlaybackBlob(channel, prepared, uploadControl.signal, onProgress);
          await prepared.renditionWrite.core.close();
        } else {
          fileSize = buffer.length;
          const headerBuffer = buffer.subarray(0, Math.min(4100, fileSize));
          mimeType = detectMimeType(headerBuffer) || metadata.mimeType || 'video/mp4';
          blobResult = await channel.putBlob(buffer);
          onProgress?.(100, fileSize, fileSize);
        }

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

        console.log('[Upload] Complete:', videoId, 'blobId:', blobResult.id, 'blobsCore:', channel.blobsKeyHex?.slice(0, 16), 'keyLen:', channel.blobsKeyHex?.length);

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
