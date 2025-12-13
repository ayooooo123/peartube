/**
 * Video Upload Module
 *
 * Handles video uploads to Hyperdrive with progress tracking.
 * Works with both file paths (desktop) and buffers/streams (mobile).
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
 * @typedef {import('./types.js').StorageContext} StorageContext
 * @typedef {import('./types.js').VideoMetadata} VideoMetadata
 */

/**
 * @typedef {Object} UploadOptions
 * @property {string} title - Video title
 * @property {string} [description] - Video description
 * @property {string} [mimeType] - MIME type (defaults to video/mp4)
 * @property {number} [duration] - Video duration in seconds
 * @property {string} [thumbnail] - Thumbnail path in drive
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
     * @param {import('hyperdrive')} drive - Target Hyperdrive
     * @param {string} filePath - Path to video file
     * @param {UploadOptions} options - Upload options
     * @param {Object} fs - File system module (bare-fs or node fs)
     * @param {ProgressCallback} [onProgress] - Progress callback
     * @returns {Promise<UploadResult>}
     */
    async uploadFromPath(drive, filePath, options, fs, onProgress) {
      const { title, description = '', mimeType: providedMimeType, duration, thumbnail, category = '' } = options;

      try {
        const videoId = b4a.toString(crypto.randomBytes(16), 'hex');

        // Get file size
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;

        // Detect MIME type from file magic bytes (first 4KB is enough)
        const headerSize = Math.min(4100, fileSize);
        const fd = fs.openSync(filePath, 'r');
        const headerBuffer = b4a.alloc(headerSize);
        fs.readSync(fd, headerBuffer, 0, headerSize, 0);
        fs.closeSync(fd);

        const detectedMimeType = detectMimeType(headerBuffer);
        const mimeType = detectedMimeType || providedMimeType || 'video/mp4';
        const ext = getExtensionForMime(mimeType);

        const videoPath = `/videos/${videoId}.${ext}`;
        const metaPath = `/videos/${videoId}.json`;

        console.log(`[Upload] Starting: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

        // Stream file to hyperdrive with larger buffer for network drives
        // Higher highWaterMark helps with slow network sources by buffering more data
        const readStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }); // 1MB buffer
        const writeStream = drive.createWriteStream(videoPath);

        let bytesWritten = 0;
        let lastProgressUpdate = 0;
        const startTime = Date.now();
        let lastBytes = 0;
        let lastSpeedCheck = startTime;
        let currentSpeed = 0;

        await new Promise((resolve, reject) => {
          writeStream.on('close', resolve);
          writeStream.on('error', reject);
          readStream.on('error', reject);

          readStream.on('data', (chunk) => {
            bytesWritten += chunk.length;
            const now = Date.now();

            // Calculate speed every 500ms for smoother estimates
            const timeSinceLastSpeed = now - lastSpeedCheck;
            if (timeSinceLastSpeed >= 500) {
              const bytesSinceLastSpeed = bytesWritten - lastBytes;
              currentSpeed = (bytesSinceLastSpeed / timeSinceLastSpeed) * 1000; // bytes/sec
              lastBytes = bytesWritten;
              lastSpeedCheck = now;
            }

            // Throttle progress updates to every 100ms
            if (onProgress && (now - lastProgressUpdate > 100 || bytesWritten === fileSize)) {
              const progress = Math.round((bytesWritten / fileSize) * 100);
              const remainingBytes = fileSize - bytesWritten;
              const eta = currentSpeed > 0 ? Math.round(remainingBytes / currentSpeed) : 0;

              onProgress(progress, bytesWritten, fileSize, {
                speed: currentSpeed,
                eta: eta
              });
              lastProgressUpdate = now;
            }
          });

          readStream.pipe(writeStream);
        });

        const totalTime = (Date.now() - startTime) / 1000;
        const avgSpeed = fileSize / totalTime;
        console.log(`[Upload] Transfer complete in ${totalTime.toFixed(1)}s (avg ${(avgSpeed / 1024 / 1024).toFixed(2)} MB/s)`);

        // Create video metadata with detected MIME type
        const metadata = {
          id: videoId,
          title,
          description,
          path: videoPath,
          mimeType,  // Detected from magic bytes
          size: fileSize,
          uploadedAt: Date.now(),
          channelKey: b4a.toString(drive.key, 'hex'),
          duration,
          thumbnail,
          category
        };

        await drive.put(metaPath, Buffer.from(JSON.stringify(metadata)));

        console.log('[Upload] Complete:', videoId, 'MIME:', mimeType);

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
     * @param {import('hyperdrive')} drive - Target Hyperdrive
     * @param {Buffer} buffer - Video data buffer
     * @param {UploadOptions} options - Upload options
     * @param {ProgressCallback} [onProgress] - Progress callback
     * @returns {Promise<UploadResult>}
     */
    async uploadFromBuffer(drive, buffer, options, onProgress) {
      const { title, description = '', mimeType: providedMimeType, duration, thumbnail, category = '' } = options;

      try {
        const videoId = b4a.toString(crypto.randomBytes(16), 'hex');
        const fileSize = buffer.length;

        // Detect MIME type from buffer magic bytes
        const headerBuffer = buffer.subarray(0, Math.min(4100, fileSize));
        const detectedMimeType = detectMimeType(headerBuffer);
        const mimeType = detectedMimeType || providedMimeType || 'video/mp4';
        const ext = getExtensionForMime(mimeType);

        const videoPath = `/videos/${videoId}.${ext}`;
        const metaPath = `/videos/${videoId}.json`;

        console.log(`[Upload] Starting buffer upload (${(fileSize / 1024 / 1024).toFixed(2)} MB), MIME: ${mimeType}`);

        // Write buffer to hyperdrive
        await drive.put(videoPath, buffer);

        if (onProgress) {
          onProgress(100, fileSize, fileSize);
        }

        // Create video metadata with detected MIME type
        const metadata = {
          id: videoId,
          title,
          description,
          path: videoPath,
          mimeType,  // Detected from magic bytes
          size: fileSize,
          uploadedAt: Date.now(),
          channelKey: b4a.toString(drive.key, 'hex'),
          duration,
          thumbnail,
          category
        };

        await drive.put(metaPath, Buffer.from(JSON.stringify(metadata)));

        console.log('[Upload] Complete:', videoId, 'MIME:', mimeType);

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
     * Upload video using streaming writes (for large files)
     *
     * @param {import('hyperdrive')} drive - Target Hyperdrive
     * @param {UploadOptions} options - Upload options
     * @param {number} totalSize - Expected total size in bytes
     * @returns {{writeStream: any, videoId: string, videoPath: string, finalize: () => Promise<UploadResult>}}
     */
    createUploadStream(drive, options, totalSize) {
      const { title, description = '', mimeType = 'video/mp4', duration, thumbnail } = options;

      const videoId = b4a.toString(crypto.randomBytes(16), 'hex');
      // Preserve original format extension for proper codec handling
      const ext = mimeType.includes('webm') ? 'webm' :
                  mimeType.includes('matroska') ? 'mkv' :
                  mimeType.includes('quicktime') ? 'mov' :
                  mimeType.includes('x-msvideo') ? 'avi' : 'mp4';
      const videoPath = `/videos/${videoId}.${ext}`;
      const metaPath = `/videos/${videoId}.json`;

      const writeStream = drive.createWriteStream(videoPath);

      const finalize = async () => {
        try {
          // Create video metadata
          const metadata = {
            id: videoId,
            title,
            description,
            path: videoPath,
            mimeType,
            size: totalSize,
            uploadedAt: Date.now(),
            channelKey: b4a.toString(drive.key, 'hex'),
            duration,
            thumbnail
          };

          await drive.put(metaPath, Buffer.from(JSON.stringify(metadata)));

          console.log('[Upload] Finalized:', videoId);

          return {
            success: true,
            videoId,
            metadata
          };
        } catch (err) {
          console.error('[Upload] Finalize failed:', err.message);
          return {
            success: false,
            error: err.message
          };
        }
      };

      return {
        writeStream,
        videoId,
        videoPath,
        finalize
      };
    },

    /**
     * Set video thumbnail from a buffer
     *
     * @param {import('hyperdrive')} drive - Target Hyperdrive
     * @param {string} videoId - Video ID
     * @param {Buffer} buffer - Image data buffer
     * @param {string} [mimeType='image/jpeg'] - Image MIME type
     * @returns {Promise<{success: boolean, thumbnailUrl?: string, path?: string, error?: string}>}
     */
    async setThumbnailFromBuffer(drive, videoId, buffer, mimeType = 'image/jpeg') {
      try {
        const ext = mimeType.includes('png') ? 'png' :
                    mimeType.includes('webp') ? 'webp' :
                    mimeType.includes('gif') ? 'gif' : 'jpg';
        const thumbnailPath = `/thumbnails/${videoId}.${ext}`;

        // Write via createWriteStream to ensure a blob entry (avoids inline values that break URL resolution)
        await new Promise((resolve, reject) => {
          const ws = drive.createWriteStream(thumbnailPath);
          ws.on('error', reject);
          ws.on('close', resolve);
          ws.end(buffer);
        });
        console.log('[Upload] Thumbnail saved:', thumbnailPath);

        // Update video metadata with thumbnail path
        const metaPath = `/videos/${videoId}.json`;
        const metaBuf = await drive.get(metaPath);
        if (metaBuf) {
          const meta = JSON.parse(b4a.toString(metaBuf, 'utf-8'));
          meta.thumbnail = thumbnailPath;
          await drive.put(metaPath, Buffer.from(JSON.stringify(meta)));
          console.log('[Upload] Updated video metadata with thumbnail:', thumbnailPath);
        }

        // Flush drive to persist to disk
        try {
          if (drive.flush) {
            await drive.flush();
            console.log('[Upload] Drive flushed after thumbnail save');
          }
        } catch (flushErr) {
          console.log('[Upload] Drive flush warning:', flushErr.message);
        }

        return {
          success: true,
          path: thumbnailPath
        };
      } catch (err) {
        console.error('[Upload] Set thumbnail failed:', err.message);
        return { success: false, error: err.message };
      }
    },

    /**
     * Delete a video from the drive
     *
     * @param {import('hyperdrive')} drive - Target Hyperdrive
     * @param {string} videoId - Video ID to delete
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async deleteVideo(drive, videoId) {
      try {
        // Find the video metadata to get the path
        const metaPath = `/videos/${videoId}.json`;
        const metaBuf = await drive.get(metaPath);

        if (!metaBuf) {
          return { success: false, error: 'Video not found' };
        }

        const metadata = JSON.parse(b4a.toString(metaBuf));

        // Delete video file and metadata
        await drive.del(metadata.path);
        await drive.del(metaPath);

        // Delete thumbnail if exists
        if (metadata.thumbnail) {
          try {
            await drive.del(metadata.thumbnail);
          } catch (e) {
            // Thumbnail may not exist
          }
        }

        console.log('[Upload] Deleted:', videoId);

        return { success: true };
      } catch (err) {
        console.error('[Upload] Delete failed:', err.message);
        return { success: false, error: err.message };
      }
    }
  };
}
