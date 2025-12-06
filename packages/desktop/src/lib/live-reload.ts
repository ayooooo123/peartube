/**
 * Live reload support for Pear development mode
 *
 * This module initializes React Refresh for hot module reloading
 * and sets up file watchers for automatic reloading during development.
 */

declare const global: typeof globalThis & { Pear?: any };

console.log('[live-reload] Starting...');

async function enableReactRefresh() {
  try {
    const ReactRefreshRuntime = (await import('react-refresh/runtime')).default;
    ReactRefreshRuntime.injectIntoGlobalHook(window);
    (window as any).$RefreshReg$ = ReactRefreshRuntime.register;
    (window as any).$RefreshSig$ = ReactRefreshRuntime.createSignatureFunctionForTransform;
    console.log('[live-reload] React Refresh runtime initialized.');
  } catch (err) {
    console.log('[live-reload] Could not initialize React Refresh (this is OK):', err);
  }
}

// Initialize React Refresh in dev mode
if (global.Pear && global.Pear.config.dev) {
  console.log('[live-reload] Dev mode detected, enabling React Refresh...');
  await enableReactRefresh();
}

// Import the main application
console.log('[live-reload] Loading main application...');
try {
  await import('../index');
  console.log('[live-reload] Main application loaded successfully');
} catch (err) {
  console.error('[live-reload] Failed to load main application:', err);
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `
      <div style="padding: 40px; text-align: center; color: #fff;">
        <h1 style="color: #ff4444;">Error Loading Application</h1>
        <pre style="text-align: left; background: #222; padding: 20px; border-radius: 8px; overflow: auto; margin: 20px 0;">${err}</pre>
        <p>Check the developer console for more details.</p>
      </div>
    `;
  }
}

export {};
