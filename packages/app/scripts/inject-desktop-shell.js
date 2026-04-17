/**
 * Post-processes Expo web export HTML for Electrobun desktop.
 *
 * - Injects Electrobun view entrypoint (views://app/index.js) before Expo bundle
 * - Adds Node.js polyfill shims (Buffer, process, global)
 * - Adds React Native NativeModules proxy shim
 * - Normalizes asset paths to relative (./_expo/) for views:// protocol
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const WEB_DIR = process.argv[2] || '.'

// Electrobun view entrypoint — sets up window.bridge, must load before Expo bundle
const VIEW_SCRIPT = `<script src="views://app/index.js"></script>`

// Node.js polyfills — Expo bundle references Node builtins that don't exist in CEF
const NODE_POLYFILLS = `<script id="peartube-node-polyfills">(function(){
if(typeof globalThis.process==='undefined'){globalThis.process={env:{},nextTick:function(fn){Promise.resolve().then(fn)},browser:true};}
if(typeof globalThis.Buffer==='undefined'){globalThis.Buffer={isBuffer:function(){return false},from:function(a){return new Uint8Array(a)},alloc:function(n){return new Uint8Array(n)}};}
if(typeof globalThis.global==='undefined'){globalThis.global=globalThis;}
try{if(screen&&screen.orientation){var o=screen.orientation;var origLock=o.lock;var origUnlock=o.unlock;if(origLock)o.lock=function(){try{return origLock.apply(this,arguments)}catch(e){return Promise.resolve()}};if(origUnlock)o.unlock=function(){try{origUnlock.apply(this,arguments)}catch(e){}};}}catch(e){}
})();</script>`

// React Native NativeModules proxy — prevents "__fbBatchedBridgeConfig is not set"
const RN_SHIM = `<script id="peartube-rn-shim">(function(){try{var scale=window.devicePixelRatio||1;var dims={width:window.innerWidth||0,height:window.innerHeight||0,scale:scale,fontScale:scale};window.nativeModuleProxy=window.nativeModuleProxy||{SourceCode:{getConstants:function(){return{scriptURL:String(location&&location.href||'')}}},DeviceInfo:{getConstants:function(){return{Dimensions:{window:dims,screen:dims}}}},UIManager:{getConstants:function(){return{ViewManagerNames:[],LazyViewManagersEnabled:false,genericBubblingEventTypes:{},genericDirectEventTypes:{}}},getViewManagerConfig:function(){return null},getConstantsForViewManager:function(){return null},getDefaultEventTypes:function(){return{}}}};window.__PEARTUBE_NATIVE_MODULE_PROXY__=true;}catch(e){}})();</script>`

function processHtmlFile(filePath) {
  let html = readFileSync(filePath, 'utf-8')

  // Clean previous injections
  html = html.replace(/<script[^>]*src="views:\/\/[^"]*index\.js"[^>]*><\/script>\n?/g, '')
  html = html.replace(/<script id="peartube-node-polyfills">[\s\S]*?<\/script>\n?/g, '')
  html = html.replace(/<script id="peartube-rn-shim">[\s\S]*?<\/script>\n?/g, '')

  // Convert ES module scripts to regular scripts (CEF compatibility)
  html = html.replace(/<script type="module">([^<]*)<\/script>/g, '<script>$1</script>')
  html = html.replace(/<script type="module"(\s+src="[^"]*")>/g, '<script$1>')

  // Relative paths for views:// protocol
  html = html.replace(/href="\/_expo\//g, 'href="./_expo/')
  html = html.replace(/src="\/_expo\//g, 'src="./_expo/')

  // Inject polyfills after <body>
  html = html.replace('<body>', `<body>\n${NODE_POLYFILLS}\n${RN_SHIM}`)

  // Inject view script before Expo entry bundle (so window.bridge is ready)
  html = html.replace(
    /(<script[^>]*src="[^"]*_expo\/static\/js\/web\/[^"]*"[^>]*><\/script>)/,
    `${VIEW_SCRIPT}\n$1`
  )

  writeFileSync(filePath, html)
  console.log(`  Processed ${filePath}`)
}

const SKIP_DIRS = ['node_modules', 'scripts', 'build', 'src', 'workers', '.git', 'web']

function walk(dir) {
  if (SKIP_DIRS.includes(dir.split('/').pop())) return
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (entry.endsWith('.html')) processHtmlFile(full)
  }
}

console.log(`[desktop:inject] Processing HTML in ${WEB_DIR}...`)
walk(WEB_DIR)
console.log('[desktop:inject] Done')
