/**
 * PearTube Desktop Worker - Thin HRPC Handler Layer
 *
 * This worker uses createBackendContext from @peartube/backend to initialize
 * all P2P components, then registers thin HRPC handlers that delegate to the API.
 *
 * Desktop-specific features (file pickers, FFmpeg) are implemented here.
 */

import fs from 'bare-fs';
import path from 'bare-path';
import os from 'bare-os';
import env from 'bare-env';
import pipe from 'pear-pipe';
import { spawn } from 'bare-subprocess';
import b4a from 'b4a';

// bare-ffmpeg for fast native transcoding
let ffmpeg: any = null;
try {
  ffmpeg = require('bare-ffmpeg');
  console.log('[Worker] bare-ffmpeg loaded');
} catch (err: any) {
  console.warn('[Worker] bare-ffmpeg not available:', err?.message);
}

// Import the orchestrator from backend
// @ts-ignore - backend-core is JavaScript
import { createBackendContext } from '@peartube/backend/orchestrator';
// @ts-ignore - Generated HRPC code
import HRPC from '@peartube/spec';

// Get Pear runtime globals
declare const Pear: any;

console.log('[Worker] PearTube Desktop Worker starting...');

// ============================================
// Initialize Backend using Orchestrator
// ============================================

// Determine storage path - prefer explicit --store, fall back to home directory
let storage: string;
if (Pear.config.storage) {
  storage = Pear.config.storage;
  console.log('[Worker] Using --store storage path:', storage);
} else {
  // Without --store, use a more stable path based on home directory
  // Pear.config.storage being null means ephemeral storage which can cause issues
  const homeDir = os.homedir();
  storage = path.join(homeDir, '.peartube');
  console.log('[Worker] No --store flag, using fallback storage:', storage);
  console.log('[Worker] For persistent storage, run with: pear run --store ~/.peartube --dev .');
}

console.log('[Worker] Pear.config:', JSON.stringify({
  storage: Pear.config.storage,
  key: Pear.config.key ? 'present' : 'null',
  dev: Pear.config.dev
}, null, 2));

const backend = await createBackendContext({
  storagePath: storage,
  onFeedUpdate: () => {
    // Feed updates will be wired after HRPC init
  },
  onStatsUpdate: (driveKey: string, videoPath: string, stats: any) => {
    // Stats updates will be wired after HRPC init
  }
});

const { ctx, api, identityManager, uploadManager, publicFeed, seedingManager, videoStats } = backend;

console.log('[Worker] Backend initialized via orchestrator');
// Use dynamic port from blobServer object (more reliable than captured value)
const getBlobPort = () => (ctx.blobServer as any)?.port || ctx.blobServerPort || 0;
console.log('[Worker] Blob server port:', getBlobPort());


// ============================================
// Desktop-Specific Functions (File Pickers, FFmpeg)
// ============================================

// Helper to get mime type from extension
function getMimeType(ext: string): string {
  const types: Record<string, string> = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'webp': 'image/webp',
    'gif': 'image/gif',
  };
  return types[ext.toLowerCase()] || 'image/jpeg';
}

// Helper to get video mime type from file path
function getMimeTypeFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const videoTypes: Record<string, string> = {
    'mp4': 'video/mp4',
    'm4v': 'video/mp4',
    'webm': 'video/webm',
    'mkv': 'video/x-matroska',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
  };
  return videoTypes[ext] || 'video/mp4';
}

// FFmpeg availability check (cached)
let ffmpegAvailable: boolean | null = null;

async function checkFFmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;

  return new Promise((resolve) => {
    try {
      const proc = spawn('ffmpeg', ['-version']);
      proc.on('exit', (code: number) => {
        ffmpegAvailable = code === 0;
        console.log('[FFmpeg] Available:', ffmpegAvailable);
        resolve(ffmpegAvailable);
      });
      proc.on('error', () => {
        ffmpegAvailable = false;
        resolve(false);
      });
    } catch {
      ffmpegAvailable = false;
      resolve(false);
    }
  });
}

// Generate thumbnail from video file using FFmpeg
async function generateThumbnail(filePath: string, videoId: string, drive: any): Promise<string | null> {
  const thumbnailPath = `/thumbnails/${videoId}.jpg`;

  const args = [
    '-ss', '1',
    '-i', filePath,
    '-vframes', '1',
    '-vf', 'scale=640:-1',
    '-q:v', '2',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    'pipe:1'
  ];

  return new Promise((resolve) => {
    try {
      const proc = spawn('ffmpeg', args);
      const chunks: Buffer[] = [];

      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on('data', () => {}); // Ignore ffmpeg progress

      proc.on('exit', async (code: number) => {
        if (code === 0 && chunks.length > 0) {
          try {
            const thumbBuf = Buffer.concat(chunks);
            // Use createWriteStream to ensure blob entry (not inline) for blob server compatibility
            await new Promise<void>((res, rej) => {
              const ws = drive.createWriteStream(thumbnailPath);
              ws.on('error', rej);
              ws.on('close', res);
              ws.end(thumbBuf);
            });
            resolve(thumbnailPath);
          } catch {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });

      proc.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Check if video has audio codec that browsers can't play (AC3, DTS, etc.)
 * Returns the codec name if transcoding is needed, null otherwise
 */
async function getAudioCodec(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const args = [
        '-v', 'quiet',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'csv=p=0',
        filePath
      ];

      const proc = spawn('ffprobe', args);
      let stdout = '';

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', () => {}); // Ignore

      proc.on('exit', (code: number) => {
        if (code === 0) {
          const codec = stdout.trim().toLowerCase();
          resolve(codec || null);
        } else {
          resolve(null);
        }
      });

      proc.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Check if audio codec needs transcoding for browser playback
 */
function needsAudioTranscode(codec: string | null): boolean {
  if (!codec) return false;
  // Codecs that browsers can't play
  const unsupportedCodecs = ['ac3', 'eac3', 'dts', 'dca', 'truehd', 'mlp'];
  return unsupportedCodecs.includes(codec.toLowerCase());
}

/**
 * Transcode video to MP4 with AAC audio using bare-ffmpeg (native, fast)
 * Falls back to ffmpeg subprocess if bare-ffmpeg unavailable
 * Returns path to transcoded file, or null on failure
 */
async function transcodeToMP4(inputPath: string, onProgress?: (percent: number) => void): Promise<string | null> {
  const tempDir = os.tmpdir();
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const timestamp = Date.now();
  const outputPath = path.join(tempDir, `${baseName}_transcoded_${timestamp}.mp4`);

  console.log('[Worker] Transcoding audio to AAC:', inputPath);

  // Try bare-ffmpeg first (native, faster)
  if (ffmpeg) {
    try {
      const result = await transcodeWithBareFFmpeg(inputPath, outputPath, onProgress);
      if (result) return result;
    } catch (err: any) {
      console.warn('[Worker] bare-ffmpeg transcode failed, falling back to subprocess:', err?.message);
    }
  }

  // Fallback to ffmpeg subprocess
  return transcodeWithSubprocess(inputPath, outputPath, onProgress);
}

/**
 * Transcode using bare-ffmpeg native bindings
 */
async function transcodeWithBareFFmpeg(inputPath: string, outputPath: string, onProgress?: (percent: number) => void): Promise<string | null> {
  console.log('[Worker] Using bare-ffmpeg native transcode');

  const inputData = fs.readFileSync(inputPath);
  const inputIO = new ffmpeg.IOContext(inputData);
  const inputFormat = new ffmpeg.InputFormatContext(inputIO);

  const videoStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.VIDEO);
  const audioStream = inputFormat.getBestStream(ffmpeg.constants.mediaTypes.AUDIO);

  if (!videoStream) {
    throw new Error('No video stream found');
  }

  console.log('[Worker] Video codec:', videoStream.codecParameters.id);
  console.log('[Worker] Audio codec:', audioStream?.codecParameters?.id || 'none');

  // Prepare output buffer
  const outputChunks: Buffer[] = [];
  const outputIO = new ffmpeg.IOContext(1024 * 1024, {
    onwrite: (chunk: Buffer) => {
      outputChunks.push(Buffer.from(chunk));
      return chunk.length;
    }
  });

  const outputFormat = new ffmpeg.OutputFormatContext('mp4', outputIO);

  // Copy video stream directly
  const outVideoStream = outputFormat.createStream();
  outVideoStream.codecParameters.copyFrom(videoStream.codecParameters);
  outVideoStream.timeBase = videoStream.timeBase;

  // Set up audio transcoding to AAC
  let audioDecoder: any = null;
  let audioEncoder: any = null;
  let resampler: any = null;
  let outAudioStream: any = null;

  if (audioStream) {
    outAudioStream = outputFormat.createStream();
    outAudioStream.codecParameters.type = ffmpeg.constants.mediaTypes.AUDIO;
    outAudioStream.codecParameters.id = ffmpeg.constants.codecs.AAC;
    outAudioStream.codecParameters.sampleRate = audioStream.codecParameters.sampleRate || 48000;
    outAudioStream.codecParameters.channelLayout = ffmpeg.constants.channelLayouts.STEREO;
    outAudioStream.codecParameters.format = ffmpeg.constants.sampleFormats.FLTP;
    outAudioStream.timeBase = { numerator: 1, denominator: outAudioStream.codecParameters.sampleRate };

    // Decoder for input audio
    const decoderCodec = new ffmpeg.Codec(audioStream.codecParameters.id);
    audioDecoder = new ffmpeg.CodecContext(decoderCodec);
    audioDecoder.sampleRate = audioStream.codecParameters.sampleRate;
    audioDecoder.channelLayout = audioStream.codecParameters.channelLayout;
    audioDecoder.sampleFormat = audioStream.codecParameters.format;
    audioDecoder.timeBase = audioStream.timeBase;
    audioDecoder.open();

    // Encoder for AAC output
    const encoderCodec = new ffmpeg.Codec(ffmpeg.constants.codecs.AAC);
    audioEncoder = new ffmpeg.CodecContext(encoderCodec);
    audioEncoder.sampleRate = outAudioStream.codecParameters.sampleRate;
    audioEncoder.channelLayout = ffmpeg.constants.channelLayouts.STEREO;
    audioEncoder.sampleFormat = ffmpeg.constants.sampleFormats.FLTP;
    audioEncoder.timeBase = outAudioStream.timeBase;
    audioEncoder.open();

    // Resampler for format conversion
    resampler = new ffmpeg.Resampler(
      audioDecoder.sampleRate,
      audioDecoder.channelLayout,
      audioDecoder.sampleFormat,
      audioEncoder.sampleRate,
      audioEncoder.channelLayout,
      audioEncoder.sampleFormat
    );
  }

  // Write header
  outputFormat.writeHeader();

  // Process packets
  const packet = new ffmpeg.Packet();
  const frame = new ffmpeg.Frame();
  const resampledFrame = new ffmpeg.Frame();
  const outputPacket = new ffmpeg.Packet();

  if (outAudioStream) {
    resampledFrame.format = ffmpeg.constants.sampleFormats.FLTP;
    resampledFrame.channelLayout = ffmpeg.constants.channelLayouts.STEREO;
    resampledFrame.sampleRate = audioEncoder.sampleRate;
    resampledFrame.nbSamples = 1024;
    resampledFrame.alloc();
  }

  let packetCount = 0;
  let totalPackets = 0;

  // First pass to count packets for progress
  while (inputFormat.readFrame(packet)) {
    totalPackets++;
    packet.unref();
  }

  // Reset to beginning
  inputIO.destroy();
  inputFormat.destroy();

  const inputData2 = fs.readFileSync(inputPath);
  const inputIO2 = new ffmpeg.IOContext(inputData2);
  const inputFormat2 = new ffmpeg.InputFormatContext(inputIO2);
  const videoStream2 = inputFormat2.getBestStream(ffmpeg.constants.mediaTypes.VIDEO);
  const audioStream2 = inputFormat2.getBestStream(ffmpeg.constants.mediaTypes.AUDIO);

  // Process packets
  while (inputFormat2.readFrame(packet)) {
    packetCount++;

    if (packet.streamIndex === videoStream2.index) {
      packet.streamIndex = outVideoStream.index;
      outputFormat.writeFrame(packet);
    } else if (audioStream2 && packet.streamIndex === audioStream2.index && outAudioStream && audioDecoder && audioEncoder) {
      packet.timeBase = audioStream2.timeBase;

      if (audioDecoder.sendPacket(packet)) {
        while (audioDecoder.receiveFrame(frame)) {
          const samplesConverted = resampler.convert(frame, resampledFrame);
          resampledFrame.nbSamples = samplesConverted;
          resampledFrame.pts = frame.pts;
          resampledFrame.timeBase = frame.timeBase;

          if (audioEncoder.sendFrame(resampledFrame)) {
            while (audioEncoder.receivePacket(outputPacket)) {
              outputPacket.streamIndex = outAudioStream.index;
              outputFormat.writeFrame(outputPacket);
              outputPacket.unref();
            }
          }
        }
      }
    }
    packet.unref();

    // Report progress
    if (totalPackets > 0 && packetCount % 100 === 0) {
      const percent = Math.round((packetCount / totalPackets) * 100);
      onProgress?.(percent);
    }
  }

  // Flush encoder
  if (audioEncoder) {
    audioEncoder.sendFrame(null);
    while (audioEncoder.receivePacket(outputPacket)) {
      outputPacket.streamIndex = outAudioStream.index;
      outputFormat.writeFrame(outputPacket);
      outputPacket.unref();
    }
  }

  outputFormat.writeTrailer();
  onProgress?.(100);

  // Write output file
  const outputBuffer = Buffer.concat(outputChunks);
  fs.writeFileSync(outputPath, outputBuffer);

  // Cleanup
  inputFormat2.destroy();
  outputFormat.destroy();
  if (audioDecoder) audioDecoder.destroy();
  if (audioEncoder) audioEncoder.destroy();
  if (resampler) resampler.destroy();
  frame.destroy();
  resampledFrame.destroy();
  inputIO2.destroy();
  outputIO.destroy();

  console.log('[Worker] bare-ffmpeg transcode complete:', outputPath);
  return outputPath;
}

/**
 * Fallback: Transcode using ffmpeg subprocess
 */
async function transcodeWithSubprocess(inputPath: string, outputPath: string, onProgress?: (percent: number) => void): Promise<string | null> {
  console.log('[Worker] Using ffmpeg subprocess transcode');

  // Get duration for progress
  const duration = await new Promise<number>((resolve) => {
    const proc = spawn('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath]);
    let stdout = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.on('exit', () => resolve(parseFloat(stdout.trim()) || 0));
    proc.on('error', () => resolve(0));
  });

  return new Promise((resolve) => {
    const args = [
      '-y', '-i', inputPath,
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      '-movflags', '+faststart',
      outputPath
    ];

    const proc = spawn('ffmpeg', args);

    proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString();
      const timeMatch = msg.match(/time=(\d+):(\d+):(\d+)/);
      if (timeMatch && duration > 0 && onProgress) {
        const secs = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
        onProgress(Math.min(99, Math.round((secs / duration) * 100)));
      }
    });

    proc.on('exit', (code: number) => {
      onProgress?.(100);
      resolve(code === 0 ? outputPath : null);
    });
    proc.on('error', () => resolve(null));
  });
}

// Allowed video file extensions
const ALLOWED_VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi'];

// Native video file picker using osascript (macOS)
async function pickVideoFile(): Promise<any> {
  return new Promise((resolve, reject) => {
    const script = `
      set theFile to choose file with prompt "Select a video file"
      return POSIX path of theFile
    `;

    const proc = spawn('osascript', ['-e', script]);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('exit', (code: number) => {
      if (code === 0 && stdout.trim()) {
        const filePath = stdout.trim();
        try {
          // Check file extension against whitelist
          const ext = filePath.split('.').pop()?.toLowerCase() || '';
          if (!ALLOWED_VIDEO_EXTENSIONS.includes(ext)) {
            reject(new Error(`Unsupported video format: .${ext}. Allowed formats: ${ALLOWED_VIDEO_EXTENSIONS.join(', ')}`));
            return;
          }
          const stat = fs.statSync(filePath);
          resolve({ filePath, name: filePath.split('/').pop() || 'video', size: stat.size });
        } catch (err: any) {
          reject(new Error(`Failed to stat file: ${err.message}`));
        }
      } else if (code === 1) {
        resolve({ cancelled: true });
      } else {
        reject(new Error(stderr || 'File picker failed'));
      }
    });

    proc.on('error', (err: Error) => reject(err));
  });
}

// Native image file picker using osascript (macOS)
async function pickImageFile(): Promise<any> {
  return new Promise((resolve, reject) => {
    const script = `
      set theFile to choose file with prompt "Select a thumbnail image" of type {"public.jpeg", "public.png", "public.image", "org.webmproject.webp"}
      return POSIX path of theFile
    `;

    const proc = spawn('osascript', ['-e', script]);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('exit', (code: number) => {
      if (code === 0 && stdout.trim()) {
        const filePath = stdout.trim();
        try {
          const stat = fs.statSync(filePath);
          const fileBuffer = fs.readFileSync(filePath);
          const base64 = fileBuffer.toString('base64');
          // Detect mime type from extension
          const ext = filePath.toLowerCase().split('.').pop() || '';
          const mimeTypes: Record<string, string> = {
            'png': 'image/png',
            'webp': 'image/webp',
            'gif': 'image/gif',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
          };
          const mimeType = mimeTypes[ext] || 'image/jpeg';
          const dataUrl = `data:${mimeType};base64,${base64}`;
          resolve({ filePath, name: filePath.split('/').pop() || 'image', size: stat.size, dataUrl });
        } catch (err: any) {
          reject(new Error(`Failed to read file: ${err.message}`));
        }
      } else if (code === 1) {
        resolve({ cancelled: true });
      } else {
        reject(new Error(stderr || 'File picker failed'));
      }
    });

    proc.on('error', (err: Error) => reject(err));
  });
}

// ============================================
// HRPC Setup
// ============================================

const ipcPipe = pipe();
if (!ipcPipe) {
  console.error('[Worker] Failed to get IPC pipe');
  throw new Error('No IPC pipe');
}

const rpc = new HRPC(ipcPipe);
console.log('[Worker] HRPC initialized');

// Wire up video stats events
videoStats.setOnStatsUpdate((driveKey: string, videoPath: string, stats: any) => {
  try {
    rpc.eventVideoStats({
      stats: {
        videoId: videoPath,
        channelKey: driveKey,
        status: stats.status || 'unknown',
        progress: stats.progress || 0,
        totalBlocks: stats.totalBlocks || 0,
        downloadedBlocks: stats.downloadedBlocks || 0,
        totalBytes: stats.totalBytes || 0,
        downloadedBytes: stats.downloadedBytes || 0,
        peerCount: stats.peerCount || 0,
        speedMBps: stats.speedMBps || '0',
        uploadSpeedMBps: stats.uploadSpeedMBps || '0',
        elapsed: stats.elapsed || 0,
        isComplete: Boolean(stats.isComplete),
      }
    });
  } catch (e) {
    // Ignore event send errors
  }
});

// ============================================
// HRPC Handlers - Thin Delegation Layer
// ============================================

// Identity handlers
rpc.onCreateIdentity(async (req: any) => {
  console.log('[Worker] onCreateIdentity called, name:', req.name);
  try {
    const result = await identityManager.createIdentity(req.name || 'New Channel', true);
    console.log('[Worker] Identity created:', result.publicKey?.slice(0, 16));
    return {
      identity: {
        publicKey: result.publicKey,
        driveKey: result.driveKey,
        name: req.name || 'New Channel',
        seedPhrase: result.mnemonic,
        isActive: true,
      }
    };
  } catch (err: any) {
    console.error('[Worker] createIdentity failed:', err.message);
    throw err;
  }
});

rpc.onGetIdentity(async () => {
  const active = identityManager.getActiveIdentity();
  console.log('[Worker] getIdentity called, active:', active ? active.name : 'none');
  console.log('[Worker] All identities count:', identityManager.getIdentities().length);
  return { identity: active };
});

rpc.onGetIdentities(async () => {
  const all = identityManager.getIdentities();
  return { identities: all.map((i: any) => ({
    publicKey: i.publicKey || '',
    driveKey: i.driveKey || '',
    name: i.name || '',
    createdAt: i.createdAt || 0,
    isActive: Boolean(i.isActive),
  }))};
});

rpc.onSetActiveIdentity(async (req: any) => {
  await identityManager.setActiveIdentity(req.publicKey);
  return { success: true };
});

rpc.onRecoverIdentity(async (req: any) => {
  const result = await identityManager.recoverIdentity(req.seedPhrase, req.name);
  return {
    identity: {
      publicKey: result.publicKey,
      driveKey: result.driveKey,
      name: req.name || 'Recovered',
      isActive: true,
    }
  };
});

// Channel handlers
rpc.onGetChannel(async (req: any) => {
  const channel = await api.getChannel(req.publicKey || '');
  return { channel };
});

rpc.onGetChannelMeta(async (req: any) => {
  const meta = await api.getChannelMeta(req.channelKey);
  return { name: meta.name, description: meta.description, videoCount: meta.videoCount || 0 };
});

rpc.onUpdateChannel(async () => ({ channel: {} }));

// Video handlers
rpc.onListVideos(async (req: any) => {
  console.log('[Worker] onListVideos called for channelKey:', req.channelKey?.slice(0, 16));
  const videos = await api.listVideos(req.channelKey || '');
  console.log('[Worker] Got', videos.length, 'videos from API');

  // Resolve thumbnail URLs via blob server
  const enriched = await Promise.all(videos.map(async (v: any) => {
    let thumbnailUrl = '';
    const channelKey = v.channelKey || req.channelKey;
    console.log('[Worker] Processing video:', v.id, 'thumbnail field:', v.thumbnail);

    if (v.thumbnail && channelKey) {
      try {
        // Try ctx.drives first, then fall back to identity drive if it's the user's own channel
        let drive = ctx.drives.get(channelKey);
        if (!drive) {
          // Check if this is the user's own identity drive
          const activeDrive = identityManager.getActiveDrive();
          if (activeDrive && b4a.toString(activeDrive.key, 'hex') === channelKey) {
            drive = activeDrive;
          }
        }
        console.log('[Worker] Drive found for', channelKey?.slice(0, 16), ':', !!drive);

        if (drive) {
          const entry = await drive.entry(v.thumbnail);
          console.log('[Worker] Entry for', v.thumbnail, ':', entry ? 'found' : 'not found');

          if (entry) {
            console.log('[Worker] Entry value:', JSON.stringify(entry.value));
          }

          if (entry && entry.value?.blob) {
            // Use blob reference for proper blob server URL
            const blobsCore = await drive.getBlobs();
            console.log('[Worker] BlobsCore:', blobsCore ? 'found' : 'not found');

            if (blobsCore) {
              // Detect mime type from thumbnail path extension
              const thumbExt = v.thumbnail.split('.').pop()?.toLowerCase() || 'jpg';
              thumbnailUrl = ctx.blobServer.getLink(blobsCore.core.key, {
                blob: entry.value.blob,
                type: getMimeType(thumbExt)
              });
              console.log('[Worker] Resolved thumbnail URL for', v.id, ':', thumbnailUrl?.slice(0, 80));
            }
          } else {
            console.log('[Worker] No blob entry found for thumbnail:', v.thumbnail, 'entry.value:', entry?.value);
          }
        } else {
          console.log('[Worker] No drive in ctx.drives for:', channelKey?.slice(0, 16));
          console.log('[Worker] Available drives:', Array.from(ctx.drives.keys()).map(k => k.slice(0, 16)));
        }
      } catch (e: any) {
        console.error('[Worker] Failed to resolve thumbnail URL:', e.message, e.stack);
      }
    } else {
      console.log('[Worker] Skipping thumbnail - thumbnail:', v.thumbnail, 'channelKey:', channelKey?.slice(0, 16));
    }

    return {
      id: v.id || '',
      title: v.title || 'Untitled',
      description: v.description || '',
      path: v.path || '',
      duration: v.duration || 0,
      thumbnail: thumbnailUrl,
      channelKey,
      channelName: v.channelName || '',
      createdAt: v.uploadedAt || v.createdAt || 0,
      views: v.views || 0,
      category: v.category || 'Other',
    };
  }));
  return { videos: enriched };
});

rpc.onGetVideoUrl(async (req: any) => {
  const videoPath = req.videoId;
  console.log('[Worker] getVideoUrl request:', req.channelKey?.slice(0, 8), videoPath);
  const result = await api.getVideoUrl(req.channelKey, videoPath);
  console.log('[Worker] Blob URL:', result.url);
  return { url: result.url };
});

rpc.onGetVideoData(async (req: any) => ({ video: { id: req.videoId, title: 'Unknown' } }));

rpc.onUploadVideo(async (req: any) => {
  const drive = identityManager.getActiveDrive();
  if (!drive) throw new Error('No active identity');

  let uploadPath = req.filePath;
  let transcodedPath: string | null = null;
  let mimeType = getMimeTypeFromPath(req.filePath);

  // Check if audio needs transcoding (AC3, DTS, etc. -> AAC)
  const hasFFmpeg = await checkFFmpeg();
  if (hasFFmpeg) {
    const audioCodec = await getAudioCodec(req.filePath);
    console.log('[Worker] Audio codec detected:', audioCodec);

    if (needsAudioTranscode(audioCodec)) {
      console.log('[Worker] Audio codec', audioCodec, 'needs transcoding to AAC');

      // Send initial "transcoding" status (negative progress indicates transcoding phase)
      rpc.eventUploadProgress({
        videoId: 'transcoding',
        progress: 0,
        bytesUploaded: 0,
        totalBytes: 0,
        speed: 0,
        eta: 0
      });

      transcodedPath = await transcodeToMP4(req.filePath, (percent) => {
        // Send transcode progress (videoId='transcoding' signals transcode phase to UI)
        rpc.eventUploadProgress({
          videoId: 'transcoding',
          progress: percent,
          bytesUploaded: 0,
          totalBytes: 0,
          speed: 0,
          eta: 0
        });
      });

      if (transcodedPath) {
        uploadPath = transcodedPath;
        mimeType = 'video/mp4';
        console.log('[Worker] Using transcoded file for upload:', uploadPath);
      } else {
        console.warn('[Worker] Transcoding failed, uploading original file');
      }
    }
  }

  // Upload the file
  const result = await uploadManager.uploadFromPath(
    drive,
    uploadPath,
    { title: req.title, description: req.description, mimeType },
    fs,
    (progress: number, bytesWritten: number, totalBytes: number, stats?: { speed?: number; eta?: number }) => {
      try {
        rpc.eventUploadProgress({
          videoId: '',
          progress,
          bytesUploaded: bytesWritten,
          totalBytes,
          speed: stats?.speed || 0,
          eta: stats?.eta || 0
        });
      } catch {}
    }
  );

  // Clean up transcoded temp file
  if (transcodedPath) {
    try {
      fs.unlinkSync(transcodedPath);
      console.log('[Worker] Cleaned up transcoded temp file');
    } catch {}
  }

  // Generate thumbnail if FFmpeg available AND no custom thumbnail will be provided
  // skipThumbnailGeneration is true when user has selected a custom thumbnail
  if (result.success && result.videoId && !req.skipThumbnailGeneration) {
    console.log('[Worker] Generating FFmpeg thumbnail (no custom thumbnail provided)');
    if (hasFFmpeg) {
      // Use original file for thumbnail (better quality, no transcode artifacts)
      const thumbPath = await generateThumbnail(req.filePath, result.videoId, drive);
      if (thumbPath) {
        const metaPath = `/videos/${result.videoId}.json`;
        const metaBuf = await drive.get(metaPath);
        if (metaBuf) {
          const meta = JSON.parse(b4a.toString(metaBuf, 'utf-8'));
          meta.thumbnail = thumbPath;
          await drive.put(metaPath, Buffer.from(JSON.stringify(meta)));
        }
      }
    }
  } else if (req.skipThumbnailGeneration) {
    console.log('[Worker] Skipping FFmpeg thumbnail - custom thumbnail will be uploaded');
  }

  return {
    video: {
      id: result.videoId || '',
      title: req.title || '',
      description: req.description || '',
      channelKey: b4a.toString(drive.key, 'hex'),
    }
  };
});

// Download video using streams
rpc.onDownloadVideo(async (req: any) => {
  let destPath = req.destPath;
  if (destPath.startsWith('file://')) {
    destPath = destPath.slice(7);
  }

  const result = await api.downloadVideo(
    req.channelKey,
    req.videoId,
    destPath,
    fs,
    (progress: number, bytesWritten: number, totalBytes: number) => {
      try {
        rpc.eventUploadProgress({ videoId: req.videoId, progress, bytesUploaded: bytesWritten, totalBytes });
      } catch {}
    }
  );

  return result;
});

// Delete video
rpc.onDeleteVideo(async (req: any) => {
  const drive = identityManager.getActiveDrive();
  if (!drive) {
    return { success: false, error: 'No active identity' };
  }
  const result = await api.deleteVideo(drive, req.videoId);
  return result;
});

// Video stats
rpc.onPrefetchVideo(async (req: any) => {
  await api.prefetchVideo(req.channelKey, req.videoId);
  return { success: true };
});

rpc.onGetVideoStats(async (req: any) => {
  const stats = api.getVideoStats(req.channelKey, req.videoId);
  return { stats: { videoId: req.videoId, channelKey: req.channelKey, ...stats } };
});

// Subscription handlers
rpc.onSubscribeChannel(async (req: any) => {
  await api.subscribeChannel(req.channelKey);
  return { success: true };
});

rpc.onUnsubscribeChannel(async (req: any) => {
  await api.unsubscribeChannel(req.channelKey);
  return { success: true };
});

rpc.onGetSubscriptions(async () => {
  const subs = await api.getSubscriptions();
  return { subscriptions: subs.map((s: any) => ({ channelKey: s.driveKey, channelName: s.name })) };
});

rpc.onJoinChannel(async (req: any) => {
  await api.subscribeChannel(req.channelKey);
  return { success: true };
});

// Public Feed handlers
rpc.onGetPublicFeed(async () => {
  const result = api.getPublicFeed();
  return {
    entries: result.entries.map((e: any) => ({
      channelKey: e.driveKey,
      channelName: e.name || '',
      videoCount: 0,
      peerCount: 0,
      lastSeen: 0,
    }))
  };
});

rpc.onRefreshFeed(async () => {
  api.refreshFeed();
  return { success: true };
});

rpc.onSubmitToFeed(async () => {
  const active = identityManager.getActiveIdentity();
  if (active?.driveKey) {
    await api.submitToFeed(active.driveKey);
  }
  return { success: true };
});

rpc.onUnpublishFromFeed(async () => {
  const active = identityManager.getActiveIdentity();
  if (active?.driveKey) {
    await api.unpublishFromFeed(active.driveKey);
  }
  return { success: true };
});

rpc.onIsChannelPublished(async () => {
  const active = identityManager.getActiveIdentity();
  if (active?.driveKey) {
    return api.isChannelPublished(active.driveKey);
  }
  return { published: false };
});

rpc.onHideChannel(async (req: any) => {
  api.hideChannel(req.channelKey);
  return { success: true };
});

// Seeding handlers
rpc.onGetSeedingStatus(async () => {
  const status = await api.getSeedingStatus();
  return { status: {
    enabled: status.config?.autoSeedWatched || false,
    usedStorage: status.storageUsedBytes || 0,
    maxStorage: (status.maxStorageGB || 10) * 1024 * 1024 * 1024,
    seedingCount: status.activeSeeds || 0,
  }};
});

rpc.onSetSeedingConfig(async (req: any) => {
  await api.setSeedingConfig(req.config);
  return { success: true };
});

rpc.onPinChannel(async (req: any) => {
  await api.pinChannel(req.channelKey);
  return { success: true };
});

rpc.onUnpinChannel(async (req: any) => {
  await api.unpinChannel(req.channelKey);
  return { success: true };
});

rpc.onGetPinnedChannels(async () => {
  const result = api.getPinnedChannels();
  return { channels: result.channels || [] };
});

// Storage management handlers
rpc.onGetStorageStats(async () => {
  return api.getStorageStats();
});

rpc.onSetStorageLimit(async (req: any) => {
  return await api.setStorageLimit(req.maxGB);
});

rpc.onClearCache(async () => {
  return await api.clearCache();
});

// Thumbnail handlers
rpc.onGetVideoThumbnail(async (req: any) => {
  const drive = ctx.drives.get(req.channelKey);
  if (drive) {
    // Try all supported formats
    for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif']) {
      const thumbPath = `/thumbnails/${req.videoId}.${ext}`;
      try {
        const entry = await drive.entry(thumbPath);
        if (entry && entry.value?.blob) {
          const blobsCore = await drive.getBlobs();
          if (blobsCore) {
            const url = ctx.blobServer.getLink(blobsCore.core.key, {
              blob: entry.value.blob,
              type: getMimeType(ext)
            });
            return { url, exists: true };
          }
        }
      } catch {}
    }
  }
  return { url: null, exists: false };
});

rpc.onGetVideoMetadata(async (req: any) => {
  const drive = ctx.drives.get(req.channelKey);
  if (drive) {
    const metaPath = `/videos/${req.videoId}.json`;
    const metaBuf = await drive.get(metaPath);
    if (metaBuf) {
      return { video: JSON.parse(b4a.toString(metaBuf, 'utf-8')) };
    }
  }
  return { video: { id: req.videoId, title: 'Unknown' } };
});

rpc.onSetVideoThumbnail(async (req: any) => {
  const drive = identityManager.getActiveDrive();
  if (!drive) return { success: false };

  const imageBuffer = Buffer.from(req.imageData, 'base64');
  const ext = req.mimeType?.includes('png') ? 'png' : 'jpg';
  const thumbnailPath = `/thumbnails/${req.videoId}.${ext}`;

  // Use createWriteStream to ensure blob entry (not inline) for blob server compatibility
  await new Promise<void>((resolve, reject) => {
    const ws = drive.createWriteStream(thumbnailPath);
    ws.on('error', reject);
    ws.on('close', resolve);
    ws.end(imageBuffer);
  });

  // Update metadata
  const metaPath = `/videos/${req.videoId}.json`;
  const metaBuf = await drive.get(metaPath);
  if (metaBuf) {
    const meta = JSON.parse(b4a.toString(metaBuf, 'utf-8'));
    meta.thumbnail = thumbnailPath;
    await drive.put(metaPath, Buffer.from(JSON.stringify(meta)));
  }

  return { success: true, thumbnailPath };
});

rpc.onSetVideoThumbnailFromFile(async (req: any) => {
  console.log('[Worker] setVideoThumbnailFromFile called:', req.videoId, req.filePath);
  const drive = identityManager.getActiveDrive();
  if (!drive) {
    console.error('[Worker] No active drive for thumbnail upload');
    return { success: false };
  }
  console.log('[Worker] Active drive key:', b4a.toString(drive.key, 'hex').slice(0, 16));

  const imageBuffer = fs.readFileSync(req.filePath);
  console.log('[Worker] Read image file, size:', imageBuffer.length);

  // Detect extension from file path
  const fileExt = req.filePath.toLowerCase().split('.').pop() || 'jpg';
  const ext = ['png', 'webp', 'gif', 'jpeg'].includes(fileExt) ? fileExt : 'jpg';
  const thumbnailPath = `/thumbnails/${req.videoId}.${ext}`;
  console.log('[Worker] Saving thumbnail:', thumbnailPath, 'ext:', ext);

  // Use createWriteStream to ensure blob entry (not inline) for blob server compatibility
  await new Promise<void>((resolve, reject) => {
    const ws = drive.createWriteStream(thumbnailPath);
    ws.on('error', reject);
    ws.on('close', resolve);
    ws.end(imageBuffer);
  });
  console.log('[Worker] Thumbnail saved to drive as blob');

  // Verify the entry was created
  const thumbEntry = await drive.entry(thumbnailPath);
  console.log('[Worker] Verify thumbnail entry:', thumbEntry ? 'found' : 'NOT FOUND');
  if (thumbEntry) {
    console.log('[Worker] Thumbnail entry value:', JSON.stringify(thumbEntry.value));
  }

  const metaPath = `/videos/${req.videoId}.json`;
  const metaBuf = await drive.get(metaPath);
  console.log('[Worker] Video metadata exists:', !!metaBuf);

  if (metaBuf) {
    const meta = JSON.parse(b4a.toString(metaBuf, 'utf-8'));
    console.log('[Worker] Old thumbnail in meta:', meta.thumbnail);
    meta.thumbnail = thumbnailPath;
    await drive.put(metaPath, Buffer.from(JSON.stringify(meta)));
    console.log('[Worker] Updated metadata with thumbnail:', thumbnailPath);

    // Verify the update
    const verifyBuf = await drive.get(metaPath);
    if (verifyBuf) {
      const verifyMeta = JSON.parse(b4a.toString(verifyBuf, 'utf-8'));
      console.log('[Worker] Verified thumbnail in meta:', verifyMeta.thumbnail);
    }
  } else {
    console.error('[Worker] No video metadata found at:', metaPath);
  }

  // Try to flush, but don't fail if flush isn't fully supported
  try {
    if (drive.flush) {
      await drive.flush();
      console.log('[Worker] Drive flushed');
    }
  } catch (flushErr: any) {
    console.log('[Worker] Drive flush not supported (ok):', flushErr.message);
  }
  return { success: true };
});

// Status handlers
rpc.onGetStatus(async () => ({
  status: {
    ready: true,
    hasIdentity: identityManager.getIdentities().length > 0,
    blobServerPort: getBlobPort(),
  }
}));

rpc.onGetSwarmStatus(async () => ({
  connected: ctx.swarm.connections.size > 0,
  peerCount: ctx.swarm.connections.size,
}));

rpc.onGetBlobServerPort(async () => ({ port: getBlobPort() }));

// Desktop-specific file pickers
rpc.onPickVideoFile(async () => {
  const result = await pickVideoFile();
  return {
    filePath: result.filePath || null,
    name: result.name || null,
    size: result.size || 0,
    cancelled: result.cancelled || false,
  };
});

rpc.onPickImageFile(async () => {
  const result = await pickImageFile();
  return {
    filePath: result.filePath || null,
    name: result.name || null,
    size: result.size || 0,
    dataUrl: result.dataUrl || null,
    cancelled: result.cancelled || false,
  };
});

// Event handlers (client->server, no-ops)
rpc.onEventReady(() => {});
rpc.onEventError((data: any) => console.error('[HRPC] Client error:', data?.message));
rpc.onEventUploadProgress(() => {});
rpc.onEventFeedUpdate(() => {});
rpc.onEventLog(() => {});
rpc.onEventVideoStats(() => {});

// Send ready event
rpc.eventReady({ blobServerPort: getBlobPort() });
console.log('[Worker] HRPC ready, handlers registered');

ipcPipe.on('error', (err: Error) => {
  console.error('[Worker] Pipe error:', err);
});

// Cleanup on shutdown
Pear.teardown(async () => {
  console.log('[Worker] Shutting down...');
  await ctx.blobServer.close();
  await ctx.swarm.destroy();
});
