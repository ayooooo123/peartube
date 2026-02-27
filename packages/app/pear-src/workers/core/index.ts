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
import pipe from 'pear-pipe';
import { spawn } from 'bare-subprocess';
import b4a from 'b4a';
import http1 from 'bare-http1';
// @ts-ignore - backend transcode modules are JavaScript
import * as transcoder from '@peartube/backend/transcode/transcoder';
// @ts-ignore - backend transcode modules are JavaScript
import * as castTranscoder from '@peartube/backend/transcode/cast-transcoder';
// @ts-ignore - backend thumbnail module
import { generateAndStoreThumbnail } from '@peartube/backend/thumbnail';

// Platform detection - bare-mpv is desktop-only (no Android/iOS prebuilds)
const currentPlatform = os.platform();
const isMpvSupported = currentPlatform === 'darwin' || currentPlatform === 'linux' || currentPlatform === 'win32';

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
const castProxySessions = new Map<string, { url: string; createdAt: number; lastAccessAt?: number; transcodeSessionId?: string; isHls?: boolean }>();
const CAST_PROXY_TTL_MS = 8 * 60 * 60 * 1000;
const castProxyPlaylistLogged = new Set<string>();

interface TranscodeSession {
  id: string;
  inputUrl: string;
  cacheKey: string;
  status: 'pending' | 'transcoding' | 'complete' | 'error';
  progress: number;
  transcodeUrl?: string;
  proxyUrl?: string;
  error?: string;
  mode: 'transcode' | 'audio' | 'remux';  // 'audio' = video copy + audio transcode (fast)
  duration?: number;  // Full video duration from probe for BUFFERED seeking
}
const transcodeSessions = new Map<string, TranscodeSession>();

// Frame request counter for diagnostics
let frameRequestCount = 0;
let lastFrameLogTime = 0;

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

    frameRequestCount++;
    const now = Date.now();
    if (now - lastFrameLogTime > 5000) {
      console.log('[Worker] mpv frame requests in last 5s:', frameRequestCount, 'needsRender:', state.player.needsRender());
      frameRequestCount = 0;
      lastFrameLogTime = now;
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

    const buffer = Buffer.from(frameData);
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
    const lastSeen = entry.lastAccessAt || entry.createdAt;
    if (now - lastSeen > CAST_PROXY_TTL_MS) {
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

  const resetProxyState = () => {
    castProxyPort = 0;
    castProxyReady = null;
    castProxyServer = null;
  };

  castProxyReady = new Promise((resolve, reject) => {
    const setCorsHeaders = (res: any) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type,Accept,Origin');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
    };

    castProxyServer = http1.createServer((req: any, res: any) => {
      try {
        console.log('[CastProxy] incoming', req.method || 'GET', req.url || '/');
      } catch {}
      setCorsHeaders(res);
      if ((req.method || '').toUpperCase() === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
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
      const extraSegments = parts[0] === 'cast' ? parts.slice(2) : [];
      if (extraSegments.some((seg) => seg === '.' || seg === '..')) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Invalid cast proxy path.');
        return;
      }
      const extraPath = extraSegments.join('/');
      const isIndexRequest = extraPath.endsWith('index.m3u8');
      const isStreamRequest = extraPath.endsWith('stream.m3u8');

      const hostHeader = req.headers?.host;
      const baseUrl = hostHeader ? `http://${hostHeader}` : '';
      const rewriteHlsPlaylist = (body: string, isComplete: boolean = false) => {
        const lines = body.split(/\r?\n/);
        const segments: Array<{ inf: string; uri: string }> = [];
        let targetDuration: string | null = null;
        let mediaSequence: number | null = null;
        let pendingInf: string | null = null;
        let maxDuration = 0;

        const rewriteUri = (trimmed: string) => {
          let pathPart = trimmed;
          let query = '';
          if (/^https?:\/\//i.test(trimmed)) {
            try {
              const parsedUrl = new URL(trimmed);
              pathPart = parsedUrl.pathname || '';
              query = parsedUrl.search || '';
            } catch {
              pathPart = trimmed;
            }
          } else {
            const qIndex = trimmed.indexOf('?');
            if (qIndex !== -1) {
              pathPart = trimmed.slice(0, qIndex);
              query = trimmed.slice(qIndex);
            }
          }
          if (pathPart.startsWith('/')) {
            pathPart = path.posix.basename(pathPart);
          }
          pathPart = pathPart.replace(/^\.?\//, '').replace(/^(\.\.\/)+/, '');
          if (!pathPart) return '';
          return `${pathPart}${query}`;
        };

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('#EXT-X-TARGETDURATION:')) {
            targetDuration = trimmed.split(':')[1]?.trim() || null;
            continue;
          }
          if (trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            const raw = trimmed.split(':')[1]?.trim();
            const parsed = raw ? Number(raw) : NaN;
            if (!Number.isNaN(parsed)) mediaSequence = parsed;
            continue;
          }
          if (trimmed.startsWith('#EXTINF:')) {
            pendingInf = trimmed;
            const raw = trimmed.split(':')[1]?.split(',')[0]?.trim();
            const parsed = raw ? Number(raw) : NaN;
            if (!Number.isNaN(parsed)) {
              maxDuration = Math.max(maxDuration, parsed);
            }
            continue;
          }
          if (trimmed.startsWith('#')) continue;

          const rewritten = rewriteUri(trimmed);
          if (!rewritten) continue;
          if (pendingInf) {
            segments.push({ inf: pendingInf, uri: rewritten });
          }
          pendingInf = null;
        }

        // Keep all segments for live transcoding - Chromecast needs them!
        const maxSegments = 10000;
        const dropCount = Math.max(0, segments.length - maxSegments);
        const kept = segments.slice(-maxSegments);
        let seq = mediaSequence;
        if (seq == null && kept.length) {
          const match = kept[0].uri.match(/(\d+)(?:\D+)?$/);
          if (match) seq = Number(match[1]);
        }
        if (seq == null) seq = 0;
        seq += dropCount;

        const output: string[] = ['#EXTM3U', '#EXT-X-VERSION:3'];
        const targetDurationValue = Math.max(
          targetDuration ? Number(targetDuration) || 0 : 0,
          Math.ceil(maxDuration || 0)
        );
        if (targetDurationValue > 0) {
          output.push(`#EXT-X-TARGETDURATION:${targetDurationValue}`);
        }
        output.push(`#EXT-X-MEDIA-SEQUENCE:${seq}`);
        for (const seg of kept) {
          output.push(seg.inf);
          output.push(seg.uri);
        }
        // Add EXT-X-ENDLIST when transcode is complete - enables VOD mode with full seeking
        if (isComplete) {
          output.push('#EXT-X-ENDLIST');
        }
        output.push('');
        return output.join('\r\n');
      };

      if (!token || !castProxySessions.has(token)) {
        console.warn('[CastProxy] missing token or session', token || 'none');
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Cast proxy session not found.');
        return;
      }

      const entry = castProxySessions.get(token);
      if (entry) {
        entry.lastAccessAt = Date.now();
      }
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

      const method = (req.method || 'GET').toUpperCase();
      let targetPathname = target.pathname;
      if (extraPath) {
        const basePath = target.pathname || '/';
        const pathApi = path.posix || path;
        const baseDir = pathApi.extname(basePath) ? pathApi.dirname(basePath) : basePath;
        const mappedExtra = isStreamRequest ? 'index.m3u8' : extraPath;
        targetPathname = pathApi.join(baseDir, mappedExtra);
      }
      const targetPath = `${targetPathname}${target.search || ''}`;
      const headers: Record<string, any> = {};
      if (req.headers?.range) {
        headers.range = req.headers.range;
      }
      const host = target.host || target.hostname
      const proxyReq = http1.request({
        method,
        host,
        path: targetPath,
        headers,
      }, (proxyRes: any) => {
        const contentType = (proxyRes.headers?.['content-type'] || '').toString();
        const isM3u8 = extraPath.endsWith('.m3u8')
          || targetPathname.endsWith('.m3u8')
          || contentType.includes('mpegurl');

        if (isIndexRequest && (proxyRes.statusCode || 200) < 400) {
          let body = '';
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (chunk: string) => { body += chunk; });
          proxyRes.on('end', () => {
            const streamUrl = baseUrl
              ? `${baseUrl}/cast/${token}/stream.m3u8`
              : `/cast/${token}/stream.m3u8`;
            const master = [
              '#EXTM3U',
              '#EXT-X-VERSION:3',
              '#EXT-X-STREAM-INF:BANDWIDTH=6000000',
              streamUrl,
              ''
            ].join('\r\n');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Content-Length', Buffer.byteLength(master));
            res.setHeader('Cache-Control', 'no-cache');
            setCorsHeaders(res);
            res.end(master);
          });
          proxyRes.on('error', (err: any) => {
            console.warn('[CastProxy] upstream response error:', err?.message || err);
            if (!res.headersSent) {
              res.statusCode = 502;
              res.end('Cast proxy upstream error');
            }
          });
          return;
        }

        if (isM3u8 && (proxyRes.statusCode || 200) < 400) {
          let body = '';
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (chunk: string) => { body += chunk; });
          proxyRes.on('end', () => {
            // Check if transcode session is complete for EXT-X-ENDLIST
            const transcodeSession = entry?.transcodeSessionId
              ? transcodeSessions.get(entry.transcodeSessionId)
              : null;
            const isTranscodeComplete = transcodeSession?.status === 'complete';
            const rewritten = rewriteHlsPlaylist(body, isTranscodeComplete);
            // Always log segment list to debug live HLS buffering issues
            const segments = rewritten.split(/\r?\n/).filter((l: string) => l.endsWith('.ts'));
            console.log(`[CastProxy] playlist has ${segments.length} segments: ${segments.join(', ')}`);
            const logKey = `${token}:${isStreamRequest ? 'stream' : 'index'}`;
            if (!castProxyPlaylistLogged.has(logKey)) {
              castProxyPlaylistLogged.add(logKey);
              const preview = rewritten.split(/\r?\n/).slice(0, 8).join('\n');
              console.log('[CastProxy] playlist sample:\n' + preview);
            }
            const out = Buffer.from(rewritten, 'utf8');
            res.statusCode = proxyRes.statusCode || 200;
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Content-Length', out.byteLength);
            res.setHeader('Cache-Control', 'no-cache');
            setCorsHeaders(res);
            res.end(out);
          });
          proxyRes.on('error', (err: any) => {
            console.warn('[CastProxy] upstream response error:', err?.message || err);
            if (!res.headersSent) {
              res.statusCode = 502;
              res.end('Cast proxy upstream error');
            }
          });
          return;
        }

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
        setCorsHeaders(res);

        // Handle stream errors to prevent crashes
        // Track if either stream has been destroyed to prevent double-cleanup
        let pipeCleanedUp = false;
        const cleanupPipe = () => {
          if (pipeCleanedUp) return;
          pipeCleanedUp = true;
          try { proxyRes.unpipe?.(res); } catch {}
          try { proxyRes.destroy?.(); } catch {}
        };

        proxyRes.on('error', (err: any) => {
          console.warn('[CastProxy] upstream response error:', err?.message || err);
          cleanupPipe();
        });
        res.on('error', (err: any) => {
          console.warn('[CastProxy] client response error:', err?.message || err);
          cleanupPipe();
        });
        res.on('close', () => {
          // Client closed connection, clean up upstream
          cleanupPipe();
        });

        // Use manual piping with error handling instead of .pipe() to prevent
        // "Writable stream closed prematurely" crashes when Chromecast disconnects
        proxyRes.on('data', (chunk: any) => {
          if (pipeCleanedUp) return;
          try {
            const canWrite = res.write(chunk);
            if (!canWrite && !pipeCleanedUp) {
              proxyRes.pause?.();
              res.once('drain', () => {
                if (!pipeCleanedUp) proxyRes.resume?.();
              });
            }
          } catch (err: any) {
            console.warn('[CastProxy] write error:', err?.message || err);
            cleanupPipe();
          }
        });
        proxyRes.on('end', () => {
          if (pipeCleanedUp) return;
          try { res.end(); } catch {}
        });
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

      const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method)
        && (req.headers?.['content-length'] || req.headers?.['transfer-encoding']);
      if (hasBody) {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    });

    castProxyServer.on('error', (err: any) => {
      console.error('[CastProxy] server error:', err?.message || err);
      resetProxyState();
      reject(err);
    });
    castProxyServer.on('close', () => {
      resetProxyState();
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

async function createCastProxyUrl(targetHost: string | undefined, sourceUrl: string, transcodeSessionId?: string): Promise<string | null> {
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
  const now = Date.now();
  const isHls = sourceUrl.endsWith('.m3u8') || sourceUrl.includes('.m3u8?');
  castProxySessions.set(token, { url: sourceUrl, createdAt: now, lastAccessAt: now, transcodeSessionId, isHls });
  const suffix = isHls ? '/index.m3u8' : '';
  return `http://${localIp}:${castProxyPort}/cast/${token}${suffix}`;
}

// ============================================
// Transcode Integration (shared backend module)
// ============================================

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

  if (activeCastTranscodeId) {
    try {
      castTranscoder.stopCastTranscode(activeCastTranscodeId);
    } catch {}
    castSessionsWithLoadSent.delete(activeCastTranscodeId);
    activeCastTranscodeId = null;
    activeCastSourceKey = null;
  }
}

// Import the orchestrator from backend
// @ts-ignore - backend-core is JavaScript
import { createBackendContext } from '@peartube/backend/orchestrator';
// @ts-ignore - Generated HRPC code
import HRPC from '@peartube/spec';

// Get Pear runtime globals
declare const Pear: any;

console.log('[Worker] PearTube Desktop Worker starting...');

const workerBaseDir =
  (typeof Pear?.config?.dir === 'string' && Pear.config.dir.trim())
    ? Pear.config.dir
    : os.cwd();
const hypercoreWorkerPath = workerBaseDir
  ? path.join(workerBaseDir, 'build/workers/hypercore-reader-worker.mjs')
  : './build/workers/hypercore-reader-worker.mjs';
(globalThis as any).__PEARTUBE_HYPERCORE_WORKER_PATH__ = hypercoreWorkerPath;
console.log('[Worker] Hypercore worker path:', hypercoreWorkerPath);

// ============================================
// Initialize Backend using Orchestrator
// ============================================

// Determine storage path: --store flag > bare-storage.persistent() > os.homedir()
let storage: string;
if (Pear.config.storage) {
  storage = Pear.config.storage;
  console.log('[Worker] Using --store storage path:', storage);
} else {
  try {
    const dir = require('bare-storage');
    storage = path.join(dir.persistent(), 'peartube');
    console.log('[Worker] Using bare-storage persistent path:', storage);
  } catch {
    const homeDir = os.homedir();
    storage = path.join(homeDir, '.peartube');
    console.log('[Worker] Falling back to homedir storage:', storage);
  }
}

console.log('[Worker] Pear.config:', JSON.stringify({
  storage: Pear.config.storage,
  key: Pear.config.key ? 'present' : 'null',
  dev: Pear.config.dev
}, null, 2));

// Buffer stats emitted before HRPC is initialized.
// This avoids dropping early stats if prefetch starts before the UI connects.
const pendingVideoStats = new Map<string, { driveKey: string; videoPath: string; stats: any }>();
const bufferStatsCallback = (driveKey: string, videoPath: string, stats: any) => {
  const key = `${driveKey}:${videoPath}`;
  pendingVideoStats.set(key, { driveKey, videoPath, stats });
};
(bufferStatsCallback as any)._statsMarker = 'buffer';

const backend = await createBackendContext({
  storagePath: storage,
  onFeedUpdate: () => {
    // Feed updates will be wired after HRPC init
  },
  onStatsUpdate: bufferStatsCallback
});

const { ctx, api, identityManager, uploadManager, publicFeed, seedingManager, videoStats, initializeIdentityFromMnemonic } = backend;

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

let bareFfmpegModule: any = null;
let bareFfmpegPromise: Promise<any> | null = null;

async function loadBareFfmpegModule(): Promise<any> {
  if (bareFfmpegModule) return bareFfmpegModule;
  if (bareFfmpegPromise) return bareFfmpegPromise;

  bareFfmpegPromise = (async () => {
    let lastError: any;
    if (typeof require === 'function') {
      try {
        const mod = require('bare-ffmpeg');
        bareFfmpegModule = mod?.default ?? mod;
        return bareFfmpegModule;
      } catch (err: any) {
        lastError = err;
      }
    }
    try {
      const mod = await import('bare-ffmpeg');
      bareFfmpegModule = (mod as any)?.default ?? mod;
      return bareFfmpegModule;
    } catch (err: any) {
      lastError = err;
    }
    throw lastError || new Error('Failed to load bare-ffmpeg');
  })();

  return bareFfmpegPromise;
}

async function generateThumbnailWithBareFfmpeg(filePath: string): Promise<Buffer | null> {
  let fd: number | null = null;
  let inputIO: any = null;
  let inputFmt: any = null;
  let decoder: any = null;
  let packet: any = null;
  let frame: any = null;
  let scaler: any = null;
  let scaledFrame: any = null;
  let outputIO: any = null;
  let outputFmt: any = null;
  let encoder: any = null;
  let outPacket: any = null;

  try {
    const ffmpeg = await loadBareFfmpegModule();
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    let offset = 0;

    fd = fs.openSync(filePath, 'r');
    inputIO = new ffmpeg.IOContext(4096, {
      onread: (buffer: Buffer) => {
        const read = fs.readSync(fd as number, buffer, 0, buffer.length, offset);
        if (read <= 0) return 0;
        offset += read;
        return read;
      },
      onseek: (o: number, whence: number) => {
        if (whence === ffmpeg.constants.seek.SIZE) return fileSize;
        if (whence === ffmpeg.constants.seek.SET) offset = o;
        else if (whence === ffmpeg.constants.seek.CUR) offset += o;
        else if (whence === ffmpeg.constants.seek.END) offset = fileSize + o;
        else return -1;
        return offset;
      }
    });

    inputFmt = new ffmpeg.InputFormatContext(inputIO);
    const videoStream = inputFmt.getBestStream(ffmpeg.constants.mediaTypes.VIDEO);
    if (!videoStream) throw new Error('No video stream found');

    const codecId = videoStream.codecParameters?.id;
    console.log('[Worker] Thumbnail: codec id =', codecId);

    decoder = videoStream.decoder();
    if (!decoder) throw new Error('No decoder available for this codec');
    decoder.timeBase = videoStream.timeBase;
    decoder.open();

    packet = new ffmpeg.Packet();
    frame = new ffmpeg.Frame();

    const timeBase = videoStream.timeBase || { numerator: 1, denominator: 1 };
    const targetSeconds = 30;
    let selected = false;
    let frameCount = 0;
    const maxFrames = 1000;

    let lastValidFormat = -1;
    let lastValidWidth = 0;
    let lastValidHeight = 0;

    while (inputFmt.readFrame(packet) && frameCount < maxFrames) {
      if (packet.streamIndex !== videoStream.index) {
        packet.unref();
        continue;
      }
      if (decoder.sendPacket(packet)) {
        while (decoder.receiveFrame(frame)) {
          frameCount++;
          
          if (!frame.width || !frame.height || frame.format < 0) {
            console.warn(`[Worker] Skipping invalid frame: width=${frame.width} height=${frame.height} format=${frame.format}`);
            continue;
          }
          
          lastValidFormat = frame.format;
          lastValidWidth = frame.width;
          lastValidHeight = frame.height;
          
          const pts = frame.pts ?? 0;
          const seconds = timeBase.denominator ? (pts * timeBase.numerator) / timeBase.denominator : 0;
          if (seconds >= targetSeconds) {
            selected = true;
            break;
          }
        }
      }
      packet.unref();
      if (selected) break;
    }

    if (!selected && lastValidFormat >= 0) {
      selected = true;
    }

    if (!selected || lastValidFormat < 0) {
      throw new Error(`No valid frame decoded: format=${lastValidFormat}`);
    }

    const targetWidth = 640;
    const targetHeight = Math.max(1, Math.round(frame.height * (targetWidth / frame.width)));

    scaler = new ffmpeg.Scaler(
      frame.format, frame.width, frame.height,
      ffmpeg.constants.pixelFormats.YUVJ420P, targetWidth, targetHeight
    );

    scaledFrame = new ffmpeg.Frame();
    scaledFrame.width = targetWidth;
    scaledFrame.height = targetHeight;
    scaledFrame.format = ffmpeg.constants.pixelFormats.YUVJ420P;
    scaledFrame.alloc();
    scaler.scale(frame, scaledFrame);
    scaledFrame.pts = 0;

    const outputChunks: Buffer[] = [];
    outputIO = new ffmpeg.IOContext(32 * 1024, {
      onwrite: (buffer: Buffer) => {
        outputChunks.push(Buffer.from(buffer));
        return buffer.length;
      }
    });

    outputFmt = new ffmpeg.OutputFormatContext('mjpeg', outputIO);
    const outStream = outputFmt.createStream();
    outStream.codecParameters.id = ffmpeg.constants.codecs.MJPEG;
    outStream.codecParameters.type = ffmpeg.constants.mediaTypes.VIDEO;
    outStream.codecParameters.width = targetWidth;
    outStream.codecParameters.height = targetHeight;
    outStream.codecParameters.format = ffmpeg.constants.pixelFormats.YUVJ420P;
    outStream.timeBase = { numerator: 1, denominator: 25 };

    encoder = outStream.encoder();
    encoder.timeBase = outStream.timeBase;
    encoder.open();
    outStream.codecParameters.fromContext(encoder);

    outputFmt.writeHeader();
    encoder.sendFrame(scaledFrame);

    outPacket = new ffmpeg.Packet();
    while (encoder.receivePacket(outPacket)) {
      outputFmt.writeFrame(outPacket);
      outPacket.unref();
    }

    outputFmt.writeTrailer();
    return Buffer.concat(outputChunks);
  } finally {
    if (outPacket) outPacket.destroy?.();
    if (encoder) encoder.destroy?.();
    if (outputFmt) outputFmt.destroy?.();
    // outputIO ownership transferred to outputFmt - don't destroy separately
    if (scaledFrame) scaledFrame.destroy?.();
    if (scaler) scaler.destroy?.();
    if (frame) frame.destroy?.();
    if (packet) packet.destroy?.();
    if (decoder) decoder.destroy?.();
    if (inputFmt) inputFmt.destroy?.();
    // inputIO ownership transferred to inputFmt - don't destroy separately
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

async function generateThumbnail(filePath: string, videoId: string, channel: any): Promise<{ thumbnailBlobId: string; thumbnailBlobsCoreKey: string } | null> {
  try {
    const thumbBuf = await generateThumbnailWithBareFfmpeg(filePath);

    if (!thumbBuf) {
      console.warn('[Worker] Thumbnail generation failed');
      return null;
    }

    if (!channel.blobs) {
      console.warn('[Worker] Channel blobs not available for thumbnail');
      return null;
    }

    const blobResult = await channel.putBlob(thumbBuf);
    console.log('[Worker] Thumbnail stored in Hyperblobs, blobId:', blobResult.id);
    return {
      thumbnailBlobId: blobResult.id,
      thumbnailBlobsCoreKey: channel.blobsKeyHex
    };
  } catch (err: any) {
    console.warn('[Worker] Thumbnail generation failed:', err?.message || err);
    return null;
  }
}

/**
 * Transcode video to MP4 with AAC audio using bare-ffmpeg.
 * Returns output path + session id, or null on failure.
 */
async function transcodeToMP4(inputPath: string, onProgress?: (percent: number) => void): Promise<{ outputPath: string; sessionId: string } | null> {
  const title = path.basename(inputPath);
  const result = await transcoder.startTranscode(inputPath, {
    duration: 0,
    title,
    onProgress: (sessionId: string, percent: number) => {
      onProgress?.(percent);
    },
  });

  if (!result?.success || !result.sessionId) {
    console.warn('[Worker] Transcode start failed:', result?.error || 'unknown error');
    return null;
  }

  if (!result.outputPath) {
    console.warn('[Worker] Transcode did not return output path');
    try { transcoder.stopTranscode(result.sessionId); } catch {}
    return null;
  }

  const sessionId = result.sessionId;
  const outputPath = result.outputPath;
  const timeoutMs = 30 * 60 * 1000; // 30 minutes
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = transcoder.getStatus(sessionId);
    if (status.error) {
      console.warn('[Worker] Transcode status error:', status.error);
      try { transcoder.stopTranscode(sessionId); } catch {}
      return null;
    }
    if (status.status === 'complete') {
      onProgress?.(100);
      return { outputPath, sessionId };
    }
    if (status.status === 'error') {
      console.warn('[Worker] Transcode failed:', status.error || 'unknown error');
      try { transcoder.stopTranscode(sessionId); } catch {}
      return null;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.warn('[Worker] Transcode timed out');
  try { transcoder.stopTranscode(sessionId); } catch {}
  return null;
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
    const toText = (chunk: unknown) => {
      if (typeof chunk === 'string') return chunk
      if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString()
      return ''
    }

    proc.stdout?.on('data', (chunk: unknown) => { stdout += toText(chunk); });
    proc.stderr?.on('data', (chunk: unknown) => { stderr += toText(chunk); });

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

    proc.on('error', (err: unknown) => {
      reject(err instanceof Error ? err : new Error(String(err)))
    });
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
    const toText = (chunk: unknown) => {
      if (typeof chunk === 'string') return chunk
      if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString()
      return ''
    }

    proc.stdout?.on('data', (chunk: unknown) => { stdout += toText(chunk); });
    proc.stderr?.on('data', (chunk: unknown) => { stderr += toText(chunk); });

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

    proc.on('error', (err: unknown) => {
      reject(err instanceof Error ? err : new Error(String(err)))
    });
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

// WORKAROUND: Empty pipe chunk crash prevention
// =============================================
// pear-pipe can emit null/undefined chunks under certain conditions (e.g., during
// rapid connect/disconnect cycles or when the main process terminates unexpectedly).
// HRPC's compact-encoding decoder crashes when it receives these invalid chunks
// because it expects a valid Buffer.
//
// This wrapper filters out null/undefined chunks before they reach HRPC.
// The warning is logged only once to avoid log spam.
//
// Root cause: pear-pipe doesn't validate chunks before emitting 'data' events.
// Upstream fix deferred - this wrapper is sufficient and low-overhead.
let sawInvalidPipeChunk = false;
const originalPipeOn = typeof ipcPipe.on === 'function' ? ipcPipe.on.bind(ipcPipe) : null;
if (originalPipeOn) {
  ipcPipe.on = (event: any, listener: any) => {
    if (event === 'data' && typeof listener === 'function') {
      const wrapped = (chunk: any) => {
        if (chunk === undefined || chunk === null) {
          if (!sawInvalidPipeChunk) {
            sawInvalidPipeChunk = true;
            console.warn('[Worker] Dropping empty IPC pipe chunk (prevents HRPC decode crash)');
          }
          return;
        }
        listener(chunk);
      };
      return originalPipeOn(event, wrapped);
    }
    return originalPipeOn(event, listener);
  };
}

const rpc = new HRPC(ipcPipe);
console.log('[Worker] HRPC initialized');

// Wire up video stats events
console.log('[Worker] Setting up videoStats callback');
const workerStatsCallback = (driveKey: string, videoPath: string, stats: any) => {
  const progress = typeof stats?.progress === 'number' ? stats.progress : 0;
  console.log('[Worker] videoStats callback fired, progress:', progress);
  try {
    rpc.eventVideoStats({
      stats: {
        videoId: videoPath,
        channelKey: driveKey,
        status: stats?.status || 'unknown',
        progress,
        totalBlocks: stats?.totalBlocks || 0,
        downloadedBlocks: stats?.downloadedBlocks || 0,
        totalBytes: stats?.totalBytes || 0,
        downloadedBytes: stats?.downloadedBytes || 0,
        peerCount: stats?.peerCount || 0,
        speedMBps: stats?.speedMBps || '0',
        uploadSpeedMBps: stats?.uploadSpeedMBps || '0',
        elapsed: stats?.elapsed || 0,
        isComplete: Boolean(stats?.isComplete),
      }
    });
    console.log('[Worker] rpc.eventVideoStats sent successfully');
  } catch (e: any) {
    console.log('[Worker] rpc.eventVideoStats error:', e?.message);
  }
};
(workerStatsCallback as any)._statsMarker = 'worker-rpc';
videoStats.setOnStatsUpdate(workerStatsCallback);

// Flush any buffered stats that fired before HRPC was ready.
if (pendingVideoStats.size > 0) {
  console.log('[Worker] Flushing buffered video stats:', pendingVideoStats.size);
  for (const { driveKey, videoPath, stats } of pendingVideoStats.values()) {
    try {
      workerStatsCallback(driveKey, videoPath, stats);
    } catch {}
  }
  pendingVideoStats.clear();
}

console.log('[Worker] videoStats callback registered');

// ============================================
// HRPC Handlers - Thin Delegation Layer
// ============================================

// Identity handlers
rpc.onCreateIdentity(async (req: any) => {
  console.log('[Worker] onCreateIdentity called, name:', req.name);
  try {
    const result = await identityManager.createIdentity(req.name || 'New Channel', true);
    // Wire identity key file so Corestore becomes deterministic on next start
    if (result.mnemonic) {
      const { needsRestart } = await initializeIdentityFromMnemonic(result.mnemonic);
      if (needsRestart) {
        console.log('[Worker] Identity key file written — backend restart needed for deterministic Corestore');
      }
    }
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
  // Wire identity key file so Corestore becomes deterministic on next start
  if (req.seedPhrase) {
    const { needsRestart } = await initializeIdentityFromMnemonic(req.seedPhrase);
    if (needsRestart) {
      console.log('[Worker] Identity key file written for recovery — backend restart needed');
    }
  }
  return {
    identity: {
      publicKey: result.publicKey,
      driveKey: result.driveKey,
      name: req.name || 'Recovered',
      isActive: true,
    }
  };
});

rpc.onBootstrapDevice(async (req: any) => {
  console.log('[Worker] onBootstrapDevice called');
  try {
    const result = await identityManager.bootstrapDevice(req.mnemonic);
    return {
      proof: result.proof,
      identityPublicKey: result.identityPublicKey,
    };
  } catch (err: any) {
    console.error('[Worker] bootstrapDevice failed:', err.message);
    throw err;
  }
});

rpc.onAttestDevice(async (req: any) => {
  console.log('[Worker] onAttestDevice called');
  try {
    const proof = await identityManager.attestDevice(
      req.identityKeyPair,
      req.devicePublicKey,
      req.proof || null
    );
    return { proof };
  } catch (err: any) {
    console.error('[Worker] attestDevice failed:', err.message);
    throw err;
  }
});

rpc.onVerifyAttestation(async (req: any) => {
  console.log('[Worker] onVerifyAttestation called');
  try {
    const result = await identityManager.verifyAttestation(req.proof);
    return {
      valid: result.valid,
      identityPublicKey: result.identityPublicKey || '',
      devicePublicKey: result.devicePublicKey || '',
    };
  } catch (err: any) {
    console.error('[Worker] verifyAttestation failed:', err.message);
    return { valid: false, identityPublicKey: '', devicePublicKey: '' };
  }
});

// Channel handlers
rpc.onGetChannel(async (req: any) => {
  const channel = await api.getChannel(req.publicKey || '');
  return { channel };
});

rpc.onGetChannelMeta(async (req: any) => {
  const meta = await api.getChannelMeta(req.channelKey, req.publicBeeKey || null);
  return { name: meta.name, description: meta.description, videoCount: meta.videoCount || 0 };
});

rpc.onUpdateChannel(async (req: any) => {
  const active = identityManager.getActiveIdentity();
  if (!active?.driveKey) return { success: false, error: 'No active channel' };
  try {
    const result = await api.updateChannel(active.driveKey, {
      name: req.name,
      description: req.description,
      avatar: req.avatar
    });
    return result;
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onUpdateVideoMetadata?.(async (req: any) => {
  const active = identityManager.getActiveIdentity();
  if (!active?.driveKey) return { success: false, error: 'No active channel' };
  try {
    const result = await api.updateVideoMetadata(
      req.channelKey || active.driveKey,
      req.videoId,
      { title: req.title, description: req.description, category: req.category }
    );
    return result;
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onUpdateChannelAvatar?.(async (req: any) => {
  const active = identityManager.getActiveIdentity();
  if (!active?.driveKey) return { success: false, error: 'No active channel' };
  try {
    const imageBuffer = fs.readFileSync(req.filePath);
    const result = await api.updateChannelAvatar(active.driveKey, imageBuffer, req.mimeType || 'image/jpeg');
    return result;
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
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
  let transcodeSessionId: string | null = null;
  let mimeType = getMimeTypeFromPath(req.filePath);

  // Check if audio needs transcoding (AC3, DTS, etc. -> AAC)
  const shouldTranscodeAudio = false; // Disabled for desktop now that mpv is the default player.
  if (shouldTranscodeAudio) {
    let probeResult: any = null;
    try {
      probeResult = await transcoder.probeMedia(req.filePath, req.title);
      console.log('[Worker] Audio codec detected:', probeResult.audioCodec);
    } catch (err: any) {
      console.warn('[Worker] Audio probe failed:', err?.message || err);
    }

    if (probeResult?.needsAudioTranscode) {
      console.log('[Worker] Audio codec', probeResult.audioCodec, 'needs transcoding to AAC');

      // Send initial "transcoding" status (negative progress indicates transcoding phase)
      rpc.eventUploadProgress({
        videoId: 'transcoding',
        progress: 0,
        bytesUploaded: 0,
        totalBytes: 0,
        speed: 0,
        eta: 0
      });

      const transcodeResult = await transcodeToMP4(req.filePath, (percent) => {
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

      if (transcodeResult) {
        transcodedPath = transcodeResult.outputPath;
        transcodeSessionId = transcodeResult.sessionId;
        uploadPath = transcodedPath;
        mimeType = 'video/mp4';
        console.log('[Worker] Using transcoded file for upload:', uploadPath);
      } else {
        console.warn('[Worker] Transcoding failed, uploading original file');
      }
    }
  }

  // Probe video dimensions
  let videoDimensions = { width: 0, height: 0 };
  try {
    const dimProbe = await transcoder.probeMedia(uploadPath, req.title) as any;
    videoDimensions = { width: dimProbe.width || 0, height: dimProbe.height || 0 };
  } catch (err: any) {
    console.warn('[Worker] Dimension probe failed (non-fatal):', err?.message || err);
  }

  // Upload the file to Hyperblobs
  const result = await uploadManager.uploadFromPath(
    channel,
    uploadPath,
    { title: req.title, description: req.description, mimeType, width: videoDimensions.width, height: videoDimensions.height },
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
  if (transcodeSessionId) {
    try {
      transcoder.stopTranscode(transcodeSessionId);
      console.log('[Worker] Cleaned up transcoded temp file');
    } catch (err) {
      console.warn('[Worker] Failed to cleanup transcoded file:', err);
    }
  } else if (transcodedPath) {
    try {
      fs.unlinkSync(transcodedPath);
      console.log('[Worker] Cleaned up transcoded temp file');
    } catch (err) {
      console.warn('[Worker] Failed to cleanup transcoded file:', err);
    }
  }

  // Generate thumbnail if no custom thumbnail will be provided
  if (result.success && result.videoId && !req.skipThumbnailGeneration) {
    console.log('[Worker] Generating thumbnail with bare-media');
    try {
      // Use unified bare-media thumbnail generation
      const thumbResult = await generateAndStoreThumbnail(req.filePath, result.videoId, channel, {
        frameIndex: 300 // ~10 seconds at 30fps
      });
      if (thumbResult?.thumbnailBlobId) {
        console.log('[Worker] Thumbnail stored with blobId:', thumbResult.thumbnailBlobId);
        // Update video metadata with thumbnail info
        await channel.updateVideo(result.videoId, {
          thumbnailBlobId: thumbResult.thumbnailBlobId,
          thumbnailBlobsCoreKey: thumbResult.thumbnailBlobsCoreKey,
          thumbnailMimeType: thumbResult.thumbnailMimeType
        });
      }
    } catch (thumbErr: any) {
      console.warn('[Worker] Thumbnail generation failed:', thumbErr?.message);
    }
  } else if (req.skipThumbnailGeneration) {
    console.log('[Worker] Skipping thumbnail - custom thumbnail will be uploaded');
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
  const requestKey = req.publicBeeKey ? req.publicBeeKey.slice(0, 16) : 'missing';
  console.log('[HRPC] downloadVideo request decoded:', req.channelKey?.slice(0, 16), req.videoId, 'publicBeeKey:', requestKey);

  try {
    // Use getVideoUrl which handles both local and remote channels
    const result = await api.getVideoUrl(req.channelKey, req.videoId, req.publicBeeKey);
    if (!result?.url) {
      return { success: false, error: 'Failed to get video URL' };
    }

    // Try to get video metadata for size info
    const meta = await api.getVideoData(req.channelKey, req.videoId, req.publicBeeKey);
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
  const active = identityManager.getActiveIdentity?.();
  const channel = await identityManager.getActiveChannel?.();
  if (!channel) return { success: false, error: 'No active channel' };
  if (!channel.writable) {
    const key = channel.keyHex || active?.driveKey || 'unknown';
    return { success: false, error: `Active channel is read-only on this device (channel=${String(key).slice(0, 16)})` };
  }
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
    const res = await api.prefetchVideo(req.channelKey, req.videoId, req.publicBeeKey || null);
    if (res?.success === false) {
      console.log('[Worker] onPrefetchVideo failed:', res?.error);
      return { success: false };
    }
    console.log('[Worker] onPrefetchVideo completed');
    return { success: true };
  } catch (e: any) {
    console.log('[Worker] onPrefetchVideo error:', e?.message);
    return { success: false };
  }
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

// Transcode settings handlers
rpc.onGetTranscodeSettings(async () => {
  return api.getTranscodeSettings();
});

rpc.onSetTranscodeSettings(async (req: any) => {
  return api.setTranscodeSettings(req);
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
        type: 'image/jpeg',
        host: ctx.blobServerHost || '127.0.0.1',
        port: ctx.blobServer?.port || ctx.blobServerPort
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
    console.log('[Worker] mpv loading URL:', req.url);
    // Verify the URL is accessible before loading
    try {
      const urlCheck = new URL(req.url);
      console.log('[Worker] mpv URL parsed - host:', urlCheck.hostname, 'port:', urlCheck.port, 'path:', urlCheck.pathname);
    } catch (urlErr: any) {
      console.error('[Worker] mpv URL parse error:', urlErr?.message);
    }
    state.player.loadFile(req.url);
    console.log('[Worker] mpv loadFile called, waiting for playback...');
    return { success: true, error: null };
  } catch (err: any) {
    console.error('[Worker] mpvLoadFile error:', err?.message);
    return { success: false, error: err?.message || 'Failed to load file' };
  }
});

rpc.onMpvPlay(async (req: any) => {
  console.log('[Worker] mpvPlay called for:', req.playerId);
  const state = mpvPlayers.get(req.playerId);
  if (!state) {
    console.log('[Worker] mpvPlay: player not found');
    return { success: false };
  }
  try {
    state.player.play();
    console.log('[Worker] mpvPlay: play() called');
    return { success: true };
  } catch (err: any) {
    console.error('[Worker] mpvPlay error:', err?.message);
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
let activeCastSourceKey: string | null = null; // Stable source key for active cast session
const castSessionsWithLoadSent = new Set<string>();

// Worker-level debouncing for castPlay to prevent native crashes from concurrent calls
let castPlayInProgress = false;
let lastCastPlayTime = 0;
const CAST_PLAY_DEBOUNCE_MS = 1500; // 1.5 second minimum between play calls

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
        // Bug 3 fix: clear source key on terminal states so retry is not suppressed
        if (state === 'stopped' || state === 'idle' || state === 'disconnected' || state === 'error') {
          activeCastSourceKey = null;
          if (activeCastTranscodeId) castSessionsWithLoadSent.delete(activeCastTranscodeId);
        }
        rpc.eventCastPlaybackState?.({ state });
      } catch {}
    });

    castContext.on('timeChanged', (time: number) => {
      try {
        // compact-encoding uint requires positive integers (>=1), clamp to avoid encoding errors
        rpc.eventCastTimeUpdate?.({ currentTime: Math.max(1, Math.floor(time || 0)) });
      } catch {}
    });

    castContext.on('error', (error: any) => {
      try {
        // Bug 3 fix: clear source key so retry is not suppressed after error
        activeCastSourceKey = null;
        if (activeCastTranscodeId) castSessionsWithLoadSent.delete(activeCastTranscodeId);
        const message = error?.message || (error ? String(error) : 'Unknown error');
        console.warn('[CastDiag] Chromecast error (raw):', message);
        console.warn('[Worker] Cast error:', message);
        // Only emit error state if we have a meaningful error message
        if (message && message !== 'undefined' && message !== '[object Object]') {
          rpc.eventCastPlaybackState?.({ state: 'error', error: message });
        }
      } catch {}
    });
  }
  return castContext;
}

const CAST_LOCALHOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1']);

function normalizeCastVolume(volume: any): number {
  const value = typeof volume === 'number' && Number.isFinite(volume) ? volume : 1;
  if (value > 1) {
    return Math.max(0, Math.min(100, value)) / 100;
  }
  return Math.max(0, Math.min(1, value));
}

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

function normalizeLocalUrlForWorker(url: string): string {
  try {
    const parsed = new URL(url);
    if (CAST_LOCALHOSTS.has(parsed.hostname)) {
      parsed.hostname = '127.0.0.1';
      return parsed.toString();
    }
  } catch {}
  return url;
}

function buildTranscodeCacheKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    const keyParam = parsed.searchParams.get('key');
    const blobParam = parsed.searchParams.get('blob');
    if (keyParam && blobParam) {
      return `blob:${keyParam}:${blobParam}`;
    }
    parsed.searchParams.delete('token');
    parsed.searchParams.delete('type');
    const entries = Array.from(parsed.searchParams.entries());
    entries.sort((a, b) => {
      if (a[0] === b[0]) return a[1].localeCompare(b[1]);
      return a[0].localeCompare(b[0]);
    });
    const params = new URLSearchParams();
    for (const [key, value] of entries) {
      params.append(key, value);
    }
    parsed.search = params.toString();
    return parsed.toString();
  } catch {
    return null;
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
  await loadBareFcast();
  if (!CastContext) {
    return { success: false, error: castLoadError || 'bare-fcast not available' };
  }
  const ctx = getCastContext();
  let deviceInfo = null as any;
  try {
    try {
      const devices = ctx.getDevices?.() || [];
      const device = devices.find((d: any) => d.id === req.deviceId);
      if (device) {
        console.log('[Worker] Cast connect:', device.name, device.protocol, device.host + ':' + device.port);
        deviceInfo = device;
      } else {
        console.log('[Worker] Cast connect: device not found for', req.deviceId);
      }
    } catch {}
    await ctx.connect(req.deviceId);
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

    // Clean up active transcode session when cast session ends
    if (activeCastTranscodeId) {
      console.log('[Worker] Cleaning up transcode cache:', activeCastTranscodeId);
      castSessionsWithLoadSent.delete(activeCastTranscodeId);
      castTranscoder.stopCastTranscode(activeCastTranscodeId);
      transcodeSessions.delete(activeCastTranscodeId);
      activeCastTranscodeId = null;
      activeCastSourceKey = null;
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

  // Worker-level debounce to prevent native crashes from concurrent castPlay calls
  const now = Date.now();
  if (castPlayInProgress) {
    console.warn('[Worker] castPlay already in progress, ignoring duplicate call');
    return { success: true }; // Return success to avoid UI errors
  }
  if (now - lastCastPlayTime < CAST_PLAY_DEBOUNCE_MS) {
    console.warn('[Worker] castPlay called too soon after previous call, ignoring');
    return { success: true }; // Return success to avoid UI errors
  }
  castPlayInProgress = true;
  lastCastPlayTime = now;

  const requestedUrl = normalizeLocalUrlForWorker(req.url);
  const protocol = castContext?._connectedDevice?.deviceInfo?.protocol;
  const deviceHost = castContext?._connectedDevice?.deviceInfo?.host;
  const requestedKey = buildTranscodeCacheKey(requestedUrl) || requestedUrl;

  if (
    protocol === 'chromecast' &&
    activeCastTranscodeId &&
    castSessionsWithLoadSent.has(activeCastTranscodeId) &&
    activeCastSourceKey === requestedKey
  ) {
    console.log('[Worker] Cast play: HLS already active for this source, skipping reload');
    return { success: true };
  }

  let url = req.url;
  let contentType = req.contentType;
  let currentTranscodeSessionId: string | null = null;
  let streamType: 'LIVE' | 'BUFFERED' = 'BUFFERED';
  let mediaDuration: number | undefined;

  try {
    if (protocol === 'chromecast') {
      try {
        console.log('[Worker] Probing media for Chromecast...');
        const probeResult = await transcoder.probeMedia(requestedUrl, req.title);
        mediaDuration = probeResult.duration;
        console.log('[Worker] Probe result:', {
          video: probeResult.videoCodec,
          audio: probeResult.audioCodec,
          profile: probeResult.videoProfile,
          level: probeResult.videoLevel,
          container: probeResult.container,
          duration: probeResult.duration,
          fileSize: probeResult.fileSize ? Math.round(probeResult.fileSize / 1024 / 1024) + 'MB' : 'unknown',
          moovAtEnd: probeResult.moovAtEnd,
          needsTranscode: probeResult.needsTranscode,
          needsRemux: probeResult.needsRemux,
          reason: probeResult.reason,
        });

        const needsProcessing = probeResult.needsVideoTranscode || probeResult.needsAudioTranscode || probeResult.needsRemux;

        const localIp = await getLocalIPv4ForTarget(deviceHost);

        if (!needsProcessing) {
          if (localIp) {
            url = rewriteUrlHost(requestedUrl, localIp);
          } else {
            url = requestedUrl;
          }
          contentType = 'video/mp4';
          console.log('[Worker] Cast play: direct serve (no transcode needed):', url);
        } else {
          console.log('[Worker] Cast play: fMP4 transcoding needed -', probeResult.reason);

          let isVideoComplete = true;
          let syncStatus: any = null;
          try {
            syncStatus = await api.checkVideoSync(requestedUrl);
            console.log('[Worker] Cast play: video sync status -',
              syncStatus.progress + '%',
              '(' + syncStatus.availableBlocks + '/' + syncStatus.totalBlocks + ' blocks)',
              syncStatus.isComplete ? 'COMPLETE' : 'INCOMPLETE',
              syncStatus.assumed ? '(ASSUMED)' : '');
            isVideoComplete = syncStatus.isComplete;
            if (!syncStatus.isComplete && !syncStatus.assumed) {
              const sizeMB = Math.round((syncStatus.byteLength || 0) / 1024 / 1024);
              const downloadedMB = Math.round(sizeMB * syncStatus.progress / 100);
              console.warn('[Worker] Cast play: Video may not be fully synced!',
                downloadedMB + 'MB /', sizeMB + 'MB downloaded.',
                'Proceeding anyway.');
            }
          } catch (syncErr: any) {
            console.warn('[Worker] Cast play: Could not check sync status:', syncErr?.message);
            isVideoComplete = true;
            syncStatus = null;
          }

          void syncStatus;

          console.log('[Worker] Cast play: starting fMP4 cast transcode...');
          const result = await castTranscoder.startCastTranscode(requestedUrl, {
            sourceKey: requestedKey,
            isVideoComplete,
          });

          if (!result.success) {
            throw new Error(result.error || 'Cast transcode failed');
          }

          currentTranscodeSessionId = result.sessionId;
          console.log('[Worker] Cast play: cast session:', result.sessionId, 'reused:', result.reused || false);

          if (result.reused) {
            const status = castTranscoder.getCastStatus(result.sessionId);
            console.log('[Worker] Cast play: Reused session has', status?.fragmentCount || 0, 'fragments');
            if (castSessionsWithLoadSent.has(result.sessionId)) {
              activeCastTranscodeId = result.sessionId;
              activeCastSourceKey = requestedKey;
              console.log('[Worker] Cast play: LOAD already sent for this session, skipping duplicate LOAD');
              return { success: true };
            }
          } else {
            const MAX_WAIT_MS = 30000;
            const POLL_INTERVAL_MS = 500;
            console.log('[Worker] Cast play: Waiting for first fMP4 fragment...');
            const waitStart = Date.now();
            let fragmentCount = 0;
            while (Date.now() - waitStart < MAX_WAIT_MS) {
              const status = castTranscoder.getCastStatus(result.sessionId);
              fragmentCount = status?.fragmentCount || 0;
              if (fragmentCount >= 1) {
                console.log('[Worker] Cast play:', fragmentCount, 'fragments ready');
                break;
              }
              if (status?.status === 'error') {
                throw new Error(status.error || 'Cast transcode failed while waiting for fragments');
              }
              const elapsed = Date.now() - waitStart;
              if (elapsed % 3000 < POLL_INTERVAL_MS) {
                console.log('[Worker] Cast play: waiting...', fragmentCount, 'fragments, elapsed:', Math.round(elapsed / 1000) + 's');
              }
              await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
            }
            if (fragmentCount < 1) {
              console.warn('[Worker] Cast play: Timeout waiting for fragments, proceeding anyway with', fragmentCount, 'fragments');
            }
            console.log('[CastDiag] fragmentCount after wait:', fragmentCount);
          }

          const hlsUrl = castTranscoder.getCastHlsUrl(result.sessionId, localIp || '127.0.0.1');
          if (!hlsUrl) {
            throw new Error('Could not get cast HLS URL');
          }
          url = hlsUrl;
          contentType = 'application/vnd.apple.mpegurl';
          streamType = 'BUFFERED';
          console.log('[CastDiag] streamType:', streamType, 'mediaDuration:', mediaDuration);
          console.log('[Worker] Cast play: using fMP4 HLS URL', url);
        }
      } catch (probeErr: any) {
        console.warn('[Worker] Cast play: probe/transcode failed, trying direct play:', probeErr?.message);
      }

      if (contentType === 'application/vnd.apple.mpegurl') {
        console.log('[Worker] Cast play: skipping proxy for HLS (direct access to segments needed)');
      } else {
        let usedDirect = false;
        try {
          const parsed = new URL(req.url);
          if (CAST_LOCALHOSTS.has(parsed.hostname)) {
            const localIp = await getLocalIPv4ForTarget(deviceHost);
            if (localIp) {
              url = rewriteUrlHost(req.url, localIp);
              usedDirect = true;
              console.log('[Worker] Cast play: using direct blob URL', url);
            }
          }
        } catch {}

        let usedProxy = false;
        try {
          if (!usedDirect) {
            await ensureCastProxyServer();
            const proxyUrl = await createCastProxyUrl(deviceHost, req.url);
            if (proxyUrl) {
              url = proxyUrl;
              usedProxy = true;
              console.log('[Worker] Cast play: using proxy URL', proxyUrl);
            }
          }
        } catch (err: any) {
          console.warn('[Worker] Cast proxy init failed:', err?.message || err);
        }
        if (!usedProxy && !usedDirect) {
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

    try {
      let host = 'unknown';
      try {
        const parsed = new URL(url);
        host = parsed.host;
      } catch {}
      console.log('[Worker] Cast play:', protocol || 'unknown', 'contentType:', contentType, 'host:', host);
    } catch {}

    // IMPORTANT: Stop any current media first to clear Chromecast's cached state
    // Otherwise Chromecast may keep polling the old URL instead of loading new one
    try {
      console.log('[Worker] Cast play: Stopping current media before loading new...');
      await castContext.stop();
      // Small delay to ensure Chromecast processes the stop
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (stopErr: any) {
      console.log('[Worker] Cast play: Stop before load failed (ok if nothing playing):', stopErr?.message);
    }

    const previousSessionId = activeCastTranscodeId;
    if (previousSessionId && previousSessionId !== currentTranscodeSessionId) {
      if (!currentTranscodeSessionId && activeCastSourceKey === requestedKey) {
        console.log('[Worker] Cast play: Keeping existing HLS session for same source');
      } else {
        console.log('[Worker] Cast play: Cleaning up previous transcode session:', previousSessionId);
        castSessionsWithLoadSent.delete(previousSessionId);
        castTranscoder.stopCastTranscode(previousSessionId);
        if (!currentTranscodeSessionId) {
          activeCastTranscodeId = null;
          activeCastSourceKey = null;
        }
      }
    }

    if (currentTranscodeSessionId) {
      activeCastTranscodeId = currentTranscodeSessionId;
      activeCastSourceKey = requestedKey;
    }

    console.log('[CastDiag] LOAD payload:', { url, contentType, streamType, title: req.title });
    await castContext.play({
      url,
      contentType,
      title: req.title,
      thumbnail: req.thumbnail,
      time: req.time || 0,
      volume: normalizeCastVolume(req.volume),
      streamType,
      duration: mediaDuration,
    });

    if (activeCastTranscodeId && contentType === 'application/vnd.apple.mpegurl') {
      castSessionsWithLoadSent.add(activeCastTranscodeId);
    }

    lastCastPlayTime = Date.now();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  } finally {
    castPlayInProgress = false;
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

    // Clean up active transcode session when cast stops
    if (activeCastTranscodeId) {
      console.log('[Worker] Cleaning up transcode cache on stop:', activeCastTranscodeId);
      castSessionsWithLoadSent.delete(activeCastTranscodeId);
      castTranscoder.stopCastTranscode(activeCastTranscodeId);
      transcodeSessions.delete(activeCastTranscodeId);
      activeCastTranscodeId = null;
      activeCastSourceKey = null;
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
    await castContext.setVolume(normalizeCastVolume(req.volume));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message };
  }
});

rpc.onCastGetState(async () => {
  // compact-encoding uint requires positive integers (>=1)
  // For optional uint fields, omit them or use 1 as minimum
  if (!castContext) {
    return { state: 'idle' }; // omit zero uint fields
  }
  try {
    const state = castContext.getPlaybackState();
    const result: { state: string; currentTime?: number; duration?: number; volume?: number } = {
      state: state.state || 'idle'
    };
    // Only include uint fields if they're positive
    if (state.currentTime > 0) result.currentTime = Math.floor(state.currentTime);
    if (state.duration > 0) result.duration = Math.floor(state.duration);
    if (state.volume > 0) result.volume = Math.floor(state.volume * 100); // convert 0-1 to 0-100
    return result;
  } catch {
    return { state: 'idle' };
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

rpc.onTranscodeStart?.(async (req: any) => {
  try {
    const sourceUrl = normalizeLocalUrlForWorker(req.sourceUrl);
    const cacheKey = buildTranscodeCacheKey(sourceUrl) || sourceUrl;

    const onProgress = (sessionId: string, percent: number) => {
      handleTranscodeProgress(sessionId, percent);
    };

    const result = await transcoder.startTranscode(sourceUrl, {
      duration: req.duration || 0,
      title: req.title || '',
      onProgress,
    });

    if (!result?.success) {
      return { success: false, error: result?.error || 'Failed to start transcode' };
    }

    const sessionId = result.sessionId
    if (!sessionId) {
      return { success: false, error: 'Missing transcode session id' };
    }
    const transcodeUrl = result.transcodeUrl || ''

    const session: TranscodeSession = {
      id: sessionId,
      inputUrl: sourceUrl,
      cacheKey,
      status: 'transcoding',
      progress: 0,
      mode: req.mode || 'transcode',
      transcodeUrl,
    };
    transcodeSessions.set(sessionId, session);

    console.log('[Worker] Transcode started:', sessionId, 'url:', transcodeUrl);
    return {
      success: true,
      sessionId,
      transcodeUrl,
    };
  } catch (err: any) {
    console.error('[Worker] Transcode start error:', err?.message || err);
    return { success: false, error: err?.message || 'Failed to start transcode' };
  }
});

rpc.onTranscodeStop?.(async (req: any) => {
  try {
    const result = transcoder.stopTranscode(req.sessionId);
    transcodeSessions.delete(req.sessionId);
    console.log('[Worker] Transcode stopped:', req.sessionId);
    return { success: result.success, error: result.error || '' };
  } catch (err: any) {
    console.error('[Worker] Transcode stop error:', err?.message || err);
    return { success: false, error: err?.message || 'Failed to stop transcode' };
  }
});

rpc.onTranscodeStatus?.(async (req: any) => {
  try {
    const status = transcoder.getStatus(req.sessionId);
    return {
      status: status.status || '',
      progress: status.progress || 0,
      bytesWritten: status.bytesWritten || 0,
      error: status.error || '',
    };
  } catch (err: any) {
    return { status: 'error', progress: 0, bytesWritten: 0, error: err?.message || 'Status failed' };
  }
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
