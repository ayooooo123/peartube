/**
 * Desktop Platform Adapter
 *
 * Abstraction layer for desktop-specific capabilities (file pickers, notifications, links).
 * This keeps UI logic platform-agnostic so it can be mirrored on mobile with its own adapter.
 */

export interface PlatformAdapter {
  pickVideoFile: () => Promise<File | null>;
  notify: (message: string) => void;
  openExternal: (url: string) => void;
}

const pickVideoFile = (): Promise<File | null> => {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.style.display = 'none';

    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      resolve(file);
      document.body.removeChild(input);
    };

    input.onerror = () => {
      resolve(null);
      document.body.removeChild(input);
    };

    document.body.appendChild(input);
    input.click();
  });
};

export const desktopAdapter: PlatformAdapter = {
  pickVideoFile,
  notify: (message: string) => {
    window.alert(message);
  },
  openExternal: (url: string) => {
    window.open(url, '_blank', 'noopener');
  },
};

export default desktopAdapter;
