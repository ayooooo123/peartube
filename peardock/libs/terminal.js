// terminal.js — Pure JavaScript (no TS-only features) – works everywhere

// Access Terminal and FitAddon from global window object (loaded via script tags)
// xterm.js UMD bundle exposes Terminal and FitAddon on window
if (typeof window === 'undefined') {
  throw new Error('window object is not available');
}

// Wait for scripts to load if they're not ready yet
function getTerminal() {
  if (window.Terminal) {
    return window.Terminal;
  }
  throw new Error('xterm.js not loaded. Make sure the script tag is included before this module.');
}

function getFitAddon() {
  if (window.FitAddon) {
    // UMD bundle exposes it as {__esModule: true, FitAddon: ƒ}
    // So we need to access window.FitAddon.FitAddon for the constructor
    if (window.FitAddon.FitAddon && typeof window.FitAddon.FitAddon === 'function') {
      return window.FitAddon.FitAddon;
    }
    // Fallback: if it's directly a function, use it
    if (typeof window.FitAddon === 'function') {
      return window.FitAddon;
    }
  }
  throw new Error('xterm-addon-fit not loaded. Make sure the script tag is included before this module.');
}

const Terminal = getTerminal();
const FitAddon = getFitAddon();

// DOM Elements
const terminalModal = document.getElementById('terminal-modal');
const terminalTitle = document.getElementById('terminal-title');
const terminalContainer = document.getElementById('terminal-container');
const tray = document.getElementById('tray');
const terminalHeader = document.querySelector('#terminal-modal .header');

// State
let terminalSessions = {};        // { [containerId: string]: session }
let activeContainerId = null;
let modalTerminalFontSize = 14;
let modalTerminalTheme = 'dark';

// Terminal theme configurations
const terminalThemes = {
  dark: {
    background: '#000000',
    foreground: '#ffffff',
    cursor: '#ffffff',
    selectionBackground: '#4d4d4d'
  },
  light: {
    background: '#ffffff',
    foreground: '#000000',
    cursor: '#000000',
    selectionBackground: '#b3d4fc'
  },
  'solarized-dark': {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    selectionBackground: '#073642'
  },
  'solarized-light': {
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#586e75',
    selectionBackground: '#eee8d5'
  },
  monokai: {
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    selectionBackground: '#49483e'
  }
};

// Resizing
let isResizing = false;
let startY = 0;
let startHeight = 0;

let mousemoveHandler = null;
let mouseupHandler = null;

// Kill button
const killBtn = document.getElementById('kill-terminal-btn');
if (killBtn) killBtn.addEventListener('click', killActiveTerminal);

// -------------------------------------------------------------------
// RESIZING
// -------------------------------------------------------------------
if (terminalHeader) {
  terminalHeader.addEventListener('mousedown', (e) => {
    // Ignore if click started on the close button
    if (e.target.closest('#kill-terminal-btn')) return;

    isResizing = true;
    startY = e.clientY;
    startHeight = terminalModal.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
}

mousemoveHandler = (e) => {
  if (!isResizing) return;

  const deltaY = startY - e.clientY;
  const newHeight = Math.max(150, Math.min(startHeight + deltaY, window.innerHeight * 0.9));

  terminalModal.style.height = `${newHeight}px`;
  terminalContainer.style.height = `${newHeight - 60}px`;

  const session = terminalSessions[activeContainerId];
  if (session && session.fitAddon) {
    requestAnimationFrame(() => {
      session.fitAddon.fit();
      // Send resize after fitting
      setTimeout(() => {
        const cols = session.xterm.cols;
        const rows = session.xterm.rows;
        if (window.activePeer && cols && rows) {
          window.activePeer.write(JSON.stringify({
            type: 'terminalResize',
            containerId: activeContainerId,
            cols,
            rows,
          }));
        }
      }, 50);
    });
  }
};

mouseupHandler = () => {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = 'default';
    document.body.style.userSelect = '';
  }
};

document.addEventListener('mousemove', mousemoveHandler);
document.addEventListener('mouseup', mouseupHandler);

// -------------------------------------------------------------------
// START TERMINAL
// -------------------------------------------------------------------
function startTerminal(containerId, containerName) {
  if (!window.activePeer) {
    console.error('[ERROR] No active peer connection.');
    return;
  }

  // Reuse if already exists
  if (terminalSessions[containerId]) {
    switchTerminal(containerId);
    return;
  }

  const xterm = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: modalTerminalFontSize,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: terminalThemes[modalTerminalTheme],
    scrollback: 10000,
  });

  // Verify FitAddon is a constructor before using it
  if (typeof FitAddon !== 'function') {
    console.error('FitAddon type:', typeof FitAddon, 'value:', FitAddon);
    throw new Error(`FitAddon is not a constructor. Type: ${typeof FitAddon}`);
  }
  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);

  const terminalDiv = document.createElement('div');
  terminalDiv.style.width = '100%';
  terminalDiv.style.height = '100%';
  terminalDiv.style.display = 'none';
  terminalContainer.appendChild(terminalDiv);

  xterm.open(terminalDiv);
  fitAddon.fit();

  // Function to send terminal dimensions to server
  const sendTerminalResize = () => {
    const cols = xterm.cols;
    const rows = xterm.rows;
    if (window.activePeer && cols && rows) {
      window.activePeer.write(JSON.stringify({
        type: 'terminalResize',
        containerId,
        cols,
        rows,
      }));
    }
  };

  const onDataDisposable = xterm.onData((data) => {
    const encoded = btoa(unescape(encodeURIComponent(data)));
    window.activePeer.write(JSON.stringify({
      type: 'terminalInput',
      containerId,
      data: encoded,
      encoding: 'base64',
    }));
  });

  // Listen for terminal resize events
  const onResizeDisposable = xterm.onResize(() => {
    sendTerminalResize();
  });

  terminalSessions[containerId] = {
    xterm,
    fitAddon,
    onDataDisposable,
    onResizeDisposable,
    container: terminalDiv,
    name: containerName,
    resizeListener: null,
  };

  // Send initial dimensions after a short delay to ensure terminal is fully rendered
  setTimeout(() => {
    fitAddon.fit();
    sendTerminalResize();
  }, 100);

  window.activePeer.write(JSON.stringify({
    command: 'startTerminal',
    args: { containerId }
  }));

  switchTerminal(containerId);
}

// -------------------------------------------------------------------
// SWITCH TERMINAL
// -------------------------------------------------------------------
function switchTerminal(containerId) {
  const session = terminalSessions[containerId];
  if (!session) return;

  // Hide previous
  if (activeContainerId && activeContainerId !== containerId) {
    const prev = terminalSessions[activeContainerId];
    if (prev) {
      prev.container.style.display = 'none';
      if (prev.resizeListener) {
        window.removeEventListener('resize', prev.resizeListener);
      }
    }
  }

  // Show current
  session.container.style.display = 'block';
  requestAnimationFrame(() => {
    session.fitAddon.fit();
    // Send resize after fitting
    setTimeout(() => {
      const cols = session.xterm.cols;
      const rows = session.xterm.rows;
      if (window.activePeer && cols && rows) {
        window.activePeer.write(JSON.stringify({
          type: 'terminalResize',
          containerId,
          cols,
          rows,
        }));
      }
    }, 50);
  });

  terminalTitle.textContent = `Terminal — ${session.name}`;
  terminalTitle.dataset.containerId = containerId;
  terminalModal.style.display = 'flex';
  activeContainerId = containerId;

  // Window resize handler
  if (session.resizeListener) {
    window.removeEventListener('resize', session.resizeListener);
  }
  session.resizeListener = () => {
    session.fitAddon.fit();
    // Send resize after fitting
    setTimeout(() => {
      const cols = session.xterm.cols;
      const rows = session.xterm.rows;
      if (window.activePeer && cols && rows) {
        window.activePeer.write(JSON.stringify({
          type: 'terminalResize',
          containerId,
          cols,
          rows,
        }));
      }
    }, 50);
  };
  window.addEventListener('resize', session.resizeListener);

  removeFromTray(containerId);
}

// -------------------------------------------------------------------
// APPEND OUTPUT
// -------------------------------------------------------------------
function appendTerminalOutput(data, containerId, encoding = 'base64') {
  const session = terminalSessions[containerId];
  if (!session) return;

  let text = data;
  if (encoding === 'base64') {
    try {
      text = decodeURIComponent(escape(atob(data)));
    } catch (e) {
      console.error('Base64 decode failed', e);
      return;
    }
  }

  session.xterm.write(text);
}

// -------------------------------------------------------------------
// CLEANUP & UTILS
// -------------------------------------------------------------------
function removeFromTray(containerId) {
  const item = document.querySelector(`.tray-item[data-id="${containerId}"]`);
  if (item) item.remove();
}

function killActiveTerminal() {
  if (!activeContainerId) return;

  const containerId = activeContainerId;
  if (window.sendCommand) {
    window.sendCommand('killTerminal', { containerId });
  }
  cleanUpTerminal(containerId);

  terminalModal.style.display = 'none';
  activeContainerId = null;
}

function cleanUpTerminal(containerId) {
  const session = terminalSessions[containerId];
  if (!session) return;

  session.xterm.dispose();
  session.onDataDisposable.dispose();
  if (session.onResizeDisposable) {
    session.onResizeDisposable.dispose();
  }
  if (session.resizeListener) {
    window.removeEventListener('resize', session.resizeListener);
  }
  if (session.container && session.container.parentNode) {
    session.container.parentNode.removeChild(session.container);
  }

  delete terminalSessions[containerId];
}

function cleanUpAllTerminals() {
  Object.keys(terminalSessions).forEach(cleanUpTerminal);
  terminalSessions = {};
  activeContainerId = null;
  terminalModal.style.display = 'none';
}

// -------------------------------------------------------------------
// TERMINAL CONTROLS
// -------------------------------------------------------------------
function updateModalTerminalFontSizeDisplay() {
  const display = document.getElementById('modal-terminal-font-size-display');
  if (display) {
    display.textContent = modalTerminalFontSize;
  }
}

function applyModalTerminalTheme(theme) {
  modalTerminalTheme = theme;
  Object.values(terminalSessions).forEach(session => {
    if (session.xterm) {
      session.xterm.options.theme = terminalThemes[theme];
    }
  });
}

// Set up terminal controls
document.addEventListener('DOMContentLoaded', () => {
  const fontDecreaseBtn = document.getElementById('modal-terminal-font-decrease');
  const fontIncreaseBtn = document.getElementById('modal-terminal-font-increase');
  const fontResetBtn = document.getElementById('modal-terminal-font-reset');
  const copyBtn = document.getElementById('modal-terminal-copy-btn');
  const clearBtn = document.getElementById('modal-terminal-clear-btn');
  const themeSelect = document.getElementById('modal-terminal-theme-select');
  
  // Helper function to send resize for all sessions
  const sendResizeForAllSessions = () => {
    Object.entries(terminalSessions).forEach(([containerId, session]) => {
      if (session.xterm && session.fitAddon) {
        session.fitAddon.fit();
        setTimeout(() => {
          const cols = session.xterm.cols;
          const rows = session.xterm.rows;
          if (window.activePeer && cols && rows) {
            window.activePeer.write(JSON.stringify({
              type: 'terminalResize',
              containerId,
              cols,
              rows,
            }));
          }
        }, 50);
      }
    });
  };

  if (fontDecreaseBtn) {
    fontDecreaseBtn.addEventListener('click', () => {
      if (modalTerminalFontSize > 8) {
        modalTerminalFontSize -= 2;
        Object.values(terminalSessions).forEach(session => {
          if (session.xterm) {
            session.xterm.options.fontSize = modalTerminalFontSize;
          }
        });
        sendResizeForAllSessions();
        updateModalTerminalFontSizeDisplay();
      }
    });
  }
  
  if (fontIncreaseBtn) {
    fontIncreaseBtn.addEventListener('click', () => {
      if (modalTerminalFontSize < 24) {
        modalTerminalFontSize += 2;
        Object.values(terminalSessions).forEach(session => {
          if (session.xterm) {
            session.xterm.options.fontSize = modalTerminalFontSize;
          }
        });
        sendResizeForAllSessions();
        updateModalTerminalFontSizeDisplay();
      }
    });
  }
  
  if (fontResetBtn) {
    fontResetBtn.addEventListener('click', () => {
      modalTerminalFontSize = 14;
      Object.values(terminalSessions).forEach(session => {
        if (session.xterm) {
          session.xterm.options.fontSize = modalTerminalFontSize;
        }
      });
      sendResizeForAllSessions();
      updateModalTerminalFontSizeDisplay();
    });
  }
  
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (activeContainerId && terminalSessions[activeContainerId]) {
        const selection = terminalSessions[activeContainerId].xterm.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).then(() => {
            const originalHTML = copyBtn.innerHTML;
            copyBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            setTimeout(() => {
              copyBtn.innerHTML = originalHTML;
            }, 2000);
          }).catch(err => {
            console.error('Failed to copy:', err);
          });
        }
      }
    });
  }
  
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (activeContainerId && terminalSessions[activeContainerId] && confirm('Clear terminal?')) {
        terminalSessions[activeContainerId].xterm.clear();
      }
    });
  }
  
  if (themeSelect) {
    themeSelect.value = modalTerminalTheme;
    themeSelect.addEventListener('change', (e) => {
      applyModalTerminalTheme(e.target.value);
    });
  }
  
  // Initialize font size display
  updateModalTerminalFontSizeDisplay();
});

// -------------------------------------------------------------------
// EXPORT
// -------------------------------------------------------------------
export {
  startTerminal,
  appendTerminalOutput,
  switchTerminal,
  killActiveTerminal,
  cleanUpTerminal,
  cleanUpAllTerminals,
};