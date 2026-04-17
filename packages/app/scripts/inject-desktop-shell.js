/**
 * Injects desktop shell chrome into Expo web build HTML files.
 *
 * Adds:
 *  - Title bar drag region (52px for macOS traffic lights)
 *  - CSS to position #root below the title bar
 *  - Node.js polyfill shims (Buffer, process, global)
 *  - React Native NativeModules proxy shim
 *  - Electrobun view entrypoint script tag
 *  - Relative path normalization for views:// protocol
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const WEB_DIR = process.argv[2] || '.'

// ── Title bar ────────────────────────────────────────────────────────────
// macOS: traffic lights sit in the inset; this area is draggable
const TITLE_BAR_HTML = `<div id="title-bar" style="background-color:#0e0e10;-webkit-app-region:drag;height:52px;position:fixed;top:0;left:0;width:240px;z-index:9999;box-sizing:border-box;"></div><div id="title-bar-right" style="background-color:#0e0e10;-webkit-app-region:drag;height:52px;position:fixed;top:0;left:240px;right:0;z-index:9998;"></div>`

// CSS to position #root below the title bar
const TITLE_BAR_CSS = `<style id="title-bar-css">html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0e0e10!important;}#root{position:fixed!important;top:52px!important;left:0!important;right:0!important;bottom:0!important;overflow:hidden;display:flex;flex-direction:column;}</style>`

// ── Electrobun view entrypoint ───────────────────────────────────────────
// Sets up window.bridge via Electrobun RPC — must load before the Expo bundle
const ELECTROBUN_VIEW_SCRIPT = `<script src="views://app/index.js"></script>`

// ── Node.js polyfills ────────────────────────────────────────────────────
// Expo bundle includes P2P code paths that reference Node builtins.
// Electrobun CEF doesn't provide Node integration — these minimal shims
// prevent runtime errors.
const NODE_POLYFILLS_SHIM = `<script id="peartube-node-polyfills">(function(){
if(typeof globalThis.process==='undefined'){globalThis.process={env:{},nextTick:function(fn){Promise.resolve().then(fn)},browser:true};}
if(typeof globalThis.Buffer==='undefined'){globalThis.Buffer={isBuffer:function(){return false},from:function(a){return new Uint8Array(a)},alloc:function(n){return new Uint8Array(n)}};}
if(typeof globalThis.global==='undefined'){globalThis.global=globalThis;}
try{if(screen&&screen.orientation){var o=screen.orientation;var origLock=o.lock;var origUnlock=o.unlock;if(origLock)o.lock=function(){try{return origLock.apply(this,arguments)}catch(e){return Promise.resolve()}};if(origUnlock)o.unlock=function(){try{origUnlock.apply(this,arguments)}catch(e){}};}}catch(e){}
})();</script>`

// ── React Native NativeModules proxy ─────────────────────────────────────
// Prevents "__fbBatchedBridgeConfig is not set" by providing a minimal shim.
const RN_NATIVE_MODULE_PROXY_SHIM = `<script id="peartube-native-module-proxy">(function(){try{var scale=window.devicePixelRatio||1;var dims={width:window.innerWidth||0,height:window.innerHeight||0,scale:scale,fontScale:scale};window.nativeModuleProxy=window.nativeModuleProxy||{SourceCode:{getConstants:function(){return{scriptURL:String(location&&location.href||'')}}},DeviceInfo:{getConstants:function(){return{Dimensions:{window:dims,screen:dims}}}},UIManager:{getConstants:function(){return{ViewManagerNames:[],LazyViewManagersEnabled:false,genericBubblingEventTypes:{},genericDirectEventTypes:{}}},getViewManagerConfig:function(){return null},getConstantsForViewManager:function(){return null},getDefaultEventTypes:function(){return{}}}};window.__PEARTUBE_NATIVE_MODULE_PROXY__=true;}catch(e){}})();</script>`

// ── Processing ───────────────────────────────────────────────────────────

function processHtmlFile(filePath) {
  let html = readFileSync(filePath, 'utf-8')

  // Remove any previous injection to allow re-processing
  html = html.replace(/<div id="(?:pear-bar|title-bar)"[^>]*>[\s\S]*?<\/div>\n?/g, '')
  html = html.replace(/<div id="(?:pear-bar-right|title-bar-right)"[^>]*>[\s\S]*?<\/div>\n?/g, '')
  html = html.replace(/<style id="(?:pear-bar-css|title-bar-css)">[\s\S]*?<\/style>\n?/g, '')
  html = html.replace(/<script id="peartube-native-module-proxy">[\s\S]*?<\/script>\n?/g, '')
  html = html.replace(/<script[^>]*src="views:\/\/[^"]*index\.js"[^>]*><\/script>\n?/g, '')

  // Convert ES module scripts to regular scripts (CEF compatibility)
  html = html.replace(/<script type="module">([^<]*)<\/script>/g, '<script>$1</script>')
  html = html.replace(/<script type="module"(\s+src="[^"]*")>/g, '<script$1>')

  // Ensure relative paths for views:// protocol (Electrobun)
  html = html.replace(/href="\/_expo\//g, 'href="./_expo/')
  html = html.replace(/src="\/_expo\//g, 'src="./_expo/')

  // Inject CSS before </head>
  html = html.replace('</head>', `${TITLE_BAR_CSS}\n</head>`)

  // Inject title bar + polyfills after <body>
  html = html.replace('<body>', `<body>\n${TITLE_BAR_HTML}\n${NODE_POLYFILLS_SHIM}\n${RN_NATIVE_MODULE_PROXY_SHIM}`)

  // Inject Electrobun view script before the Expo entry bundle
  html = html.replace(
    /(<script[^>]*src="[^"]*_expo\/static\/js\/web\/[^"]*"[^>]*><\/script>)/,
    `${ELECTROBUN_VIEW_SCRIPT}\n$1`
  )

  writeFileSync(filePath, html)
  console.log(`  Processed ${filePath}`)
}

const SKIP_DIRS = ['node_modules', 'scripts', 'build', 'src', 'workers', '.git', 'web']

function processDirectory(dir) {
  if (SKIP_DIRS.includes(dir.split('/').pop())) return
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) processDirectory(fullPath)
    else if (entry.endsWith('.html')) processHtmlFile(fullPath)
  }
}

console.log(`Injecting desktop shell into HTML files in ${WEB_DIR}...`)
processDirectory(WEB_DIR)
console.log('Done!')
