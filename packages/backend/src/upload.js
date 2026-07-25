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

import { probeMp4File, probeMp4Buffer, isMp4MimeType } from './mp4-playback-probe.js';
import { saveBlobPlaybackProfile } from './blob-playback-profile.js';
import { normalizeContentDetails } from './channel/structured-content.js';
import {
  createPublicationManifest,
  createRenditionDescriptor,
  encodePublicationManifest,
} from './assets/index.js';
import {
  createEntityReference,
  createMediaClaim,
  encodeMediaClaimEnvelope,
} from './media-graph/index.js';
import { PUBLISHER_RECORD_TYPES } from './publisher/canonical.js';

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
 * Get file extension for a MIME type
 * @param {string} mimeType - MIME type
 * @returns {string} File extension without dot
 */
export function getPlaybackSupportForMimeType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'video/mp4' || normalized === 'video/webm') {
    return { availability: 'playable', playbackSupport: 'direct' };
  }
  return { availability: 'playable', playbackSupport: 'unverified-container' };
}

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

async function catalogOperationsAreAbsent(catalog, operations) {
  if (typeof catalog?.getOperationReceipt !== 'function') return false;
  try {
    const receipts = await Promise.all(operations.map(operation => {
      const operationId = operation?.recordId || operation?.transitionId;
      if (!operationId) throw new Error('operation id unavailable');
      return catalog.getOperationReceipt(operationId);
    }));
    return receipts.every(receipt => receipt?.accepted !== true);
  } catch {
    return false;
  }
}

async function appendImmutablePublication(catalog, signedOperations) {
  let receipts;
  try {
    receipts = await catalog.appendBatchAndConfirm(signedOperations);
  } catch (error) {
    if (!await catalogOperationsAreAbsent(catalog, signedOperations)) {
      throw markUploadCommitState(error, 'uploadCommitUncertain');
    }
    throw error;
  }
  if (!Array.isArray(receipts) || receipts.length !== signedOperations.length ||
      receipts.some(receipt => receipt?.accepted !== true)) {
    const error = new Error('Publisher catalog rejected upload projection');
    if (receipts?.some?.(receipt => receipt?.accepted === true)) {
      throw markUploadCommitState(error, 'uploadCommitUncertain');
    }
    throw error;
  }
  return receipts;
}

async function rollbackUploadedBlob(channel, blobResult) {
  if (!channel?.blobs || typeof channel.blobs.clear !== 'function') {
    throw new Error('Upload rollback is unavailable');
  }
  await channel.blobs.clear(blobResult);
}


async function maybeAttachImmutablePublication(metadata, blobResult, channel, fileSize, mimeType, runtime = {}) {
  const { catalogRegistry, mediaCatalogProjection, scopedNetwork, deviceKeyPair } = runtime;
  if (!catalogRegistry || !deviceKeyPair?.publicKey || !deviceKeyPair?.secretKey) return metadata;
  const currentTime = runtime.now();
  const requestedPublisherId = runtime.publisherId;
  const bindings = requestedPublisherId
    ? [await catalogRegistry.resolve(requestedPublisherId)]
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
  return serializeCatalogWrite(catalog, async () => {
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
  const manifest = createPublicationManifest({
    publisherId,
    sequence: firstSequence,
    title: metadata.title || metadata.id,
    description: metadata.description || null,
    renditions: [rendition],
    provenance: [{
      type: 'upload',
      videoId: metadata.id,
      blobId: blobResult.id,
      coreKey: channel.blobsKeyHex,
      renditionId: rendition.renditionId,
      start: blockOffset,
      end: blockOffset + blockLength
    }],
    keyPair: deviceKeyPair,
    signedAt: currentTime
  });
  const subjectRef = createEntityReference({
    entityKind: 'work',
    namespace: 'issuer-native',
    issuerRootKey: publisherId,
    issuerLocalId: metadata.id
  });
  const claims = [
    createMediaClaim({
      claimType: 'EntityMetadataClaim',
      subjectRefs: [subjectRef],
      payload: {
        title: metadata.title || metadata.id,
        description: metadata.description || null,
        publicationId: manifest.publicationId
      },
      confidence: 1000,
      issuerSequence: firstSequence + 1,
      policyEpoch: writer.admissionPolicyEpoch,
      keyPair: deviceKeyPair,
      signedAt: currentTime
    }),
    createMediaClaim({
      claimType: 'AvailabilityObservation',
      subjectRefs: [subjectRef],
      payload: {
        publicationId: manifest.publicationId,
        renditionId: rendition.renditionId,
        availabilityStatus: 'available'
      },
      confidence: 1000,
      issuerSequence: firstSequence + 2,
      policyEpoch: writer.admissionPolicyEpoch,
      keyPair: deviceKeyPair,
      signedAt: currentTime
    })
  ];
  const operations = [{
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    sequence: firstSequence,
    body: {
      publicationId: b4a.from(manifest.publicationId, 'hex'),
      manifestId: b4a.from(manifest.body.manifestId, 'hex'),
      payload: encodePublicationManifest(manifest)
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
  const signedOperations = []
  for (const candidate of operations) {
    signedOperations.push(await catalog.createLocalOperation({
      ...candidate,
      policyEpoch: writer.admissionPolicyEpoch,
      signedAt: currentTime
    }))
  }
  await appendImmutablePublication(catalog, signedOperations)
  metadata.immutablePublication = {
    publicationId: manifest.publicationId,
    manifestId: manifest.body.manifestId,
    renditionId: rendition.renditionId,
    publisherId: manifest.body.publisherId,
    sequence: firstSequence,
    claimIds: claims.map(claim => claim.claimId),
    manifest
  };
  try {
    await mediaCatalogProjection?.rebuild?.();
    await scopedNetwork?.publishLocalPublisherCatalog?.({ publisherId });
  } catch (error) {
    throw markUploadCommitState(error, 'uploadCommitSucceeded');
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
 * @property {number} [originalAirDate] - Original air date timestamp
 * @property {string} [provenanceVersion] - Metadata resolver version
 * @property {string} [publicationState] - Private/public publication state
 * @property {string} [contentFingerprint] - Stable content fingerprint
 * @property {string} [importIdentityKey] - Normalized import identity
 * @property {string} [importClaimantId] - Import claim contender ID
 */

/**
 * @typedef {Object} UploadResult
 * @property {boolean} success - Whether upload succeeded
 * @property {string} [videoId] - Generated video ID
 * @property {VideoMetadata} [metadata] - Video metadata
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
  const publicationRuntime = { catalogRegistry, mediaCatalogProjection, scopedNetwork, deviceKeyPair, now };
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
          if (existing) {
            return { success: true, videoId: providedVideoId, metadata: existing, reused: true }
          }
        }
        const videoId = providedVideoId || b4a.toString(crypto.randomBytes(16), 'hex');
        const metadata = normalizeVideoMetadata(options, videoId);

        // Get file size
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;

        // Detect MIME type from file magic bytes (first 4KB is enough)
        // Use chunked read to avoid issues with large files in bare runtime
        const headerSize = Math.min(4100, fileSize);
        let headerBuffer;

        if (fs.createReadStream) {
          // Use streaming for header detection
          headerBuffer = await new Promise((resolve, reject) => {
            const chunks = [];
            let bytesRead = 0;
            const stream = fs.createReadStream(filePath, { start: 0, end: headerSize - 1 });
            stream.on('data', chunk => {
              chunks.push(chunk);
              bytesRead += chunk.length;
            });
            stream.on('end', () => resolve(b4a.concat(chunks)));
            stream.on('error', reject);
          });
        } else {
          // Fallback for environments without createReadStream
          const fd = fs.openSync(filePath, 'r');
          headerBuffer = b4a.alloc(headerSize);
          fs.readSync(fd, headerBuffer, 0, headerSize, 0);
          fs.closeSync(fd);
        }

        const detectedMimeType = detectMimeType(headerBuffer);
        const mimeType = detectedMimeType || metadata.mimeType || 'video/mp4';

        console.log(`[Upload] Starting: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

        const startTime = Date.now();
        let bytesWritten = 0;
        let lastProgressUpdate = Date.now();

        // Use streaming upload for large files
        blobResult = await new Promise((resolve, reject) => {
          const writeStream = channel.blobs.createWriteStream();
          const readStream = fs.createReadStream(filePath);

          readStream.on('data', (chunk) => {
            bytesWritten += chunk.length;
            const now = Date.now();
            // Update progress every 500ms to avoid flooding
            if (onProgress && (now - lastProgressUpdate > 500 || bytesWritten === fileSize)) {
              const progress = Math.round((bytesWritten / fileSize) * 100);
              const elapsed = (now - startTime) / 1000;
              const speed = elapsed > 0 ? bytesWritten / elapsed : 0;
              const remaining = fileSize - bytesWritten;
              const eta = speed > 0 ? remaining / speed : 0;
              onProgress(progress, bytesWritten, fileSize, { speed, eta });
              lastProgressUpdate = now;
            }
          });

          readStream.on('error', reject);
          writeStream.on('error', reject);
          writeStream.on('close', () => {
            // Format blob ID as string like putBlob does
            const id = writeStream.id;
            const idStr = `${id.blockOffset}:${id.blockLength}:${id.byteOffset}:${id.byteLength}`;
            resolve({ id: idStr, ...id });
          });

          readStream.pipe(writeStream);
        });

        if (onProgress) {
          onProgress(100, fileSize, fileSize, { speed: 0, eta: 0 });
        }

        const totalTime = (Date.now() - startTime) / 1000;
        const avgSpeed = fileSize / totalTime;
        console.log(`[Upload] Transfer complete in ${totalTime.toFixed(1)}s (avg ${(avgSpeed / 1024 / 1024).toFixed(2)} MB/s)`);


        // Complete the validated metadata with generated upload values
        buildVideoMetadata(
          metadata,
          blobResult,
          channel,
          fileSize,
          mimeType
        );
        await maybeAttachImmutablePublication(metadata, blobResult, channel, fileSize, mimeType, {
          ...publicationRuntime,
          publisherId: options.publisherId
        });
        immutableCommitConfirmed = Boolean(metadata.immutablePublication);
        await persistPlaybackProfile(channel, blobResult.id, mimeType, () => probeMp4File(fs, filePath, { fileSize }));

        // Store metadata in channel HyperDB
        await channel.addVideo(metadata, {
          syncPublic: metadata.publicationState !== 'replicationPending'
        });

        console.log('[Upload] Complete:', videoId, 'blobId:', blobResult.id, 'blobsCore:', channel.blobsKeyHex?.slice(0, 16), 'keyLen:', channel.blobsKeyHex?.length);

        return {
          success: true,
          videoId,
          metadata
        };
      } catch (err) {
        if (blobResult && !immutableCommitConfirmed &&
            err?.uploadCommitSucceeded !== true && err?.uploadCommitUncertain !== true) {
          try {
            await rollbackUploadedBlob(channel, blobResult);
          } catch {
            err = new Error('Upload failed and rollback could not be completed');
          }
        }
        console.error('[Upload] Failed:', err.message);
        return {
          success: false,
          error: err.message
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

      try {
        if (!channel.blobs) {
          throw new Error('Channel blobs not initialized');
        }

        const videoId = b4a.toString(crypto.randomBytes(16), 'hex');
        const metadata = normalizeVideoMetadata(options, videoId);
        const fileSize = buffer.length;

        // Detect MIME type from buffer magic bytes
        const headerBuffer = buffer.subarray(0, Math.min(4100, fileSize));
        const detectedMimeType = detectMimeType(headerBuffer);
        const mimeType = detectedMimeType || metadata.mimeType || 'video/mp4';

        console.log(`[Upload] Starting buffer upload (${(fileSize / 1024 / 1024).toFixed(2)} MB), MIME: ${mimeType}`);

        // Store video bytes in Hyperblobs
        blobResult = await channel.putBlob(buffer);

        if (onProgress) {
          onProgress(100, fileSize, fileSize);
        }


        // Complete the validated metadata with generated upload values
        buildVideoMetadata(
          metadata,
          blobResult,
          channel,
          fileSize,
          mimeType
        );
        await maybeAttachImmutablePublication(metadata, blobResult, channel, fileSize, mimeType, {
          ...publicationRuntime,
          publisherId: options.publisherId
        });
        immutableCommitConfirmed = Boolean(metadata.immutablePublication);
        await persistPlaybackProfile(channel, blobResult.id, mimeType, () => probeMp4Buffer(buffer));

        // Store metadata in channel HyperDB
        await channel.addVideo(metadata, {
          syncPublic: metadata.publicationState !== 'replicationPending'
        });

        console.log('[Upload] Complete:', videoId, 'blobId:', blobResult.id, 'blobsCore:', channel.blobsKeyHex?.slice(0, 16), 'keyLen:', channel.blobsKeyHex?.length);

        return {
          success: true,
          videoId,
          metadata
        };
      } catch (err) {
        if (blobResult && !immutableCommitConfirmed &&
            err?.uploadCommitSucceeded !== true && err?.uploadCommitUncertain !== true) {
          try {
            await rollbackUploadedBlob(channel, blobResult);
          } catch {
            err = new Error('Upload failed and rollback could not be completed');
          }
        }
        console.error('[Upload] Failed:', err.message);
        return {
          success: false,
          error: err.message
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
