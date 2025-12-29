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
import http1 from 'bare-http1';

// bare-ffmpeg for fast native transcoding
let ffmpeg: any = null;
let ffmpegLoadError: string | null = null;
let ffmpegLoadPromise: Promise<void> | null = null;

async function loadBareFfmpeg(): Promise<void> {
  if (ffmpeg || ffmpegLoadError) return;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;
  ffmpegLoadPromise = (async () => {
    let lastError: any;
    if (typeof require === 'function') {
      try {
        const mod = require('bare-ffmpeg');
        ffmpeg = mod?.default ?? mod;
        console.log('[Worker] bare-ffmpeg loaded');
        return;
      } catch (err: any) {
        lastError = err;
      }
    }
    try {
      const mod = await import('bare-ffmpeg');
      ffmpeg = (mod as any)?.default ?? mod;
      console.log('[Worker] bare-ffmpeg loaded');
      return;
    } catch (err: any) {
      lastError = err;
    }
    ffmpegLoadError = lastError?.message || 'Unknown error';
    console.warn('[Worker] bare-ffmpeg not available:', ffmpegLoadError);
  })();
  return ffmpegLoadPromise;
}

void loadBareFfmpeg();

// bare-mpv for universal codec playback (AC3, DTS, etc.)
let MpvPlayer: any = null;
let mpvLoadError: string | null = null;
let mpvLoadPromise: Promise<void> | null = null;

async function loadBareMpv(): Promise<void> {
  if (MpvPlayer || mpvLoadError) return;
  if (mpvLoadPromise) return mpvLoadPromise;
  mpvLoadPromise = (async () => {
    let lastError: any;
    if (typeof require === 'function') {
      try {
        const mod = require('bare-mpv');
        MpvPlayer = mod?.MpvPlayer ?? mod?.default?.MpvPlayer ?? mod;
        if (!MpvPlayer) {
          throw new Error('bare-mpv export missing MpvPlayer');
        }
        console.log('[Worker] bare-mpv loaded');
        return;
      } catch (err: any) {
        lastError = err;
      }
    }
    try {
      const mod = await import('bare-mpv');
      MpvPlayer = (mod as any)?.MpvPlayer ?? (mod as any)?.default?.MpvPlayer ?? (mod as any)?.default ?? null;
      if (!MpvPlayer) {
        throw new Error('bare-mpv export missing MpvPlayer');
      }
      console.log('[Worker] bare-mpv loaded');
      return;
    } catch (err: any) {
      lastError = err;
    }
    mpvLoadError = lastError?.message || 'Unknown error';
    console.warn('[Worker] bare-mpv not available:', mpvLoadError);
  })();
  return mpvLoadPromise;
}

void loadBareMpv();

// Active mpv player instances (keyed by player ID)
const mpvPlayers = new Map<string, any>();
let mpvPlayerIdCounter = 0;
let mpvFrameServer: any = null;
let mpvFrameServerPort = 0;
let mpvFrameServerReady: Promise<number> | null = null;

function handleMpvFrameRequest(req: any, res: any) {
  const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
  try {
    if (req.method !== 'GET') {
      res.writeHead(405, { ...corsHeaders, 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    const rawUrl = typeof req.url === 'string' ? req.url : '/';
    const path = rawUrl.split('?')[0] || '/';
    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 'frame' || !parts[1]) {
      res.writeHead(404, { ...corsHeaders, 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const playerId = decodeURIComponent(parts[1]);
    const state = mpvPlayers.get(playerId);
    if (!state) {
      res.writeHead(404, { ...corsHeaders, 'Content-Type': 'text/plain' });
      res.end('Player Not Found');
      return;
    }

    if (!state.player.needsRender()) {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const frameData = state.player.renderFrame();
    if (!frameData || frameData.length === 0) {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const buffer = b4a.from(frameData);
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'application/octet-stream',
      'Content-Length': buffer.byteLength,
      'Cache-Control': 'no-store',
      'X-Frame-Width': String(state.width),
      'X-Frame-Height': String(state.height),
    });
    res.end(buffer);
  } catch (err: any) {
    console.error('[Worker] mpv frame server error:', err?.message);
    try {
      res.writeHead(500, { ...corsHeaders, 'Content-Type': 'text/plain' });
      res.end('Internal Error');
    } catch {
      // Ignore response errors.
    }
  }
}

async function ensureMpvFrameServer(): Promise<number> {
  if (mpvFrameServerPort) return mpvFrameServerPort;
  if (mpvFrameServerReady) return mpvFrameServerReady;

  mpvFrameServerReady = new Promise((resolve, reject) => {
    mpvFrameServer = http1.createServer(handleMpvFrameRequest);
    mpvFrameServer.on('error', (err: any) => {
      console.error('[Worker] mpv frame server failed:', err?.message);
      reject(err);
    });
    mpvFrameServer.listen(0, '127.0.0.1', () => {
      mpvFrameServerPort = mpvFrameServer.address().port || 0;
      console.log('[Worker] mpv frame server listening on port:', mpvFrameServerPort);
      resolve(mpvFrameServerPort);
    });
  });

  return mpvFrameServerReady;
}

// Import the orchestrator from backend
// @ts-ignore - backend-core is JavaScript
import { createBackendContext } from '@peartube/backend/orchestrator';
// @ts-ignore - backend-core is JavaScript
import { loadDrive } from '@peartube/backend/storage';
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

// Create a placeholder callback that we'll replace after HRPC init
const placeholderStatsCallback = (driveKey: string, videoPath: string, stats: any) => {
  console.log('[Worker] PLACEHOLDER stats callback called - this should not happen!');
};
(placeholderStatsCallback as any)._statsMarker = 'placeholder';

const backend = await createBackendContext({
  storagePath: storage,
  onFeedUpdate: () => {
    // Feed updates will be wired after HRPC init
  },
  onStatsUpdate: placeholderStatsCallback
});

const { ctx, api, identityManager, uploadManager, publicFeed, seedingManager, videoStats } = backend;

// Shutdown flag to prevent RPC handlers from running during cleanup
let isShuttingDown = false;

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

// Generate thumbnail from video file using FFmpeg and store in Hyperblobs
async function generateThumbnail(filePath: string, videoId: string, channel: any): Promise<{ thumbnailBlobId: string; thumbnailBlobsCoreKey: string } | null> {
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
            // Store in Hyperblobs
            if (!channel.blobs) {
              console.warn('[Worker] Channel blobs not available for thumbnail');
              resolve(null);
              return;
            }
            const blobResult = await channel.putBlob(thumbBuf);
            console.log('[Worker] Thumbnail stored in Hyperblobs, blobId:', blobResult.id);
            resolve({
              thumbnailBlobId: blobResult.id,
              thumbnailBlobsCoreKey: channel.blobsKeyHex
            });
          } catch (err: any) {
            console.warn('[Worker] Thumbnail storage failed:', err?.message);
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

// When running under Pear v2, the main process can inject the runtime pipe so we don't
// need to spawn a separate process. Fall back to pear-pipe() for legacy/standalone usage.
const injectedPipe = (globalThis as any).__PEARTUBE_HRPC_PIPE__ as any
const ipcPipe = injectedPipe || pipe();
if (!ipcPipe) {
  console.error('[Worker] Failed to get IPC pipe');
  throw new Error('No IPC pipe');
}

const rpc = new HRPC(ipcPipe);
console.log('[Worker] HRPC initialized');

// Wire up video stats events
console.log('[Worker] Setting up videoStats callback');
const workerStatsCallback = (driveKey: string, videoPath: string, stats: any) => {
  console.log('[Worker] videoStats callback fired, progress:', stats.progress);
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
    console.log('[Worker] rpc.eventVideoStats sent successfully');
  } catch (e: any) {
    console.log('[Worker] rpc.eventVideoStats error:', e?.message);
  }
};
(workerStatsCallback as any)._statsMarker = 'worker-rpc';
videoStats.setOnStatsUpdate(workerStatsCallback);
console.log('[Worker] videoStats callback registered');

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

rpc.onUpdateChannel(async (req: any) => {
  const active = identityManager.getActiveIdentity();
  if (active?.driveKey) {
    await api.updateChannel(active.driveKey, req.name, req.description);
  }
  return { channel: {} };
});

// Video handlers
rpc.onListVideos(async (req: any) => {
  console.log('[Worker] onListVideos called for channelKey:', req.channelKey?.slice(0, 16), 'publicBeeKey:', req.publicBeeKey?.slice(0, 16));
  const videos = await api.listVideos(req.channelKey || '', req.publicBeeKey);
  console.log('[Worker] Got', videos.length, 'videos from API');

  // Resolve thumbnail URLs via blob server with timeout
  const enriched = await Promise.all(videos.map(async (v: any) => {
    let thumbnailUrl = '';
    const channelKey = v.channelKey || req.channelKey;

    if ((v.thumbnail || v.id) && channelKey) {
      try {
        // Add 3 second timeout for thumbnail resolution
        const thumbPromise = api.getVideoThumbnail(channelKey, v.id || '');
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Thumbnail timeout')), 3000)
        );
        const thumb = await Promise.race([thumbPromise, timeoutPromise]) as any;
        if (thumb?.exists && thumb.url) thumbnailUrl = thumb.url;
      } catch (e: any) {
        // Silently skip thumbnail errors - don't block video listing
        console.log('[Worker] Thumbnail skipped for', v.id?.slice(0, 8), ':', e.message);
      }
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
  console.log('[Worker] onListVideos returning', enriched.length, 'videos');
  return { videos: enriched };
});

rpc.onGetVideoUrl(async (req: any) => {
  const videoPath = req.videoId;
  console.log('[Worker] getVideoUrl request:', req.channelKey?.slice(0, 8), videoPath, 'publicBeeKey:', req.publicBeeKey?.slice(0, 16));
  const result = await api.getVideoUrl(req.channelKey, videoPath, req.publicBeeKey);
  console.log('[Worker] Blob URL:', result.url);
  return { url: result.url };
});

rpc.onGetVideoData(async (req: any) => {
  if (isShuttingDown) return { video: { id: req.videoId, title: 'Unknown' } };
  const video = await api.getVideoData(req.channelKey, req.videoId, req.publicBeeKey);
  return { video: video || { id: req.videoId, title: 'Unknown' } };
});

rpc.onUploadVideo(async (req: any) => {
  const active = identityManager.getActiveIdentity();
  if (!active?.driveKey) throw new Error('No active identity');

  const channel = await identityManager.getActiveChannel?.();
  if (!channel) throw new Error('No active channel');

  if (!channel.blobs) throw new Error('Channel blobs not initialized');

  let uploadPath = req.filePath;
  let transcodedPath: string | null = null;
  let mimeType = getMimeTypeFromPath(req.filePath);

  // Check if audio needs transcoding (AC3, DTS, etc. -> AAC)
  const hasFFmpeg = await checkFFmpeg();
  const shouldTranscodeAudio = false; // Disabled for desktop now that mpv is the default player.
  if (hasFFmpeg && shouldTranscodeAudio) {
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

  // Upload the file to Hyperblobs
  const result = await uploadManager.uploadFromPath(
    channel,
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
  if (result.success && result.videoId && !req.skipThumbnailGeneration && hasFFmpeg) {
    console.log('[Worker] Generating FFmpeg thumbnail');
    try {
      const thumbResult = await generateThumbnail(req.filePath, result.videoId, channel);
      if (thumbResult?.thumbnailBlobId) {
        console.log('[Worker] Thumbnail stored with blobId:', thumbResult.thumbnailBlobId);
        // Update video metadata with thumbnail info
        await channel.updateVideo(result.videoId, {
          thumbnailBlobId: thumbResult.thumbnailBlobId,
          thumbnailBlobsCoreKey: thumbResult.thumbnailBlobsCoreKey
        });
      }
    } catch (thumbErr: any) {
      console.warn('[Worker] Thumbnail generation failed:', thumbErr?.message);
    }
  } else if (req.skipThumbnailGeneration) {
    console.log('[Worker] Skipping FFmpeg thumbnail - custom thumbnail will be uploaded');
  }

  console.log('[Worker] Upload result:', JSON.stringify({ success: result.success, videoId: result.videoId, blobId: result.metadata?.blobId }));

  if (!result.success) {
    console.error('[Worker] Upload failed:', result.error);
  }

  return {
    video: {
      id: result.videoId || '',
      title: req.title || '',
      description: req.description || '',
      channelKey: active.driveKey,
    }
  };
});

// Download video - returns URL for web/desktop download
rpc.onDownloadVideo(async (req: any) => {
  console.log('[HRPC] downloadVideo:', req.channelKey?.slice(0, 16), req.videoId, 'publicBeeKey:', req.publicBeeKey?.slice(0, 16));

  try {
    // Use getVideoUrl which handles both local and remote channels
    const result = await api.getVideoUrl(req.channelKey, req.videoId, req.publicBeeKey);
    if (!result?.url) {
      return { success: false, error: 'Failed to get video URL' };
    }

    // Try to get video metadata for size info
    const meta = await api.getVideoData(req.channelKey, req.videoId);
    let size = 0;
    if (meta?.blobId) {
      const parts = meta.blobId.split(':').map(Number);
      if (parts.length === 4) {
        size = parts[3]; // byteLength
      }
    }

    console.log('[HRPC] Download URL:', result.url, 'size:', size);
    return {
      success: true,
      filePath: result.url,
      size: size || meta?.size || 0
    };
  } catch (err: any) {
    console.error('[HRPC] downloadVideo failed:', err?.message);
    return { success: false, error: err?.message || 'download failed' };
  }
});

// Delete video
rpc.onDeleteVideo(async (req: any) => {
  const channel = await identityManager.getActiveChannel?.();
  if (!channel) return { success: false, error: 'No active channel' };
  try {
    await channel.deleteVideo(req.videoId);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Delete failed' };
  }
});

// Video stats
rpc.onPrefetchVideo(async (req: any) => {
  console.log('[Worker] onPrefetchVideo called:', req.channelKey?.slice(0, 16), req.videoId);
  try {
    await api.prefetchVideo(req.channelKey, req.videoId, req.publicBeeKey);
    console.log('[Worker] onPrefetchVideo completed');
  } catch (e: any) {
    console.log('[Worker] onPrefetchVideo error:', e?.message);
  }
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
      publicBeeKey: e.publicBeeKey || '',  // Fast path key for viewers
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

// ============================================
// Comment handlers
// ============================================

rpc.onAddComment(async (req: any) => {
  console.log('[Worker] ===== ADD COMMENT HANDLER CALLED =====');
  console.log('[Worker] addComment req:', JSON.stringify(req));
  console.log('[Worker] api.addComment exists:', typeof api.addComment);

  // Validate required fields first
  if (!req.channelKey || !req.videoId || !req.text) {
    console.log('[Worker] addComment: missing required fields');
    return { success: false, error: 'Missing required fields (channelKey, videoId, or text)' };
  }

  try {
    console.log('[Worker] addComment: calling api.addComment...');
    const result = await api.addComment(req.channelKey, req.videoId, req.text, req.parentId, req.publicBeeKey);
    console.log('[Worker] addComment result:', JSON.stringify(result));
    return { success: result.success, commentId: result.commentId || null, error: result.error };
  } catch (e: any) {
    console.log('[Worker] addComment failed:', e?.message, e?.stack);
    return { success: false, error: e?.message || 'Failed to add comment' };
  }
});

rpc.onListComments(async (req: any) => {
  console.log('[Worker] listComments:', req.channelKey?.slice(0, 16), req.videoId, 'publicBeeKey:', req.publicBeeKey?.slice(0, 16));
  try {
    const result = await api.listComments(req.channelKey, req.videoId, { page: req.page || 0, limit: req.limit || 50, publicBeeKey: req.publicBeeKey });
    const comments = (result.comments || []).map((c: any) => ({
      videoId: req.videoId,
      commentId: c.commentId || c.id || '',
      text: c.text || '',
      authorKeyHex: c.authorKeyHex || c.author || '',
      timestamp: c.timestamp || 0,
      parentId: c.parentId || null,
      isAdmin: Boolean(c.isAdmin)
    }));
    return { success: Boolean(result?.success), comments, error: result?.error || null };
  } catch (e: any) {
    console.log('[Worker] listComments failed:', e?.message);
    return { success: false, comments: [], error: e?.message };
  }
});

rpc.onHideComment(async (req: any) => {
  console.log('[Worker] hideComment:', req.commentId);
  try {
    const result = await api.hideComment(req.channelKey, req.videoId, req.commentId, req.publicBeeKey);
    return { success: result.success, error: result.error };
  } catch (e: any) {
    console.log('[Worker] hideComment failed:', e?.message);
    return { success: false, error: e?.message };
  }
});

rpc.onRemoveComment(async (req: any) => {
  console.log('[Worker] removeComment:', req.commentId);
  try {
    const result = await api.removeComment(req.channelKey, req.videoId, req.commentId, req.publicBeeKey);
    return { success: result.success, error: result.error };
  } catch (e: any) {
    console.log('[Worker] removeComment failed:', e?.message);
    return { success: false, error: e?.message };
  }
});

// ============================================
// Reaction handlers
// ============================================

rpc.onAddReaction(async (req: any) => {
  console.log('[Worker] addReaction:', req.channelKey?.slice(0, 16), req.videoId, req.reactionType, 'publicBeeKey:', req.publicBeeKey?.slice(0, 16));
  try {
    const result = await api.addReaction(req.channelKey, req.videoId, req.reactionType, req.publicBeeKey);
    return { success: result.success, error: result.error };
  } catch (e: any) {
    console.log('[Worker] addReaction failed:', e?.message);
    return { success: false, error: e?.message };
  }
});

rpc.onRemoveReaction(async (req: any) => {
  console.log('[Worker] removeReaction:', req.channelKey?.slice(0, 16), req.videoId, 'publicBeeKey:', req.publicBeeKey?.slice(0, 16));
  try {
    const result = await api.removeReaction(req.channelKey, req.videoId, req.publicBeeKey);
    return { success: result.success, error: result.error };
  } catch (e: any) {
    console.log('[Worker] removeReaction failed:', e?.message);
    return { success: false, error: e?.message };
  }
});

rpc.onGetReactions(async (req: any) => {
  console.log('[Worker] getReactions:', req.channelKey?.slice(0, 16), req.videoId, 'publicBeeKey:', req.publicBeeKey?.slice(0, 16));
  try {
    const result = await api.getReactions(req.channelKey, req.videoId, req.publicBeeKey);
    const countsObj = (result && typeof result === 'object' && result.counts && typeof result.counts === 'object')
      ? result.counts
      : {};
    const counts = Object.entries(countsObj).map(([reactionType, count]) => ({
      reactionType: String(reactionType),
      count: typeof count === 'number' ? count : 0,
    }));

    return { 
      success: Boolean(result?.success), 
      counts, 
      userReaction: result?.userReaction || null,
      error: result?.error || null 
    };
  } catch (e: any) {
    console.log('[Worker] getReactions failed:', e?.message);
    return { success: false, counts: [], userReaction: null, error: e?.message };
  }
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
  if (isShuttingDown) return { url: null, exists: false };

  try {
    // Get video metadata to find thumbnail blob info
    const video = await api.getVideoData(req.channelKey, req.videoId);
    if (!video) return { url: null, exists: false };

    if (video.thumbnailBlobId && video.thumbnailBlobsCoreKey) {
      // New Hyperblobs-based thumbnail
      const blobsCore = ctx.store.get(b4a.from(video.thumbnailBlobsCoreKey, 'hex'));
      await blobsCore.ready();

      // Parse blobId string to blob object
      const parts = video.thumbnailBlobId.split(':').map(Number);
      const blob = {
        blockOffset: parts[0],
        blockLength: parts[1],
        byteOffset: parts[2],
        byteLength: parts[3]
      };

      const url = ctx.blobServer.getLink(blobsCore.key, {
        blob,
        type: 'image/jpeg'
      });
      return { url, exists: true };
    }
  } catch (err: any) {
    console.log('[Worker] Thumbnail fetch error:', err?.message);
  }

  return { url: null, exists: false };
});

rpc.onGetVideoMetadata(async (req: any) => {
  if (isShuttingDown) return { video: { id: req.videoId, title: 'Unknown' } };
  const video = await api.getVideoData(req.channelKey, req.videoId);
  return { video: video || { id: req.videoId, title: 'Unknown' } };
});

rpc.onSetVideoThumbnail(async (req: any) => {
  const active = identityManager.getActiveIdentity();
  if (!active?.driveKey) return { success: false };

  const channel = await identityManager.getActiveChannel?.();
  if (!channel) return { success: false };

  if (!channel.blobs) return { success: false, error: 'Channel blobs not initialized' };

  const imageBuffer = Buffer.from(req.imageData, 'base64');

  // Store thumbnail in Hyperblobs
  const blobResult = await channel.putBlob(imageBuffer);
  console.log('[Worker] Thumbnail stored in Hyperblobs, blobId:', blobResult.id);

  // Update video metadata with thumbnail info
  await channel.updateVideo(req.videoId, {
    thumbnailBlobId: blobResult.id,
    thumbnailBlobsCoreKey: channel.blobsKeyHex
  });

  return { success: true, thumbnailBlobId: blobResult.id };
});

rpc.onSetVideoThumbnailFromFile(async (req: any) => {
  console.log('[Worker] setVideoThumbnailFromFile called:', req.videoId, req.filePath);
  const active = identityManager.getActiveIdentity();
  if (!active?.driveKey) return { success: false };
  const channel = await identityManager.getActiveChannel?.();
  if (!channel) return { success: false };

  if (!channel.blobs) {
    console.error('[Worker] Channel blobs not initialized');
    return { success: false, error: 'Channel blobs not initialized' };
  }

  const imageBuffer = fs.readFileSync(req.filePath);
  console.log('[Worker] Read image file, size:', imageBuffer.length);

  // Store thumbnail in Hyperblobs
  const blobResult = await channel.putBlob(imageBuffer);
  console.log('[Worker] Thumbnail stored in Hyperblobs, blobId:', blobResult.id);

  // Update video metadata with thumbnail info
  await channel.updateVideo(req.videoId, {
    thumbnailBlobId: blobResult.id,
    thumbnailBlobsCoreKey: channel.blobsKeyHex
  });
  console.log('[Worker] Updated video metadata with thumbnail blobId');

  return { success: true, thumbnailBlobId: blobResult.id };
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

// Multi-device pairing
rpc.onCreateDeviceInvite(async (req: any) => {
  console.log('[Worker] createDeviceInvite:', req.channelKey?.slice(0, 16));
  const res = await api.createDeviceInvite(req.channelKey);
  return { inviteCode: res.inviteCode };
});

rpc.onPairDevice(async (req: any) => {
  console.log('[Worker] pairDevice');
  const res = await api.pairDevice(req.inviteCode, req.deviceName || '');
  // If this device doesn't have an identity yet, create one that points at the paired channel.
  try {
    const existing = identityManager.getIdentities?.() || [];
    if (existing.length === 0 && res?.channelKey) {
      await identityManager.addPairedChannelIdentity?.(res.channelKey, 'Paired Channel');
    }
  } catch (e: any) {
    console.log('[Worker] addPairedChannelIdentity skipped:', e?.message);
  }
  return { success: Boolean(res.success), channelKey: res.channelKey };
});

rpc.onListDevices(async (req: any) => {
  console.log('[Worker] listDevices:', req.channelKey?.slice(0, 16));
  const res = await api.listDevices(req.channelKey);
  return { devices: res.devices || [] };
});

rpc.onGlobalSearchVideos(async (req: any) => {
  console.log('[Worker] globalSearchVideos called with:', JSON.stringify(req));
  try {
    const rawResults = await api.globalSearchVideos(req.query, { topK: req.topK || 20 });
    console.log('[Worker] globalSearchVideos got', rawResults.length, 'raw results');
    // Convert results to match the encoding schema (score and metadata as strings)
    const results = rawResults.map((r: any) => ({
      id: String(r.id || ''),
      score: r.score != null ? String(r.score) : null,
      metadata: r.metadata ? JSON.stringify(r.metadata) : null
    }));
    console.log('[Worker] globalSearchVideos returning', results.length, 'results');
    if (results.length > 0) {
      console.log('[Worker] first result:', JSON.stringify(results[0]));
    }
    return { results };
  } catch (err: any) {
    console.error('[Worker] globalSearchVideos error:', err?.message || err);
    return { results: [] };
  }
});

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

// ============================================
// MPV Player RPC Handlers
// ============================================

rpc.onMpvAvailable(async () => {
  await loadBareMpv();
  return { available: MpvPlayer !== null, error: mpvLoadError };
});

rpc.onMpvCreate(async (req: any) => {
  await loadBareMpv();
  if (!MpvPlayer) {
    return { success: false, error: mpvLoadError || 'bare-mpv not available' };
  }
  try {
    const frameServerPort = await ensureMpvFrameServer();
    const playerId = `mpv_${++mpvPlayerIdCounter}`;
    const player = new MpvPlayer();
    const initStatus = player.initialize();
    if (initStatus !== 0) {
      throw new Error(`Failed to initialize mpv: ${initStatus}`);
    }

    // Initialize software renderer at requested size
    const width = req.width || 1280;
    const height = req.height || 720;
    const renderReady = player.initRender(width, height);
    if (!renderReady) {
      throw new Error('Failed to initialize mpv renderer');
    }

    mpvPlayers.set(playerId, {
      player,
      width,
      height,
      lastFrameTime: 0,
    });

    console.log('[Worker] Created mpv player:', playerId, `${width}x${height}`);
    return { success: true, playerId, frameServerPort };
  } catch (err: any) {
    console.error('[Worker] mpvCreate error:', err?.message);
    return { success: false, error: err?.message || 'Failed to create player' };
  }
});

rpc.onMpvLoadFile(async (req: any) => {
  const state = mpvPlayers.get(req.playerId);
  if (!state) {
    return { success: false, error: 'Player not found' };
  }
  try {
    console.log('[Worker] mpv loading:', req.url);
    state.player.loadFile(req.url);
    return { success: true, error: null };
  } catch (err: any) {
    console.error('[Worker] mpvLoadFile error:', err?.message);
    return { success: false, error: err?.message || 'Failed to load file' };
  }
});

rpc.onMpvPlay(async (req: any) => {
  const state = mpvPlayers.get(req.playerId);
  if (!state) return { success: false };
  try {
    state.player.play();
    return { success: true };
  } catch (err) {
    return { success: false };
  }
});

rpc.onMpvPause(async (req: any) => {
  const state = mpvPlayers.get(req.playerId);
  if (!state) return { success: false };
  try {
    state.player.pause();
    return { success: true };
  } catch (err) {
    return { success: false };
  }
});

rpc.onMpvSeek(async (req: any) => {
  const state = mpvPlayers.get(req.playerId);
  if (!state) return { success: false };
  try {
    state.player.seek(req.time);
    return { success: true };
  } catch (err) {
    return { success: false };
  }
});

rpc.onMpvGetState(async (req: any) => {
  const state = mpvPlayers.get(req.playerId);
  if (!state) {
    return { success: false, error: 'Player not found' };
  }
  try {
    return {
      success: true,
      currentTime: state.player.currentTime || 0,
      duration: state.player.duration || 0,
      paused: state.player.paused ?? true,
    };
  } catch (err) {
    return { success: false, error: 'Failed to read player state' };
  }
});

rpc.onMpvRenderFrame(async (req: any) => {
  const state = mpvPlayers.get(req.playerId);
  if (!state) {
    return { success: false, hasFrame: false, frameData: null, error: 'Player not found' };
  }
  try {
    // Check if we need to render a new frame
    if (!state.player.needsRender()) {
      return { success: true, hasFrame: false, frameData: null };
    }

    const frameData = state.player.renderFrame();
    if (!frameData || frameData.length === 0) {
      return { success: true, hasFrame: false, frameData: null };
    }

    // Return as base64 for RPC transport (not ideal but works)
    const base64 = b4a.toString(frameData, 'base64');
    return { success: true, hasFrame: true, frameData: base64, width: state.width, height: state.height };
  } catch (err) {
    return { success: false, hasFrame: false, frameData: null, error: 'Failed to render frame' };
  }
});

rpc.onMpvDestroy(async (req: any) => {
  const state = mpvPlayers.get(req.playerId);
  if (!state) return { success: false };
  try {
    state.player.destroy();
    mpvPlayers.delete(req.playerId);
    console.log('[Worker] Destroyed mpv player:', req.playerId);
    return { success: true };
  } catch (err) {
    mpvPlayers.delete(req.playerId);
    return { success: false };
  }
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
  isShuttingDown = true;

  // Give in-flight RPC handlers a moment to finish
  await new Promise(resolve => setTimeout(resolve, 100));

// Clean up mpv players
for (const [playerId, state] of mpvPlayers) {
  try {
    state.player.destroy();
    console.log('[Worker] Destroyed mpv player on shutdown:', playerId);
    } catch (e) {
      // Ignore errors during cleanup
    }
}
mpvPlayers.clear();

if (mpvFrameServer) {
  try {
    mpvFrameServer.close();
    console.log('[Worker] mpv frame server closed');
  } catch (err: any) {
    console.warn('[Worker] mpv frame server close error:', err?.message);
  }
  mpvFrameServer = null;
  mpvFrameServerPort = 0;
  mpvFrameServerReady = null;
}

  try {
    await ctx.blobServer?.close();
  } catch (e) {
    // Ignore close errors during shutdown
  }
  try {
    await ctx.swarm?.destroy();
  } catch (e) {
    // Ignore close errors during shutdown
  }
});
