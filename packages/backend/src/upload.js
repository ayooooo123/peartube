/**
 * Video Upload Module
 *
 * Handles video uploads to Hyperdrive with progress tracking.
 * Works with both file paths (desktop) and buffers/streams (mobile).
 */

import crypto from 'hypercore-crypto';
import b4a from 'b4a';

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
      const { title, description = '', mimeType = 'video/mp4', duration, thumbnail } = options;

      try {
        const videoId = b4a.toString(crypto.randomBytes(16), 'hex');
        const ext = mimeType.includes('webm') ? 'webm' : 'mp4';
        const videoPath = `/videos/${videoId}.${ext}`;
        const metaPath = `/videos/${videoId}.json`;

        // Get file size
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;

        console.log(`[Upload] Starting: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

        // Stream file to hyperdrive
        const readStream = fs.createReadStream(filePath);
        const writeStream = drive.createWriteStream(videoPath);

        let bytesWritten = 0;
        let lastProgressUpdate = 0;

        await new Promise((resolve, reject) => {
          writeStream.on('close', resolve);
          writeStream.on('error', reject);
          readStream.on('error', reject);

          readStream.on('data', (chunk) => {
            bytesWritten += chunk.length;
            const now = Date.now();

            // Throttle progress updates to every 100ms
            if (onProgress && (now - lastProgressUpdate > 100 || bytesWritten === fileSize)) {
              const progress = Math.round((bytesWritten / fileSize) * 100);
              onProgress(progress, bytesWritten, fileSize);
              lastProgressUpdate = now;
            }
          });

          readStream.pipe(writeStream);
        });

        // Create video metadata
        const metadata = {
          id: videoId,
          title,
          description,
          path: videoPath,
          mimeType,
          size: fileSize,
          uploadedAt: Date.now(),
          channelKey: b4a.toString(drive.key, 'hex'),
          duration,
          thumbnail
        };

        await drive.put(metaPath, Buffer.from(JSON.stringify(metadata)));

        console.log('[Upload] Complete:', videoId);

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
      const { title, description = '', mimeType = 'video/mp4', duration, thumbnail } = options;

      try {
        const videoId = b4a.toString(crypto.randomBytes(16), 'hex');
        const ext = mimeType.includes('webm') ? 'webm' : 'mp4';
        const videoPath = `/videos/${videoId}.${ext}`;
        const metaPath = `/videos/${videoId}.json`;

        const fileSize = buffer.length;
        console.log(`[Upload] Starting buffer upload (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

        // Write buffer to hyperdrive
        await drive.put(videoPath, buffer);

        if (onProgress) {
          onProgress(100, fileSize, fileSize);
        }

        // Create video metadata
        const metadata = {
          id: videoId,
          title,
          description,
          path: videoPath,
          mimeType,
          size: fileSize,
          uploadedAt: Date.now(),
          channelKey: b4a.toString(drive.key, 'hex'),
          duration,
          thumbnail
        };

        await drive.put(metaPath, Buffer.from(JSON.stringify(metadata)));

        console.log('[Upload] Complete:', videoId);

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
      const ext = mimeType.includes('webm') ? 'webm' : 'mp4';
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
        const ext = mimeType.includes('png') ? 'png' : 'jpg';
        const thumbnailPath = `/thumbnails/${videoId}.${ext}`;

        await drive.put(thumbnailPath, buffer);

        console.log('[Upload] Thumbnail saved:', thumbnailPath);

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
