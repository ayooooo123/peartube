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
import https from 'bare-https';
import { fileURLToPath } from 'url-file-url';

// Platform detection - bare-mpv is desktop-only (no Android/iOS prebuilds)
const currentPlatform = os.platform();
const isMpvSupported = currentPlatform === 'darwin' || currentPlatform === 'linux' || currentPlatform === 'win32';

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

// Only load bare-mpv on supported platforms (has no Android/iOS prebuilds)
if (isMpvSupported) {
  void loadBareMpv();
} else {
  mpvLoadError = `bare-mpv not available on ${currentPlatform}`;
  console.log(`[Worker] Skipping bare-mpv on ${currentPlatform} (desktop-only)`);
}

// Active mpv player instances (keyed by player ID)
const mpvPlayers = new Map<string, any>();
let mpvPlayerIdCounter = 0;
let mpvFrameServer: any = null;
let mpvFrameServerPort = 0;
let mpvFrameServerReady: Promise<number> | null = null;

let castProxyServer: any = null;
let castProxyPort = 0;
let castProxyReady: Promise<number> | null = null;
const castProxySessions = new Map<string, { url: string; createdAt: number }>();
const CAST_PROXY_TTL_MS = 30 * 60 * 1000;

// Transcode module (runs inline - bare-worker doesn't work in Pear sandbox)
let transcoderInitialized = false;
let transcoderHttpPort = 0;

interface TranscodeSession {
  id: string;
  inputUrl: string;
  status: 'pending' | 'transcoding' | 'complete' | 'error';
  progress: number;
  servingUrl?: string;
  error?: string;
  mode: 'transcode' | 'audio' | 'remux';  // 'audio' = video copy + audio transcode (fast)
}
const transcodeSessions = new Map<string, TranscodeSession>();

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

function cleanupCastProxySessions(now = Date.now()) {
  for (const [token, entry] of castProxySessions.entries()) {
    if (now - entry.createdAt > CAST_PROXY_TTL_MS) {
      castProxySessions.delete(token);
    }
  }
}

function buildLocalProxyTarget(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (CAST_LOCALHOSTS.has(parsed.hostname)) {
      parsed.hostname = '127.0.0.1';
    }
    return parsed;
  } catch {
    return null;
  }
}

async function ensureCastProxyServer(): Promise<number> {
  if (castProxyPort) return castProxyPort;
  if (castProxyReady) return castProxyReady;

  castProxyReady = new Promise((resolve, reject) => {
    castProxyServer = http1.createServer((req: any, res: any) => {
      try {
        console.log('[CastProxy] incoming', req.method || 'GET', req.url || '/');
      } catch {}
      const now = Date.now();
      cleanupCastProxySessions(now);
      const base = 'http://localhost';
      const parsed = new URL(req.url || '/', base);
      if (parsed.pathname === '/cast/ping') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end('pong');
        return;
      }
      const parts = parsed.pathname.split('/').filter(Boolean);
      const token = parts[0] === 'cast' ? parts[1] : null;

      if (!token || !castProxySessions.has(token)) {
        console.warn('[CastProxy] missing token or session', token || 'none');
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Cast proxy session not found.');
        return;
      }

      const entry = castProxySessions.get(token);
      const target = entry ? buildLocalProxyTarget(entry.url) : null;
      if (!target) {
        console.warn('[CastProxy] invalid target url for token', token);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Cast proxy target invalid.');
        return;
      }
      try {
        const remote = req.socket?.remoteAddress || 'unknown';
        console.log('[CastProxy] request from', remote, '->', target.host);
      } catch {}

      const proxyReq = http1.request({
        method: req.method || 'GET',
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        headers: {
          range: req.headers?.range,
        },
      }, (proxyRes: any) => {
        res.statusCode = proxyRes.statusCode || 502;
        try {
          console.log('[CastProxy] upstream status', proxyRes.statusCode, 'len', proxyRes.headers?.['content-length'] || 'unknown');
        } catch {}
        if (proxyRes.headers) {
          for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (value !== undefined) {
              res.setHeader(key, value as any);
            }
          }
        }

        // Handle stream errors to prevent crashes
        proxyRes.on('error', (err: any) => {
          console.warn('[CastProxy] upstream response error:', err?.message || err);
        });
        res.on('error', (err: any) => {
          console.warn('[CastProxy] client response error:', err?.message || err);
          try { proxyRes.destroy(); } catch {}
        });
        res.on('close', () => {
          // Client closed connection, clean up upstream
          try { proxyRes.destroy(); } catch {}
        });

        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err: any) => {
        console.warn('[CastProxy] upstream error:', err?.message || err);
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/plain');
          res.end(`Cast proxy upstream error: ${err?.message || err}`);
          return;
        }
        try { res.end(); } catch {}
      });

      if (req.method === 'HEAD') {
        proxyReq.end();
      } else {
        req.pipe(proxyReq);
      }
    });

    castProxyServer.on('error', (err: any) => {
      console.error('[CastProxy] server error:', err?.message || err);
      reject(err);
    });

    castProxyServer.listen(0, '0.0.0.0', () => {
      const addr = castProxyServer.address?.() || null;
      castProxyPort = addr?.port || 0;
      console.log('[CastProxy] listening on', addr?.address || '0.0.0.0', 'port:', castProxyPort);
      resolve(castProxyPort);
    });
  });

  return castProxyReady;
}

async function createCastProxyUrl(targetHost: string | undefined, sourceUrl: string): Promise<string | null> {
  const localIp = await getLocalIPv4ForTarget(targetHost);
  if (!localIp || !castProxyPort) {
    console.warn('[Worker] Cast proxy unavailable', {
      localIp: localIp || null,
      port: castProxyPort || 0
    });
    return null;
  }
  console.log('[Worker] Cast proxy local IP selected:', localIp, 'targetHost:', targetHost || 'unknown');
  cleanupCastProxySessions();
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  castProxySessions.set(token, { url: sourceUrl, createdAt: Date.now() });
  return `http://${localIp}:${castProxyPort}/cast/${token}`;
}

// ============================================
// Inline Transcoder Module
// (bare-worker doesn't work in Pear's sandboxed environment)
// ============================================

interface InternalTranscodeSession {
  id: string;
  outputPath: string;
  inputUrl: string;
  status: 'starting' | 'transcoding' | 'complete' | 'error';
  progress: number;
  duration: number;
  error?: string;
  mode: 'transcode' | 'audio' | 'remux';  // 'audio' = video copy + audio transcode (fast)
}

const transcoder = (() => {
  const sessions = new Map<string, InternalTranscodeSession>();
  let httpServer: any = null;
  let httpPort = 0;

  // Parse range header for HTTP range requests
  function parseRangeHeader(rangeHeader: string | undefined, fileSize: number): { start: number, end: number } | null {
    if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;
    const range = rangeHeader.slice(6);
    const [startStr, endStr] = range.split('-');
    const start = parseInt(startStr, 10) || 0;
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    if (start >= fileSize || end >= fileSize || start > end) return null;
    return { start, end };
  }

  // Handle HTTP requests for transcoded files
  // Supports both completed files and growing files (live transcoding)
  function handleRequest(req: any, res: any) {
    const url = req.url || '/';
    const match = url.match(/^\/transcode\/([^\/]+)/);
    if (!match) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const sessionId = match[1];
    const session = sessions.get(sessionId);

    if (!session) {
      res.statusCode = 404;
      res.end('Session not found');
      return;
    }

    if (!fs.existsSync(session.outputPath)) {
      res.statusCode = 404;
      res.end('Output file not ready');
      return;
    }

    try {
      const isComplete = session.status === 'complete';

      // For completed files, serve with Content-Length
      if (isComplete) {
        const stat = fs.statSync(session.outputPath);
        const fileSize = stat.size;
        const range = parseRangeHeader(req.headers?.range, fileSize);

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');

        if (range) {
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${fileSize}`);
          res.setHeader('Content-Length', range.end - range.start + 1);
          const stream = fs.createReadStream(session.outputPath, { start: range.start, end: range.end });
          stream.pipe(res);
        } else {
          res.statusCode = 200;
          res.setHeader('Content-Length', fileSize);
          const stream = fs.createReadStream(session.outputPath);
          stream.pipe(res);
        }
        return;
      }

      // For growing files (live transcoding), stream data as it becomes available
      // This is how VLC handles Chromecast streaming
      console.log('[Transcoder] Streaming growing file to Chromecast, status:', session.status);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.statusCode = 200;

      let position = 0;
      let noDataCount = 0;
      const MAX_NO_DATA_ITERATIONS = 120; // ~60 seconds max wait for new data

      const streamData = () => {
        // Check if response is still valid
        if (res.destroyed || res.writableEnded) {
          console.log('[Transcoder] Response closed, stopping stream');
          return;
        }

        // Re-fetch session to get current status
        const currentSession = sessions.get(sessionId);
        if (!currentSession) {
          console.log('[Transcoder] Session gone, closing stream');
          try { res.end(); } catch {}
          return;
        }

        try {
          if (!fs.existsSync(currentSession.outputPath)) {
            // File not created yet
            noDataCount++;
            if (noDataCount >= MAX_NO_DATA_ITERATIONS) {
              console.warn('[Transcoder] File never created, closing stream');
              try { res.end(); } catch {}
              return;
            }
            setTimeout(streamData, 500);
            return;
          }

          const stat = fs.statSync(currentSession.outputPath);
          const currentSize = stat.size;

          if (currentSize > position) {
            // New data available, read and send it
            noDataCount = 0;
            const bytesToRead = Math.min(currentSize - position, 1024 * 1024); // Max 1MB per chunk
            const buffer = Buffer.alloc(bytesToRead);
            const fd = fs.openSync(currentSession.outputPath, 'r');
            fs.readSync(fd, buffer, 0, bytesToRead, position);
            fs.closeSync(fd);

            position += bytesToRead;

            res.write(buffer, (err: any) => {
              if (err) {
                console.warn('[Transcoder] Write error:', err?.message);
                return;
              }
              // Continue streaming quickly when there's data
              setTimeout(streamData, 50);
            });
          } else if (currentSession.status === 'complete') {
            // Transcoding finished, close the response
            console.log('[Transcoder] Transcode complete, closing stream. Total bytes sent:', position);
            try { res.end(); } catch {}
          } else if (currentSession.status === 'error') {
            // Error occurred
            console.warn('[Transcoder] Transcode error, closing stream:', currentSession.error);
            try { res.end(); } catch {}
          } else {
            // No new data yet, wait and retry
            noDataCount++;
            if (noDataCount >= MAX_NO_DATA_ITERATIONS) {
              console.warn('[Transcoder] No data for too long, closing stream');
              try { res.end(); } catch {}
              return;
            }
            setTimeout(streamData, 500);
          }
        } catch (err: any) {
          console.error('[Transcoder] Stream error:', err?.message);
          try { res.end(); } catch {}
        }
      };

      // Start streaming
      streamData();
    } catch (err: any) {
      console.error('[Transcoder] Error serving file:', err?.message);
      res.statusCode = 500;
      res.end('Error serving file');
    }
  }

  // VLC-style streaming transcode: FFmpeg reads from URL directly (no pre-download)
  // This enables real-time transcoding while downloading, like VLC does for Chromecast
  async function streamingTranscodeFromUrl(
    session: InternalTranscodeSession,
    inputUrl: string,
    mode: 'transcode' | 'audio' | 'remux',
    onProgress?: (percent: number) => void
  ): Promise<void> {
    console.log(`[Transcoder] VLC-style streaming ${mode} from URL:`, inputUrl);

    return new Promise((resolve, reject) => {
      // Build FFmpeg args based on mode
      const platform = os.platform();
      const args = [
        '-y',
        '-hide_banner',
        '-loglevel', 'info',
      ];

      // Add hardware-accelerated decoding for supported platforms
      if (platform === 'darwin') {
        // macOS: Use VideoToolbox for hardware decoding (HEVC, H.264, etc.)
        args.push('-hwaccel', 'videotoolbox');
      }

      args.push('-i', inputUrl);

      if (mode === 'remux') {
        // Just copy streams, change container to MP4
        args.push('-c:v', 'copy', '-c:a', 'copy');
      } else if (mode === 'audio') {
        // Copy video, transcode audio to AAC
        args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
      } else {
        // Full transcode: H.264 + AAC with hardware acceleration when available
        if (platform === 'darwin') {
          // macOS: Use VideoToolbox hardware encoder (GPU accelerated)
          console.log('[Transcoder] Using VideoToolbox hardware acceleration (macOS)');
          args.push(
            '-c:v', 'h264_videotoolbox',
            '-profile:v', 'main',
            '-level:v', '4.0',
            '-b:v', '6M',            // VideoToolbox works better with slightly higher bitrate
            '-maxrate', '8M',
            '-pix_fmt', 'nv12',      // VideoToolbox prefers nv12
            '-allow_sw', '1',        // Allow software fallback if HW fails
            '-realtime', '1',        // Optimize for real-time encoding
            '-c:a', 'aac',
            '-b:a', '192k',
            '-ar', '48000',
            '-ac', '2'
          );
        } else if (platform === 'linux') {
          // Linux: Try VAAPI or NVENC, fallback to software
          console.log('[Transcoder] Using software encoding (Linux - TODO: add VAAPI/NVENC)');
          args.push(
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-profile:v', 'main',
            '-level:v', '4.0',
            '-pix_fmt', 'yuv420p',
            '-b:v', '4M',
            '-maxrate', '5M',
            '-bufsize', '10M',
            '-g', '50',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-ar', '48000',
            '-ac', '2'
          );
        } else if (platform === 'win32') {
          // Windows: Try NVENC or QSV, fallback to software
          console.log('[Transcoder] Using software encoding (Windows - TODO: add NVENC/QSV)');
          args.push(
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-profile:v', 'main',
            '-level:v', '4.0',
            '-pix_fmt', 'yuv420p',
            '-b:v', '4M',
            '-maxrate', '5M',
            '-bufsize', '10M',
            '-g', '50',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-ar', '48000',
            '-ac', '2'
          );
        } else {
          // Unknown platform: software encoding
          args.push(
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-profile:v', 'main',
            '-level:v', '4.0',
            '-pix_fmt', 'yuv420p',
            '-b:v', '4M',
            '-maxrate', '5M',
            '-bufsize', '10M',
            '-g', '50',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-ar', '48000',
            '-ac', '2'
          );
        }
      }

      // Fragmented MP4 for streaming - enables playback before transcode completes
      // Using frag_every_frame for smoother streaming
      args.push(
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
        '-frag_duration', '1000000',  // 1 second fragments
        '-f', 'mp4',
        session.outputPath
      );

      console.log('[Transcoder] FFmpeg args:', args.join(' '));

      const proc = spawn('ffmpeg', args);
      let lastProgress = 0;
      let duration = 0;

      proc.stderr.on('data', (chunk: Buffer) => {
        const msg = chunk.toString();

        // Parse duration from input analysis
        const durationMatch = msg.match(/Duration:\s*(\d+):(\d+):(\d+)/);
        if (durationMatch && duration === 0) {
          duration = parseInt(durationMatch[1]) * 3600 +
                     parseInt(durationMatch[2]) * 60 +
                     parseInt(durationMatch[3]);
          session.duration = duration;
        }

        // Parse current time for progress
        const timeMatch = msg.match(/time=(\d+):(\d+):(\d+)/);
        if (timeMatch && duration > 0) {
          const currentTime = parseInt(timeMatch[1]) * 3600 +
                              parseInt(timeMatch[2]) * 60 +
                              parseInt(timeMatch[3]);
          const progress = Math.min(99, Math.round((currentTime / duration) * 100));
          if (progress > lastProgress) {
            lastProgress = progress;
            session.progress = progress;
            onProgress?.(progress);
          }
        }

        // Check for errors
        if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid')) {
          console.warn('[Transcoder] FFmpeg warning/error:', msg.trim());
        }
      });

      proc.on('exit', (code: number) => {
        if (code === 0) {
          session.progress = 100;
          onProgress?.(100);
          console.log('[Transcoder] Streaming transcode complete');
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      proc.on('error', (err: Error) => {
        reject(new Error(`FFmpeg spawn error: ${err.message}`));
      });
    });
  }

  // Download source to temp file (streaming to disk, not memory)
  async function downloadToTempFile(url: string, destPath: string, onProgress?: (bytes: number) => void): Promise<number> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http1;

      const doRequest = (requestUrl: string) => {
        const req = protocol.get(requestUrl, (res: any) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doRequest(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const writeStream = fs.createWriteStream(destPath);
          let bytesWritten = 0;

          res.on('data', (chunk: Buffer) => {
            writeStream.write(chunk);
            bytesWritten += chunk.length;
            onProgress?.(bytesWritten);
          });

          res.on('end', () => {
            writeStream.end(() => {
              console.log('[Transcoder] Download complete:', bytesWritten, 'bytes');
              resolve(bytesWritten);
            });
          });

          res.on('error', (err: Error) => {
            writeStream.destroy();
            reject(err);
          });
        });
        req.on('error', reject);
      };

      doRequest(url);
    });
  }

  // Create streaming IOContext that reads from file with onread/onseek callbacks
  function createFileReadIOContext(filePath: string, fileSize: number): any {
    const fd = fs.openSync(filePath, 'r');
    let currentPos = 0;

    const ioContext = new ffmpeg.IOContext(16384, {
      onread: (buffer: Buffer) => {
        if (currentPos >= fileSize) return 0; // EOF
        const bytesToRead = Math.min(buffer.length, fileSize - currentPos);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, currentPos);
        currentPos += bytesRead;
        return bytesRead;
      },
      onseek: (offset: number, whence: number) => {
        const SEEK_SET = 0, SEEK_CUR = 1, SEEK_END = 2, AVSEEK_SIZE = 0x10000;
        if (whence === AVSEEK_SIZE) return fileSize;
        if (whence === SEEK_SET) currentPos = offset;
        else if (whence === SEEK_CUR) currentPos += offset;
        else if (whence === SEEK_END) currentPos = fileSize + offset;
        return currentPos;
      }
    });

    // Attach cleanup function
    (ioContext as any)._cleanup = () => {
      try { fs.closeSync(fd); } catch (e) {}
    };

    return ioContext;
  }

  // Create streaming IOContext that writes to file with onwrite callback
  function createFileWriteIOContext(filePath: string): { io: any, getSize: () => number } {
    const fd = fs.openSync(filePath, 'w');
    let bytesWritten = 0;

    const ioContext = new ffmpeg.IOContext(Buffer.alloc(16384), {
      onwrite: (chunk: Buffer) => {
        fs.writeSync(fd, chunk);
        bytesWritten += chunk.length;
      }
    });

    // Attach cleanup function
    (ioContext as any)._cleanup = () => {
      try { fs.closeSync(fd); } catch (e) {}
    };

    return {
      io: ioContext,
      getSize: () => bytesWritten
    };
  }

  // Remux using bare-ffmpeg with streaming I/O
  async function remuxWithStreaming(session: InternalTranscodeSession, inputPath: string, inputSize: number): Promise<void> {
    if (!ffmpeg) throw new Error('bare-ffmpeg not loaded');
    console.log('[Transcoder] Starting streaming remux');

    const inputIO = createFileReadIOContext(inputPath, inputSize);
    const inputFmt = new ffmpeg.InputFormatContext(inputIO);
    await inputFmt.openInput();
    await inputFmt.findStreamInfo();

    const { io: outputIO, getSize } = createFileWriteIOContext(session.outputPath);
    const outputFmt = new ffmpeg.OutputFormatContext('mp4', outputIO);

    for (let i = 0; i < inputFmt.streams.length; i++) {
      outputFmt.addStream(inputFmt.streams[i].codecParameters);
    }

    await outputFmt.writeHeader({ movflags: 'frag_keyframe+empty_moov+default_base_moof' });

    const packet = new ffmpeg.Packet();
    let packetsProcessed = 0;

    while (true) {
      const ret = await inputFmt.readFrame(packet);
      if (ret < 0) break;
      packetsProcessed++;
      if (packetsProcessed % 100 === 0) {
        session.progress = Math.min(95, (packetsProcessed / 1000) * 10);
      }
      await outputFmt.writeFrame(packet);
      packet.unref();
    }

    await outputFmt.writeTrailer();

    // Cleanup
    inputIO._cleanup?.();
    outputIO._cleanup?.();

    console.log('[Transcoder] Remux complete, output size:', getSize());
  }

  // Audio-only transcode (copy video stream, transcode audio to AAC) - FAST!
  async function transcodeAudioWithStreaming(session: InternalTranscodeSession, inputPath: string, inputSize: number): Promise<void> {
    if (!ffmpeg) throw new Error('bare-ffmpeg not loaded');
    console.log('[Transcoder] Starting audio-only transcode (video copy)');

    const inputIO = createFileReadIOContext(inputPath, inputSize);
    const inputFmt = new ffmpeg.InputFormatContext(inputIO);
    await inputFmt.openInput();
    await inputFmt.findStreamInfo();

    const { io: outputIO, getSize } = createFileWriteIOContext(session.outputPath);
    const outputFmt = new ffmpeg.OutputFormatContext('mp4', outputIO);

    let audioStreamIndex = -1;
    let audioDecoder: any = null;
    let audioEncoder: any = null;
    let resampler: any = null;

    // Set up streams
    for (let i = 0; i < inputFmt.streams.length; i++) {
      const inStream = inputFmt.streams[i];
      const codecType = inStream.codecParameters.codecType;

      if (codecType === ffmpeg.constants.mediaTypes.AUDIO && audioStreamIndex === -1) {
        audioStreamIndex = i;
        const decoderCodec = new ffmpeg.Codec(inStream.codecParameters.id);
        audioDecoder = new ffmpeg.CodecContext(decoderCodec);
        audioDecoder.setParameters(inStream.codecParameters);
        await audioDecoder.open();

        const encoderCodec = new ffmpeg.Codec(ffmpeg.constants.codecs.AAC);
        audioEncoder = new ffmpeg.CodecContext(encoderCodec);
        audioEncoder.sampleRate = 48000;
        audioEncoder.channelLayout = ffmpeg.constants.channelLayouts.STEREO;
        audioEncoder.sampleFormat = ffmpeg.constants.sampleFormats.FLTP;
        audioEncoder.bitRate = 192000;
        await audioEncoder.open();

        if (audioDecoder.sampleRate !== audioEncoder.sampleRate ||
            audioDecoder.channelLayout !== audioEncoder.channelLayout ||
            audioDecoder.sampleFormat !== audioEncoder.sampleFormat) {
          resampler = new ffmpeg.Resampler(
            audioDecoder.channelLayout, audioDecoder.sampleFormat, audioDecoder.sampleRate,
            audioEncoder.channelLayout, audioEncoder.sampleFormat, audioEncoder.sampleRate
          );
        }
        outputFmt.addStream(audioEncoder.codecParameters);
      } else {
        // Copy video and other streams directly
        outputFmt.addStream(inStream.codecParameters);
      }
    }

    await outputFmt.writeHeader({ movflags: 'frag_keyframe+empty_moov+default_base_moof' });

    const packet = new ffmpeg.Packet();
    const frame = new ffmpeg.Frame();
    let packetsProcessed = 0;

    while (true) {
      const ret = await inputFmt.readFrame(packet);
      if (ret < 0) break;
      packetsProcessed++;
      if (packetsProcessed % 100 === 0) {
        session.progress = Math.min(95, (packetsProcessed / 1000) * 10);
      }

      if (packet.streamIndex === audioStreamIndex && audioDecoder && audioEncoder) {
        // Transcode audio
        await audioDecoder.sendPacket(packet);
        while (true) {
          const decRet = await audioDecoder.receiveFrame(frame);
          if (decRet < 0) break;
          let processedFrame = frame;
          if (resampler) processedFrame = await resampler.convert(frame);
          await audioEncoder.sendFrame(processedFrame);
          const outPacket = new ffmpeg.Packet();
          while (true) {
            const encRet = await audioEncoder.receivePacket(outPacket);
            if (encRet < 0) break;
            await outputFmt.writeFrame(outPacket);
            outPacket.unref();
          }
          frame.unref();
        }
      } else {
        // Copy video/other packets directly (no transcoding)
        await outputFmt.writeFrame(packet);
      }
      packet.unref();
    }

    // Flush audio encoder
    if (audioEncoder) {
      await audioEncoder.sendFrame(null);
      const flushPacket = new ffmpeg.Packet();
      while (true) {
        const encRet = await audioEncoder.receivePacket(flushPacket);
        if (encRet < 0) break;
        await outputFmt.writeFrame(flushPacket);
        flushPacket.unref();
      }
    }

    await outputFmt.writeTrailer();
    inputIO._cleanup?.();
    outputIO._cleanup?.();
    console.log('[Transcoder] Audio transcode complete, output size:', getSize());
  }

  // Full transcode with streaming I/O (video to H.264, audio to AAC)
  async function transcodeWithStreaming(session: InternalTranscodeSession, inputPath: string, inputSize: number): Promise<void> {
    if (!ffmpeg) throw new Error('bare-ffmpeg not loaded');
    console.log('[Transcoder] Starting full transcode with streaming I/O');

    const inputIO = createFileReadIOContext(inputPath, inputSize);
    const inputFmt = new ffmpeg.InputFormatContext(inputIO);
    await inputFmt.openInput();
    await inputFmt.findStreamInfo();

    const { io: outputIO, getSize } = createFileWriteIOContext(session.outputPath);
    const outputFmt = new ffmpeg.OutputFormatContext('mp4', outputIO);

    let videoStreamIndex = -1;
    let audioStreamIndex = -1;
    let videoDecoder: any = null;
    let videoEncoder: any = null;
    let audioDecoder: any = null;
    let audioEncoder: any = null;
    let scaler: any = null;
    let resampler: any = null;

    for (let i = 0; i < inputFmt.streams.length; i++) {
      const inStream = inputFmt.streams[i];
      const codecType = inStream.codecParameters.codecType;

      if (codecType === ffmpeg.constants.mediaTypes.VIDEO && videoStreamIndex === -1) {
        videoStreamIndex = i;
        const decoderCodec = new ffmpeg.Codec(inStream.codecParameters.id);
        videoDecoder = new ffmpeg.CodecContext(decoderCodec);
        videoDecoder.setParameters(inStream.codecParameters);
        await videoDecoder.open();

        // Try hardware encoder first (VideoToolbox on macOS, NVENC on NVIDIA)
        let useHardware = false;
        const platform = os.platform();
        let encoderCodec: any;

        if (platform === 'darwin') {
          try {
            encoderCodec = new ffmpeg.Codec('h264_videotoolbox');
            console.log('[Transcoder] Trying VideoToolbox hardware encoder...');
            useHardware = true;
          } catch (e: any) {
            console.log('[Transcoder] VideoToolbox not available:', e?.message || e);
          }
        } else if (platform === 'linux' || platform === 'win32') {
          try {
            encoderCodec = new ffmpeg.Codec('h264_nvenc');
            console.log('[Transcoder] Trying NVENC hardware encoder...');
            useHardware = true;
          } catch (e: any) {
            console.log('[Transcoder] NVENC not available:', e?.message || e);
          }
        }

        if (!encoderCodec) {
          encoderCodec = new ffmpeg.Codec(ffmpeg.constants.codecs.H264);
          console.log('[Transcoder] Using software x264 encoder');
        }

        videoEncoder = new ffmpeg.CodecContext(encoderCodec);
        videoEncoder.width = videoDecoder.width;
        videoEncoder.height = videoDecoder.height;
        videoEncoder.pixelFormat = ffmpeg.constants.pixelFormats.YUV420P;
        videoEncoder.timeBase = { num: 1, den: 30 };
        videoEncoder.bitRate = 6000000; // 6 Mbps (slightly lower for faster encoding)
        videoEncoder.gopSize = 30;
        videoEncoder.maxBFrames = 2;

        if (!useHardware) {
          // Software encoder - use ultrafast preset for speed
          videoEncoder.setOption('profile', 'high');
          videoEncoder.setOption('level', '4.1');
          videoEncoder.setOption('preset', 'ultrafast');
          videoEncoder.setOption('tune', 'zerolatency');
        }

        try {
          await videoEncoder.open();
          console.log('[Transcoder] Encoder opened:', useHardware ? 'hardware' : 'software (ultrafast)');
        } catch (hwErr: any) {
          if (useHardware) {
            console.warn('[Transcoder] Hardware encoder failed to open, falling back to software:', hwErr?.message);
            // Fallback to software
            encoderCodec = new ffmpeg.Codec(ffmpeg.constants.codecs.H264);
            videoEncoder = new ffmpeg.CodecContext(encoderCodec);
            videoEncoder.width = videoDecoder.width;
            videoEncoder.height = videoDecoder.height;
            videoEncoder.pixelFormat = ffmpeg.constants.pixelFormats.YUV420P;
            videoEncoder.timeBase = { num: 1, den: 30 };
            videoEncoder.bitRate = 6000000;
            videoEncoder.gopSize = 30;
            videoEncoder.maxBFrames = 2;
            videoEncoder.setOption('profile', 'high');
            videoEncoder.setOption('level', '4.1');
            videoEncoder.setOption('preset', 'ultrafast');
            videoEncoder.setOption('tune', 'zerolatency');
            await videoEncoder.open();
            console.log('[Transcoder] Fallback to software encoder successful');
          } else {
            throw hwErr;
          }
        }

        if (videoDecoder.pixelFormat !== videoEncoder.pixelFormat) {
          scaler = new ffmpeg.Scaler(
            videoDecoder.width, videoDecoder.height, videoDecoder.pixelFormat,
            videoEncoder.width, videoEncoder.height, videoEncoder.pixelFormat
          );
        }
        outputFmt.addStream(videoEncoder.codecParameters);

      } else if (codecType === ffmpeg.constants.mediaTypes.AUDIO && audioStreamIndex === -1) {
        audioStreamIndex = i;
        const decoderCodec = new ffmpeg.Codec(inStream.codecParameters.id);
        audioDecoder = new ffmpeg.CodecContext(decoderCodec);
        audioDecoder.setParameters(inStream.codecParameters);
        await audioDecoder.open();

        const encoderCodec = new ffmpeg.Codec(ffmpeg.constants.codecs.AAC);
        audioEncoder = new ffmpeg.CodecContext(encoderCodec);
        audioEncoder.sampleRate = 48000;
        audioEncoder.channelLayout = ffmpeg.constants.channelLayouts.STEREO;
        audioEncoder.sampleFormat = ffmpeg.constants.sampleFormats.FLTP;
        audioEncoder.bitRate = 192000;
        await audioEncoder.open();

        if (audioDecoder.sampleRate !== audioEncoder.sampleRate ||
            audioDecoder.channelLayout !== audioEncoder.channelLayout ||
            audioDecoder.sampleFormat !== audioEncoder.sampleFormat) {
          resampler = new ffmpeg.Resampler(
            audioDecoder.channelLayout, audioDecoder.sampleFormat, audioDecoder.sampleRate,
            audioEncoder.channelLayout, audioEncoder.sampleFormat, audioEncoder.sampleRate
          );
        }
        outputFmt.addStream(audioEncoder.codecParameters);
      }
    }

    await outputFmt.writeHeader({ movflags: 'frag_keyframe+empty_moov+default_base_moof' });

    const packet = new ffmpeg.Packet();
    const frame = new ffmpeg.Frame();
    let packetsProcessed = 0;

    while (true) {
      const ret = await inputFmt.readFrame(packet);
      if (ret < 0) break;
      packetsProcessed++;
      if (packetsProcessed % 50 === 0) {
        session.progress = Math.min(95, packetsProcessed / 20);
      }

      if (packet.streamIndex === videoStreamIndex && videoDecoder && videoEncoder) {
        await videoDecoder.sendPacket(packet);
        while (true) {
          const decRet = await videoDecoder.receiveFrame(frame);
          if (decRet < 0) break;
          let processedFrame = frame;
          if (scaler) processedFrame = await scaler.scale(frame);
          await videoEncoder.sendFrame(processedFrame);
          const outPacket = new ffmpeg.Packet();
          while (true) {
            const encRet = await videoEncoder.receivePacket(outPacket);
            if (encRet < 0) break;
            outPacket.streamIndex = 0;
            await outputFmt.writeFrame(outPacket);
            outPacket.unref();
          }
          frame.unref();
        }
      } else if (packet.streamIndex === audioStreamIndex && audioDecoder && audioEncoder) {
        await audioDecoder.sendPacket(packet);
        while (true) {
          const decRet = await audioDecoder.receiveFrame(frame);
          if (decRet < 0) break;
          let processedFrame = frame;
          if (resampler) processedFrame = await resampler.convert(frame);
          await audioEncoder.sendFrame(processedFrame);
          const outPacket = new ffmpeg.Packet();
          while (true) {
            const encRet = await audioEncoder.receivePacket(outPacket);
            if (encRet < 0) break;
            outPacket.streamIndex = 1;
            await outputFmt.writeFrame(outPacket);
            outPacket.unref();
          }
          frame.unref();
        }
      }
      packet.unref();
    }

    // Flush encoders
    if (videoEncoder) {
      await videoEncoder.sendFrame(null);
      const flushPacket = new ffmpeg.Packet();
      while (true) {
        const encRet = await videoEncoder.receivePacket(flushPacket);
        if (encRet < 0) break;
        flushPacket.streamIndex = 0;
        await outputFmt.writeFrame(flushPacket);
        flushPacket.unref();
      }
    }
    if (audioEncoder) {
      await audioEncoder.sendFrame(null);
      const flushPacket = new ffmpeg.Packet();
      while (true) {
        const encRet = await audioEncoder.receivePacket(flushPacket);
        if (encRet < 0) break;
        flushPacket.streamIndex = 1;
        await outputFmt.writeFrame(flushPacket);
        flushPacket.unref();
      }
    }

    await outputFmt.writeTrailer();

    // Cleanup
    inputIO._cleanup?.();
    outputIO._cleanup?.();

    console.log('[Transcoder] Transcode complete, output size:', getSize());
  }

  return {
    async initHttpServer(): Promise<number> {
      if (httpServer && httpPort > 0) return httpPort;
      return new Promise((resolve, reject) => {
        try {
          httpServer = http1.createServer(handleRequest);
          httpServer.listen(0, '127.0.0.1', () => {
            const addr = httpServer.address();
            httpPort = typeof addr === 'object' ? addr.port : 0;
            console.log('[Transcoder] HTTP server listening on port:', httpPort);
            resolve(httpPort);
          });
        } catch (err: any) {
          console.error('[Transcoder] Failed to start HTTP server:', err?.message);
          reject(err);
        }
      });
    },

    async startTranscode(
      id: string,
      inputUrl: string,
      mode: 'transcode' | 'audio' | 'remux',
      onProgress?: (sessionId: string, progress: number) => void
    ): Promise<{ sessionId: string, servingUrl: string }> {
      const port = await this.initHttpServer();
      const tmpDir = os.tmpdir();
      const outputPath = path.join(tmpDir, `transcode_${id}.mp4`);

      const session: InternalTranscodeSession = {
        id, outputPath, inputUrl,
        status: 'starting', progress: 0, duration: 0, mode,
      };
      sessions.set(id, session);

      // VLC-style: Start transcoding in background - FFmpeg reads directly from URL
      // No pre-download needed! This enables real-time transcoding like VLC.
      (async () => {
        try {
          session.status = 'transcoding';

          // Stream transcode: FFmpeg reads URL directly, outputs fragmented MP4
          // Chromecast can start playing as soon as first fragments are written
          console.log(`[Transcoder] Starting VLC-style streaming ${mode}...`);
          await streamingTranscodeFromUrl(
            session,
            inputUrl,
            mode,
            (progress) => onProgress?.(id, progress)
          );

          session.status = 'complete';
          session.progress = 100;
          onProgress?.(id, 100);
        } catch (err: any) {
          console.error('[Transcoder] Error:', err?.message || err);
          session.status = 'error';
          session.error = err?.message || 'Transcode failed';
        }
      })();

      // Progress reporting
      if (onProgress) {
        const progressInterval = setInterval(() => {
          const s = sessions.get(id);
          if (!s || s.status === 'complete' || s.status === 'error') {
            clearInterval(progressInterval);
            return;
          }
          onProgress(id, s.progress);
        }, 1000);
      }

      return { sessionId: id, servingUrl: `http://127.0.0.1:${port}/transcode/${id}` };
    },

    stopTranscode(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (session) {
        try {
          // Clean up output file
          if (fs.existsSync(session.outputPath)) {
            fs.unlinkSync(session.outputPath);
          }
        } catch (err) {
          console.warn('[Transcoder] Failed to clean up files:', err);
        }
        sessions.delete(sessionId);
      }
    },

    getSessionStatus(sessionId: string): InternalTranscodeSession | null {
      return sessions.get(sessionId) || null;
    },

    getHttpPort(): number {
      return httpPort;
    }
  };
})();

// ============================================
// Transcode Worker Integration
// ============================================

// Initialize inline transcoder (bare-worker doesn't work in Pear sandbox)
async function ensureTranscoder(): Promise<number> {
  if (transcoderInitialized && transcoderHttpPort > 0) {
    return transcoderHttpPort;
  }

  try {
    transcoderHttpPort = await transcoder.initHttpServer();
    transcoderInitialized = true;
    console.log('[Transcoder] initialized on port:', transcoderHttpPort);
    return transcoderHttpPort;
  } catch (err: any) {
    console.error('[Transcoder] failed to initialize:', err?.message || err);
    throw err;
  }
}

// Progress callback for transcoding
function handleTranscodeProgress(sessionId: string, progress: number) {
  const session = transcodeSessions.get(sessionId);
  if (session) {
    session.progress = progress;
  }
  // Emit progress event to UI
  try {
    rpc?.eventTranscodeProgress?.({
      sessionId,
      percent: progress,
      bytesWritten: 0,
    });
  } catch (e) {
    // RPC may not be ready yet
  }
}

// Clean up transcode sessions
function cleanupTranscodeSessions() {
  for (const [id] of transcodeSessions) {
    try {
      transcoder.stopTranscode(id);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
  transcodeSessions.clear();
}

// Check if content type/codec requires transcoding for Chromecast
// Chromecast supports: H.264 (up to 4.1), AAC, MP3
// Chromecast does NOT support: HEVC/H.265, VP9 (on some devices), AC3, DTS, MKV container
const CHROMECAST_UNSUPPORTED_CONTENT_TYPES = [
  'video/x-matroska',
  'video/mkv',
  'video/hevc',
  'video/x-hevc',
  'audio/ac3',
  'audio/eac3',
  'audio/dts',
];

const CHROMECAST_UNSUPPORTED_EXTENSIONS = [
  '.mkv',
  '.avi',
  '.wmv',
  '.flv',
  '.ts',
  '.m2ts',
];

// Chromecast supported video codecs
const CHROMECAST_SUPPORTED_VIDEO_CODECS = [
  'h264', 'avc1', 'avc',
  'vp8',
  'vp9', // Some Chromecasts support VP9
];

// Chromecast supported audio codecs
const CHROMECAST_SUPPORTED_AUDIO_CODECS = [
  'aac', 'mp4a',
  'mp3', 'mp3float',
  'vorbis',
  'opus',
  'flac', // Chromecast Ultra supports FLAC
];

interface ProbeResult {
  videoCodec: string | null;
  audioCodec: string | null;
  videoProfile: string | null;  // H.264 profile (Baseline, Main, High, High 10, etc.)
  videoLevel: number | null;     // H.264 level (4.1, 5.0, etc.)
  container: string | null;      // Detected container format (mp4, mkv, etc.)
  duration: number;
  needsTranscode: boolean;       // Any codec needs re-encoding
  needsVideoTranscode: boolean;  // Video specifically needs re-encoding
  needsAudioTranscode: boolean;  // Audio specifically needs re-encoding
  needsRemux: boolean;           // Just need container change (fast copy)
  reason: string;
}

// Probe a media file to get codec information using FFmpeg
async function probeMediaCodecs(url: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const result: ProbeResult = {
      videoCodec: null,
      audioCodec: null,
      videoProfile: null,
      videoLevel: null,
      container: null,
      duration: 0,
      needsTranscode: false,
      needsVideoTranscode: false,
      needsAudioTranscode: false,
      needsRemux: false,
      reason: '',
    };

    try {
      // Use ffprobe if available, otherwise ffmpeg -i
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        url
      ];

      const proc = spawn('ffprobe', args);
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('exit', (code: number) => {
        if (code !== 0) {
          console.warn('[Worker] ffprobe failed, trying ffmpeg -i');
          // Fallback to ffmpeg -i
          probeWithFfmpeg(url).then(resolve);
          return;
        }

        try {
          const data = JSON.parse(stdout);

          // Extract container format
          if (data.format?.format_name) {
            result.container = data.format.format_name.toLowerCase();
          }

          // Extract codec info from streams
          for (const stream of data.streams || []) {
            if (stream.codec_type === 'video' && !result.videoCodec) {
              result.videoCodec = stream.codec_name?.toLowerCase() || null;
              // Extract H.264 profile and level
              if (stream.profile) {
                result.videoProfile = stream.profile;
              }
              if (stream.level !== undefined) {
                // FFprobe returns level as integer (41 = 4.1, 50 = 5.0)
                result.videoLevel = stream.level / 10;
              }
            }
            if (stream.codec_type === 'audio' && !result.audioCodec) {
              result.audioCodec = stream.codec_name?.toLowerCase() || null;
            }
          }

          // Extract duration from format
          if (data.format?.duration) {
            result.duration = parseFloat(data.format.duration) || 0;
          }

          // Check if transcoding/remuxing is needed
          checkTranscodeNeeded(result, url);
          resolve(result);
        } catch (err) {
          console.warn('[Worker] Failed to parse ffprobe output:', err);
          resolve(result);
        }
      });

      proc.on('error', () => {
        // ffprobe not available, try ffmpeg
        probeWithFfmpeg(url).then(resolve);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        try { proc.kill(); } catch {}
        resolve(result);
      }, 10000);

    } catch (err) {
      console.error('[Worker] Probe error:', err);
      resolve(result);
    }
  });
}

// Fallback probe using ffmpeg -i
async function probeWithFfmpeg(url: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const result: ProbeResult = {
      videoCodec: null,
      audioCodec: null,
      videoProfile: null,
      videoLevel: null,
      container: null,
      duration: 0,
      needsTranscode: false,
      needsVideoTranscode: false,
      needsAudioTranscode: false,
      needsRemux: false,
      reason: '',
    };

    try {
      const args = ['-i', url, '-f', 'null', '-'];
      const proc = spawn('ffmpeg', args);
      let stderr = '';

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('exit', () => {
        // Parse ffmpeg output for codec info
        // Example: Stream #0:0: Video: h264 (High), yuv420p, 1920x1080
        // Example: Stream #0:0: Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p10le
        // Example: Stream #0:1: Audio: ac3, 48000 Hz, 5.1, fltp, 640 kb/s

        // Extended regex to capture profile in parentheses
        const videoMatch = stderr.match(/Stream.*Video:\s*(\w+)(?:\s*\(([^)]+)\))?/i);
        if (videoMatch) {
          result.videoCodec = videoMatch[1].toLowerCase();
          // Extract profile from parentheses (e.g., "High", "High 10", "Main")
          if (videoMatch[2]) {
            const profile = videoMatch[2].split(/[,\/]/)[0].trim();
            result.videoProfile = profile;
          }
        }

        const audioMatch = stderr.match(/Stream.*Audio:\s*(\w+)/i);
        if (audioMatch) {
          result.audioCodec = audioMatch[1].toLowerCase();
        }

        const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (durationMatch) {
          result.duration =
            parseInt(durationMatch[1]) * 3600 +
            parseInt(durationMatch[2]) * 60 +
            parseFloat(durationMatch[3]);
        }

        // Try to extract container from "Input #0, matroska,webm" or "Input #0, mp4"
        const containerMatch = stderr.match(/Input\s*#\d+,\s*([^,\s]+)/i);
        if (containerMatch) {
          result.container = containerMatch[1].toLowerCase();
        }

        checkTranscodeNeeded(result, url);
        resolve(result);
      });

      proc.on('error', (err) => {
        console.warn('[Worker] ffmpeg probe error:', err);
        resolve(result);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        try { proc.kill(); } catch {}
        resolve(result);
      }, 10000);

    } catch (err) {
      console.error('[Worker] Probe with ffmpeg error:', err);
      resolve(result);
    }
  });
}

// Chromecast-compatible containers (can play directly)
const CHROMECAST_SUPPORTED_CONTAINERS = [
  'mp4', 'mov', 'm4v', 'm4a',  // MPEG-4 family
  'webm',                       // WebM
  'mp3',                        // MP3 audio
];

// H.264 profiles that are NOT supported by Chromecast
// High 10 = 10-bit color, High 4:4:4 = 4:4:4 chroma subsampling
const H264_UNSUPPORTED_PROFILES = [
  'high 10',
  'high10',
  'high 4:4:4',
  'high444',
  'high 4:4:4 predictive',
];

// Check if the probed codecs need transcoding or remuxing for Chromecast
function checkTranscodeNeeded(result: ProbeResult, url?: string): void {
  const transcodeReasons: string[] = [];
  const remuxReasons: string[] = [];

  let videoNeedsTranscode = false;
  let audioNeedsTranscode = false;
  let videoCodecSupported = true;
  let audioCodecSupported = true;

  // Check video codec
  if (result.videoCodec) {
    const isSupported = CHROMECAST_SUPPORTED_VIDEO_CODECS.some(
      codec => result.videoCodec!.includes(codec)
    );
    if (!isSupported) {
      transcodeReasons.push(`video codec '${result.videoCodec}' not supported`);
      videoNeedsTranscode = true;
      videoCodecSupported = false;
    }
  }

  // Check H.264 profile (High 10, High 4:4:4 not supported)
  if (result.videoProfile && result.videoCodec?.includes('h264')) {
    const profileLower = result.videoProfile.toLowerCase();
    if (H264_UNSUPPORTED_PROFILES.some(p => profileLower.includes(p))) {
      transcodeReasons.push(`H.264 profile '${result.videoProfile}' not supported (10-bit or 4:4:4)`);
      videoNeedsTranscode = true;
      videoCodecSupported = false;
    }
  }

  // Check H.264 level (above 4.1 is poorly supported on many Chromecasts)
  if (result.videoLevel && result.videoCodec?.includes('h264')) {
    if (result.videoLevel > 4.2) {
      transcodeReasons.push(`H.264 level ${result.videoLevel} too high (max ~4.1-4.2)`);
      videoNeedsTranscode = true;
      videoCodecSupported = false;
    }
  }

  // Check audio codec
  if (result.audioCodec) {
    const isSupported = CHROMECAST_SUPPORTED_AUDIO_CODECS.some(
      codec => result.audioCodec!.includes(codec)
    );
    if (!isSupported) {
      transcodeReasons.push(`audio codec '${result.audioCodec}' not supported`);
      audioNeedsTranscode = true;
      audioCodecSupported = false;
    }
  }

  // Check container format
  let containerSupported = true;
  if (result.container) {
    containerSupported = CHROMECAST_SUPPORTED_CONTAINERS.some(
      c => result.container!.includes(c)
    );
    if (!containerSupported) {
      remuxReasons.push(`container '${result.container}' not supported`);
    }
  } else if (url) {
    // Fallback: check URL extension
    try {
      const urlLower = url.toLowerCase();
      const hasUnsupportedExt = CHROMECAST_UNSUPPORTED_EXTENSIONS.some(ext => urlLower.endsWith(ext));
      if (hasUnsupportedExt) {
        containerSupported = false;
        remuxReasons.push('container extension not supported');
      }
    } catch {}
  }

  // Set granular flags
  result.needsVideoTranscode = videoNeedsTranscode;
  result.needsAudioTranscode = audioNeedsTranscode;

  // Determine what's needed
  if (videoNeedsTranscode || audioNeedsTranscode) {
    // At least one codec needs transcoding
    result.needsTranscode = true;
    result.needsRemux = false;
    result.reason = transcodeReasons.join(', ');
  } else if (!containerSupported && videoCodecSupported && audioCodecSupported) {
    // Codecs are fine, just need to change container (fast remux)
    result.needsTranscode = false;
    result.needsRemux = true;
    result.reason = remuxReasons.join(', ');
  } else {
    result.needsTranscode = false;
    result.needsRemux = false;
    result.reason = '';
  }
}

// Quick check based on content type/extension (for initial filtering)
function mightNeedTranscode(contentType?: string, url?: string): boolean {
  // Check content type
  if (contentType) {
    const lowerType = contentType.toLowerCase();
    if (CHROMECAST_UNSUPPORTED_CONTENT_TYPES.some(t => lowerType.includes(t))) {
      return true;
    }
  }

  // Check file extension from URL
  if (url) {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.toLowerCase();
      if (CHROMECAST_UNSUPPORTED_EXTENSIONS.some(ext => pathname.endsWith(ext))) {
        return true;
      }
    } catch {
      // Invalid URL, ignore
    }
  }

  return false;
}

// Find existing transcode session by source URL
function findTranscodeSessionByUrl(sourceUrl: string): TranscodeSession | null {
  for (const session of transcodeSessions.values()) {
    if (session.inputUrl === sourceUrl && session.status !== 'error') {
      return session;
    }
  }
  return null;
}

// Wait for transcode to reach minimum progress or have output file ready for playback
// With VLC-style streaming, output file starts immediately with fragmented MP4
async function waitForTranscodeProgress(sessionId: string, minProgress: number, timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now();
  const MIN_FILE_SIZE = 64 * 1024; // 64KB minimum (fMP4 header + some fragments)

  while (Date.now() - startTime < timeoutMs) {
    const session = transcodeSessions.get(sessionId);
    if (!session) return false;
    if (session.status === 'error') return false;
    if (session.status === 'complete') return true;
    if (session.progress >= minProgress) return true;

    // VLC-style: Check if output file exists and has content (fragmented MP4 starts writing immediately)
    const internalSession = transcoder.getSessionStatus(sessionId);
    if (internalSession?.outputPath) {
      try {
        const stat = fs.statSync(internalSession.outputPath);
        if (stat.size >= MIN_FILE_SIZE) {
          console.log(`[Worker] Output file ready (${stat.size} bytes), proceeding with cast`);
          return true;
        }
      } catch (e) {
        // File doesn't exist yet, keep waiting
      }
    }

    await new Promise(resolve => setTimeout(resolve, 300)); // Check more frequently
  }
  return false;
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
  blobServerBindHost: '0.0.0.0',
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

// ============================================
// Cast RPC Handlers (FCast/Chromecast)
// ============================================

let CastContext: any = null;
let castLoadError: string | null = null;
let castLoadPromise: Promise<void> | null = null;
let castContext: any = null; // Singleton instance
let activeCastTranscodeId: string | null = null; // Track active transcode for cleanup

async function loadBareFcast(): Promise<void> {
  if (CastContext || castLoadError) return;
  if (castLoadPromise) return castLoadPromise;
  castLoadPromise = (async () => {
    let lastError: any;
    if (typeof require === 'function') {
      try {
        const mod = require('bare-fcast');
        CastContext = mod?.CastContext ?? mod?.default ?? mod;
        console.log('[Worker] bare-fcast loaded');
        return;
      } catch (err: any) {
        lastError = err;
      }
    }
    try {
      const mod = await import('bare-fcast');
      CastContext = (mod as any)?.CastContext ?? (mod as any)?.default ?? mod;
      console.log('[Worker] bare-fcast loaded');
      return;
    } catch (err: any) {
      lastError = err;
    }
    castLoadError = lastError?.message || 'Unknown error';
    console.warn('[Worker] bare-fcast not available:', castLoadError);
  })();
  return castLoadPromise;
}

function getCastContext(): any {
  if (!castContext && CastContext) {
    castContext = new CastContext();

    // Forward discovery events via RPC
    castContext.on('deviceFound', (device: any) => {
      try {
        rpc.eventCastDeviceFound?.({ device: {
          id: device.id,
          name: device.name,
          host: device.host,
          port: device.port,
          protocol: device.protocol,
        }});
      } catch {}
    });

    castContext.on('deviceLost', (deviceId: string) => {
      try {
        rpc.eventCastDeviceLost?.({ deviceId });
      } catch {}
    });

    // Forward playback events
    castContext.on('playbackStateChanged', (state: string) => {
      try {
        rpc.eventCastPlaybackState?.({ state });
      } catch {}
    });

    castContext.on('timeChanged', (time: number) => {
      try {
        rpc.eventCastTimeUpdate?.({ currentTime: time });
      } catch {}
    });

    castContext.on('error', (error: any) => {
      try {
        const message = error?.message || String(error);
        console.warn('[Worker] Cast error:', message);
        rpc.eventCastPlaybackState?.({ state: 'error', error: message });
      } catch {}
    });
  }
  return castContext;
}

const CAST_LOCALHOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1']);

function isUsableIPv4(address: string | null | undefined, family?: any): boolean {
  if (!address) return false;
  if (address.includes(':')) return false;
  if (CAST_LOCALHOSTS.has(address)) return false;
  if (address.startsWith('127.')) return false;
  if (family && family !== 4 && family !== 'IPv4') return false;
  return true;
}

async function getLocalIPv4ForTarget(targetHost?: string): Promise<string | null> {
  if (!targetHost) return null;

  try {
    const mod = await import('bare-dgram');
    const dgram = (mod as any)?.default || mod;
    const socket = (() => {
      try {
        return dgram.createSocket('udp4');
      } catch {}
      try {
        return dgram.createSocket({ type: 'udp4' });
      } catch {}
      return dgram.createSocket();
    })();
    await new Promise(resolve => socket.bind(0, resolve));
    socket.connect(1, targetHost);
    const addr = socket.address?.();
    const local = addr?.address || null;
    await socket.close?.();
    if (isUsableIPv4(local, addr?.family)) {
      return local;
    }
  } catch (err: any) {
    console.warn('[Worker] bare-dgram local IP detection failed:', err?.message || err);
  }

  let targetPrefix: string | null = null;
  const parts = targetHost.split('.');
  if (parts.length === 4) {
    targetPrefix = parts.slice(0, 3).join('.');
  }

  try {
    const mod = await import('udx-native');
    const UDX = (mod as any)?.default || mod;
    const udx = new UDX();
    let fallback: string | null = null;

    for (const iface of udx.networkInterfaces()) {
      if (iface.family !== 4 || iface.internal) continue;
      if (!isUsableIPv4(iface.host, iface.family)) continue;
      if (targetPrefix && iface.host.startsWith(`${targetPrefix}.`)) {
        return iface.host;
      }
      if (!fallback) fallback = iface.host;
    }

    return fallback;
  } catch (err: any) {
    console.warn('[Worker] udx-native not available for IP detection:', err?.message || err);
    return null;
  }
}

function rewriteUrlHost(url: string, host: string): string {
  try {
    const parsed = new URL(url);
    parsed.hostname = host;
    return parsed.toString();
  } catch {
    return url;
  }
}

rpc.onCastAvailable(async () => {
  await loadBareFcast();
  return { available: CastContext !== null, error: castLoadError };
});

rpc.onCastStartDiscovery(async () => {
  await loadBareFcast();
  if (!CastContext) {
    return { success: false, error: castLoadError || 'bare-fcast not available' };
  }
  try {
    const ctx = getCastContext();
    // Start discovery (async for mDNS setup)
    await ctx.startDiscovery();
    return { success: true };
  } catch (err: any) {
    console.error('[Worker] Cast discovery error:', err);
    return { success: false, error: err?.message };
  }
});

rpc.onCastStopDiscovery(async () => {
  if (!castContext) return { success: true };
  try {
    castContext.stopDiscovery();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onCastGetDevices(async () => {
  if (!castContext) return { devices: [] };
  try {
    const devices = castContext.getDevices();
    return { devices: devices.map((d: any) => ({
      id: d.id,
      name: d.name,
      host: d.host,
      port: d.port,
      protocol: d.protocol,
    }))};
  } catch {
    return { devices: [] };
  }
});

rpc.onCastAddManualDevice(async (req: any) => {
  await loadBareFcast();
  if (!CastContext) {
    return { success: false, error: castLoadError || 'bare-fcast not available' };
  }
  try {
    const ctx = getCastContext();
    const device = ctx._discoverer.addManualDevice({
      name: req.name,
      host: req.host,
      port: req.port,
      protocol: req.protocol || 'fcast',
    });
    return { success: true, device: {
      id: device.id,
      name: device.name,
      host: device.host,
      port: device.port,
      protocol: device.protocol,
    }};
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onCastConnect(async (req: any) => {
  if (!castContext) {
    return { success: false, error: 'Cast not initialized' };
  }
  let deviceInfo = null as any;
  try {
    try {
      const devices = castContext.getDevices?.() || [];
      const device = devices.find((d: any) => d.id === req.deviceId);
      if (device) {
        console.log('[Worker] Cast connect:', device.name, device.protocol, device.host + ':' + device.port);
        deviceInfo = device;
      } else {
        console.log('[Worker] Cast connect: device not found for', req.deviceId);
      }
    } catch {}
    await castContext.connect(req.deviceId);
    return deviceInfo ? {
      success: true,
      device: {
        id: deviceInfo.id,
        name: deviceInfo.name,
        host: deviceInfo.host,
        port: deviceInfo.port,
        protocol: deviceInfo.protocol,
      },
    } : { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onCastDisconnect(async () => {
  if (!castContext) return { success: true };
  try {
    await castContext.disconnect();
    castProxySessions.clear();

    // Clean up transcoded file cache when cast session ends
    if (activeCastTranscodeId) {
      console.log('[Worker] Cleaning up transcode cache:', activeCastTranscodeId);
      try {
        transcoder.stopTranscode(activeCastTranscodeId);
        transcodeSessions.delete(activeCastTranscodeId);
      } catch (e) {
        // Ignore cleanup errors
      }
      activeCastTranscodeId = null;
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onCastPlay(async (req: any) => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected to cast device' };
  }
  try {
    let url = req.url;
    let contentType = req.contentType;
    let isLiveTranscode = false; // Track if we're using live transcoding stream
    const protocol = castContext?._connectedDevice?.deviceInfo?.protocol;
    const deviceHost = castContext?._connectedDevice?.deviceInfo?.host;

    // For Chromecast, probe the file and check if transcoding/remuxing is needed
    if (protocol === 'chromecast') {
      // Always probe for actual codec info (MP4 can contain unsupported codecs like AC3/DTS)
      console.log('[Worker] Probing media codecs for Chromecast...');
      const probeResult = await probeMediaCodecs(req.url);
      console.log('[Worker] Probe result:', {
        video: probeResult.videoCodec,
        audio: probeResult.audioCodec,
        profile: probeResult.videoProfile,
        level: probeResult.videoLevel,
        container: probeResult.container,
        needsTranscode: probeResult.needsTranscode,
        needsRemux: probeResult.needsRemux,
        reason: probeResult.reason
      });

      // Determine processing mode - pick the fastest option
      const needsProcessing = probeResult.needsTranscode || probeResult.needsRemux;
      let mode: 'transcode' | 'audio' | 'remux' = 'remux';
      if (probeResult.needsVideoTranscode) {
        mode = 'transcode';  // Full transcode (slowest)
      } else if (probeResult.needsAudioTranscode) {
        mode = 'audio';  // Audio-only transcode, video copy (fast!)
      } else if (probeResult.needsRemux) {
        mode = 'remux';  // Container change only (fastest)
      }

      if (needsProcessing) {
        const actionNames = { remux: 'remuxing', audio: 'audio-only transcode', transcode: 'full transcode' };
        const action = actionNames[mode];
        const reason = probeResult.reason || 'container/extension not supported';
        console.log(`[Worker] Cast play: ${action} needed -`, reason);

        try {
          // Check for existing transcode session for this URL
          let session = findTranscodeSessionByUrl(req.url);

          if (!session) {
            // Start new transcode/remux session
            await ensureTranscoder();
            const id = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            session = {
              id,
              inputUrl: req.url,
              status: 'pending',
              progress: 0,
              mode,
            };
            transcodeSessions.set(id, session);

            // Start transcoding via inline transcoder module
            try {
              const result = await transcoder.startTranscode(
                id,
                req.url,
                mode,
                handleTranscodeProgress
              );
              session.status = 'transcoding';
              session.servingUrl = result.servingUrl;
            } catch (err: any) {
              session.status = 'error';
              session.error = err?.message || 'Failed to start transcode';
              console.warn(`[Worker] Cast play: ${mode} failed to start:`, session.error);
            }
          }

          // If session is active, wait for buffer (or full completion if waitForComplete)
          if (session && (session.status === 'transcoding' || session.status === 'complete')) {
            // Track this transcode session for cleanup on disconnect
            activeCastTranscodeId = session.id;

            // If waitForComplete is set, wait for full transcode (enables seeking)
            if (req.waitForComplete) {
              console.log(`[Worker] Cast play: waiting for complete ${mode} (seeking enabled)...`);
              const maxWait = 10 * 60 * 1000; // 10 minute max wait
              const isComplete = await waitForTranscodeProgress(session.id, 100, maxWait);
              if (!isComplete) {
                return {
                  success: false,
                  error: 'Transcode timed out. Try again or use live streaming mode.',
                };
              }
              console.log(`[Worker] Cast play: ${mode} complete, seeking enabled`);
            } else {
              // VLC-style streaming: output starts immediately, check for file content
              // Remux/audio are very fast, full transcode takes longer
              const minProgress = mode === 'transcode' ? 3 : 1;
              const timeout = mode === 'transcode' ? 12000 : 5000;
              const hasBuffer = await waitForTranscodeProgress(session.id, minProgress, timeout);
              if (!hasBuffer) {
                console.warn(`[Worker] Cast play: ${mode} buffer timeout`);
                // If video transcoding is required but timed out, return error
                if (mode === 'transcode' && probeResult.needsVideoTranscode) {
                  return {
                    success: false,
                    error: 'Video requires transcoding which is too slow for real-time casting. Consider using a video with H.264 codec.',
                  };
                }
              }
            }

            // Create proxy URL for the processed stream
            if (session.servingUrl) {
              await ensureCastProxyServer();
              const proxyUrl = await createCastProxyUrl(deviceHost, session.servingUrl);
              if (proxyUrl) {
                url = proxyUrl;
                contentType = 'video/mp4'; // Now in MP4 container
                isLiveTranscode = true; // Use LIVE stream type for stability
                console.log(`[Worker] Cast play: using LIVE stream mode (no seeking during transcode)`);
                console.log(`[Worker] Cast play: using ${mode}ed URL via proxy`, proxyUrl);
              } else {
                console.warn(`[Worker] Cast play: failed to create proxy for ${mode} URL`);
              }
            }
          }
        } catch (err: any) {
          console.error(`[Worker] Cast play ${mode} error:`, err?.message || err);
          // If video transcoding is required, return error instead of falling back
          if (mode === 'transcode' && probeResult.needsVideoTranscode) {
            return {
              success: false,
              error: 'Failed to transcode video: ' + (err?.message || 'unknown error'),
            };
          }
        }
      }

      // If not transcoding (or transcoding failed), use regular proxy
      if (url === req.url) {
        let usedProxy = false;
        try {
          await ensureCastProxyServer();
          const proxyUrl = await createCastProxyUrl(deviceHost, req.url);
          if (proxyUrl) {
            url = proxyUrl;
            usedProxy = true;
            console.log('[Worker] Cast play: using proxy URL', proxyUrl);
          }
        } catch (err: any) {
          console.warn('[Worker] Cast proxy init failed:', err?.message || err);
        }
        if (!usedProxy) {
          try {
            const parsed = new URL(req.url);
            if (CAST_LOCALHOSTS.has(parsed.hostname)) {
              const localIp = await getLocalIPv4ForTarget(deviceHost);
              if (localIp) {
                url = rewriteUrlHost(req.url, localIp);
                console.log('[Worker] Cast play: rewrote host to', localIp);
              }
            }
          } catch {}
        }
      }
    }

    // Log final URL info
    try {
      let host = 'unknown';
      try {
        const parsed = new URL(url);
        host = parsed.host;
      } catch {}
      console.log('[Worker] Cast play:', protocol || 'unknown', 'contentType:', contentType, 'host:', host);
    } catch {}

    await castContext.play({
      url,
      contentType,
      title: req.title,
      thumbnail: req.thumbnail,
      time: isLiveTranscode ? 0 : req.time, // Start from beginning for live transcoding
      volume: req.volume,
      streamType: isLiveTranscode ? 'LIVE' : undefined, // LIVE = no seeking
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onCastPause(async () => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected' };
  }
  try {
    await castContext.pause();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onCastResume(async () => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected' };
  }
  try {
    await castContext.resume();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onCastStop(async () => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected' };
  }
  try {
    await castContext.stop();
    castProxySessions.clear();

    // Clean up transcoded file cache when cast stops
    if (activeCastTranscodeId) {
      console.log('[Worker] Cleaning up transcode cache on stop:', activeCastTranscodeId);
      try {
        transcoder.stopTranscode(activeCastTranscodeId);
        transcodeSessions.delete(activeCastTranscodeId);
      } catch (e) {
        // Ignore cleanup errors
      }
      activeCastTranscodeId = null;
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onCastSeek(async (req: any) => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected' };
  }
  try {
    await castContext.seek(req.time);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onCastSetVolume(async (req: any) => {
  if (!castContext?.isConnected()) {
    return { success: false, error: 'Not connected' };
  }
  try {
    await castContext.setVolume(req.volume);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onCastGetState(async () => {
  if (!castContext) {
    return { state: 'idle', currentTime: 0, duration: 0, volume: 1.0 };
  }
  try {
    const state = castContext.getPlaybackState();
    return {
      state: state.state || 'idle',
      currentTime: state.currentTime || 0,
      duration: state.duration || 0,
      volume: state.volume ?? 1.0,
    };
  } catch {
    return { state: 'idle', currentTime: 0, duration: 0, volume: 1.0 };
  }
});

rpc.onCastIsConnected(async () => {
  return { connected: Boolean(castContext?.isConnected()) };
});

// ============================================
// Event handlers for cast (client->server, forward to RPC events)
rpc.onEventCastDeviceFound?.(() => {});
rpc.onEventCastDeviceLost?.(() => {});
rpc.onEventCastPlaybackState?.(() => {});
rpc.onEventCastTimeUpdate?.(() => {});

// ============================================
// Transcode RPC handlers
// ============================================

rpc.onTranscodeStart(async (req: any) => {
  try {
    await ensureTranscoder();

    // Generate unique session ID
    const id = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Determine mode based on content type or default to transcode
    const mode: 'transcode' | 'audio' | 'remux' = req.mode || 'transcode';

    // Create session
    const session: TranscodeSession = {
      id,
      inputUrl: req.sourceUrl,
      status: 'pending',
      progress: 0,
      mode,
    };
    transcodeSessions.set(id, session);

    // Start transcoding via inline transcoder module
    try {
      const result = await transcoder.startTranscode(
        id,
        req.sourceUrl,
        mode,
        handleTranscodeProgress
      );
      session.status = 'transcoding';
      session.servingUrl = result.servingUrl;
    } catch (err: any) {
      session.status = 'error';
      session.error = err?.message || 'Failed to start transcode';
      return { success: false, error: session.error };
    }

    console.log('[Worker] Transcode started:', id, 'url:', session.servingUrl);
    return {
      success: true,
      sessionId: id,
      transcodeUrl: session.servingUrl,
    };
  } catch (err: any) {
    console.error('[Worker] Transcode start error:', err?.message || err);
    return { success: false, error: err?.message || 'Failed to start transcode' };
  }
});

rpc.onTranscodeStop(async (req: any) => {
  try {
    const session = transcodeSessions.get(req.sessionId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    // Stop transcoding via inline transcoder module
    transcoder.stopTranscode(req.sessionId);

    transcodeSessions.delete(req.sessionId);
    console.log('[Worker] Transcode stopped:', req.sessionId);
    return { success: true };
  } catch (err: any) {
    console.error('[Worker] Transcode stop error:', err?.message || err);
    return { success: false, error: err?.message || 'Failed to stop transcode' };
  }
});

rpc.onTranscodeStatus(async (req: any) => {
  const session = transcodeSessions.get(req.sessionId);
  if (!session) {
    return { status: 'not_found', progress: 0, bytesWritten: 0 };
  }
  return {
    status: session.status,
    progress: session.progress,
    bytesWritten: 0, // Will be updated from worker events
    error: session.error,
  };
});

// Transcode progress event handler (client->server, no-op)
rpc.onEventTranscodeProgress?.(() => {});

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

if (castProxyServer) {
  try {
    castProxyServer.close();
    console.log('[CastProxy] server closed');
  } catch (err: any) {
    console.warn('[CastProxy] close error:', err?.message);
  }
  castProxyServer = null;
  castProxyPort = 0;
  castProxyReady = null;
  castProxySessions.clear();
}

// Clean up transcode sessions
cleanupTranscodeSessions();

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
