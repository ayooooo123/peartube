/**
 * PearTube - Frontend Entry Point
 *
 * This is the main entry point for the PearTube React application.
 * The Pear bridge is initialized by the main process.
 */

import { createRoot } from 'react-dom/client';
import { TamaguiProvider } from './lib/TamaguiProvider';
import App from './App';
import { AppStoreProvider } from './state/appStore';

// Enable Pear hot updates if available
if (typeof window !== 'undefined') {
  const pear = (window as any).Pear;
  if (pear?.updates && pear?.reload) {
    try {
      pear.updates(() => pear.reload());
    } catch (err) {
      console.error('[Frontend] Failed to enable Pear auto-reload:', err);
    }
  }
}

// Debug: Check Pear availability
console.log('[Frontend] Checking Pear runtime...');
console.log('[Frontend] window.Pear exists?', typeof (window as any).Pear);
console.log('[Frontend] window.Pear keys:', (window as any).Pear ? Object.keys((window as any).Pear) : 'N/A');

// Render React app
const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

const root = createRoot(container);
root.render(
  <TamaguiProvider>
    <AppStoreProvider>
      <App />
    </AppStoreProvider>
  </TamaguiProvider>
);

console.log('[Frontend] PearTube frontend initialized');
