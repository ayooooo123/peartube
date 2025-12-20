/**
 * Video Upload Module
 *
 * Handles video uploads to Hyperblobs with progress tracking.
 * Works with both file paths (desktop) and buffers/streams (mobile).
 *
 * Architecture:
 * - Video bytes are stored in the channel's shared Hyperblobs instance
 * - Video metadata is stored in Autobase via channel.addVideo()
 * - Blob IDs (4 numbers: blockOffset, blockLength, byteOffset, byteLength) are stored in metadata
 */

import crypto from 'hypercore-crypto';
import b4a from 'b4a';

/**
 * Video file signatures (magic bytes) for MIME type detection
 * Based on file format specifications
 */
const VIDEO_SIGNATURES = [
  // MP4/M4V/MOV (ftyp box)
  { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70], mime: 'video/mp4' },
  // WebM/MKV (EBML header)
  { offset: 0, bytes: [0x1A, 0x45, 0xDF, 0xA3], mime: null }, // Need to check DocType
  // AVI (RIFF....AVI)
  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], mime: null }, // Need to check for AVI
  // FLV
  { offset: 0, bytes: [0x46, 0x4C, 0x56, 0x01], mime: 'video/x-flv' },
  // MPEG
  { offset: 0, bytes: [0x00, 0x00, 0x01, 0xBA], mime: 'video/mpeg' },
  { offset: 0, bytes: [0x00, 0x00, 0x01, 0xB3], mime: 'video/mpeg' },
  // Ogg
  { offset: 0, bytes: [0x4F, 0x67, 0x67, 0x53], mime: 'video/ogg' },
  // 3GP
  { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x33, 0x67, 0x70], mime: 'video/3gpp' },
];

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

/**
 * @typedef {Object} UploadOptions
 * @property {string} title - Video title
 * @property {string} [description] - Video description
 * @property {string} [mimeType] - MIME type (defaults to video/mp4)
 * @property {number} [duration] - Video duration in seconds
 * @property {string} [thumbnail] - Thumbnail blob ID
 * @property {string} [category] - Video category
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
export function createUploadManager({ ctx }) {
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
      const { title, description = '', mimeType: providedMimeType, duration, thumbnail, category = '' } = options;

      try {
        if (!channel.blobs) {
          throw new Error('Channel blobs not initialized');
        }

        const videoId = b4a.toString(crypto.randomBytes(16), 'hex');

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
        const mimeType = detectedMimeType || providedMimeType || 'video/mp4';

        console.log(`[Upload] Starting: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

        const startTime = Date.now();
        let bytesWritten = 0;
        let lastProgressUpdate = Date.now();

        // Use streaming upload for large files
        const blobResult = await new Promise((resolve, reject) => {
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

        // Create video metadata and store in Autobase
        // Ensure all string fields are actually strings to pass validation
        const metadata = {
          id: videoId,
          title: String(title || ''),
          description: String(description || ''),
          mimeType: String(mimeType || 'video/mp4'),
          size: fileSize,
          uploadedAt: Date.now(),
          uploadedBy: channel.localWriterKeyHex,
          blobId: blobResult.id,
          blobsCoreKey: channel.blobsKeyHex, // Which device's blobs core has this video
          duration,
          thumbnail,
          category: String(category || '')
        };

        // Store metadata in Autobase
        await channel.addVideo(metadata);

        console.log('[Upload] Complete:', videoId, 'blobId:', blobResult.id, 'blobsCore:', channel.blobsKeyHex?.slice(0, 16), 'keyLen:', channel.blobsKeyHex?.length);

        return {
          success: true,
          videoId,
          metadata
        };
      } catch (err) {
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
      const { title, description = '', mimeType: providedMimeType, duration, thumbnail, category = '' } = options;

      try {
        if (!channel.blobs) {
          throw new Error('Channel blobs not initialized');
        }

        const videoId = b4a.toString(crypto.randomBytes(16), 'hex');
        const fileSize = buffer.length;

        // Detect MIME type from buffer magic bytes
        const headerBuffer = buffer.subarray(0, Math.min(4100, fileSize));
        const detectedMimeType = detectMimeType(headerBuffer);
        const mimeType = detectedMimeType || providedMimeType || 'video/mp4';

        console.log(`[Upload] Starting buffer upload (${(fileSize / 1024 / 1024).toFixed(2)} MB), MIME: ${mimeType}`);

        // Store video bytes in Hyperblobs
        const blobResult = await channel.putBlob(buffer);

        if (onProgress) {
          onProgress(100, fileSize, fileSize);
        }

        // Create video metadata and store in Autobase
        // Ensure all string fields are actually strings to pass validation
        const metadata = {
          id: videoId,
          title: String(title || ''),
          description: String(description || ''),
          mimeType: String(mimeType || 'video/mp4'),
          size: fileSize,
          uploadedAt: Date.now(),
          uploadedBy: channel.localWriterKeyHex,
          blobId: blobResult.id,
          blobsCoreKey: channel.blobsKeyHex, // Which device's blobs core has this video
          duration,
          thumbnail,
          category: String(category || '')
        };

        // Store metadata in Autobase
        await channel.addVideo(metadata);

        console.log('[Upload] Complete:', videoId, 'blobId:', blobResult.id, 'blobsCore:', channel.blobsKeyHex?.slice(0, 16), 'keyLen:', channel.blobsKeyHex?.length);

        return {
          success: true,
          videoId,
          metadata
        };
      } catch (err) {
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
          thumbnailBlobsCoreKey: channel.blobsKeyHex
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
