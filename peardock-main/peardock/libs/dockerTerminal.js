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
const dockerTerminalModal = document.getElementById('docker-terminal-modal');
const dockerTerminalTitle = document.getElementById('docker-terminal-title');
const dockerTerminalContainer = document.getElementById('docker-terminal-container');
const dockerKillTerminalBtn = document.getElementById('docker-kill-terminal-btn');

// Terminal variables
let dockerTerminalSession = null;
let dockerTerminalFontSize = 14;
let dockerTerminalTheme = 'dark';

// Terminal theme configurations
const dockerTerminalThemes = {
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

/**
 * Initialize and start the Docker CLI terminal.
 * @param {string} connectionId - Unique ID for the connection.
 * @param {Object} peer - Active peer object for communication.
 */
function startDockerTerminal(connectionId, peer) {
    if (!peer) {
      console.error('[ERROR] No active peer for Docker CLI terminal.');
      return;
    }
  
    if (dockerTerminalSession) {
      console.log('[INFO] Docker CLI terminal session already exists.');
      return;
    }
  
    // Verify DOM elements
    const dockerTerminalContainer = document.getElementById('docker-terminal-container');
    const dockerTerminalTitle = document.getElementById('docker-terminal-title');
    const dockerTerminalModal = document.getElementById('dockerTerminalModal');
    const dockerKillTerminalBtn = document.getElementById('docker-kill-terminal-btn');
  
    if (!dockerTerminalContainer || !dockerTerminalTitle || !dockerTerminalModal || !dockerKillTerminalBtn) {
      console.error('[ERROR] Missing required DOM elements for Docker CLI terminal.');
      return;
    }
  
    // Initialize the xterm.js terminal
    const xterm = new Terminal({
      cursorBlink: true,
      fontSize: dockerTerminalFontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: dockerTerminalThemes[dockerTerminalTheme],
      scrollback: 10000,
    });
    // Verify FitAddon is a constructor before using it
    if (typeof FitAddon !== 'function') {
      console.error('FitAddon type:', typeof FitAddon, 'value:', FitAddon);
      throw new Error(`FitAddon is not a constructor. Type: ${typeof FitAddon}`);
    }
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
  
    // Prepare the terminal container
    dockerTerminalContainer.innerHTML = ''; // Clear previous content
    xterm.open(dockerTerminalContainer);
    fitAddon.fit();
  
    // Function to send terminal dimensions to server
    const sendTerminalResize = () => {
      const cols = xterm.cols;
      const rows = xterm.rows;
      if (peer && cols && rows) {
        peer.write(JSON.stringify({
          type: 'dockerTerminalResize',
          connectionId,
          cols,
          rows,
        }));
      }
    };

    // Listen for terminal resize events
    const onResizeDisposable = xterm.onResize(() => {
      sendTerminalResize();
    });

    // Handle peer data - store handler reference for cleanup
    const peerDataHandler = (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.connectionId === connectionId) {
          const decodedData = decodeResponseData(response.data, response.encoding);
  
          if (response.type === 'dockerOutput') {
            xterm.write(`${decodedData.trim()}\r\n`);
          } else if (response.type === 'terminalErrorOutput') {
            xterm.write(`\r\n[ERROR] ${decodedData.trim()}\r\n`);
          }
        }
      } catch (error) {
        console.error(`[ERROR] Failed to parse response from peer: ${error.message}`);
      }
    };
    
    peer.on('data', peerDataHandler);
    dockerTerminalSession = { xterm, fitAddon, connectionId, peer, peerDataHandler, onResizeDisposable };
  
    // Send initial dimensions after a short delay to ensure terminal is fully rendered
    setTimeout(() => {
      fitAddon.fit();
      sendTerminalResize();
    }, 100);
  
    // Add window resize listener
    const windowResizeListener = () => {
      fitAddon.fit();
      setTimeout(() => {
        sendTerminalResize();
      }, 50);
    };
    window.addEventListener('resize', windowResizeListener);
    dockerTerminalSession.windowResizeListener = windowResizeListener;
  
    // Buffer to accumulate user input
    let inputBuffer = '';
  
    // Handle terminal input
    xterm.onData((input) => {
      if (input === '\r') {
        // User pressed Enter
        const fullCommand = prependDockerCommand(inputBuffer.trim());
        if (fullCommand) {
          peer.write(
            JSON.stringify({
              command: 'dockerCommand',
              connectionId,
              data: fullCommand,
            })
          );
          xterm.write('\r\n'); // Move to the next line
        } else {
          xterm.write('\r\n[ERROR] Invalid or blocked command. Only read-only Docker commands are allowed.\r\n');
          xterm.write('[INFO] Allowed commands: ps, images, logs, inspect, stats, etc.\r\n');
        }
        inputBuffer = ''; // Clear the buffer after processing
      } else if (input === '\u007F') {
        // Handle backspace
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1); // Remove last character
          xterm.write('\b \b'); // Erase character from display
        }
      } else {
        // Append input to buffer and display it
        inputBuffer += input;
        xterm.write(input);
      }
    });
  
    // Update the terminal modal and title
    dockerTerminalTitle.textContent = `Docker CLI Terminal: ${connectionId}`;
    const modalInstance = new bootstrap.Modal(dockerTerminalModal);
    modalInstance.show();
  
    // Attach event listener for Kill Terminal button
    dockerKillTerminalBtn.onclick = () => {
      cleanUpDockerTerminal();
    };
  }
  
// Allowed Docker commands (read-only and safe operations)
const ALLOWED_DOCKER_COMMANDS = new Set([
  'ps', 'images', 'volumes', 'networks', 'info', 'version',
  'logs', 'inspect', 'stats', 'top', 'diff', 'port',
  'history', 'search', 'events', 'system', 'help'
]);

// Blocked dangerous commands and patterns
const BLOCKED_COMMANDS = new Set([
  'exec', 'run', 'create', 'start', 'stop', 'restart', 'kill',
  'rm', 'rmi', 'prune', 'build', 'commit', 'push', 'pull',
  'tag', 'load', 'save', 'import', 'export', 'cp', 'update'
]);

const BLOCKED_PATTERNS = [
  /rm\s+-f/,           // Force remove
  /rm\s+-rf/,          // Recursive force remove
  /prune/,             // Prune operations
  /system\s+prune/,     // System prune
  /volume\s+prune/,     // Volume prune
  /\$\(/,              // Command substitution
  /`/,                  // Backticks
  /&&/,                 // Command chaining
  /\|\|/,               // OR operator
  /;/,                  // Command separator
  />.*</,              // Redirection (e.g., >file or <file)
  /2>&1/,               // Stderr redirection
];

const MAX_COMMAND_LENGTH = 500; // Maximum command length

/**
 * Validates and sanitizes Docker command input.
 * @param {string} command - Command string entered by the user.
 * @returns {string|null} - Validated Docker command or null if invalid.
 */
function validateDockerCommand(command) {
  // Check command length
  if (command.length > MAX_COMMAND_LENGTH) {
    console.warn('[WARN] Command exceeds maximum length.');
    return null;
  }

  // Check for dangerous operators and patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      console.warn('[WARN] Blocked pattern detected in command.');
      return null;
    }
  }

  // Extract the base command (first word after 'docker')
  const normalizedCommand = command.trim().toLowerCase();
  let baseCommand = normalizedCommand;
  
  if (normalizedCommand.startsWith('docker ')) {
    baseCommand = normalizedCommand.substring(7).trim().split(/\s+/)[0];
  } else {
    baseCommand = normalizedCommand.split(/\s+/)[0];
  }

  // Check if command is blocked
  if (BLOCKED_COMMANDS.has(baseCommand)) {
    console.warn(`[WARN] Blocked command detected: ${baseCommand}`);
    return null;
  }

  // If command is in allowed list, validate structure
  if (ALLOWED_DOCKER_COMMANDS.has(baseCommand)) {
    // Additional validation: ensure no dangerous flags
    const dangerousFlags = ['--privileged', '--cap-add', '--security-opt'];
    for (const flag of dangerousFlags) {
      if (normalizedCommand.includes(flag)) {
        console.warn(`[WARN] Dangerous flag detected: ${flag}`);
        return null;
      }
    }
    return command.startsWith('docker ') ? command : `docker ${command}`;
  }

  // For commands not in whitelist, be more restrictive
  // Only allow if it's a help command or info query
  if (baseCommand === 'help' || baseCommand === '--help' || baseCommand === '-h') {
    return command.startsWith('docker ') ? command : `docker ${command}`;
  }

  // Block unknown commands for security
  console.warn(`[WARN] Unknown or potentially unsafe command: ${baseCommand}`);
  return null;
}

/**
 * Prepend 'docker' to the command if it's missing.
 * @param {string} command - Command string entered by the user.
 * @returns {string|null} - Full Docker command or null if invalid.
 * @deprecated Use validateDockerCommand instead for better security
 */
function prependDockerCommand(command) {
  return validateDockerCommand(command);
}

/**
 * Decode response data from Base64 or return as-is if not encoded.
 * @param {string} data - Response data from the server.
 * @param {string} encoding - Encoding type (e.g., 'base64').
 * @returns {string} - Decoded or plain data.
 */
function decodeResponseData(data, encoding) {
  if (encoding === 'base64') {
    try {
      return atob(data); // Decode Base64 data
    } catch (error) {
      console.error(`[ERROR] Failed to decode Base64 data: ${error.message}`);
      return '[ERROR] Command failed.';
    }
  }
  return data; // Return plain data if not encoded
}

/**
 * Clean up the Docker CLI terminal session.
 */
function cleanUpDockerTerminal() {
    console.log('[INFO] Cleaning up Docker Terminal...');
  
    // Retrieve the required DOM elements
    const dockerTerminalContainer = document.getElementById('docker-terminal-container');
    const dockerTerminalModal = document.getElementById('dockerTerminalModal');
  
    if (!dockerTerminalContainer || !dockerTerminalModal) {
      console.error('[ERROR] Required DOM elements not found for cleaning up the Docker Terminal.');
      return;
    }
  
    // Dispose of the terminal session if it exists
    if (dockerTerminalSession) {
      if (dockerTerminalSession.xterm) {
        dockerTerminalSession.xterm.dispose();
      }
      // Remove peer data handler if it exists
      if (dockerTerminalSession.peer && dockerTerminalSession.peerDataHandler) {
        dockerTerminalSession.peer.removeListener('data', dockerTerminalSession.peerDataHandler);
      }
      // Remove resize listener if it exists
      if (dockerTerminalSession.onResizeDisposable) {
        dockerTerminalSession.onResizeDisposable.dispose();
      }
      // Remove window resize listener if it exists
      if (dockerTerminalSession.windowResizeListener) {
        window.removeEventListener('resize', dockerTerminalSession.windowResizeListener);
      }
      dockerTerminalSession = null; // Reset the session object
    }
  
    // Clear the terminal content
    dockerTerminalContainer.innerHTML = '';
  
    // Use Bootstrap API to hide the modal
    const modalInstance = bootstrap.Modal.getInstance(dockerTerminalModal);
    if (modalInstance) {
      modalInstance.hide();
    } else {
      console.warn('[WARNING] Modal instance not found. Falling back to manual close.');
      dockerTerminalModal.style.display = 'none';
    }
  
    // Ensure lingering backdrops are removed
    const backdrop = document.querySelector('.modal-backdrop');
    if (backdrop) {
      backdrop.remove();
    }
  
    // Restore the body's scroll behavior
    document.body.classList.remove('modal-open');
    document.body.style.paddingRight = '';
  
    console.log('[INFO] Docker CLI terminal session cleanup completed.');
  }
  

// Attach event listener for Kill Terminal button (redundant safety check)
if (dockerKillTerminalBtn) {
  dockerKillTerminalBtn.onclick = () => {
    cleanUpDockerTerminal();
  };
}

// Terminal controls for Docker terminal
function updateDockerTerminalFontSizeDisplay() {
  const display = document.getElementById('docker-terminal-font-size-display');
  if (display) {
    display.textContent = dockerTerminalFontSize;
  }
}

function applyDockerTerminalTheme(theme) {
  dockerTerminalTheme = theme;
  if (dockerTerminalSession && dockerTerminalSession.xterm) {
    dockerTerminalSession.xterm.options.theme = dockerTerminalThemes[theme];
  }
}

// Set up Docker terminal controls
document.addEventListener('DOMContentLoaded', () => {
  const fontDecreaseBtn = document.getElementById('docker-terminal-font-decrease');
  const fontIncreaseBtn = document.getElementById('docker-terminal-font-increase');
  const fontResetBtn = document.getElementById('docker-terminal-font-reset');
  const copyBtn = document.getElementById('docker-terminal-copy-btn');
  const clearBtn = document.getElementById('docker-terminal-clear-btn');
  const themeSelect = document.getElementById('docker-terminal-theme-select');
  
  // Helper function to send resize for Docker terminal
  const sendDockerTerminalResize = () => {
    if (dockerTerminalSession && dockerTerminalSession.xterm && dockerTerminalSession.fitAddon) {
      dockerTerminalSession.fitAddon.fit();
      setTimeout(() => {
        const cols = dockerTerminalSession.xterm.cols;
        const rows = dockerTerminalSession.xterm.rows;
        if (dockerTerminalSession.peer && cols && rows) {
          dockerTerminalSession.peer.write(JSON.stringify({
            type: 'dockerTerminalResize',
            connectionId: dockerTerminalSession.connectionId,
            cols,
            rows,
          }));
        }
      }, 50);
    }
  };

  if (fontDecreaseBtn) {
    fontDecreaseBtn.addEventListener('click', () => {
      if (dockerTerminalFontSize > 8) {
        dockerTerminalFontSize -= 2;
        if (dockerTerminalSession && dockerTerminalSession.xterm) {
          dockerTerminalSession.xterm.options.fontSize = dockerTerminalFontSize;
        }
        sendDockerTerminalResize();
        updateDockerTerminalFontSizeDisplay();
      }
    });
  }
  
  if (fontIncreaseBtn) {
    fontIncreaseBtn.addEventListener('click', () => {
      if (dockerTerminalFontSize < 24) {
        dockerTerminalFontSize += 2;
        if (dockerTerminalSession && dockerTerminalSession.xterm) {
          dockerTerminalSession.xterm.options.fontSize = dockerTerminalFontSize;
        }
        sendDockerTerminalResize();
        updateDockerTerminalFontSizeDisplay();
      }
    });
  }
  
  if (fontResetBtn) {
    fontResetBtn.addEventListener('click', () => {
      dockerTerminalFontSize = 14;
      if (dockerTerminalSession && dockerTerminalSession.xterm) {
        dockerTerminalSession.xterm.options.fontSize = dockerTerminalFontSize;
      }
      sendDockerTerminalResize();
      updateDockerTerminalFontSizeDisplay();
    });
  }
  
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (dockerTerminalSession && dockerTerminalSession.xterm) {
        const selection = dockerTerminalSession.xterm.getSelection();
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
      if (dockerTerminalSession && dockerTerminalSession.xterm && confirm('Clear terminal?')) {
        dockerTerminalSession.xterm.clear();
      }
    });
  }
  
  if (themeSelect) {
    themeSelect.value = dockerTerminalTheme;
    themeSelect.addEventListener('change', (e) => {
      applyDockerTerminalTheme(e.target.value);
    });
  }
  
  // Initialize font size display
  updateDockerTerminalFontSizeDisplay();
});

// Export functions
export { startDockerTerminal, cleanUpDockerTerminal, dockerTerminalSession };
