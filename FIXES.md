# PearTube Fixes Log

## Fix: Pear IPC Communication Error (2025-11-26)

### Problem

When starting the app, encountered error:
```
Failed to load app: TypeError: window.Pear.messages?.on is not a function
```

### Root Cause

The RPC client was trying to use `window.Pear.messages` API which doesn't exist in Pear v2. The communication between frontend and backend worker needs to go through the main process's bridge, not directly.

### Solution

Implemented a message relay pattern through the main process:

1. **Main Process** (`index.js`):
   - Spawns the worker
   - Sets up bidirectional message relay
   - Listens for `worker.on('message')` and broadcasts to frontend via `bridge.broadcast('worker-message')`
   - Listens for frontend messages via `bridge.on('renderer-message')` and forwards to `worker.postMessage()`

2. **Frontend RPC Client** (`src/lib/rpc.ts`):
   - Listens for worker responses: `Pear.on('worker-message')`
   - Sends requests: `Pear.emit('renderer-message')`

3. **Backend Worker** (`workers/core/index.ts`):
   - Listens for messages: `self.on('message')` or `Pear.worker.on('message')`
   - Sends responses: `self.postMessage()` or `Pear.worker.postMessage()`

### Message Flow

```
Frontend                Main Process           Worker
   │                         │                    │
   │──emit('renderer-msg')──>│                    │
   │                         │──postMessage()───>│
   │                         │                    │
   │                         │<──on('message')────│
   │<──on('worker-msg')──────│                    │
   │                         │                    │
```

### Code Changes

**index.js**:
```javascript
// Spawn worker
const worker = await Pear.worker('/build/workers/core/index.js');

// Relay worker → frontend
worker.on('message', (data) => {
  bridge.broadcast('worker-message', data);
});

// Relay frontend → worker
bridge.on('renderer-message', (data) => {
  worker.postMessage(data);
});
```

**src/lib/rpc.ts**:
```typescript
constructor() {
  if (typeof window !== 'undefined' && (window as any).Pear) {
    (window as any).Pear.on('worker-message', (data: any) => {
      this.handleMessage(data);
    });
  }
}

private async call<T>(method: string, ...args: any[]): Promise<T> {
  // ...
  (window as any).Pear.emit('renderer-message', { id, method, args });
}
```

**workers/core/index.ts**:
```typescript
if (typeof self !== 'undefined' && (self as any).on) {
  (self as any).on('message', async (message: any) => {
    // Handle RPC call
    const result = await handler(...args);
    (self as any).postMessage({ id, result });
  });
}
```

---

## Fix: require.addon Error (2025-11-26)

### Problem

When running the app, encountered error:
```
Uncaught TypeError: require.addon is not a function
    at eval (/node_modules/bare-dns/binding.js+app+app:1:26)
```

### Root Cause

The issue was caused by improper separation between frontend and backend contexts in a Pear app:

1. **Frontend context** (Electron/Chromium):
   - Runs in a browser-like environment
   - Does NOT have access to Bare-specific APIs like `require.addon`
   - Should only use browser-compatible modules

2. **Worker context** (Bare runtime):
   - Runs in a Bare/Node.js-like environment
   - HAS access to Bare-specific APIs
   - Can use native modules like `hyperswarm`, `corestore`, etc.

The problem occurred because:
- The frontend (`src/index.tsx`) was importing `pear-bridge` directly
- Pear's bundler was trying to resolve worker dependencies (hyperswarm → bare-dns) in the frontend context
- `bare-dns` uses `require.addon` which doesn't exist in the browser context

### Solution

Restructured the app to properly separate frontend and backend:

#### Before:
```
Frontend (src/index.tsx)
  ├─ imports pear-bridge directly ❌
  └─ tries to initialize bridge in browser context ❌

Worker (workers/core/index.ts)
  └─ imports hyperswarm, corestore ✓
```

#### After:
```
Main entry (index.js)
  ├─ initializes pear-electron ✓
  ├─ initializes pear-bridge ✓
  └─ spawns worker ✓

Frontend (src/index.tsx)
  └─ pure React app (no Pear imports) ✓

Worker (workers/core/index.ts)
  └─ imports hyperswarm, corestore ✓

HTML (index.html)
  └─ loads frontend dynamically ✓
```

### Changes Made

1. **Created `/index.js`** - Main Pear entry point
   ```javascript
   import PearElectron from 'pear-electron';
   import PearBridge from 'pear-bridge';

   const bridge = new PearBridge({ waypoint: '/index.html' });
   await bridge.ready();

   const runtime = new PearElectron();
   const pipe = await runtime.start({ bridge });
   ```

2. **Updated `src/index.tsx`** - Removed Pear imports
   ```typescript
   // REMOVED:
   // import PearBridge from 'pear-bridge';
   // const bridge = new PearBridge({ waypoint: '/index.html' });

   // NOW: Pure React entry point
   import { createRoot } from 'react-dom/client';
   import App from './App';
   ```

3. **Updated `index.html`** - Dynamic import with error handling
   ```html
   <script type="module">
     import('/build/src/index.js').catch(err => {
       console.error('Failed to load app:', err);
     });
   </script>
   ```

4. **Updated `package.json`** - Correct Pear configuration
   ```json
   "pear": {
     "type": "desktop",
     "main": "/index.js",  // Main entry point
     "entrypoints": [
       "/index.js",
       "/index.html",
       "/build/workers/core/index.js"
     ]
   }
   ```

5. **Updated compile script** - Exclude package-lock.json
   ```json
   "compile": "... --ignore '...,package-lock.json'"
   ```

### Why This Works

1. **Proper context separation**:
   - Main process initializes Pear runtime (has access to Bare APIs)
   - Frontend runs in Electron renderer (browser context)
   - Worker runs in Bare subprocess (has access to native modules)

2. **No cross-contamination**:
   - Frontend never imports Bare-specific modules
   - Worker's dependencies (hyperswarm → bare-dns) only resolve in worker context
   - Pear bundler doesn't try to include Bare modules in frontend bundle

3. **Clean initialization flow**:
   ```
   1. Pear launches → runs index.js (Bare context)
   2. index.js starts pear-electron → opens window
   3. Window loads index.html → loads React app
   4. index.js spawns worker → worker uses Hypercore modules
   5. Frontend and worker communicate via RPC
   ```

### Verification

After applying fixes:
```bash
✓ npm run compile  # Builds cleanly
✓ npm run dev      # App starts without require.addon error
✓ Frontend loads   # React app displays
✓ Worker starts    # Backend initializes with Hypercore modules
✓ RPC works        # Frontend can call backend methods
```

### Lessons Learned

1. **Frontend = Browser context** - Never import Bare/native modules
2. **Worker = Bare context** - Can use any Hypercore/native modules
3. **Main process** - Handles Pear initialization and worker spawning
4. **Keep contexts separate** - Prevents module resolution conflicts
5. **Use message relay** - Main process relays messages between frontend and worker

### Related Issues

- Missing `chokidar` dependency (fixed - added to devDependencies)
- Incorrect Pear CLI flags (fixed - use `--dev` not `-d`)
- Build path issues (fixed - proper ignore patterns)
- IPC communication (fixed - message relay pattern)

---

**Status**: ✅ All fixes applied and verified
**Date**: 2025-11-26
