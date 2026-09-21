/**
 * PearTube Desktop — loopback static file server for the Expo web bundle.
 *
 * The shell serves the exported bundle over 127.0.0.1 so Expo Router sees a
 * clean `window.location.pathname`. That port is reachable by every local
 * process, and — for content types a browser loads cross-origin — by any page
 * the user has open. Unlike the IPC WebSocket this surface carries no
 * capability, so the only thing standing between a request and the filesystem
 * is path containment: a resolved path that is not `viewsDir` or below it is
 * never opened.
 *
 * `new URL()` collapses literal `../` segments, but percent-encoded separators
 * survive parsing and only become separators when the pathname is decoded, so
 * containment has to be checked after decoding, on the resolved path, in every
 * branch that opens a file.
 *
 * Split out of index.ts so the request path can be driven directly in tests
 * without Bun globals — the same split as ipc-channel.ts.
 */
import { basename, join, resolve, sep } from 'path'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
}

const IPC_PORT_PATH = '/__peartube_ipc_port'

/**
 * `candidate` is `root` itself or a descendant of it. The separator-terminated
 * prefix is what rules out a sibling whose name merely starts with the root's
 * (`<viewsDir>-evil`), which a bare `startsWith(root)` accepts.
 */
export function isContained(root: string, candidate: string): boolean {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Map a URL pathname to an absolute path inside `viewsDir`, or `null` when it
 * escapes, is malformed, or contains a NUL.
 *
 * `viewsDir` must already be absolute and canonical — the launcher does that
 * once at startup rather than per request. Resolution here is lexical:
 * the served tree is the app's own bundle, so there are no symlinks to chase,
 * and a per-request `realpath` would be a syscall on every asset.
 */
export function resolveStaticPath(viewsDir: string, pathname: string): string | null {
  let decoded: string
  try {
    // Exactly once. A second pass would turn `%252e%252e` into `..`.
    decoded = decodeURIComponent(pathname)
  } catch {
    // Malformed escape (`/%zz`). Nothing legitimate looks like this.
    return null
  }
  if (decoded.includes('\0')) return null
  // `join` (not `resolve`) so a decoded absolute path stays under the root
  // instead of replacing it; the escape it cannot stop is `..`, which the
  // containment check below catches.
  const candidate = resolve(join(viewsDir, decoded))
  return isContained(viewsDir, candidate) ? candidate : null
}

/**
 * Extension including the dot, taken from the last segment so a dot anywhere
 * in the bundle's own directory path (`PearTube-dev.app/...`) cannot be read
 * as the request's extension.
 */
export function extensionOf(filePath: string): string {
  const name = basename(filePath)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

export type StaticFile = {
  /** 0 for a missing file, matching `Bun.file().size`. */
  size: number
  text(): Promise<string>
  /** Response body for the file — `Bun.file()` streams it. */
  body: BodyInit
}

export type StaticFileHandlerDeps = {
  /** Absolute, canonical bundle root. */
  viewsDir: string
  openFile: (filePath: string) => StaticFile
  ipcPort: () => number
}

// 404 for anything uncontained: a 403 would confirm which paths exist outside
// the bundle.
function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

/**
 * The `fetch` half of the static server's Bun.serve config.
 */
export function createStaticFileHandler(deps: StaticFileHandlerDeps) {
  const { viewsDir, openFile, ipcPort } = deps
  // The bundle's own index — the one path the SPA fallback may reach.
  const indexPath = join(viewsDir, 'index.html')

  return async function fetchStatic(req: { url: string }): Promise<Response> {
    const url = new URL(req.url)

    // IPC port discovery
    if (url.pathname === IPC_PORT_PATH) {
      return new Response(JSON.stringify({ port: ipcPort() }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let filePath = resolveStaticPath(viewsDir, url.pathname === '/' ? '/index.html' : url.pathname)
    if (filePath === null) return notFound()

    let file = openFile(filePath)
    if (!file.size) {
      // SPA fallback: serve index.html for navigation routes.
      const ext = extensionOf(filePath)
      if (ext !== '' && ext !== '.html') return notFound()
      filePath = indexPath
      file = openFile(filePath)
      if (!file.size) return notFound()
    }

    const ext = extensionOf(filePath)

    // Inject Electrobun view script into HTML at serve time.
    // This replaces the build-time inject-desktop-shell.js script — no
    // post-processing of files on disk, no fragile regex replacements.
    if (ext === '.html') {
      let html = await file.text()
      // Inject view entrypoint before the Expo bundle so window.bridge is ready
      if (!html.includes('views://app/index.js')) {
        html = html.replace(
          /(<script[^>]*src="[^"]*_expo\/static\/js\/web\/[^"]*"[^>]*><\/script>)/,
          '<script src="views://app/index.js"></script>\n$1'
        )
      }
      return new Response(html, { headers: { 'Content-Type': 'text/html' } })
    }

    return new Response(file.body, {
      headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
    })
  }
}
