/**
 * Injects Pear control bar into Expo web build HTML files
 * This adds the window control bar with minimize/maximize/close buttons
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// Get target directory from args, default to current directory
const WEB_DIR = process.argv[2] || '.'

// Pear bar HTML to inject - contains the draggable title bar with window controls
// The bar spans the full width and includes the sidebar area for proper traffic light positioning
const PEAR_BAR_HTML = `<div id="pear-bar" style="background-color:#0e0e10;-webkit-app-region:drag;height:52px;position:fixed;top:0;left:0;width:240px;z-index:9999;display:flex;align-items:flex-start;padding-top:12px;padding-left:12px;box-sizing:border-box;"><pear-ctrl style="-webkit-app-region:no-drag;"></pear-ctrl></div><div id="pear-bar-right" style="background-color:#0e0e10;-webkit-app-region:drag;height:52px;position:fixed;top:0;left:240px;right:0;z-index:9998;"></div>`

// CSS to position #root below the pear-bar title bar (52px for macOS traffic lights)
const PEAR_BAR_CSS = `<style id="pear-bar-css">html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0e0e10!important;}#root{position:fixed!important;top:52px!important;left:0!important;right:0!important;bottom:0!important;overflow:hidden;display:flex;flex-direction:column;}</style>`

// CSP meta tag for Pear
const PEAR_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' pear: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' pear:; style-src 'self' 'unsafe-inline'; connect-src 'self' pear: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; media-src 'self' blob: http://127.0.0.1:* http://localhost:*; img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*;">`

// Worker client script - ES module that has access to Pear's import resolution
const WORKER_CLIENT_SCRIPT = `<script type="module" src="./worker-client.js"></script>`

function processHtmlFile(filePath) {
  let html = readFileSync(filePath, 'utf-8')

  // Remove any existing pear-bar injection to allow re-processing
  html = html.replace(/<div id="pear-bar"[^>]*>[\s\S]*?<\/div>\n?/g, '')
  html = html.replace(/<style id="pear-bar-css">[\s\S]*?<\/style>\n?/g, '')
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/g, '')
  html = html.replace(/<script src="src\/pear-bridge\.js"><\/script>\n?/g, '')
  html = html.replace(/<script[^>]*src="(?:\.\/)?worker-client\.js"[^>]*><\/script>\n?/g, '')

  // Convert module scripts to regular scripts for Pear compatibility
  // Pear's DependencyStream cannot analyze ES module scripts properly
  // Handle inline module scripts
  html = html.replace(/<script type="module">([^<]*)<\/script>/g, '<script>$1</script>')
  // Handle external module scripts (with src attribute)
  html = html.replace(/<script type="module"(\s+src="[^"]*")>/g, '<script$1>')

  // Convert absolute paths to relative paths for Pear compatibility
  // Expo generates paths like "/_expo/..." which pear can't resolve
  html = html.replace(/href="\/_expo\//g, 'href="./_expo/')
  html = html.replace(/src="\/_expo\//g, 'src="./_expo/')

  // Inject CSP after <head>
  html = html.replace('<head>', `<head>\n${PEAR_CSP}`)

  // Inject CSS before </head>
  html = html.replace('</head>', `${PEAR_BAR_CSS}\n</head>`)

  // Inject pear bar after <body>
  html = html.replace('<body>', `<body>\n${PEAR_BAR_HTML}`)

  // Inject worker client script before </body> (after other scripts load, unbundled for Pear require access)
  html = html.replace('</body>', `${WORKER_CLIENT_SCRIPT}\n</body>`)

  writeFileSync(filePath, html)
  console.log(`  Processed ${filePath}`)
}

// Skip directories that shouldn't be processed
const SKIP_DIRS = ['node_modules', 'scripts', 'build', 'src', 'workers', '.git', 'web']

function shouldSkip(dir) {
  const basename = dir.split('/').pop()
  return SKIP_DIRS.includes(basename)
}

console.log(`Injecting Pear bar into HTML files in ${WEB_DIR}...`)

// Count processed files
let count = 0
function countFiles(dir) {
  if (shouldSkip(dir)) return
  const entries = readdirSync(dir)
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      countFiles(fullPath)
    } else if (entry.endsWith('.html')) {
      count++
    }
  }
}

function processDirectoryFiltered(dir) {
  if (shouldSkip(dir)) return
  const entries = readdirSync(dir)

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      processDirectoryFiltered(fullPath)
    } else if (entry.endsWith('.html')) {
      processHtmlFile(fullPath)
    }
  }
}

countFiles(WEB_DIR)
processDirectoryFiltered(WEB_DIR)
console.log(`Done! Processed ${count} HTML files.`)
