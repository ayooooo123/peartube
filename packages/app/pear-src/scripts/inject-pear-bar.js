/**
 * Injects Pear control bar into Expo web build HTML files
 * This adds the window control bar with minimize/maximize/close buttons
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// Get target directory from args, default to current directory
const WEB_DIR = process.argv[2] || '.'

// Title bar drag region — works with Electron's hiddenInset titleBarStyle
// macOS: traffic lights sit in the inset; this area is draggable
// Windows: titleBarOverlay handles buttons natively
const PEAR_BAR_HTML = `<div id="pear-bar" style="background-color:#0e0e10;-webkit-app-region:drag;height:52px;position:fixed;top:0;left:0;width:240px;z-index:9999;box-sizing:border-box;"></div><div id="pear-bar-right" style="background-color:#0e0e10;-webkit-app-region:drag;height:52px;position:fixed;top:0;left:240px;right:0;z-index:9998;"></div>`

// CSS to position #root below the pear-bar title bar (52px for macOS traffic lights)
const PEAR_BAR_CSS = `<style id="pear-bar-css">html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0e0e10!important;}#root{position:fixed!important;top:52px!important;left:0!important;right:0!important;bottom:0!important;overflow:hidden;display:flex;flex-direction:column;}</style>`

// CSP meta tag — allows pear:, peartube-app:, and views: protocols
const PEAR_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' pear: peartube-app: views: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' pear: peartube-app: views:; style-src 'self' 'unsafe-inline'; connect-src 'self' pear: peartube-app: views: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; media-src 'self' blob: http://127.0.0.1:* http://localhost:*; img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*;">`

// Worker client script - ES module that has access to Pear's import resolution
const WORKER_CLIENT_SCRIPT = `<script type="module" src="./worker-client.js"></script>`
// Electrobun view entrypoint — sets up window.bridge via Electrobun RPC
const ELECTROBUN_VIEW_SCRIPT = `<script src="views://app/index.js"></script>`
const EXPO_ENTRY_SCRIPT_PATTERN = /<script[^>]*src="\.\/_expo\/static\/js\/web\/[^"]+"[^>]*><\/script>/

// Node.js polyfills for modules that leak into the web bundle (streamx, bare-events, etc.)
// These are needed because the Expo bundle includes some P2P code paths that depend on
// Node.js builtins. In Electron these were available via Node integration; in Electrobun CEF
// we need to provide minimal shims.
const NODE_POLYFILLS_SHIM = `<script id="peartube-node-polyfills">(function(){
if(typeof globalThis.process==='undefined'){globalThis.process={env:{},nextTick:function(fn){Promise.resolve().then(fn)},browser:true};}
if(typeof globalThis.Buffer==='undefined'){globalThis.Buffer={isBuffer:function(){return false},from:function(a){return new Uint8Array(a)},alloc:function(n){return new Uint8Array(n)}};}
if(typeof globalThis.global==='undefined'){globalThis.global=globalThis;}
})();</script>`

// React Native (Metro web) NativeModules shim.
// Prevents "__fbBatchedBridgeConfig is not set" by providing a minimal `nativeModuleProxy`.
const RN_NATIVE_MODULE_PROXY_SHIM = `<script id="peartube-native-module-proxy">(function(){try{var scale=window.devicePixelRatio||1;var dims={width:window.innerWidth||0,height:window.innerHeight||0,scale:scale,fontScale:scale};window.nativeModuleProxy=window.nativeModuleProxy||{SourceCode:{getConstants:function(){return{scriptURL:String(location&&location.href||'')}}},DeviceInfo:{getConstants:function(){return{Dimensions:{window:dims,screen:dims}}}},UIManager:{getConstants:function(){return{ViewManagerNames:[],LazyViewManagersEnabled:false,genericBubblingEventTypes:{},genericDirectEventTypes:{}}},getViewManagerConfig:function(){return null},getConstantsForViewManager:function(){return null},getDefaultEventTypes:function(){return{}}}};window.__PEARTUBE_NATIVE_MODULE_PROXY__=true;}catch(e){}})();</script>`

function processHtmlFile(filePath) {
  let html = readFileSync(filePath, 'utf-8')

  // Remove any existing pear-bar injection to allow re-processing
  html = html.replace(/<div id="pear-bar"[^>]*>[\s\S]*?<\/div>\n?/g, '')
  html = html.replace(/<div id="pear-bar-right"[^>]*>[\s\S]*?<\/div>\n?/g, '')
  html = html.replace(/<style id="pear-bar-css">[\s\S]*?<\/style>\n?/g, '')
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/g, '')
  html = html.replace(/<script src="src\/pear-bridge\.js"><\/script>\n?/g, '')
  html = html.replace(/<script[^>]*src="(?:\.\/)?worker-client\.js"[^>]*><\/script>\n?/g, '')
  html = html.replace(/<script id="peartube-native-module-proxy">[\s\S]*?<\/script>\n?/g, '')

  // Convert module scripts to regular scripts for Pear compatibility
  // Pear's DependencyStream cannot analyze ES module scripts properly
  // Handle inline module scripts
  html = html.replace(/<script type="module">([^<]*)<\/script>/g, '<script>$1</script>')
  // Handle external module scripts (with src attribute)
  html = html.replace(/<script type="module"(\s+src="[^"]*")>/g, '<script$1>')

  // Normalize asset paths based on serving mode.
  // Electrobun (views://) needs relative paths (./_expo/).
  // Electron HTTP server needs absolute paths (/_expo/).
  if (process.env.PEARTUBE_ABSOLUTE_PATHS === 'false') {
    // Ensure relative paths for views:// protocol
    html = html.replace(/href="\/_expo\//g, 'href="./_expo/')
    html = html.replace(/src="\/_expo\//g, 'src="./_expo/')
  } else {
    // Ensure absolute paths for HTTP server
    html = html.replace(/href="\.\/_expo\//g, 'href="/_expo/')
    html = html.replace(/src="\.\/_expo\//g, 'src="/_expo/')
  }

  // Inject CSP after <head> (skip for Electrobun — local app doesn't need CSP)
  if (process.env.PEARTUBE_ABSOLUTE_PATHS !== 'false') {
    html = html.replace('<head>', `<head>\n${PEAR_CSP}`)
  }

  // Inject CSS before </head>
  html = html.replace('</head>', `${PEAR_BAR_CSS}\n</head>`)

  // Inject pear bar after <body>
  html = html.replace('<body>', `<body>\n${PEAR_BAR_HTML}\n${NODE_POLYFILLS_SHIM}\n${RN_NATIVE_MODULE_PROXY_SHIM}`)

  // Electrobun view entrypoint — inject before Expo bundle so window.bridge is ready.
  // Always inject for desktop builds (both HTTP and views:// serving).
  // Remove any previous injection first
  html = html.replace(/<script[^>]*src="views:\/\/[^"]*index\.js"[^>]*><\/script>\n?/g, '')
  // Inject before the Expo entry script
  html = html.replace(
    /(<script[^>]*src="[^"]*_expo\/static\/js\/web\/[^"]*"[^>]*><\/script>)/,
    `${ELECTROBUN_VIEW_SCRIPT}\n$1`
  )

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
