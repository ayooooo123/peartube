/* eslint-disable no-restricted-imports, @typescript-eslint/ban-ts-comment, no-empty, no-extra-semi, @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-expressions, prefer-const */
/**
 * PearTube Desktop Worker — Thin HRPC Handler Shim
 * Initializes via createBackend() from @peartube/backend, which registers
 * all shared HRPC handlers via registerSharedHandlers(). Handler dispatch
 * resolves methods on the `backend` object at call-time, so we attach
 * desktop-specific implementations AFTER createBackend() returns.
 */
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import { spawn } from 'bare-subprocess'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import http1 from 'bare-http1'
// @ts-ignore
import { selectLocalIPv4ForTarget } from '@peartube/backend/cast/network-address'
// @ts-ignore
import { redactCapabilityUrl } from '@peartube/backend/capability-url'
// @ts-ignore
import * as transcoder from '@peartube/backend/transcode/transcoder'
// @ts-ignore
import * as castTranscoder from '@peartube/backend/transcode/cast-transcoder'
// @ts-ignore
import { generateAndStoreThumbnail } from '@peartube/backend/thumbnail'
// @ts-ignore
import { createBackend } from '@peartube/backend/src/backend-entry.js'
// @ts-ignore
import { createBackendContext } from '@peartube/backend/orchestrator'
// @ts-ignore
import { PROTOCOL_VERSION } from '@peartube/host'
// @ts-ignore
import { isExpectedBlobRequestCancellation } from '@peartube/backend/blob-request-cancellation'
// @ts-ignore
import { normalizeUploadVideoMediaMetadata } from '@peartube/backend/upload-video-contract'
// Bare runtime globals (available when spawned via pear.run())
declare const Bare: { argv: string[]; IPC: any } | undefined

// Prevent a stray promise rejection or thrown error from aborting the entire
// desktop backend worker. On the Bare runtime the default
// unhandledRejection/uncaughtException handler calls abort() (SIGABRT), which
// tears down the app's whole backend — observed as recurring `bare` crashes.
// The mobile backend (packages/app/backend/index.mjs) already installs this
// parity; the desktop worker was missing it. Log the reason and return true to
// suppress the fatal default; expected P2P blob-range cancellations are consumed
// silently. Covers post-import runtime rejections (static imports run first).
if (typeof Bare !== 'undefined' && Bare !== null && 'on' in Bare) {
  const on = Bare.on
  if (typeof on === 'function') {
    on.call(Bare, 'unhandledRejection', (reason: unknown) => {
      let expected = false
      try { expected = isExpectedBlobRequestCancellation(reason) } catch { expected = false }
      if (expected) return true
      try {
        console.error('[DesktopWorker] Unhandled rejection:', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
      } catch {}
      return true
    })
    on.call(Bare, 'uncaughtException', (error: unknown) => {
      try {
        console.error('[DesktopWorker] Uncaught exception:', error instanceof Error ? (error.stack ?? error.message) : String(error))
      } catch {}
      return true
    })
  }
}
// Cast proxy infrastructure
let castProxyServer: any = null
let castProxyPort = 0
let castProxyReady: Promise<number> | null = null
const castProxySessions = new Map<string, { url: string; createdAt: number; lastAccessAt?: number; transcodeSessionId?: string; isHls?: boolean }>()
const CAST_PROXY_TTL_MS = 8 * 60 * 60 * 1000
interface TranscodeSession {
  id: string; inputUrl: string; cacheKey: string
  status: 'pending' | 'transcoding' | 'complete' | 'error'; progress: number
  transcodeUrl?: string; proxyUrl?: string; error?: string
  mode: 'transcode' | 'audio' | 'remux'; duration?: number
}
const transcodeSessions = new Map<string, TranscodeSession>()
function handleTranscodeProgress(sessionId: string, progress: number) {
  const session = transcodeSessions.get(sessionId)
  if (session) session.progress = progress
  try { rpc?.eventTranscodeProgress?.({ sessionId, percent: progress, bytesWritten: 0 }) } catch {}
}
function cleanupTranscodeSessions() {
  for (const [id] of transcodeSessions) { try { transcoder.stopTranscode(id) } catch {} }
  transcodeSessions.clear()
  if (activeCastTranscodeId) {
    try { castTranscoder.stopCastTranscode(activeCastTranscodeId) } catch {}
    castSessionsWithLoadSent.delete(activeCastTranscodeId)
    activeCastTranscodeId = null; activeCastSourceKey = null
  }
}
function cleanupCastProxySessions(now = Date.now()) {
  for (const [token, entry] of castProxySessions.entries()) {
    if (now - (entry.lastAccessAt || entry.createdAt) > CAST_PROXY_TTL_MS) castProxySessions.delete(token)
  }
}
function buildLocalProxyTarget(url: string): URL | null {
  try {
    const parsed = new URL(url)
    if (CAST_LOCALHOSTS.has(parsed.hostname)) parsed.hostname = '127.0.0.1'
    return parsed
  } catch { return null }
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
        console.log('[CastProxy] incoming', req.method || 'GET', redactCapabilityUrl(req.url || '/'));
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
      const rewriteHlsPlaylist = (body: string, isComplete: boolean = false) => {
        const lines = body.split(/\r?\n/); const segments: Array<{ inf: string; uri: string }> = []; let targetDuration: string | null = null; let mediaSequence: number | null = null; let pendingInf: string | null = null; let maxDuration = 0
        const rewriteUri = (trimmed: string) => { let pathPart = trimmed; let query = ''; if (/^https?:\/\//i.test(trimmed)) { try { const parsedUrl = new URL(trimmed); pathPart = parsedUrl.pathname || ''; query = parsedUrl.search || '' } catch { pathPart = trimmed } } else { const qIndex = trimmed.indexOf('?'); if (qIndex !== -1) { pathPart = trimmed.slice(0, qIndex); query = trimmed.slice(qIndex) } }; if (pathPart.startsWith('/')) pathPart = path.posix.basename(pathPart); pathPart = pathPart.replace(/^\.?\//, '').replace(/^(\.\.\/)+ /, ''); if (!pathPart) return ''; return `${pathPart}${query}` }
        for (const line of lines) { const trimmed = line.trim(); if (!trimmed) continue; if (trimmed.startsWith('#EXT-X-TARGETDURATION:')) { targetDuration = trimmed.split(':')[1]?.trim() || null; continue }; if (trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { const raw = trimmed.split(':')[1]?.trim(); const parsed = raw ? Number(raw) : NaN; if (!Number.isNaN(parsed)) mediaSequence = parsed; continue }; if (trimmed.startsWith('#EXTINF:')) { pendingInf = trimmed; const raw = trimmed.split(':')[1]?.split(',')[0]?.trim(); const parsed = raw ? Number(raw) : NaN; if (!Number.isNaN(parsed)) maxDuration = Math.max(maxDuration, parsed); continue }; if (trimmed.startsWith('#')) continue; const rewritten = rewriteUri(trimmed); if (!rewritten) continue; if (pendingInf) segments.push({ inf: pendingInf, uri: rewritten }); pendingInf = null }
        const maxSegments = 10000; const dropCount = Math.max(0, segments.length - maxSegments); const kept = segments.slice(-maxSegments); let seq = mediaSequence; if (seq == null && kept.length) { const match = kept[0].uri.match(/(\d+)(?:\D+)?$/); if (match) seq = Number(match[1]) }; if (seq == null) seq = 0; seq += dropCount
        const output: string[] = ['#EXTM3U', '#EXT-X-VERSION:3']; const targetDurationValue = Math.max(targetDuration ? Number(targetDuration) || 0 : 0, Math.ceil(maxDuration || 0)); if (targetDurationValue > 0) output.push(`#EXT-X-TARGETDURATION:${targetDurationValue}`); output.push(`#EXT-X-MEDIA-SEQUENCE:${seq}`); for (const seg of kept) { output.push(seg.inf); output.push(seg.uri) }; if (isComplete) output.push('#EXT-X-ENDLIST'); output.push(''); return output.join('\r\n')
      };

      if (!token || !castProxySessions.has(token)) {
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
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Cast proxy target invalid.');
        return;
      }
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
            const streamUrl = `/cast/${token}/stream.m3u8`;
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
            if (!res.headersSent) { res.statusCode = 502; res.end('Cast proxy upstream error'); }
          });
          return;
        }

        if (isM3u8 && (proxyRes.statusCode || 200) < 400) {
          let body = '';
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (chunk: string) => { body += chunk; });
          proxyRes.on('end', () => {
            const transcodeSession = entry?.transcodeSessionId
              ? transcodeSessions.get(entry.transcodeSessionId)
              : null;
            const isTranscodeComplete = transcodeSession?.status === 'complete';
            const rewritten = rewriteHlsPlaylist(body, isTranscodeComplete);
            const segments = rewritten.split(/\r?\n/).filter((l: string) => l.endsWith('.ts'));
            console.log(`[CastProxy] playlist has ${segments.length} segments`);
            const out = Buffer.from(rewritten, 'utf8');
            res.statusCode = proxyRes.statusCode || 200;
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Content-Length', out.byteLength);
            res.setHeader('Cache-Control', 'no-cache');
            setCorsHeaders(res);
            res.end(out);
          });
          proxyRes.on('error', (err: any) => {
            if (!res.headersSent) { res.statusCode = 502; res.end('Cast proxy upstream error'); }
          });
          return;
        }

        res.statusCode = proxyRes.statusCode || 502;
        if (proxyRes.headers) {
          for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (value !== undefined) res.setHeader(key, value as any);
          }
        }
        setCorsHeaders(res);
        let pipeCleanedUp = false;
        const cleanupPipe = () => {
          if (pipeCleanedUp) return;
          pipeCleanedUp = true;
          try { proxyRes.unpipe?.(res); } catch {}
          try { proxyRes.destroy?.(); } catch {}
        };
        proxyRes.on('error', () => cleanupPipe());
        res.on('error', () => cleanupPipe());
        res.on('close', () => cleanupPipe());

        proxyRes.on('data', (chunk: any) => {
          if (pipeCleanedUp) return;
          try {
            const canWrite = res.write(chunk);
            if (!canWrite && !pipeCleanedUp) {
              proxyRes.pause?.();
              res.once('drain', () => { if (!pipeCleanedUp) proxyRes.resume?.(); });
            }
          } catch { cleanupPipe() }
        });
        proxyRes.on('end', () => { if (!pipeCleanedUp) try { res.end() } catch {} });
      });

      proxyReq.on('error', (err: any) => {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/plain');
          res.end(`Cast proxy upstream error: ${err?.message || err}`);
          return;
        }
        try { res.end() } catch {}
      });
      const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method)
        && (req.headers?.['content-length'] || req.headers?.['transfer-encoding']);
      if (hasBody) req.pipe(proxyReq);
      else proxyReq.end();
    });

    castProxyServer.on('error', (err: any) => { resetProxyState(); reject(err) });
    castProxyServer.on('close', () => resetProxyState());
    castProxyServer.listen(0, '0.0.0.0', () => {
      const addr = castProxyServer.address?.() || null;
      castProxyPort = addr?.port || 0;
      console.log('[CastProxy] listening on port:', castProxyPort);
      resolve(castProxyPort);
    });
  });

  return castProxyReady;
}
async function createCastProxyUrl(targetHost: string | undefined, sourceUrl: string, transcodeSessionId?: string): Promise<string | null> {
  const localIp = await getLocalIPv4ForTarget(targetHost)
  if (!localIp || !castProxyPort) return null
  cleanupCastProxySessions()
  const token = b4a.toString(crypto.randomBytes(16), 'hex')
  const now = Date.now()
  const isHls = sourceUrl.endsWith('.m3u8') || sourceUrl.includes('.m3u8?')
  castProxySessions.set(token, { url: sourceUrl, createdAt: now, lastAccessAt: now, transcodeSessionId, isHls })
  return `http://${localIp}:${castProxyPort}/cast/${token}${isHls ? '/index.m3u8' : ''}`
}
// Cast helpers
const CAST_LOCALHOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1'])
let CastContext: any = null
let castLoadError: string | null = null
let castLoadPromise: Promise<void> | null = null
let castContext: any = null
let activeCastTranscodeId: string | null = null
let activeCastSourceKey: string | null = null
const castSessionsWithLoadSent = new Set<string>()
let castPlayInProgress = false
let lastCastPlayTime = 0
const CAST_PLAY_DEBOUNCE_MS = 1500
async function loadCastContext(): Promise<void> {
  if (CastContext || castLoadError) return
  if (castLoadPromise) return castLoadPromise
  castLoadPromise = (async () => {
    try {
      if (typeof require === 'function') { const m = require('@peartube/backend/cast'); CastContext = m?.CastContext ?? m?.default ?? m; if (CastContext) return }
      const m = await import('@peartube/backend/cast'); CastContext = (m as any)?.CastContext ?? (m as any)?.default ?? m
    } catch (err: any) { castLoadError = err?.message || 'Unknown error'; console.warn('[Worker] cast context not available:', castLoadError) }
  })()
  return castLoadPromise
}
function normalizeCastVolume(v: any): number { const n = typeof v === 'number' && Number.isFinite(v) ? v : 1; return n > 1 ? Math.max(0, Math.min(100, n)) / 100 : Math.max(0, Math.min(1, n)) }
async function getLocalIPv4ForTarget(targetHost?: string): Promise<string | null> {
  if (!targetHost) return null
  try {
    return selectLocalIPv4ForTarget(targetHost, os.networkInterfaces())
  } catch {
    return null
  }
}
function rewriteUrlHost(url: string, host: string): string { try { const p = new URL(url); p.hostname = host; return p.toString() } catch { return url } }
function normalizeLocalUrlForWorker(url: string): string { try { const p = new URL(url); if (CAST_LOCALHOSTS.has(p.hostname)) { p.hostname = '127.0.0.1'; return p.toString() } } catch {} return url }
function buildTranscodeCacheKey(url: string): string | null {
  try {
    const p = new URL(url); const k = p.searchParams.get('key'); const b = p.searchParams.get('blob')
    if (k && b) return `blob:${k}:${b}`
    p.searchParams.delete('token'); p.searchParams.delete('type')
    const entries = Array.from(p.searchParams.entries()).sort((a, b) => a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))
    p.search = new URLSearchParams(entries).toString(); return p.toString()
  } catch { return null }
}

function getCastContext(): any {
  if (!castContext && CastContext) {
    castContext = new CastContext()
    castContext.on('deviceFound', (d: any) => { try { rpc?.eventCastDeviceFound?.({ device: { id: d.id, name: d.name, host: d.host, port: d.port, protocol: d.protocol } }) } catch {} })
    castContext.on('deviceLost', (id: string) => { try { rpc?.eventCastDeviceLost?.({ deviceId: id }) } catch {} })
    castContext.on('playbackStateChanged', (state: string) => {
      if (state === 'stopped' || state === 'idle' || state === 'disconnected' || state === 'error') { activeCastSourceKey = null; if (activeCastTranscodeId) castSessionsWithLoadSent.delete(activeCastTranscodeId) }
      try { rpc?.eventCastPlaybackState?.({ state }) } catch {}
    })
    castContext.on('timeChanged', (t: number) => { try { rpc?.eventCastTimeUpdate?.({ currentTime: Math.max(1, Math.floor(t || 0)) }) } catch {} })
    castContext.on('error', (error: any) => {
      activeCastSourceKey = null; if (activeCastTranscodeId) castSessionsWithLoadSent.delete(activeCastTranscodeId)
      const msg = error?.message || (error ? String(error) : 'Unknown error')
      if (msg && msg !== 'undefined' && msg !== '[object Object]') try { rpc?.eventCastPlaybackState?.({ state: 'error', error: msg }) } catch {}
    })
  }
  return castContext
}
// Desktop file pickers
const ALLOWED_VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi']
function getMimeTypeFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo' }[ext] || 'video/mp4'
}
function spawnOsascript(script: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-e', script])
    let stdout = '', stderr = ''
    const toText = (c: unknown) => typeof c === 'string' ? c : c instanceof Uint8Array ? Buffer.from(c).toString() : ''
    proc.stdout?.on('data', (c: unknown) => { stdout += toText(c) })
    proc.stderr?.on('data', (c: unknown) => { stderr += toText(c) })
    proc.on('exit', (code: number) => { code === 0 && stdout.trim() ? resolve(stdout.trim()) : code === 1 ? resolve(null) : reject(new Error(stderr || 'osascript failed')) })
    proc.on('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))))
  })
}
async function pickVideoFile(): Promise<any> {
  const filePath = await spawnOsascript('set theFile to choose file with prompt "Select a video file"\nreturn POSIX path of theFile')
  if (!filePath) return { cancelled: true }
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  if (!ALLOWED_VIDEO_EXTENSIONS.includes(ext)) throw new Error(`Unsupported format: .${ext}`)
  const stat = fs.statSync(filePath)
  return { filePath, name: filePath.split('/').pop() || 'video', size: stat.size }
}
async function pickImageFile(): Promise<any> {
  const filePath = await spawnOsascript('set theFile to choose file with prompt "Select a thumbnail image" of type {"public.jpeg", "public.png", "public.image", "org.webmproject.webp"}\nreturn POSIX path of theFile')
  if (!filePath) return { cancelled: true }
  const stat = fs.statSync(filePath)
  const buf = fs.readFileSync(filePath)
  const ext = filePath.toLowerCase().split('.').pop() || ''
  const mimeType = { png: 'image/png', webp: 'image/webp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[ext] || 'image/jpeg'
  return { filePath, name: filePath.split('/').pop() || 'image', size: stat.size, dataUrl: `data:${mimeType};base64,${buf.toString('base64')}` }
}
// Storage + Transport + Backend Init
declare const Bare: { argv: string[]; IPC: any } | undefined
console.log('[Worker] PearTube Desktop Worker starting...')

// Storage: Bare.argv[2] (from Electrobun/pear-runtime), then default
const bareArgv = (typeof Bare !== 'undefined' && Array.isArray(Bare.argv)) ? Bare.argv : []
const runtimeStorage = bareArgv[2] || null

let storage: string
if (runtimeStorage) { storage = runtimeStorage }
else { try { const dir = require('bare-storage'); storage = path.join(dir.persistent(), 'peartube') } catch { storage = path.join(os.homedir(), '.peartube') } }
console.log('[Worker] Storage:', storage)

const workerResourceDir = (() => {
  try {
    return path.dirname(decodeURIComponent(new URL(import.meta.url).pathname))
  } catch {
    return runtimeStorage || os.cwd()
  }
})()
;(globalThis as any).__PEARTUBE_HYPERCORE_WORKER_PATH__ = path.join(workerResourceDir, '..', 'hypercore-reader-worker.mjs')

// Transport: Bare.IPC (Electrobun sidecar), then injected pipe
const bareIPC = (typeof Bare !== 'undefined' && (Bare as any).IPC) ? (Bare as any).IPC : null
const injectedPipe = (globalThis as any).__PEARTUBE_HRPC_PIPE__ as any
const ipcPipe = bareIPC || injectedPipe
if (!ipcPipe) throw new Error('No IPC pipe — Bare.IPC or __PEARTUBE_HRPC_PIPE__ required')

let rpc: any
let isShuttingDown = false

const { rpc: _rpc, backend, destroy } = await createBackend({
  stream: ipcPipe,
  storagePath: storage,
  platform: 'desktop',
  protocolVersion: PROTOCOL_VERSION,
  createBackendContext,
  autoAttachSharedAppHandlers: true,
  onReady: (data: any) => { console.log('[Worker] Backend ready, blob port:', data?.blobServerPort) },
  onError: (err: any) => { console.error('[Worker] Backend error:', err?.message || err) },
  onMediaGraphUpdate: (update: { revision: string; changedCount: number }) => {
    try { _rpc?.eventMediaGraphUpdate?.({ revision: update.revision, changedCount: update.changedCount }) } catch {}
  },
  onVideoStats: (driveKey: string, videoPath: string, stats: any) => {
    try {
      _rpc?.eventVideoStats?.({ stats: { videoId: videoPath, channelKey: driveKey, status: stats?.status || 'unknown', progress: stats?.progress || 0, totalBlocks: stats?.totalBlocks || 0, downloadedBlocks: stats?.downloadedBlocks || 0, totalBytes: stats?.totalBytes || 0, downloadedBytes: stats?.downloadedBytes || 0, peerCount: stats?.peerCount || 0, speedMBps: stats?.speedMBps || '0', uploadSpeedMBps: stats?.uploadSpeedMBps || '0', elapsed: stats?.elapsed || 0, isComplete: Boolean(stats?.isComplete) } })
    } catch {}
  },
})
rpc = _rpc
const { ctx, api, identityManager, uploadManager, videoStats, initializeIdentityFromMnemonic, scopedNetwork } = backend as any
const missingDesktopServices = [
  ctx ? null : 'ctx',
  api ? null : 'api',
  identityManager ? null : 'identityManager',
  identityManager && typeof identityManager.getIdentities !== 'function' ? 'identityManager.getIdentities' : null,
  uploadManager ? null : 'uploadManager',
].filter(Boolean)
if (missingDesktopServices.length > 0) {
  throw new Error(
    `[Worker] Backend context did not initialize required desktop services: ${missingDesktopServices.join(', ')}. ` +
    'Ensure createBackendContext is passed to createBackend.',
  )
}
const getBlobPort = () => (ctx.blobServer as any)?.port || ctx.blobServerPort || 0
ctx.registerCleanup?.('desktop cast proxy', () => {
  if (castProxyServer) {
    try { castProxyServer.close() } catch {}
    castProxyServer = null
    castProxyPort = 0
    castProxyReady = null
    castProxySessions.clear()
  }
}, { timeoutMs: 1000 })
ctx.registerCleanup?.('desktop transcode sessions', () => cleanupTranscodeSessions(), { timeoutMs: 1000 })

console.log('[Worker] Backend initialized, attaching desktop handler methods...')
// registerSharedHandlers (called inside createBackend) registered lazy closures
// that dispatch to backend.camelCase(handlerName) at call time.
// registerSharedHandlers (called inside createBackend) registered lazy
// closures that dispatch to backend.camelCase(handlerName) at call time.
// We attach all handler implementations now, before any RPC call arrives.

const B = backend as any
B.getChannel = async (r: any) => ({ channel: await api.getChannel(r.publicKey || '') })
B.getChannelMeta = async (r: any) => { const m = await api.getChannelMeta(r.channelKey, r.publicBeeKey || null); return { name: m.name, description: m.description, videoCount: m.videoCount || 0 } }
B.updateChannel = async (r: any) => { const a = identityManager.getActiveIdentity(); if (!a?.driveKey) return { success: false, error: 'No active channel' }; return api.updateChannel(a.driveKey, { name: r.name, description: r.description, avatar: r.avatar }) }
B.updateVideoMetadata = async (r: any) => { const a = identityManager.getActiveIdentity(); if (!a?.driveKey) return { success: false, error: 'No active channel' }; return api.updateVideoMetadata(r.channelKey || a.driveKey, r.videoId, { title: r.title, description: r.description, category: r.category }) }
B.updateChannelAvatar = async (r: any) => { const a = identityManager.getActiveIdentity(); if (!a?.driveKey) return { success: false, error: 'No active channel' }; const buf = fs.readFileSync(r.filePath); return api.updateChannelAvatar(a.driveKey, buf, r.mimeType || 'image/jpeg') }
B.listVideos = async (r: any) => {
  const ck = r?.channelKey || ''; if (!ck) return { success: false, error: 'Missing channelKey', videos: [] }
  let raw: any[] = []; try { raw = await api.listVideos(ck, r.publicBeeKey) } catch (err: any) { return { success: false, error: err?.message || String(err), stale: true, retryable: true, videos: [] } }
  return { success: true, videos: (raw || []).map((v: any) => {
    const id = v?.id ? String(v.id) : ''; if (!id) return null
    return {
      id,
      title: v?.title ? String(v.title) : 'Untitled',
      description: v?.description ? String(v.description) : '',
      path: v?.path ? String(v.path) : '',
      duration: Number(v?.duration) || 0,
      thumbnail: v?.thumbnail ? String(v.thumbnail) : '',
      channelKey: ck,
      channelName: v?.channelName ? String(v.channelName) : '',
      createdAt: Number(v?.uploadedAt || v?.createdAt) || 0,
      views: Number(v?.views) || 0,
      category: v?.category ? String(v.category) : '',
      blobId: v?.blobId ? String(v.blobId) : null,
      blobsCoreKey: v?.blobsCoreKey ? String(v.blobsCoreKey) : null,
      mimeType: v?.mimeType ? String(v.mimeType) : null,
      availability: v?.availability ? String(v.availability) : null,
      playbackSupport: v?.playbackSupport ? String(v.playbackSupport) : null,
      publicationId: v?.publicationId ? String(v.publicationId) : null,
      immutablePublication: v?.immutablePublication?.publicationId ? {
        publicationId: String(v.immutablePublication.publicationId),
        manifestId: v.immutablePublication.manifestId ? String(v.immutablePublication.manifestId) : null,
        renditionId: v.immutablePublication.renditionId ? String(v.immutablePublication.renditionId) : null,
        publisherId: v.immutablePublication.publisherId ? String(v.immutablePublication.publisherId) : null,
      } : null,
      publicBeeKey: v?.publicBeeKey ? String(v.publicBeeKey) : null,
      width: Number(v?.width) || 0,
      height: Number(v?.height) || 0,
    }
  }).filter(Boolean) }
}
B.getVideoUrl = async (r: any) => {
  const res = await api.getVideoUrl(
    r.channelKey,
    r.videoId,
    r.publicBeeKey,
    r.blobId,
    r.blobsCoreKey,
    r.mimeType
  )
  return { url: res.url }
}
B.preparePlayback = async (r: any) => api.preparePlayback(
  r.channelKey,
  r.videoId,
  r.publicBeeKey,
  r.blobId,
  r.blobsCoreKey,
  r.mimeType
)
B.setPlaybackActive = async (r: any = {}) => api.setPlaybackActive(r)

// Desktop compat fallback: the renderer calls this only after deciding (via
// MediaSource.isTypeSupported / mediabunny) that it cannot play the source
// directly. Start a bare-ffmpeg compat transcode (video stream-copy +
// audio→AAC where possible) and hand back the local fMP4-HLS URL the MSE
// player pulls fragments from. Any failure falls back to the direct URL.
rpc.onWebPreparePlayback(async (r: any) => {
  const prep = await api.preparePlayback(
    r.channelKey, r.videoId, r.publicBeeKey,
    r.blobId, r.blobsCoreKey, r.mimeType
  )
  if (!prep?.url) return prep
  try {
    const directUrl = normalizeLocalUrlForWorker(prep.url)
    const sourceKey = buildTranscodeCacheKey(directUrl) || directUrl
    const result = await castTranscoder.startCompatTranscode(directUrl, {
      player: 'webkit', sourceKey, force: true, isVideoComplete: true,
    })
    if (!result?.success) {
      return { ...prep, transcoded: false, transcodeError: result?.reason || result?.error || 'compat transcode unavailable' }
    }
    if (!result.reused) {
      const waitStart = Date.now()
      while (Date.now() - waitStart < 30000) {
        const st = castTranscoder.getCastStatus(result.sessionId)
        if (st?.fragmentCount >= 1 || st?.status === 'error') break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      const st = castTranscoder.getCastStatus(result.sessionId)
      if (st?.status === 'error') {
        return { ...prep, transcoded: false, transcodeError: st?.error || 'compat transcode failed' }
      }
    }
    const hlsUrl = castTranscoder.getCastHlsUrl(result.sessionId, '127.0.0.1')
    if (!hlsUrl) return { ...prep, transcoded: false, transcodeError: 'no HLS URL' }
    console.log('[Worker] webPreparePlayback: compat transcode started, mode:', result.mode)
    return { ...prep, url: hlsUrl, transcoded: true }
  } catch (e: any) {
    console.warn('[Worker] webPreparePlayback compat path failed:', e?.message)
    return { ...prep, transcoded: false, transcodeError: e?.message }
  }
})
B.getVideoData = async (r: any) => { if (isShuttingDown) return { video: { id: r.videoId, title: 'Unknown' } }; const v = await api.getVideoData(r.channelKey, r.videoId, r.publicBeeKey, r.blobId, r.blobsCoreKey, r.mimeType); return { video: v || { id: r.videoId, title: 'Unknown' } } }
B.getVideoMetadata = async (r: any) => { if (isShuttingDown) return { video: { id: r.videoId, title: 'Unknown' } }; const v = await api.getVideoData(r.channelKey, r.videoId); return { video: v || { id: r.videoId, title: 'Unknown' } } }
B.downloadVideo = async (r: any) => { try { const res = await api.getVideoUrl(r.channelKey, r.videoId, r.publicBeeKey); if (!res?.url) return { success: false, error: 'Failed to get URL' }; const meta = await api.getVideoData(r.channelKey, r.videoId, r.publicBeeKey); let size = 0; if (meta?.blobId) { const p = meta.blobId.split(':').map(Number); if (p.length === 4) size = p[3] } return { success: true, filePath: res.url, size: size || meta?.size || 0 } } catch (e: any) { return { success: false, error: e?.message } } }
B.deleteVideo = async (r: any) => { const a = identityManager.getActiveIdentity?.(); const ch = await identityManager.getActiveChannel?.(); if (!ch) return { success: false, error: 'No active channel' }; if (!ch.writable) return { success: false, error: 'Channel is read-only' }; try { await ch.deleteVideo(r.videoId); return { success: true } } catch (e: any) { return { success: false, error: e?.message } } }
B.prefetchVideo = async (r: any) => { try { const res = await api.prefetchVideo(r.channelKey, r.videoId, r.publicBeeKey || null); return { success: res?.success !== false } } catch { return { success: false } } }
B.getVideoStats = async (r: any) => { const s = api.getVideoStats(r.channelKey, r.videoId); return { stats: { videoId: r.videoId, channelKey: r.channelKey, ...s } } }
B.subscribeChannel = async (r: any) => { await api.subscribeChannel(r.channelKey); return { success: true } }
B.unsubscribeChannel = async (r: any) => { await api.unsubscribeChannel(r.channelKey); return { success: true } }
B.getSubscriptions = async () => { const s = await api.getSubscriptions(); return { subscriptions: s.map((i: any) => ({ channelKey: i.driveKey, channelName: i.name })) } }
B.joinChannel = async (r: any) => { await api.subscribeChannel(r.channelKey); return { success: true } }
B.getStatus = async () => ({ status: { ready: true, hasIdentity: identityManager.getIdentities().length > 0, blobServerPort: getBlobPort(), protocolVersion: PROTOCOL_VERSION } })
B.getSwarmStatus = async () => {
  const s = api.getSwarmStatus()
  const scopedDiagnostics = scopedNetwork?.getDiagnostics?.() || null
  return {
    connected: (s.swarmConnections || 0) > 0,
    peerCount: s.swarmConnections || 0,
    swarmConnections: s.swarmConnections || 0,
    swarmPeers: s.swarmPeers || 0,
    networkJson: scopedDiagnostics ? JSON.stringify(scopedDiagnostics) : null,
    startupTimingJson: s.startupTiming ? JSON.stringify(s.startupTiming) : null,
    swarmOffline: Boolean(s.swarmOffline),
    swarmOfflineReason: s.swarmOfflineReason || null,
    swarmListenResolved: Boolean(s.swarmListenResolved),
    peerPoolJoined: Boolean(s.peerPoolJoined),
    recommendedBoundary: s.recommendedBoundary || s.doctor?.recommendedBoundary || null,
  }
}
B.getBlobServerPort = async () => ({ port: getBlobPort() })
B.createDeviceInvite = async (r: any) => { const res = await api.createDeviceInvite(r.channelKey); return { inviteCode: res.inviteCode } }
B.pairDevice = async (r: any) => { const res = await api.pairDevice(r.inviteCode, r.deviceName || ''); try { const ex = identityManager.getIdentities?.() || []; if (ex.length === 0 && res?.channelKey) await identityManager.addPairedChannelIdentity?.(res.channelKey, 'Paired Channel') } catch {} return { success: Boolean(res.success), channelKey: res.channelKey } }
B.listDevices = async (r: any) => { const res = await api.listDevices(r.channelKey); return { devices: res.devices || [] } }
B.globalSearchVideos = async (r: any) => { try { const raw = await api.globalSearchVideos(r.query, { topK: r.topK || 20 }); return { success: true, results: raw.map((i: any) => ({ id: String(i.id || ''), score: i.score != null ? String(i.score) : null, metadata: i.metadata ? JSON.stringify(i.metadata) : null })) } } catch (err: any) { return { success: false, error: err?.message || String(err), retryable: true, results: [] } } }
B.searchVideos = async (r: any) => {
  try {
    const raw = await api.searchVideos(r.channelKey, r.query, { topK: r.topK || 10, federated: Boolean(r.federated) })
    return {
      results: (raw || []).map((item: any) => ({
        id: String(item.id || ''),
        score: item.score != null ? String(item.score) : null,
        metadata: item.metadata ? JSON.stringify(item.metadata) : null,
      })),
    }
  } catch {
    return { results: [] }
  }
}
B.retrySyncChannel = async (r: any) => {
  try {
    const res = await api.retrySyncChannel?.(r.channelKey)
    if (res && typeof res === 'object') return res
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message || 'Retry failed' }
  }
}
B.indexVideoVectors = async (r: any) => {
  try {
    const result = await api.indexVideoVectors?.(r.channelKey)
    return result && typeof result === 'object' ? result : { indexedCount: 0 }
  } catch {
    return { indexedCount: 0 }
  }
}
B.createIdentity = async (r: any) => {
  const result = await identityManager.createIdentity(r.name || 'New Channel', true)
  if (result.mnemonic) { const { needsRestart } = await initializeIdentityFromMnemonic(result.mnemonic); if (needsRestart) console.log('[Worker] Identity key file written') }
  return { identity: { publicKey: result.publicKey, driveKey: result.driveKey, name: r.name || 'New Channel', seedPhrase: result.mnemonic, isActive: true } }
}
B.getIdentity = async () => ({ identity: identityManager.getActiveIdentity() })
B.getIdentities = async () => ({ identities: identityManager.getIdentities().map((i: any) => ({ publicKey: i.publicKey || '', driveKey: i.driveKey || '', name: i.name || '', createdAt: i.createdAt || 0, isActive: Boolean(i.isActive) })) })
B.setActiveIdentity = async (r: any) => { await identityManager.setActiveIdentity(r.publicKey); return { success: true } }
B.recoverIdentity = async (r: any) => { const res = await identityManager.recoverIdentity(r.seedPhrase, r.name); if (r.seedPhrase) { const { needsRestart } = await initializeIdentityFromMnemonic(r.seedPhrase); if (needsRestart) console.log('[Worker] Identity key file written for recovery') } return { identity: { publicKey: res.publicKey, driveKey: res.driveKey, name: r.name || 'Recovered', isActive: true } } }
B.bootstrapDevice = async (r: any) => { const res = await identityManager.bootstrapDevice(r.mnemonic); return { proof: res.proof, identityPublicKey: res.identityPublicKey } }
B.attestDevice = async (r: any) => { const proof = await identityManager.attestDevice(r.identityKeyPair, r.devicePublicKey, r.proof || null); return { proof } }
B.verifyAttestation = async (r: any) => { try { const res = await identityManager.verifyAttestation(r.proof); return { valid: res.valid, identityPublicKey: res.identityPublicKey || '', devicePublicKey: res.devicePublicKey || '' } } catch { return { valid: false, identityPublicKey: '', devicePublicKey: '' } } }
B.uploadVideo = async (r: any) => {
  const active = identityManager.getActiveIdentity()
  if (!active?.driveKey) throw new Error('No active identity')
  const channel = await identityManager.getActiveChannel?.()
  if (!channel?.blobs) throw new Error('No active channel or blobs not initialized')
  let uploadPath = r.filePath, mimeType = getMimeTypeFromPath(r.filePath)
  let videoDimensions = { width: 0, height: 0 }
  try { const p = await transcoder.probeMedia(uploadPath, r.title) as any; videoDimensions = { width: p.width || 0, height: p.height || 0 } } catch {}
  const mediaMetadata = normalizeUploadVideoMediaMetadata(r)
  const result = await uploadManager.uploadFromPath(channel, uploadPath, { title: r.title, description: r.description, mimeType, width: videoDimensions.width, height: videoDimensions.height, ...mediaMetadata }, fs, (progress: number, bytesWritten: number, totalBytes: number, stats?: any) => { try { rpc.eventUploadProgress({ videoId: '', progress, bytesUploaded: bytesWritten, totalBytes, speed: stats?.speed || 0, eta: stats?.eta || 0 }) } catch {} })
  if (result.success && result.videoId && !r.skipThumbnailGeneration) {
    try { const t = await generateAndStoreThumbnail(r.filePath, result.videoId, channel, { frameIndex: 300 }); if (t?.thumbnailBlobId) await channel.updateVideo(result.videoId, { thumbnailBlobId: t.thumbnailBlobId, thumbnailBlobsCoreKey: t.thumbnailBlobsCoreKey, thumbnailMimeType: t.thumbnailMimeType }) } catch {}
  }
  return { video: { id: result.videoId || '', title: r.title || '', description: r.description || '', channelKey: active.driveKey } }
}
B.pickVideoFile = async () => { const r = await pickVideoFile(); return { filePath: r.filePath || null, name: r.name || null, size: r.size || 0, cancelled: r.cancelled || false } }
B.pickImageFile = async () => { const r = await pickImageFile(); return { filePath: r.filePath || null, name: r.name || null, size: r.size || 0, dataUrl: r.dataUrl || null, cancelled: r.cancelled || false } }
B.castAvailable = async () => { await loadCastContext(); return { available: CastContext !== null, error: castLoadError } }
B.castStartDiscovery = async () => { await loadCastContext(); if (!CastContext) return { success: false, error: castLoadError || 'not available' }; try { await getCastContext().startDiscovery(); return { success: true } } catch (e: any) { return { success: false, error: e?.message } } }
B.castStopDiscovery = async () => { if (!castContext) return { success: true }; try { castContext.stopDiscovery(); return { success: true } } catch (e: any) { return { success: false, error: e?.message } } }
B.castGetDevices = async () => { if (!castContext) return { devices: [] }; try { return { devices: castContext.getDevices().map((d: any) => ({ id: d.id, name: d.name, host: d.host, port: d.port, protocol: d.protocol })) } } catch { return { devices: [] } } }
B.castAddManualDevice = async (r: any) => { await loadCastContext(); if (!CastContext) return { success: false, error: 'not available' }; try { const d = getCastContext().addManualDevice({ name: r.name, host: r.host, port: r.port, protocol: r.protocol || 'chromecast' }); return { success: true, device: { id: d.id, name: d.name, host: d.host, port: d.port, protocol: d.protocol } } } catch (e: any) { return { success: false, error: e?.message } } }
B.castConnect = async (r: any) => { await loadCastContext(); if (!CastContext) return { success: false, error: 'not available' }; const c = getCastContext(); try { const devices = c.getDevices?.() || []; const dev = devices.find((d: any) => d.id === r.deviceId); await c.connect(r.deviceId); return dev ? { success: true, device: { id: dev.id, name: dev.name, host: dev.host, port: dev.port, protocol: dev.protocol } } : { success: true } } catch (e: any) { return { success: false, error: e?.message } } }
B.castDisconnect = async () => { if (!castContext) return { success: true }; try { await castContext.disconnect(); castProxySessions.clear(); if (activeCastTranscodeId) { castSessionsWithLoadSent.delete(activeCastTranscodeId); castTranscoder.stopCastTranscode(activeCastTranscodeId); transcodeSessions.delete(activeCastTranscodeId); activeCastTranscodeId = null; activeCastSourceKey = null } return { success: true } } catch (e: any) { return { success: false, error: e?.message } } }
B.castPause = async () => { if (!castContext?.isConnected()) return { success: false, error: 'Not connected' }; try { await castContext.pause(); return { success: true } } catch (e: any) { return { success: false, error: e?.message } } }
B.castResume = async () => { if (!castContext?.isConnected()) return { success: false, error: 'Not connected' }; try { await castContext.resume(); return { success: true } } catch (e: any) { return { success: false, error: e?.message } } }
B.castStop = async () => { if (!castContext?.isConnected()) return { success: false, error: 'Not connected' }; try { await castContext.stop(); castProxySessions.clear(); if (activeCastTranscodeId) { castSessionsWithLoadSent.delete(activeCastTranscodeId); castTranscoder.stopCastTranscode(activeCastTranscodeId); transcodeSessions.delete(activeCastTranscodeId); activeCastTranscodeId = null; activeCastSourceKey = null } return { success: true } } catch (e: any) { return { success: false, error: e?.message } } }
B.castSeek = async (r: any) => { if (!castContext?.isConnected()) return { success: false, error: 'Not connected' }; try { await castContext.seek(r.time); return { success: true } } catch (e: any) { return { success: false, error: e?.message } } }
B.castSetVolume = async (r: any) => { if (!castContext?.isConnected()) return { success: false, error: 'Not connected' }; try { await castContext.setVolume(normalizeCastVolume(r.volume)); return { success: true } } catch (e: any) { return { success: false, error: e?.message } } }
B.castGetState = async () => { if (!castContext) return { state: 'idle' }; try { const s = castContext.getPlaybackState(); const r: any = { state: s.state || 'idle' }; if (s.currentTime > 0) r.currentTime = Math.floor(s.currentTime); if (s.duration > 0) r.duration = Math.floor(s.duration); if (s.volume > 0) r.volume = Math.floor(s.volume * 100); return r } catch { return { state: 'idle' } } }
B.castIsConnected = async () => ({ connected: Boolean(castContext?.isConnected()) })
B.castPlay = async (r: any) => {
  if (!castContext?.isConnected()) return { success: false, error: 'Not connected to cast device' }
  const now = Date.now()
  if (castPlayInProgress) return { success: true, reason: 'in-progress' }
  if (now - lastCastPlayTime < CAST_PLAY_DEBOUNCE_MS) return { success: true, reason: 'debounced' }
  castPlayInProgress = true; lastCastPlayTime = now
  const requestedUrl = normalizeLocalUrlForWorker(r.url)
  const protocol = castContext?._connectedDevice?.deviceInfo?.protocol
  const deviceHost = castContext?._connectedDevice?.deviceInfo?.host
  const requestedKey = buildTranscodeCacheKey(requestedUrl) || requestedUrl
  if (protocol === 'chromecast' && activeCastTranscodeId && castSessionsWithLoadSent.has(activeCastTranscodeId) && activeCastSourceKey === requestedKey) return { success: true }
  let url = r.url, contentType = r.contentType, currentTranscodeSessionId: string | null = null, streamType: 'LIVE' | 'BUFFERED' = 'BUFFERED', mediaDuration: number | undefined
  try {
    if (protocol === 'chromecast') {
      try {
        const probe = await transcoder.probeMedia(requestedUrl, r.title); mediaDuration = probe.duration
        const needsProcessing = probe.needsVideoTranscode || probe.needsAudioTranscode || probe.needsRemux
        const localIp = await getLocalIPv4ForTarget(deviceHost)
        if (!needsProcessing) { url = localIp ? rewriteUrlHost(requestedUrl, localIp) : requestedUrl; contentType = 'video/mp4' }
        else {
          const result = await castTranscoder.startCastTranscode(requestedUrl, { sourceKey: requestedKey, isVideoComplete: true })
          if (!result.success) throw new Error(result.error || 'Cast transcode failed')
          currentTranscodeSessionId = result.sessionId
          if (result.reused && castSessionsWithLoadSent.has(result.sessionId)) { activeCastTranscodeId = result.sessionId; activeCastSourceKey = requestedKey; return { success: true } }
          if (!result.reused) { const waitStart = Date.now(); while (Date.now() - waitStart < 30000) { const st = castTranscoder.getCastStatus(result.sessionId); if (st?.fragmentCount >= 1 || st?.status === 'error') break; await new Promise(resolve => setTimeout(resolve, 500)) } }
          const hlsUrl = castTranscoder.getCastHlsUrl(result.sessionId, localIp || '127.0.0.1')
          if (!hlsUrl) throw new Error('Could not get cast HLS URL')
          url = hlsUrl; contentType = 'application/vnd.apple.mpegurl'; streamType = 'LIVE'
        }
      } catch (e: any) { console.warn('[Worker] Cast probe/transcode failed, direct play:', e?.message) }
      if (contentType !== 'application/vnd.apple.mpegurl') {
        let usedDirect = false
        try { const p = new URL(r.url); if (CAST_LOCALHOSTS.has(p.hostname)) { const ip = await getLocalIPv4ForTarget(deviceHost); if (ip) { url = rewriteUrlHost(r.url, ip); usedDirect = true } } } catch {}
        if (!usedDirect) { try { await ensureCastProxyServer(); const pu = await createCastProxyUrl(deviceHost, r.url); if (pu) url = pu } catch {} }
        if (!usedDirect) { try { const p = new URL(r.url); if (CAST_LOCALHOSTS.has(p.hostname)) { const ip = await getLocalIPv4ForTarget(deviceHost); if (ip) url = rewriteUrlHost(r.url, ip) } } catch {} }
      }
    }
    try { await castContext.stop(); await new Promise(resolve => setTimeout(resolve, 200)) } catch {}
    const prev = activeCastTranscodeId
    if (prev && prev !== currentTranscodeSessionId) { if (!currentTranscodeSessionId && activeCastSourceKey === requestedKey) { /* keep */ } else { castSessionsWithLoadSent.delete(prev); castTranscoder.stopCastTranscode(prev); if (!currentTranscodeSessionId) { activeCastTranscodeId = null; activeCastSourceKey = null } } }
    if (currentTranscodeSessionId) { activeCastTranscodeId = currentTranscodeSessionId; activeCastSourceKey = requestedKey }
    const isHlsCast = contentType === 'application/vnd.apple.mpegurl'
    const loadDuration = isHlsCast ? undefined : mediaDuration
    await castContext.play({ url, contentType, title: r.title, thumbnail: r.thumbnail, time: r.time || 0, volume: normalizeCastVolume(r.volume), streamType, duration: loadDuration })
    if (activeCastTranscodeId && contentType === 'application/vnd.apple.mpegurl') castSessionsWithLoadSent.add(activeCastTranscodeId)
    lastCastPlayTime = Date.now(); return { success: true }
  } catch (e: any) { return { success: false, error: e?.message } }
  finally { castPlayInProgress = false }
}
B.transcodeStart = async (r: any) => { try { const src = normalizeLocalUrlForWorker(r.sourceUrl); const ck = buildTranscodeCacheKey(src) || src; const res = await transcoder.startTranscode(src, { duration: r.duration || 0, title: r.title || '', onProgress: (sid: string, pct: number) => handleTranscodeProgress(sid, pct) }); if (!res?.success || !res.sessionId) return { success: false, error: res?.error || 'Failed' }; transcodeSessions.set(res.sessionId, { id: res.sessionId, inputUrl: src, cacheKey: ck, status: 'transcoding', progress: 0, mode: r.mode || 'transcode', transcodeUrl: res.transcodeUrl || '' }); return { success: true, sessionId: res.sessionId, transcodeUrl: res.transcodeUrl || '' } } catch (e: any) { return { success: false, error: e?.message } } }
B.transcodeStop = async (r: any) => { try { const res = transcoder.stopTranscode(r.sessionId); transcodeSessions.delete(r.sessionId); return { success: res.success, error: res.error || '' } } catch (e: any) { return { success: false, error: e?.message } } }
B.transcodeStatus = async (r: any) => { try { const s = transcoder.getStatus(r.sessionId); return { status: s.status || '', progress: s.progress || 0, bytesWritten: s.bytesWritten || 0, error: s.error || '' } } catch (e: any) { return { status: 'error', progress: 0, bytesWritten: 0, error: e?.message } } }
B.eventReady = () => {}
B.eventError = (data: any) => { if (data?.message) console.error('[HRPC] Client error:', data.message) }
B.eventUploadProgress = () => {}
B.eventDownloadProgress = () => {}
B.eventMediaGraphUpdate = () => {}
B.eventLog = () => {}
B.eventVideoStats = () => {}
B.eventCastDeviceFound = () => {}
B.eventCastDeviceLost = () => {}
B.eventCastPlaybackState = () => {}
B.eventCastTimeUpdate = () => {}
B.eventTranscodeProgress = () => {}
// Resume the stream now that all handlers are registered
if (typeof ipcPipe.resume === 'function') {
  ipcPipe.resume()
}
rpc.eventReady({ blobServerPort: getBlobPort(), protocolVersion: PROTOCOL_VERSION })
console.log('[Worker] HRPC ready, all handlers attached')

ipcPipe.on('error', (err: Error) => console.error('[Worker] Pipe error:', err))

// Shutdown triggers: Bare.IPC close (Electrobun quit), SIGTERM/SIGINT/SIGHUP
// (kill, parent-death on well-behaved launchers), fallback process signals.
// Corestore holds an exclusive flock() on db/LOCK that only releases when
// store.close() runs (via destroy() → shutdownBackend), so a shutdown that
// skips destroy() leaves ~/.peartube unusable until the orphan is killed.
const shutdown = async (reason: string) => {
  if (isShuttingDown) return
  console.log(`[Worker] Shutting down (${reason})...`)
  isShuttingDown = true

  const exitProcess = () => {
    try { (globalThis as any).Bare?.exit?.(0) } catch {}
    try { (globalThis as any).process?.exit?.(0) } catch {}
  }

  const cleanup = (async () => {
    await new Promise(resolve => setTimeout(resolve, 100))
    try { await destroy() } catch (err) { console.error('[Worker] destroy() failed:', err) }
  })()

  const timeout = new Promise(resolve => setTimeout(resolve, 3000))
  await Promise.race([cleanup, timeout])
  exitProcess()
}

if (typeof Bare !== 'undefined' && Bare.IPC) {
  Bare.IPC.on('close', () => shutdown('IPC close'))
}
try {
  const proc = (globalThis as any).process
  proc?.on?.('SIGTERM', () => shutdown('SIGTERM'))
  proc?.on?.('SIGINT', () => shutdown('SIGINT'))
  proc?.on?.('SIGHUP', () => shutdown('SIGHUP'))
} catch {}
