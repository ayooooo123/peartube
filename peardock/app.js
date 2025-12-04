import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import { startTerminal, appendTerminalOutput } from './libs/terminal.js';
import { startDockerTerminal, cleanUpDockerTerminal } from './libs/dockerTerminal.js';
import { fetchTemplates, displayTemplateList, openDeployModal, collectDuplicateFormData, populateDuplicateForm } from './libs/templateDeploy.js';
import { showContainerSkeleton, createProgressBar, updateProgressBar, removeProgressBar } from './libs/loadingStates.js';
import { closeAllModals, showStatusIndicator, hideStatusIndicator, updateStatusIndicator, showAlert } from './libs/uiUtils.js';
import notificationManager from './libs/notifications.js';

// DOM Elements - Cache frequently accessed elements (will be initialized in DOMContentLoaded)
let containerList = null;
let connectionList = null;
let addConnectionForm = null;
let newConnectionTopic = null;
let connectionTitle = null;
let dashboard = null;
let welcomePage = null;
let sidebar = null;
let collapseSidebarBtn = null;
let alertContainer = null;

// Modal Elements (will be initialized in DOMContentLoaded)
let duplicateModalElement = null;
let duplicateModal = null;
let duplicateContainerForm = null;

// Notification tray initialization state
let notificationTrayInitialized = false;

// Global variables
const connections = {};
window.openTerminals = {};
let activePeer = null;
window.activePeer = null; // Expose to other modules
let statsInterval = null;

// Centralized volumes cache/store
const volumesStore = {
  volumes: [],
  lastUpdate: null,
  loading: false,
  listeners: new Set(), // Listeners that want to be notified when volumes update
  
  // Get cached volumes
  get() {
    return this.volumes;
  },
  
  // Set volumes and notify listeners
  set(volumes) {
    this.volumes = Array.isArray(volumes) ? volumes : [];
    this.lastUpdate = Date.now();
    this.loading = false;
    this.notifyListeners();
  },
  
  // Add a listener callback
  subscribe(callback) {
    this.listeners.add(callback);
    // Immediately call with current data if available
    if (this.volumes.length > 0) {
      callback(this.volumes);
    }
    // Return unsubscribe function
    return () => this.listeners.delete(callback);
  },
  
  // Notify all listeners
  notifyListeners() {
    this.listeners.forEach(callback => {
      try {
        callback(this.volumes);
      } catch (error) {
        console.error('[ERROR] Volume listener error:', error);
      }
    });
  },
  
  // Check if cache is stale (older than 30 seconds)
  isStale() {
    if (!this.lastUpdate) return true;
    return Date.now() - this.lastUpdate > 30000;
  },
  
  // Set loading state
  setLoading(loading) {
    this.loading = loading;
  },
  
  // Check if currently loading
  isLoading() {
    return this.loading;
  }
};

// Expose volumes store to window for use by other modules
window.volumesStore = volumesStore;
let lastStatsUpdate = Date.now();
function stopStatsInterval() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
    console.log('[INFO] Stats interval stopped.');
  }
}

// Utility functions are now imported from uiUtils.js


document.addEventListener('DOMContentLoaded', () => {
  const dockerTerminalModal = document.getElementById('dockerTerminalModal');

  if (dockerTerminalModal) {
    dockerTerminalModal.addEventListener('hidden.bs.modal', () => {
      console.log('[INFO] Modal fully closed. Performing additional cleanup.');
      cleanUpDockerTerminal();
    });
  }
});

function startStatsInterval() {
  // Guard: stop existing interval before starting a new one
  stopStatsInterval();

  // Only start if there's an active peer
  if (!window.activePeer) {
    console.warn('[WARN] No active peer; not starting stats interval.');
    return;
  }

  // Increased interval to 500ms for better performance (was 100ms)
  statsInterval = setInterval(() => {
    if (window.activePeer) {
      const now = Date.now();
      if (now - lastStatsUpdate >= 500) { // Ensure at least 500ms between updates
        lastStatsUpdate = now;
      }
    } else {
      console.warn('[WARN] No active peer; skipping stats request.');
      stopStatsInterval(); // Stop interval if peer is no longer active
    }
  }, 500); // Poll every 500ms for better performance (reduced from 100ms)
}
const smoothedStats = {}; // Container-specific smoothing storage
const historicalStats = {}; // Container-specific historical stats for charts
const MAX_HISTORY_POINTS = 60; // Keep last 60 data points (5 minutes at 5s intervals)

function smoothStats(containerId, newStats, smoothingFactor = 0.2) {
  if (!smoothedStats[containerId]) {
    smoothedStats[containerId] = { cpu: 0, memory: 0, ip: newStats.ip || 'No IP Assigned' };
  }

  smoothedStats[containerId].cpu =
    smoothedStats[containerId].cpu * (1 - smoothingFactor) +
    newStats.cpu * smoothingFactor;

  smoothedStats[containerId].memory =
    smoothedStats[containerId].memory * (1 - smoothingFactor) +
    newStats.memory * smoothingFactor;

  // Preserve the latest IP address
  smoothedStats[containerId].ip = newStats.ip || smoothedStats[containerId].ip;

  // Store historical data for charts
  if (!historicalStats[containerId]) {
    historicalStats[containerId] = {
      timestamps: [],
      cpu: [],
      memory: []
    };
  }
  
  const history = historicalStats[containerId];
  const now = new Date();
  history.timestamps.push(now);
  history.cpu.push(smoothedStats[containerId].cpu);
  history.memory.push(smoothedStats[containerId].memory);
  
  // Keep only last MAX_HISTORY_POINTS
  if (history.timestamps.length > MAX_HISTORY_POINTS) {
    history.timestamps.shift();
    history.cpu.shift();
    history.memory.shift();
  }
  
  // Update charts if on container details view
  if (currentView === 'container-details' && currentContainerDetails && currentContainerDetails.Id === containerId) {
    updateStatsCharts(containerId);
  }

  return smoothedStats[containerId];
}


function refreshContainerStats() {
  if (!window.activePeer) {
    // Don't try to refresh if there's no active peer
    return;
  }
  console.log('[INFO] Refreshing container stats...');
  sendCommand('listContainers'); // Request an updated container list
  startStatsInterval(); // Restart stats interval
}

function waitForPeerResponse(expectedMessageFragment, timeout = 900000) {
  console.log(`[DEBUG] Waiting for peer response with fragment: "${expectedMessageFragment}"`);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    window.handlePeerResponse = (response) => {
      console.log(`[DEBUG] Received response: ${JSON.stringify(response)}`);
      console.log(response.message)
      if (response && response.success && response.message.includes(expectedMessageFragment)) {
        console.log(`[DEBUG] Expected response received: ${response.message}`);
        resolve(response);
      } else if (Date.now() - startTime > timeout) {
        console.warn('[WARN] Timeout while waiting for peer response');
        reject(new Error('Timeout waiting for peer response'));
      }
    };

    // Timeout fallback
    setTimeout(() => {
      console.warn('[WARN] Timed out waiting for response');
      reject(new Error('Timed out waiting for peer response'));
    }, timeout);
  });
}

// Utility functions for managing cookies and localStorage
const COOKIE_SIZE_LIMIT = 4000; // 4KB limit for cookies
const CONNECTIONS_STORAGE_KEY = 'peardock_connections';
const USE_LOCALSTORAGE_KEY = 'peardock_use_localstorage';

function setCookie(name, value, days = 365) {
  const date = new Date();
  date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
  const expires = `expires=${date.toUTCString()}`;
  const cookieValue = `${name}=${encodeURIComponent(value)};${expires};path=/`;
  
  // Check cookie size (approximate)
  if (cookieValue.length > COOKIE_SIZE_LIMIT) {
    console.warn(`[WARN] Cookie size (${cookieValue.length} bytes) exceeds limit. Using localStorage instead.`);
    // Mark that we should use localStorage
    try {
      localStorage.setItem(USE_LOCALSTORAGE_KEY, 'true');
      localStorage.setItem(CONNECTIONS_STORAGE_KEY, value);
      return;
    } catch (err) {
      console.error(`[ERROR] Failed to save to localStorage: ${err.message}`);
      // Fall through to try cookie anyway
    }
  }
  
  document.cookie = cookieValue;
}

function getCookie(name) {
  const cookies = document.cookie.split('; ');
  for (let i = 0; i < cookies.length; i++) {
    const [key, value] = cookies[i].split('=');
    if (key === name) return decodeURIComponent(value);
  }
  return null;
}

function deleteCookie(name) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
}

// Load connections from cookies or localStorage
function loadConnections() {
  let savedConnections = null;
  
  // Check if we should use localStorage
  try {
    const useLocalStorage = localStorage.getItem(USE_LOCALSTORAGE_KEY);
    if (useLocalStorage === 'true') {
      savedConnections = localStorage.getItem(CONNECTIONS_STORAGE_KEY);
    } else {
      savedConnections = getCookie('connections');
    }
  } catch (err) {
    console.warn(`[WARN] localStorage not available, falling back to cookies: ${err.message}`);
    savedConnections = getCookie('connections');
  }
  
  const connections = savedConnections ? JSON.parse(savedConnections) : {};

  // Recreate the topic Buffer from the hex string
  for (const topicId in connections) {
    const { topicHex, alias } = connections[topicId];
    connections[topicId] = {
      topic: b4a.from(topicHex, 'hex'),
      topicHex,
      alias: alias || null,
      peer: null, // Initialize additional properties
      swarm: null,
      connectedAt: null,
      lastHealthCheck: null,
      latency: null,
      healthStatus: 'unknown'
    };
  }

  return connections;
}


// Save connections to cookies or localStorage
function saveConnections() {
  const serializableConnections = {};

  for (const topicId in connections) {
    const { topic, topicHex, alias } = connections[topicId]; // Only serialize simple properties
    serializableConnections[topicId] = {
      topicHex,
      topic: b4a.toString(topic, 'hex'), // Convert Buffer to hex string
      alias: alias || null, // Save alias
    };
  }

  const serialized = JSON.stringify(serializableConnections);
  
  // Check size and use appropriate storage
  if (serialized.length > COOKIE_SIZE_LIMIT) {
    // Use localStorage for large data
    try {
      localStorage.setItem(USE_LOCALSTORAGE_KEY, 'true');
      localStorage.setItem(CONNECTIONS_STORAGE_KEY, serialized);
      console.log('[INFO] Saved connections to localStorage (data too large for cookies)');
    } catch (err) {
      console.error(`[ERROR] Failed to save to localStorage: ${err.message}`);
      // Try cookie as fallback (may fail but we try)
      setCookie('connections', serialized);
    }
  } else {
    // Use cookies for small data
    try {
      localStorage.removeItem(USE_LOCALSTORAGE_KEY);
      localStorage.removeItem(CONNECTIONS_STORAGE_KEY);
    } catch (err) {
      // Ignore localStorage errors
    }
    setCookie('connections', serialized);
  }
}


// Add Reset Connections Button
// Toggle Reset Connections Button Visibility
function toggleResetButtonVisibility() {
  const resetConnectionsBtn = document.querySelector('#sidebar .btn-danger');
  if (!resetConnectionsBtn) return;

  // Show or hide the button based on active connections
  resetConnectionsBtn.style.display = Object.keys(connections).length > 0 ? 'block' : 'none';
}



// Initialize container filtering
function initContainerFiltering() {
  const searchInput = document.getElementById('container-search');
  const statusFilter = document.getElementById('container-status-filter');
  const sortSelect = document.getElementById('container-sort');
  const clearBtn = document.getElementById('clear-filters');
  
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      containerFilterState.search = e.target.value;
      if (containerFilterState.allContainers.length > 0) {
        renderContainers(containerFilterState.allContainers, Object.keys(connections)[0] || '');
      }
    });
  }
  
  if (statusFilter) {
    statusFilter.addEventListener('change', (e) => {
      containerFilterState.status = e.target.value;
      if (containerFilterState.allContainers.length > 0) {
        renderContainers(containerFilterState.allContainers, Object.keys(connections)[0] || '');
      }
    });
  }
  
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      containerFilterState.sort = e.target.value;
      if (containerFilterState.allContainers.length > 0) {
        renderContainers(containerFilterState.allContainers, Object.keys(connections)[0] || '');
      }
    });
  }
  
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      containerFilterState.search = '';
      containerFilterState.status = 'all';
      containerFilterState.sort = 'name-asc';
      if (searchInput) searchInput.value = '';
      if (statusFilter) statusFilter.value = 'all';
      if (sortSelect) sortSelect.value = 'name-asc';
      if (containerFilterState.allContainers.length > 0) {
        renderContainers(containerFilterState.allContainers, Object.keys(connections)[0] || '');
      }
    });
  }
}

// Initialize the app
console.log('[INFO] Client app initialized');

// Utility functions are now imported from uiUtils.js

/**
 * Centralized error handler for server responses
 * Parses errors, formats user-friendly messages, and sends to notification center
 * @param {Object} response - Server response object
 * @returns {string|null} - Formatted error message or null if no error
 */
function handleErrorResponse(response) {
  // Check if response has an error
  if (!response || !response.error) {
    return null;
  }

  const errorMessage = typeof response.error === 'string' 
    ? response.error 
    : (response.error?.message || response.error?.toString() || 'Unknown error');

  // Parse Docker API errors
  let formattedMessage = errorMessage;
  let errorType = 'danger';
  let operation = 'Operation';

  // Extract operation type from error message or response context
  if (errorMessage.includes('volume')) {
    operation = 'Volume';
    if (errorMessage.includes('in use')) {
      // Extract volume name and container ID if available
      const volumeMatch = errorMessage.match(/remove\s+([^\s:]+)/);
      const containerMatch = errorMessage.match(/\[([a-f0-9]+)\]/);
      if (volumeMatch && containerMatch) {
        formattedMessage = `Cannot remove volume "${volumeMatch[1]}": volume is in use by container ${containerMatch[1].substring(0, 12)}`;
      } else if (volumeMatch) {
        formattedMessage = `Cannot remove volume "${volumeMatch[1]}": volume is in use`;
      } else {
        formattedMessage = 'Cannot remove volume: volume is in use by a container';
      }
    } else if (errorMessage.includes('not found')) {
      formattedMessage = 'Volume not found';
    } else if (errorMessage.includes('create')) {
      formattedMessage = `Failed to create volume: ${errorMessage.replace(/.*create\s+volume[:\s]+/i, '')}`;
    } else if (errorMessage.includes('remove')) {
      formattedMessage = `Failed to remove volume: ${errorMessage.replace(/.*remove\s+volume[:\s]+/i, '')}`;
    }
  } else if (errorMessage.includes('container')) {
    operation = 'Container';
    if (errorMessage.includes('not found')) {
      formattedMessage = 'Container not found';
    } else if (errorMessage.includes('already exists')) {
      formattedMessage = 'Container with this name already exists';
    } else if (errorMessage.includes('in use')) {
      formattedMessage = 'Container is in use and cannot be removed';
    } else if (errorMessage.includes('409') || errorMessage.includes('conflict')) {
      formattedMessage = 'Container operation conflict: resource is in use';
    }
  } else if (errorMessage.includes('image')) {
    operation = 'Image';
    if (errorMessage.includes('not found')) {
      formattedMessage = 'Image not found';
    } else if (errorMessage.includes('pull')) {
      formattedMessage = `Failed to pull image: ${errorMessage.replace(/.*pull[:\s]+/i, '')}`;
    }
  } else if (errorMessage.includes('network')) {
    operation = 'Network';
    if (errorMessage.includes('not found')) {
      formattedMessage = 'Network not found';
    } else if (errorMessage.includes('already exists')) {
      formattedMessage = 'Network with this name already exists';
    }
  } else if (errorMessage.includes('HTTP code 409') || errorMessage.includes('conflict')) {
    formattedMessage = 'Resource conflict: the resource is currently in use';
  } else if (errorMessage.includes('HTTP code 404') || errorMessage.includes('not found')) {
    formattedMessage = 'Resource not found';
  } else if (errorMessage.includes('HTTP code 403') || errorMessage.includes('permission') || errorMessage.includes('access denied')) {
    operation = 'Permission';
    formattedMessage = 'Access denied: insufficient permissions';
    errorType = 'warning';
  } else if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
    operation = 'Network';
    formattedMessage = 'Operation timed out: server did not respond in time';
  } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('connection')) {
    operation = 'Network';
    formattedMessage = 'Connection failed: unable to reach server';
  } else if (errorMessage.includes('validation') || errorMessage.includes('invalid')) {
    operation = 'Validation';
    formattedMessage = `Invalid input: ${errorMessage.replace(/.*validation[:\s]+/i, '').replace(/.*invalid[:\s]+/i, '')}`;
    errorType = 'warning';
  }

  // Clean up the message - remove technical details that aren't user-friendly
  formattedMessage = formattedMessage
    .replace(/\(HTTP code \d+\)\s*/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Truncate if too long
  if (formattedMessage.length > 200) {
    formattedMessage = formattedMessage.substring(0, 197) + '...';
  }

  // Send to notification center
  if (typeof notificationManager !== 'undefined') {
    notificationManager.add(errorType, formattedMessage, {
      autoDismiss: errorType === 'warning' ? true : false, // Keep errors visible longer
      duration: errorType === 'warning' ? 8000 : 10000
    });
  }

  // Return formatted message for use with showAlert() if needed
  return formattedMessage;
}

// Navigation Management
let currentView = 'dashboard';

function initNavigation() {
  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const view = link.dataset.view;
      if (view) {
        navigateToView(view);
      }
    });
  });
  
  // Set initial view
  navigateToView('dashboard');
}

function navigateToView(viewName) {
  // Hide all views
  document.querySelectorAll('.view').forEach(view => {
    view.classList.add('hidden');
  });
  
  // Show selected view
  const targetView = document.getElementById(`${viewName}-view`);
  if (targetView) {
    targetView.classList.remove('hidden');
  }
  
  // Update active nav link (only for main navigation views)
  if (viewName !== 'container-details') {
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.remove('active');
      if (link.dataset.view === viewName) {
        link.classList.add('active');
      }
    });
  }
  
  currentView = viewName;
  
  // Load view-specific data
  if (viewName === 'dashboard') {
    loadDashboard();
  } else if (viewName === 'containers') {
    // Containers view is already handled by existing code
    if (window.activePeer) {
      sendCommand('listContainers');
    }
  } else if (viewName === 'images') {
    loadImages();
  } else if (viewName === 'networks') {
    loadNetworks();
  } else if (viewName === 'volumes') {
    loadVolumes();
  } else if (viewName === 'stacks') {
    loadStacks();
  } else if (viewName === 'deploy') {
    loadDeployView();
  } else if (viewName === 'container-details') {
    // Container details view - data is loaded when showContainerDetails is called
  }
}

// Expose to window for onclick handlers
window.navigateToView = navigateToView;

// Dashboard Functions
function loadDashboard() {
  if (!window.activePeer) {
    return;
  }
  
  // Set up volumes subscription early to catch broadcasts
  if (!volumesStoreSubscription) {
    volumesStoreSubscription = volumesStore.subscribe((volumes) => {
      // Only auto-update if we're on the volumes view
      if (currentView === 'volumes') {
        renderVolumes(volumes);
      }
    });
  }
  
  // Load system info
  sendCommand('getSystemInfo');
  
  // Load container stats for counts
  sendCommand('listContainers');
  
  // Load images count
  sendCommand('listImages');
  
  // Load networks count
  sendCommand('listNetworks');
  
  // Load volumes
  sendCommand('listVolumes');
}

function updateDashboardStats(containers, images, networks) {
  if (containers) {
    const running = containers.filter(c => c.State === 'running').length;
    const stopped = containers.filter(c => c.State !== 'running').length;
    
    const runningEl = document.getElementById('stat-running-containers');
    const stoppedEl = document.getElementById('stat-stopped-containers');
    if (runningEl) runningEl.textContent = running;
    if (stoppedEl) stoppedEl.textContent = stopped;
  }
  
  if (images) {
    const imagesEl = document.getElementById('stat-total-images');
    if (imagesEl) imagesEl.textContent = images.length;
  }
  
  if (networks) {
    const networksEl = document.getElementById('stat-total-networks');
    if (networksEl) networksEl.textContent = networks.length;
  }
}

function updateSystemInfo(systemInfo) {
  if (!systemInfo) return;
  
  const dockerInfoEl = document.getElementById('docker-info-content');
  const resourcesEl = document.getElementById('system-resources-content');
  
  if (dockerInfoEl && systemInfo.info) {
    const info = systemInfo.info;
    dockerInfoEl.innerHTML = `
      <div class="key-value">
        <span class="key">Docker Version:</span>
        <span class="value">${systemInfo.version?.Version || 'Unknown'}</span>
      </div>
      <div class="key-value">
        <span class="key">Containers:</span>
        <span class="value">${info.Containers || 0}</span>
      </div>
      <div class="key-value">
        <span class="key">Running:</span>
        <span class="value">${info.ContainersRunning || 0}</span>
      </div>
      <div class="key-value">
        <span class="key">Paused:</span>
        <span class="value">${info.ContainersPaused || 0}</span>
      </div>
      <div class="key-value">
        <span class="key">Stopped:</span>
        <span class="value">${info.ContainersStopped || 0}</span>
      </div>
      <div class="key-value">
        <span class="key">Images:</span>
        <span class="value">${info.Images || 0}</span>
      </div>
      <div class="key-value">
        <span class="key">Storage Driver:</span>
        <span class="value">${info.Driver || 'Unknown'}</span>
      </div>
    `;
  }
  
  if (resourcesEl && systemInfo.info) {
    const info = systemInfo.info;
    const formatBytes = (bytes) => {
      if (!bytes) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    };
    
    resourcesEl.innerHTML = `
      <div class="key-value">
        <span class="key">Total Memory:</span>
        <span class="value">${formatBytes(info.MemTotal)}</span>
      </div>
      <div class="key-value">
        <span class="key">CPU Cores:</span>
        <span class="value">${info.NCPU || 'Unknown'}</span>
      </div>
      <div class="key-value">
        <span class="key">Operating System:</span>
        <span class="value">${info.OperatingSystem || 'Unknown'}</span>
      </div>
      <div class="key-value">
        <span class="key">Architecture:</span>
        <span class="value">${info.Architecture || 'Unknown'}</span>
      </div>
      <div class="key-value">
        <span class="key">Kernel Version:</span>
        <span class="value">${info.KernelVersion || 'Unknown'}</span>
      </div>
    `;
  }
}

// Images Functions
let allImages = []; // Store all images for filtering
let currentImageFilter = 'all'; // Current filter: 'all', 'used', 'unused'

function loadImages() {
  if (!window.activePeer) {
    return;
  }
  sendCommand('listImages');
}

function filterImages(filter) {
  currentImageFilter = filter;
  
  // Update active button
  document.querySelectorAll('.image-filter-btn').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.filter === filter) {
      btn.classList.add('active');
    }
  });
  
  // Re-render images with current filter
  renderImages(allImages);
}

function renderImages(images) {
  // Store all images
  allImages = images || [];
  
  // Calculate filter counts
  const usedCount = allImages.filter(image => image.usage && image.usage.length > 0).length;
  const unusedCount = allImages.filter(image => !image.usage || image.usage.length === 0).length;
  
  // Update filter badge counts
  const allCountEl = document.getElementById('filter-count-all');
  const usedCountEl = document.getElementById('filter-count-used');
  const unusedCountEl = document.getElementById('filter-count-unused');
  
  if (allCountEl) allCountEl.textContent = allImages.length;
  if (usedCountEl) usedCountEl.textContent = usedCount;
  if (unusedCountEl) unusedCountEl.textContent = unusedCount;
  
  // Filter images based on current filter
  let filteredImages = allImages;
  if (currentImageFilter === 'used') {
    filteredImages = allImages.filter(image => image.usage && image.usage.length > 0);
  } else if (currentImageFilter === 'unused') {
    filteredImages = allImages.filter(image => !image.usage || image.usage.length === 0);
  }
  
  const imagesList = document.getElementById('images-list');
  if (!imagesList) return;
  
  if (!filteredImages || filteredImages.length === 0) {
    const filterText = currentImageFilter === 'used' ? 'used' : currentImageFilter === 'unused' ? 'unused' : '';
    imagesList.innerHTML = `<tr><td colspan="8" class="text-center text-muted">No ${filterText} images found</td></tr>`;
    return;
  }
  
  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };
  
  imagesList.innerHTML = filteredImages.map(image => {
    const repoTag = image.RepoTags && image.RepoTags[0] ? image.RepoTags[0].split(':') : ['<none>', '<none>'];
    const repo = repoTag[0];
    const tag = repoTag[1];
    const imageId = image.Id.substring(7, 19);
    const size = formatBytes(image.Size);
    const created = image.Created ? new Date(image.Created * 1000).toLocaleDateString() : 'Unknown';
    const usage = image.usage ? image.usage.length : 0;
    
    return `
      <tr>
        <td>
          <input type="checkbox" class="image-checkbox" data-image-id="${image.Id}" onchange="updateBulkActionsImagesToolbar()">
        </td>
        <td>${repo}</td>
        <td><span class="badge bg-secondary">${tag}</span></td>
        <td><code>${imageId}</code></td>
        <td>${size}</td>
        <td>${created}</td>
        <td>${usage} container${usage !== 1 ? 's' : ''}</td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-info action-inspect-image" data-image-id="${image.Id}" title="Inspect">
              <i class="fas fa-info-circle"></i>
            </button>
            <button class="btn btn-outline-success action-tag-image" data-image-id="${image.Id}" title="Tag Image">
              <i class="fas fa-tag"></i>
            </button>
            <button class="btn btn-outline-danger action-remove-image" data-image-id="${image.Id}" title="Remove">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  // Add event listeners
  imagesList.querySelectorAll('.action-remove-image').forEach(btn => {
    btn.addEventListener('click', () => {
      const imageId = btn.dataset.imageId;
      showConfirmModal('Are you sure you want to remove this image?', () => {
        sendCommand('removeImage', { id: imageId, force: true });
        setTimeout(() => loadImages(), 1000);
      });
    });
  });

  imagesList.querySelectorAll('.action-tag-image').forEach(btn => {
    btn.addEventListener('click', async () => {
      const imageId = btn.dataset.imageId;
      const modal = new bootstrap.Modal(document.getElementById('tagImageModal'));
      const repoInput = document.getElementById('tag-repo');
      const tagInput = document.getElementById('tag-tag');
      const confirmBtn = document.getElementById('confirm-tag-btn');
      
      repoInput.value = '';
      tagInput.value = 'latest';
      
      // Remove old listeners
      if (confirmBtn && confirmBtn.parentNode) {
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        
        newConfirmBtn.addEventListener('click', async () => {
        const repo = repoInput.value.trim();
        if (repo) {
          const tag = tagInput.value.trim() || 'latest';
          
          modal.hide();
          showStatusIndicator(`Tagging image...`);
          sendCommand('tagImage', { id: imageId, repo, tag });
          
          try {
            const response = await waitForPeerResponse('Image tagged as');
            showAlert('success', response.message || 'Image tagged successfully');
            loadImages();
          } catch (error) {
            console.error('[ERROR] Failed to tag image:', error);
            showAlert('danger', error.message || 'Failed to tag image');
          } finally {
            hideStatusIndicator();
          }
        } else {
          showAlert('danger', 'Repository name is required');
        }
      });
      } else {
        console.warn('[WARNING] confirm-tag-btn not found in DOM, skipping listener setup');
      }
      
      modal.show();
    });
  });
  
  imagesList.querySelectorAll('.action-inspect-image').forEach(btn => {
    btn.addEventListener('click', () => {
      const imageId = btn.dataset.imageId;
      openImageInspectModal(imageId);
    });
  });
}

// Networks Functions
function loadNetworks() {
  if (!window.activePeer) {
    return;
  }
  sendCommand('listNetworks');
}

function renderNetworks(networks) {
  const networksList = document.getElementById('networks-list');
  if (!networksList) return;
  
  if (!networks || networks.length === 0) {
    networksList.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No networks found</td></tr>';
    return;
  }
  
  networksList.innerHTML = networks.map(network => {
    const subnet = network.IPAM?.Config?.[0]?.Subnet || '-';
    const gateway = network.IPAM?.Config?.[0]?.Gateway || '-';
    const usage = network.usage ? network.usage.length : 0;
    
    return `
      <tr>
        <td><strong>${network.Name}</strong></td>
        <td><span class="badge bg-info">${network.Driver}</span></td>
        <td>${network.Scope || 'local'}</td>
        <td><code>${subnet}</code></td>
        <td><code>${gateway}</code></td>
        <td>${usage} container${usage !== 1 ? 's' : ''}</td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-info action-inspect-network" data-network-id="${network.Id}" title="Inspect">
              <i class="fas fa-info-circle"></i>
            </button>
            <button class="btn btn-outline-success action-connect-network" data-network-id="${network.Id}" title="Connect Container">
              <i class="fas fa-plug"></i>
            </button>
            ${network.Name !== 'bridge' && network.Name !== 'host' && network.Name !== 'none' ? `
            <button class="btn btn-outline-danger action-remove-network" data-network-id="${network.Id}" title="Remove">
              <i class="fas fa-trash"></i>
            </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  // Add event listeners
  networksList.querySelectorAll('.action-remove-network').forEach(btn => {
    btn.addEventListener('click', () => {
      const networkId = btn.dataset.networkId;
      showConfirmModal('Are you sure you want to remove this network?', () => {
        sendCommand('removeNetwork', { id: networkId });
        setTimeout(() => loadNetworks(), 1000);
      });
    });
  });
  
  networksList.querySelectorAll('.action-inspect-network').forEach(btn => {
    btn.addEventListener('click', () => {
      const networkId = btn.dataset.networkId;
      openNetworkInspectModal(networkId);
    });
  });

  networksList.querySelectorAll('.action-connect-network').forEach(btn => {
    btn.addEventListener('click', async () => {
      const networkId = btn.dataset.networkId;
      const modal = new bootstrap.Modal(document.getElementById('connectNetworkModal'));
      const containerSelect = document.getElementById('connect-container-select');
      const confirmBtn = document.getElementById('confirm-connect-btn');
      
      // Store networkId for later use
      modal._networkId = networkId;
      
      // Get list of containers for selection
      sendCommand('listContainers');
      
      // Wait for containers list
      const originalHandler = window.handlePeerResponse;
      window.handlePeerResponse = async (response) => {
        if (response.type === 'containers' && response.data) {
          const containers = response.data;
          if (containers.length === 0) {
            showAlert('warning', 'No containers available to connect');
            if (typeof originalHandler === 'function') {
              window.handlePeerResponse = originalHandler;
            }
            return;
          }
          
          // Populate select dropdown
          containerSelect.innerHTML = '<option value="">Select a container...</option>';
          containers.forEach(container => {
            const name = container.Names[0]?.replace(/^\//, '') || container.Id.substring(0, 12);
            const option = document.createElement('option');
            option.value = container.Id;
            option.textContent = `${name} (${container.State})`;
            containerSelect.appendChild(option);
          });
          
          // Remove old listeners - re-query element to ensure it still exists in DOM
          const currentConfirmBtn = document.getElementById('confirm-connect-btn');
          if (currentConfirmBtn && currentConfirmBtn.parentNode) {
            const newConfirmBtn = currentConfirmBtn.cloneNode(true);
            currentConfirmBtn.parentNode.replaceChild(newConfirmBtn, currentConfirmBtn);
            
            newConfirmBtn.addEventListener('click', async () => {
            const containerId = containerSelect.value;
            if (containerId) {
              modal.hide();
              showStatusIndicator(`Connecting container to network...`);
              sendCommand('connectNetwork', { networkId: modal._networkId, containerId });
              
              try {
                const response = await waitForPeerResponse('Container connected to network');
                showAlert('success', response.message || 'Container connected to network');
                loadNetworks();
              } catch (error) {
                console.error('[ERROR] Failed to connect container:', error);
                showAlert('danger', error.message || 'Failed to connect container');
              } finally {
                hideStatusIndicator();
              }
            } else {
              showAlert('danger', 'Please select a container');
            }
          });
          } else {
            // Fallback: if element doesn't exist, add listener directly (shouldn't happen normally)
            console.warn('[WARNING] confirm-connect-btn not found in DOM, skipping listener setup');
          }
          
          modal.show();
          
          if (typeof originalHandler === 'function') {
            window.handlePeerResponse = originalHandler;
          }
        } else if (typeof originalHandler === 'function') {
          originalHandler(response);
        }
      };
    });
  });
}

// Volumes Functions
function loadStacks() {
  if (!window.activePeer) {
    console.warn('[WARN] No active peer connection');
    return;
  }
  sendCommand('listStacks');
}

function renderStacks(stacks) {
  const stacksListBody = document.getElementById('stacks-list-body');
  if (!stacksListBody) return;

  if (!stacks || stacks.length === 0) {
    stacksListBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No stacks found. Deploy a stack to get started.</td></tr>';
    return;
  }

  stacksListBody.innerHTML = stacks.map(stack => {
    const runningCount = stack.containers.filter(c => c.state === 'running').length;
    const totalCount = stack.containers.length;
    const statusClass = runningCount === totalCount && totalCount > 0 ? 'text-success' : 
                       runningCount > 0 ? 'text-warning' : 'text-danger';
    
    return `
      <tr>
        <td><strong>${stack.name}</strong></td>
        <td>${stack.services.join(', ')}</td>
        <td>${totalCount} container(s)</td>
        <td><span class="${statusClass}">${runningCount}/${totalCount} running</span></td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-info action-inspect-stack" data-stack-name="${stack.name}" title="Inspect">
              <i class="fas fa-info-circle"></i>
            </button>
            <button class="btn btn-outline-danger action-remove-stack" data-stack-name="${stack.name}" title="Remove Stack">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Add event listeners
  stacksListBody.querySelectorAll('.action-inspect-stack').forEach(btn => {
    btn.addEventListener('click', () => {
      const stackName = btn.dataset.stackName;
      openStackInspectModal(stackName);
    });
  });
  
  stacksListBody.querySelectorAll('.action-remove-stack').forEach(btn => {
    btn.addEventListener('click', async () => {
      const stackName = btn.dataset.stackName;
      let confirmed = false;
      await new Promise((resolve) => {
        showConfirmModal(`Remove stack "${stackName}"? This will remove all containers in the stack.`, () => {
          confirmed = true;
          resolve();
        });
        const modalEl = document.getElementById('confirmModal');
        if (modalEl) {
          modalEl.addEventListener('hidden.bs.modal', () => {
            if (!confirmed) resolve();
          }, { once: true });
        }
      });
      if (!confirmed) return;
      
      showStatusIndicator(`Removing stack "${stackName}"...`);
      sendCommand('removeStack', { stackName });
      
      try {
        const response = await waitForPeerResponse(`Stack "${stackName}" removed successfully`);
        showAlert('success', response.message);
        loadStacks();
      } catch (error) {
        console.error('[ERROR] Failed to remove stack:', error);
        showAlert('danger', error.message || 'Failed to remove stack');
      } finally {
        hideStatusIndicator();
      }
    });
  });
}

// Deploy stack handler
function setupDeployStackHandler() {
  const deployStackBtn = document.getElementById('deploy-stack-btn');
  const deployStackForm = document.getElementById('deploy-stack-form');
  
  if (deployStackBtn && deployStackForm) {
    deployStackBtn.addEventListener('click', async () => {
      const stackName = document.getElementById('stack-name').value.trim();
      const composeContent = document.getElementById('compose-content').value.trim();
      
      if (!stackName || !composeContent) {
        showAlert('danger', 'Stack name and compose content are required');
        return;
      }

      showStatusIndicator(`Deploying stack "${stackName}"...`);
      sendCommand('deployStack', { stackName, composeContent });

      try {
        const response = await waitForPeerResponse(`Stack "${stackName}" deployed successfully`);
        showAlert('success', response.message);
        
        // Close modal and reset form
        const modal = bootstrap.Modal.getInstance(document.getElementById('deploy-stack-modal'));
        if (modal) modal.hide();
        deployStackForm.reset();
        
        // Load stacks view
        navigateToView('stacks');
        loadStacks();
      } catch (error) {
        console.error('[ERROR] Failed to deploy stack:', error);
        showAlert('danger', error.message || 'Failed to deploy stack');
      } finally {
        hideStatusIndicator();
      }
    });
  }
}

// Subscription for volumes store to auto-update UI
let volumesStoreSubscription = null;

function loadVolumes() {
  if (!window.activePeer) {
    return;
  }
  
  // Set up subscription to auto-update UI when volumes change
  if (!volumesStoreSubscription) {
    volumesStoreSubscription = volumesStore.subscribe((volumes) => {
      // Only auto-update if we're on the volumes view
      if (currentView === 'volumes') {
        renderVolumes(volumes);
      }
    });
  }
  
  // Check cache first - if fresh, use it; otherwise load from server
  if (!volumesStore.isStale() && volumesStore.get().length > 0) {
    renderVolumes(volumesStore.get());
    return;
  }
  
  // Set loading state
  volumesStore.setLoading(true);
  sendCommand('listVolumes');
}

function renderVolumes(volumes) {
  // Note: Do not call volumesStore.set() here to avoid infinite loop
  // The store is already updated before calling renderVolumes() in the message handler
  const volumesList = document.getElementById('volumes-list');
  if (!volumesList) return;
  
  if (!volumes || volumes.length === 0) {
    volumesList.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No volumes found</td></tr>';
    return;
  }
  
  volumesList.innerHTML = volumes.map(volume => {
    const usage = volume.usage ? volume.usage.length : 0;
    
    return `
      <tr>
        <td><strong>${volume.Name}</strong></td>
        <td><span class="badge bg-info">${volume.Driver || 'local'}</span></td>
        <td><code>${volume.Mountpoint || '-'}</code></td>
        <td>${usage} container${usage !== 1 ? 's' : ''}</td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-info action-inspect-volume" data-volume-name="${volume.Name}" title="Inspect">
              <i class="fas fa-info-circle"></i>
            </button>
            <button class="btn btn-outline-danger action-remove-volume" data-volume-name="${volume.Name}" title="Remove">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  // Add event listeners
  volumesList.querySelectorAll('.action-remove-volume').forEach(btn => {
    btn.addEventListener('click', () => {
      const volumeName = btn.dataset.volumeName;
      showConfirmModal('Are you sure you want to remove this volume? This cannot be undone.', () => {
        // Set up response handler to refresh volumes list
        const originalHandler = window.handlePeerResponse;
        window.handlePeerResponse = (response) => {
          // Always call original handler first for volume broadcasts and other messages
          if (typeof originalHandler === 'function') {
            originalHandler(response);
          }
          
          // Handle remove volume success response
          if (response.success && response.message && response.message.includes('removed')) {
            showAlert('success', response.message);
            // Volumes will be updated via server broadcast, but refresh to be sure
            if (currentView === 'volumes') {
              loadVolumes();
            }
          } else if (response.error) {
            // Error is already handled by centralized handler in handlePeerData
            // But we can still show alert for immediate feedback
            const errorMsg = handleErrorResponse(response);
            if (errorMsg) {
              showAlert('danger', errorMsg);
            }
          }
          
          // Only reset handler if this was the remove volume response (not a broadcast)
          if (response.success && response.message && response.message.includes('removed')) {
            window.handlePeerResponse = originalHandler;
          }
        };
        
        sendCommand('removeVolume', { name: volumeName });
        
        // Reset handler after timeout as safety measure
        setTimeout(() => {
          if (window.handlePeerResponse !== originalHandler) {
            window.handlePeerResponse = originalHandler;
          }
        }, 30000);
      });
    });
  });
  
  volumesList.querySelectorAll('.action-inspect-volume').forEach(btn => {
    btn.addEventListener('click', () => {
      const volumeName = btn.dataset.volumeName;
      openVolumeInspectModal(volumeName);
    });
  });
}

// Modal Functions
function setupBuildImageHandler() {
  const buildImageBtn = document.getElementById('build-image-btn');
  const buildImageForm = document.getElementById('buildImageForm');
  
  if (buildImageBtn && buildImageForm) {
    buildImageBtn.addEventListener('click', async () => {
      const tag = document.getElementById('image-tag').value.trim();
      const dockerfile = document.getElementById('dockerfile-content').value.trim();
      
      if (!tag || !dockerfile) {
        showAlert('danger', 'Image tag and Dockerfile content are required');
        return;
      }

      showStatusIndicator(`Building image "${tag}"...`);
      sendCommand('buildImage', { tag, dockerfile });

      try {
        const response = await waitForPeerResponse('Image built successfully');
        showAlert('success', response.message || 'Image built successfully');
        
        // Close modal and reset form
        const modal = bootstrap.Modal.getInstance(document.getElementById('buildImageModal'));
        if (modal) modal.hide();
        buildImageForm.reset();
        
        // Refresh images list
        sendCommand('listImages');
      } catch (error) {
        console.error('[ERROR] Failed to build image:', error);
        showAlert('danger', error.message || 'Failed to build image');
      } finally {
        hideStatusIndicator();
      }
    });
  }
}

function pullImage() {
  const imageName = document.getElementById('pull-image-name')?.value?.trim();
  if (!imageName) {
    showAlert('danger', 'Please enter an image name');
    return;
  }
  
  const modal = bootstrap.Modal.getInstance(document.getElementById('pullImageModal'));
  if (modal) modal.hide();
  
  showStatusIndicator(`Pulling image "${imageName}"...`);
  sendCommand('pullImage', { image: imageName });
  
  // Wait for response
  const originalHandler = window.handlePeerResponse;
  window.handlePeerResponse = (response) => {
    if (response.success && response.message && response.message.includes('pulled successfully')) {
      hideStatusIndicator();
      showAlert('success', response.message);
      loadImages();
      if (currentView === 'dashboard') {
        sendCommand('listImages');
      }
    } else if (response.error) {
      hideStatusIndicator();
      // Error is already handled by centralized handler in handlePeerData
      // But we can still show alert for immediate feedback
      const errorMsg = handleErrorResponse(response);
      if (errorMsg) {
        showAlert('danger', errorMsg);
      }
    }
    if (typeof originalHandler === 'function') {
      originalHandler(response);
    }
    window.handlePeerResponse = originalHandler;
  };
  
  setTimeout(() => {
    if (window.handlePeerResponse === originalHandler) {
      window.handlePeerResponse = originalHandler;
    }
  }, 300000); // 5 minute timeout
}

function createNetwork() {
  const name = document.getElementById('network-name')?.value?.trim();
  if (!name) {
    showAlert('danger', 'Please enter a network name');
    return;
  }
  
  const driver = document.getElementById('network-driver')?.value || 'bridge';
  const subnet = document.getElementById('network-subnet')?.value?.trim() || null;
  
  const modal = bootstrap.Modal.getInstance(document.getElementById('createNetworkModal'));
  if (modal) modal.hide();
  
  showStatusIndicator(`Creating network "${name}"...`);
  sendCommand('createNetwork', { name, driver, subnet });
  
  // Wait for response
  const originalHandler = window.handlePeerResponse;
  window.handlePeerResponse = (response) => {
    if (response.success && response.message && response.message.includes('created successfully')) {
      hideStatusIndicator();
      showAlert('success', response.message);
      loadNetworks();
      if (currentView === 'dashboard') {
        sendCommand('listNetworks');
      }
      // Reset form
      document.getElementById('create-network-form')?.reset();
    } else if (response.error) {
      hideStatusIndicator();
      // Error is already handled by centralized handler in handlePeerData
      // But we can still show alert for immediate feedback
      const errorMsg = handleErrorResponse(response);
      if (errorMsg) {
        showAlert('danger', errorMsg);
      }
    }
    if (typeof originalHandler === 'function') {
      originalHandler(response);
    }
    window.handlePeerResponse = originalHandler;
  };
  
  setTimeout(() => {
    if (window.handlePeerResponse === originalHandler) {
      window.handlePeerResponse = originalHandler;
    }
  }, 30000);
}

function createVolume() {
  const name = document.getElementById('volume-name')?.value?.trim();
  if (!name) {
    showAlert('danger', 'Please enter a volume name');
    return;
  }
  
  const driver = document.getElementById('volume-driver')?.value?.trim() || null;
  
  const modal = bootstrap.Modal.getInstance(document.getElementById('createVolumeModal'));
  if (modal) modal.hide();
  
  showStatusIndicator(`Creating volume "${name}"...`);
  sendCommand('createVolume', { name, driver });
  
  // Store the volume name being created for later matching
  const volumeNameBeingCreated = name;
  let volumeCreated = false;
  
  // Wait for response
  const originalHandler = window.handlePeerResponse;
  window.handlePeerResponse = (response) => {
    // Always call original handler first for volume broadcasts and other messages
    if (typeof originalHandler === 'function') {
      originalHandler(response);
    }
    
    // Check if volume was already created to avoid duplicate processing
    if (volumeCreated) {
      return;
    }
    
    // Handle create volume success response - more flexible condition
    const isDirectSuccess = response.success && 
                            response.message && 
                            (response.message.includes('created successfully') || 
                             response.message.includes('created'));
    
    // Check if volumes broadcast includes the newly created volume
    let isVolumeInBroadcast = false;
    if (response.type === 'volumes' || (response.success && (response.data || response.volumes))) {
      const volumesArray = response.data || response.volumes || [];
      if (Array.isArray(volumesArray)) {
        isVolumeInBroadcast = volumesArray.some(vol => {
          const volName = typeof vol === 'string' ? vol : (vol.Name || vol.name || '');
          return volName === volumeNameBeingCreated;
        });
      }
    }
    
    // Handle success (either direct response or volumes broadcast with new volume)
    if (isDirectSuccess || isVolumeInBroadcast) {
      volumeCreated = true;
      hideStatusIndicator();
      
      if (isDirectSuccess && response.message) {
        showAlert('success', response.message);
      } else if (isVolumeInBroadcast) {
        showAlert('success', `Volume "${volumeNameBeingCreated}" created successfully`);
      }
      
      // Volumes will be updated via server broadcast, but refresh to be sure
      loadVolumes();
      // Reset form
      document.getElementById('create-volume-form')?.reset();
      
      // Reset handler since we've handled the response
      window.handlePeerResponse = originalHandler;
    } else if (response.error) {
      hideStatusIndicator();
      // Error is already handled by centralized handler in handlePeerData
      // But we can still show alert for immediate feedback
      const errorMsg = handleErrorResponse(response);
      if (errorMsg) {
        showAlert('danger', errorMsg);
      }
      // Reset handler on error
      window.handlePeerResponse = originalHandler;
    }
  };
  
  // Safety timeout - hide spinner and reset handler if no response received
  setTimeout(() => {
    if (!volumeCreated && window.handlePeerResponse !== originalHandler) {
      console.warn(`[WARN] Volume creation timeout for "${volumeNameBeingCreated}" - hiding spinner as safety measure`);
      hideStatusIndicator();
      window.handlePeerResponse = originalHandler;
    }
  }, 30000);
}

// Container Details Functions
let currentContainerDetails = null;

function showContainerDetails(container) {
  currentContainerDetails = container;
  navigateToView('container-details');
  
  // Update title
  const titleEl = document.getElementById('container-details-title');
  if (titleEl) {
    const name = container.Names[0]?.replace(/^\//, '') || container.Id.substring(0, 12);
    titleEl.innerHTML = `<i class="fas fa-box me-2"></i>${name}`;
  }
  
  // Load container config
  sendCommand('inspectContainer', { id: container.Id });
  
  // Set up callback for container config
  window.inspectContainerCallback = (config) => {
    populateContainerDetails(config, container);
    window.inspectContainerCallback = null;
  };
  
  // Switch to overview tab
  const overviewTab = document.getElementById('overview-tab');
  if (overviewTab) {
    const tab = new bootstrap.Tab(overviewTab);
    tab.show();
  }
}

// Copy to clipboard utility
function copyToClipboard(text, buttonElement) {
  navigator.clipboard.writeText(text).then(() => {
    const originalHTML = buttonElement.innerHTML;
    buttonElement.innerHTML = '<i class="fas fa-check"></i> Copied!';
    buttonElement.style.background = 'var(--accent-success)';
    buttonElement.style.borderColor = 'var(--accent-success)';
    setTimeout(() => {
      buttonElement.innerHTML = originalHTML;
      buttonElement.style.background = '';
      buttonElement.style.borderColor = '';
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy:', err);
    showAlert('danger', 'Failed to copy to clipboard');
  });
}

// Format relative time
function formatRelativeTime(dateString) {
  if (!dateString || dateString === 'Unknown' || dateString === 'Not started') return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffSecs < 60) return `${diffSecs} second${diffSecs !== 1 ? 's' : ''} ago`;
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) !== 1 ? 's' : ''} ago`;
}

function populateContainerDetails(config, container) {
  if (!config) return;
  
  // Overview Tab
  populateOverviewTab(config, container);
  
  // Configuration Tab
  populateConfigTab(config);
  
  // Networking Tab
  populateNetworkingTab(config);
  
  // Stats Tab - will be updated by stats updates
  updateContainerDetailsStats(container);
  
  // Attach copy button event listeners after content is populated
  setTimeout(() => {
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const textToCopy = this.getAttribute('data-copy');
        if (textToCopy) {
          copyToClipboard(textToCopy, this);
        }
      });
    });
  }, 100);
}

function populateOverviewTab(config, container) {
  const content = document.getElementById('container-overview-content');
  if (!content) return;
  
  const name = config.Name?.replace(/^\//, '') || 'Unknown';
  const image = config.Config?.Image || 'Unknown';
  const state = config.State?.Status || 'Unknown';
  const created = config.Created ? new Date(config.Created).toLocaleString() : 'Unknown';
  const createdRelative = config.Created ? formatRelativeTime(config.Created) : '';
  const started = config.State?.StartedAt ? new Date(config.State.StartedAt).toLocaleString() : 'Not started';
  const startedRelative = config.State?.StartedAt ? formatRelativeTime(config.State.StartedAt) : '';
  const id = config.Id || 'Unknown';
  const fullId = id;
  const shortId = id.substring(0, 12);
  const restartCount = config.RestartCount || 0;
  
  // Get IP address
  let ipAddress = 'No IP Assigned';
  let primaryNetwork = null;
  if (config.NetworkSettings && config.NetworkSettings.Networks) {
    const networks = Object.values(config.NetworkSettings.Networks);
    if (networks.length > 0 && networks[0].IPAddress) {
      ipAddress = networks[0].IPAddress;
      primaryNetwork = networks[0];
    }
  }
  
  // Status badge class
  const statusBadgeClass = state === 'running' ? 'status-running' : 
                           state === 'paused' ? 'status-paused' :
                           state === 'restarting' ? 'status-restarting' : 'status-exited';
  
  // Status icon
  const statusIcon = state === 'running' ? 'fa-circle-check' :
                     state === 'paused' ? 'fa-pause-circle' :
                     state === 'restarting' ? 'fa-sync-alt' : 'fa-stop-circle';
  
  content.innerHTML = `
    <!-- Basic Information Section -->
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-info-circle"></i>
        <h3 class="detail-section-title">Basic Information</h3>
      </div>
      <div class="detail-info-grid">
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-tag"></i>
            Container Name
          </div>
          <div class="detail-info-value">${name}</div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-fingerprint"></i>
            Container ID
          </div>
          <div class="detail-info-value">
            <code>${shortId}</code>
            <button class="copy-btn" data-copy="${fullId}" title="Copy full ID">
              <i class="fas fa-copy"></i>
            </button>
          </div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-box"></i>
            Image
          </div>
          <div class="detail-info-value">${image}</div>
        </div>
      </div>
    </div>

    <!-- Status & Health Section -->
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-heartbeat"></i>
        <h3 class="detail-section-title">Status & Health</h3>
      </div>
      <div class="detail-info-grid">
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-circle"></i>
            Status
          </div>
          <div class="detail-info-value">
            <span class="detail-badge ${statusBadgeClass}">
              <i class="fas ${statusIcon}"></i>
              ${state}
            </span>
          </div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-redo"></i>
            Restart Count
          </div>
          <div class="detail-info-value">
            <div class="detail-stat-card" style="padding: var(--spacing-sm); margin-top: var(--spacing-xs);">
              <div class="detail-stat-icon" style="background: rgba(45, 212, 191, 0.2); color: var(--accent-primary);">
                <i class="fas fa-redo"></i>
              </div>
              <div class="detail-stat-content">
                <div class="detail-stat-value">${restartCount}</div>
                <div class="detail-stat-label">Restarts</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Network Information Section -->
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-network-wired"></i>
        <h3 class="detail-section-title">Network Information</h3>
      </div>
      <div class="detail-info-grid">
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-ip-address"></i>
            IP Address
          </div>
          <div class="detail-info-value">
            ${ipAddress !== 'No IP Assigned' ? `
              <code>${ipAddress}</code>
              <button class="copy-btn" data-copy="${ipAddress}" title="Copy IP address">
                <i class="fas fa-copy"></i>
              </button>
            ` : '<span style="color: var(--text-muted);">No IP Assigned</span>'}
          </div>
        </div>
        ${primaryNetwork && primaryNetwork.Gateway ? `
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-network-wired"></i>
            Gateway
          </div>
          <div class="detail-info-value"><code>${primaryNetwork.Gateway}</code></div>
        </div>
        ` : ''}
        ${primaryNetwork && primaryNetwork.MacAddress ? `
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-ethernet"></i>
            MAC Address
          </div>
          <div class="detail-info-value"><code>${primaryNetwork.MacAddress}</code></div>
        </div>
        ` : ''}
      </div>
    </div>

    <!-- Timeline Section -->
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-clock"></i>
        <h3 class="detail-section-title">Timeline</h3>
      </div>
      <div class="detail-info-grid">
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-calendar-plus"></i>
            Created
          </div>
          <div class="detail-info-value">
            ${created}
            ${createdRelative ? `<div class="relative-time">${createdRelative}</div>` : ''}
          </div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-play-circle"></i>
            Started
          </div>
          <div class="detail-info-value">
            ${started}
            ${startedRelative ? `<div class="relative-time">${startedRelative}</div>` : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

function populateConfigTab(config) {
  const content = document.getElementById('container-config-content');
  if (!content) return;
  
  const cmd = config.Config?.Cmd || [];
  const entrypoint = config.Config?.Entrypoint || [];
  const workingDir = config.Config?.WorkingDir || '';
  const user = config.Config?.User || '';
  const env = config.Config?.Env || [];
  const exposedPorts = config.Config?.ExposedPorts ? Object.keys(config.Config.ExposedPorts) : [];
  const labels = config.Config?.Labels || {};
  const hostname = config.Config?.Hostname || '';
  const domainname = config.Config?.Domainname || '';
  const tty = config.Config?.Tty || false;
  const openStdin = config.Config?.OpenStdin || false;
  
  // Format command and entrypoint
  const cmdStr = cmd.length > 0 ? cmd.join(' ') : null;
  const entrypointStr = entrypoint.length > 0 ? entrypoint.join(' ') : null;
  
  // Parse environment variables into key-value pairs
  const envVars = env.map(e => {
    const idx = e.indexOf('=');
    if (idx === -1) return { key: e, value: '' };
    return { key: e.substring(0, idx), value: e.substring(idx + 1) };
  });
  
  content.innerHTML = `
    <!-- Command & Entrypoint Section -->
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-terminal"></i>
        <h3 class="detail-section-title">Command & Entrypoint</h3>
      </div>
      <div class="detail-info-grid">
        <div class="detail-info-item" style="grid-column: 1 / -1;">
          <div class="detail-info-label">
            <i class="fas fa-play"></i>
            Command
          </div>
          ${cmdStr ? `
            <div class="detail-code-block">
              <pre><code>${cmdStr}</code></pre>
              <button class="copy-btn" data-copy="${cmdStr}" title="Copy command" style="position: absolute; top: var(--spacing-sm); right: var(--spacing-sm);">
                <i class="fas fa-copy"></i>
              </button>
            </div>
          ` : `
            <div class="empty-state" style="padding: var(--spacing-md); text-align: left;">
              <span style="color: var(--text-muted);">Not set</span>
            </div>
          `}
        </div>
        <div class="detail-info-item" style="grid-column: 1 / -1;">
          <div class="detail-info-label">
            <i class="fas fa-sign-in-alt"></i>
            Entrypoint
          </div>
          ${entrypointStr ? `
            <div class="detail-code-block">
              <pre><code>${entrypointStr}</code></pre>
              <button class="copy-btn" data-copy="${entrypointStr}" title="Copy entrypoint" style="position: absolute; top: var(--spacing-sm); right: var(--spacing-sm);">
                <i class="fas fa-copy"></i>
              </button>
            </div>
          ` : `
            <div class="empty-state" style="padding: var(--spacing-md); text-align: left;">
              <span style="color: var(--text-muted);">Not set</span>
            </div>
          `}
        </div>
      </div>
    </div>

    <!-- Runtime Settings Section -->
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-cog"></i>
        <h3 class="detail-section-title">Runtime Settings</h3>
      </div>
      <div class="detail-info-grid">
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-folder"></i>
            Working Directory
          </div>
          <div class="detail-info-value">
            ${workingDir ? `<code>${workingDir}</code>` : '<span style="color: var(--text-muted);">Not set</span>'}
          </div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-user"></i>
            User
          </div>
          <div class="detail-info-value">${user || '<span style="color: var(--text-muted);">Default</span>'}</div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-server"></i>
            Hostname
          </div>
          <div class="detail-info-value">
            ${hostname ? `<code>${hostname}</code>` : '<span style="color: var(--text-muted);">Not set</span>'}
          </div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-globe"></i>
            Domain Name
          </div>
          <div class="detail-info-value">
            ${domainname ? `<code>${domainname}</code>` : '<span style="color: var(--text-muted);">Not set</span>'}
          </div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-toggle-on"></i>
            TTY
          </div>
          <div class="detail-info-value">
            <span class="detail-badge ${tty ? 'status-running' : 'status-exited'}">
              ${tty ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-keyboard"></i>
            Open STDIN
          </div>
          <div class="detail-info-value">
            <span class="detail-badge ${openStdin ? 'status-running' : 'status-exited'}">
              ${openStdin ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Environment Variables Section -->
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-list"></i>
        <h3 class="detail-section-title">Environment Variables</h3>
      </div>
      ${envVars.length > 0 ? `
        <div style="overflow-x: auto;">
          <table class="detail-env-table">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Value</th>
                <th style="width: 80px;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${envVars.map(envVar => `
                <tr>
                  <td><code>${envVar.key}</code></td>
                  <td><code>${envVar.value || '<span style="color: var(--text-muted);">(empty)</span>'}</code></td>
                  <td>
                    <button class="copy-btn" data-copy="${envVar.key}=${envVar.value}" title="Copy variable">
                      <i class="fas fa-copy"></i>
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `
        <div class="empty-state">
          <i class="fas fa-inbox"></i>
          <div>No environment variables set</div>
        </div>
      `}
    </div>

    <!-- Exposed Ports Section -->
    ${exposedPorts.length > 0 ? `
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-plug"></i>
        <h3 class="detail-section-title">Exposed Ports</h3>
      </div>
      <div class="detail-info-grid">
        ${exposedPorts.map(port => {
          const [portNum, protocol] = port.split('/');
          return `
            <div class="detail-info-item">
              <div class="detail-info-value">
                <span class="protocol-badge ${protocol || 'tcp'}">${protocol || 'tcp'}</span>
                <code style="margin-left: var(--spacing-sm);">${portNum}</code>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
    ` : ''}

    <!-- Labels Section -->
    ${Object.keys(labels).length > 0 ? `
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-tags"></i>
        <h3 class="detail-section-title">Labels</h3>
      </div>
      <div style="overflow-x: auto;">
        <table class="detail-env-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th style="width: 80px;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${Object.entries(labels).map(([key, value]) => `
              <tr>
                <td><code>${key}</code></td>
                <td><code>${value}</code></td>
                <td>
                  <button class="copy-btn" data-copy="${key}=${value}" title="Copy label">
                    <i class="fas fa-copy"></i>
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}
  `;
}

function populateNetworkingTab(config) {
  const content = document.getElementById('container-networking-content');
  if (!content) return;
  
  const networkMode = config.HostConfig?.NetworkMode || 'default';
  const networks = config.NetworkSettings?.Networks || {};
  const ports = config.NetworkSettings?.Ports || {};
  const dns = config.HostConfig?.Dns || [];
  const extraHosts = config.HostConfig?.ExtraHosts || [];
  const links = config.HostConfig?.Links || [];
  
  // Format port bindings with detailed info
  const portBindings = [];
  if (ports) {
    Object.keys(ports).forEach(port => {
      const [portNum, protocol] = port.split('/');
      const bindings = ports[port];
      if (bindings && bindings.length > 0) {
        bindings.forEach(binding => {
          portBindings.push({
            containerPort: portNum,
            protocol: protocol || 'tcp',
            hostIp: binding.HostIp || '0.0.0.0',
            hostPort: binding.HostPort,
            display: `${binding.HostIp || '0.0.0.0'}:${binding.HostPort} → ${portNum}/${protocol || 'tcp'}`
          });
        });
      } else {
        // Exposed but not bound
        portBindings.push({
          containerPort: portNum,
          protocol: protocol || 'tcp',
          hostIp: null,
          hostPort: null,
          display: `${portNum}/${protocol || 'tcp'} (exposed, not bound)`
        });
      }
    });
  }
  
  // Network cards data
  const networkCards = [];
  Object.keys(networks).forEach(netName => {
    const net = networks[netName];
    networkCards.push({
      name: netName,
      ipAddress: net.IPAddress || 'Not assigned',
      gateway: net.Gateway || 'Not set',
      macAddress: net.MacAddress || 'Not set',
      networkId: net.NetworkID || 'Not set',
      endpointId: net.EndpointID || 'Not set',
      ipPrefixLen: net.IPPrefixLen || null,
      globalIPv6Address: net.GlobalIPv6Address || null,
      globalIPv6PrefixLen: net.GlobalIPv6PrefixLen || null,
      ipv6Gateway: net.IPv6Gateway || null
    });
  });
  
  content.innerHTML = `
    <!-- Network Mode Section -->
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-network-wired"></i>
        <h3 class="detail-section-title">Network Mode</h3>
      </div>
      <div class="detail-info-grid">
        <div class="detail-info-item">
          <div class="detail-info-label">
            <i class="fas fa-sitemap"></i>
            Mode
          </div>
          <div class="detail-info-value">
            <span class="detail-badge status-running">
              <i class="fas fa-network-wired"></i>
              ${networkMode}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Networks Section -->
    ${networkCards.length > 0 ? `
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-project-diagram"></i>
        <h3 class="detail-section-title">Connected Networks</h3>
      </div>
      ${networkCards.map(net => `
        <div class="network-card">
          <div class="network-card-header">
            <div class="network-card-title">
              <i class="fas fa-network-wired"></i>
              ${net.name}
            </div>
          </div>
          <div class="detail-info-grid">
            <div class="detail-info-item">
              <div class="detail-info-label">
                <i class="fas fa-ip-address"></i>
                IP Address
              </div>
              <div class="detail-info-value">
                ${net.ipAddress !== 'Not assigned' ? `
                  <code>${net.ipAddress}</code>
                  ${net.ipPrefixLen ? `<span style="color: var(--text-muted); margin-left: var(--spacing-xs);">/${net.ipPrefixLen}</span>` : ''}
                  <button class="copy-btn" data-copy="${net.ipAddress}" title="Copy IP address">
                    <i class="fas fa-copy"></i>
                  </button>
                ` : '<span style="color: var(--text-muted);">Not assigned</span>'}
              </div>
            </div>
            <div class="detail-info-item">
              <div class="detail-info-label">
                <i class="fas fa-route"></i>
                Gateway
              </div>
              <div class="detail-info-value">
                ${net.gateway !== 'Not set' ? `<code>${net.gateway}</code>` : '<span style="color: var(--text-muted);">Not set</span>'}
              </div>
            </div>
            <div class="detail-info-item">
              <div class="detail-info-label">
                <i class="fas fa-ethernet"></i>
                MAC Address
              </div>
              <div class="detail-info-value">
                ${net.macAddress !== 'Not set' ? `<code>${net.macAddress}</code>` : '<span style="color: var(--text-muted);">Not set</span>'}
              </div>
            </div>
            ${net.globalIPv6Address ? `
            <div class="detail-info-item">
              <div class="detail-info-label">
                <i class="fas fa-ip-address"></i>
                IPv6 Address
              </div>
              <div class="detail-info-value">
                <code>${net.globalIPv6Address}</code>
                ${net.globalIPv6PrefixLen ? `<span style="color: var(--text-muted); margin-left: var(--spacing-xs);">/${net.globalIPv6PrefixLen}</span>` : ''}
                <button class="copy-btn" data-copy="${net.globalIPv6Address}" title="Copy IPv6 address">
                  <i class="fas fa-copy"></i>
                </button>
              </div>
            </div>
            ` : ''}
            ${net.ipv6Gateway ? `
            <div class="detail-info-item">
              <div class="detail-info-label">
                <i class="fas fa-route"></i>
                IPv6 Gateway
              </div>
              <div class="detail-info-value"><code>${net.ipv6Gateway}</code></div>
            </div>
            ` : ''}
            ${net.networkId && net.networkId !== 'Not set' ? `
            <div class="detail-info-item">
              <div class="detail-info-label">
                <i class="fas fa-fingerprint"></i>
                Network ID
              </div>
              <div class="detail-info-value">
                <code style="font-size: 0.75rem;">${net.networkId.length > 12 ? net.networkId.substring(0, 12) + '...' : net.networkId}</code>
                <button class="copy-btn" data-copy="${net.networkId}" title="Copy network ID">
                  <i class="fas fa-copy"></i>
                </button>
              </div>
            </div>
            ` : ''}
            ${net.endpointId && net.endpointId !== 'Not set' ? `
            <div class="detail-info-item">
              <div class="detail-info-label">
                <i class="fas fa-link"></i>
                Endpoint ID
              </div>
              <div class="detail-info-value">
                <code style="font-size: 0.75rem;">${net.endpointId.length > 12 ? net.endpointId.substring(0, 12) + '...' : net.endpointId}</code>
                <button class="copy-btn" data-copy="${net.endpointId}" title="Copy endpoint ID">
                  <i class="fas fa-copy"></i>
                </button>
              </div>
            </div>
            ` : ''}
          </div>
        </div>
      `).join('')}
    </div>
    ` : `
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-project-diagram"></i>
        <h3 class="detail-section-title">Connected Networks</h3>
      </div>
      <div class="empty-state">
        <i class="fas fa-network-wired"></i>
        <div>No networks connected</div>
      </div>
    </div>
    `}

    <!-- Port Mappings Section -->
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-plug"></i>
        <h3 class="detail-section-title">Port Mappings</h3>
      </div>
      ${portBindings.length > 0 ? `
        <div style="overflow-x: auto;">
          <table class="port-mapping-table">
            <thead>
              <tr>
                <th>Host IP</th>
                <th>Host Port</th>
                <th>Container Port</th>
                <th>Protocol</th>
                <th style="width: 80px;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${portBindings.map(binding => `
                <tr>
                  <td>${binding.hostIp ? `<code>${binding.hostIp}</code>` : '<span style="color: var(--text-muted);">-</span>'}</td>
                  <td>${binding.hostPort ? `<code>${binding.hostPort}</code>` : '<span style="color: var(--text-muted);">-</span>'}</td>
                  <td><code>${binding.containerPort}</code></td>
                  <td><span class="protocol-badge ${binding.protocol}">${binding.protocol}</span></td>
                  <td>
                    ${binding.hostPort ? `
                      <button class="copy-btn" data-copy="${binding.hostIp || '0.0.0.0'}:${binding.hostPort}" title="Copy host address">
                        <i class="fas fa-copy"></i>
                      </button>
                    ` : '<span style="color: var(--text-muted);">-</span>'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `
        <div class="empty-state">
          <i class="fas fa-plug"></i>
          <div>No port mappings configured</div>
        </div>
      `}
    </div>

    <!-- DNS Configuration Section -->
    ${dns.length > 0 ? `
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-server"></i>
        <h3 class="detail-section-title">DNS Servers</h3>
      </div>
      <div class="detail-info-grid">
        ${dns.map(dnsServer => `
          <div class="detail-info-item">
            <div class="detail-info-value">
              <i class="fas fa-server" style="color: var(--accent-info); margin-right: var(--spacing-xs);"></i>
              <code>${dnsServer}</code>
              <button class="copy-btn" data-copy="${dnsServer}" title="Copy DNS server">
                <i class="fas fa-copy"></i>
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    <!-- Extra Hosts Section -->
    ${extraHosts.length > 0 ? `
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-list"></i>
        <h3 class="detail-section-title">Extra Hosts</h3>
      </div>
      <div style="overflow-x: auto;">
        <table class="detail-env-table">
          <thead>
            <tr>
              <th>Hostname</th>
              <th>IP Address</th>
              <th style="width: 80px;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${extraHosts.map(host => {
              const [hostname, ip] = host.split(':');
              return `
                <tr>
                  <td><code>${hostname}</code></td>
                  <td><code>${ip}</code></td>
                  <td>
                    <button class="copy-btn" data-copy="${host}" title="Copy host entry">
                      <i class="fas fa-copy"></i>
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <!-- Container Links Section -->
    ${links.length > 0 ? `
    <div class="detail-section-card">
      <div class="detail-section-header">
        <i class="fas fa-link"></i>
        <h3 class="detail-section-title">Container Links</h3>
      </div>
      <div class="detail-info-grid">
        ${links.map(link => `
          <div class="detail-info-item">
            <div class="detail-info-value">
              <i class="fas fa-link" style="color: var(--accent-primary); margin-right: var(--spacing-xs);"></i>
              <code>${link}</code>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}
  `;
}

let cpuChart = null;
let memoryChart = null;

function updateContainerDetailsStats(container) {
  // This will be called by the stats update function
  // For now, just show current stats if available
  if (smoothedStats[container.Id]) {
    const stats = smoothedStats[container.Id];
    const cpuEl = document.getElementById('detail-cpu');
    const memoryEl = document.getElementById('detail-memory');
    
    if (cpuEl) cpuEl.textContent = `${stats.cpu.toFixed(2)}%`;
    if (memoryEl) memoryEl.textContent = `${(stats.memory / (1024 * 1024)).toFixed(2)} MB`;
  }
  
  // Initialize charts
  updateStatsCharts(container.Id);
}

function updateStatsCharts(containerId) {
  if (!historicalStats[containerId] || historicalStats[containerId].timestamps.length === 0) {
    return;
  }
  
  const history = historicalStats[containerId];
  const container = document.getElementById('stats-charts-container');
  if (!container) return;
  
  // Format timestamps for display
  const labels = history.timestamps.map(ts => {
    const date = new Date(ts);
    return `${date.getMinutes()}:${date.getSeconds().toString().padStart(2, '0')}`;
  });
  
  // Create or update CPU chart
  const cpuCtx = document.getElementById('cpu-chart-canvas');
  if (!cpuCtx) {
    // Create canvas if it doesn't exist
    container.innerHTML = `
      <div class="row g-3">
        <div class="col-12">
          <h6 class="mb-3">CPU Usage</h6>
          <div class="chart-wrapper" style="height: 250px; position: relative;">
            <canvas id="cpu-chart-canvas"></canvas>
          </div>
        </div>
        <div class="col-12">
          <h6 class="mb-3">Memory Usage</h6>
          <div class="chart-wrapper" style="height: 250px; position: relative;">
            <canvas id="memory-chart-canvas"></canvas>
          </div>
        </div>
      </div>
    `;
  }
  
  const cpuCanvas = document.getElementById('cpu-chart-canvas');
  const memoryCanvas = document.getElementById('memory-chart-canvas');
  
  if (cpuCanvas && typeof Chart !== 'undefined') {
    if (!cpuChart) {
      cpuChart = new Chart(cpuCanvas, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: 'CPU %',
            data: history.cpu,
            borderColor: 'rgb(16, 185, 129)',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            tension: 0.4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              max: 100,
              ticks: {
                color: 'rgba(255, 255, 255, 0.7)'
              },
              grid: {
                color: 'rgba(255, 255, 255, 0.1)'
              }
            },
            x: {
              ticks: {
                color: 'rgba(255, 255, 255, 0.7)'
              },
              grid: {
                color: 'rgba(255, 255, 255, 0.1)'
              }
            }
          }
        }
      });
    } else {
      cpuChart.data.labels = labels;
      cpuChart.data.datasets[0].data = history.cpu;
      cpuChart.update('none');
    }
  }
  
  if (memoryCanvas && typeof Chart !== 'undefined') {
    // Convert memory to MB
    const memoryMB = history.memory.map(m => m / (1024 * 1024));
    
    if (!memoryChart) {
      memoryChart = new Chart(memoryCanvas, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: 'Memory (MB)',
            data: memoryMB,
            borderColor: 'rgb(59, 130, 246)',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            tension: 0.4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                color: 'rgba(255, 255, 255, 0.7)'
              },
              grid: {
                color: 'rgba(255, 255, 255, 0.1)'
              }
            },
            x: {
              ticks: {
                color: 'rgba(255, 255, 255, 0.7)'
              },
              grid: {
                color: 'rgba(255, 255, 255, 0.1)'
              }
            }
          }
        }
      });
    } else {
      memoryChart.data.labels = labels;
      memoryChart.data.datasets[0].data = memoryMB;
      memoryChart.update('none');
    }
  }
}

// Logs state management
let logsState = {
  paused: false,
  autoScroll: true,
  currentFilter: 'all',
  searchTerm: '',
  allLogs: []
};

// Detect log level from log line
function detectLogLevel(line) {
  const lowerLine = line.toLowerCase();
  if (lowerLine.includes('error') || lowerLine.includes('exception') || lowerLine.includes('fatal')) {
    return 'error';
  } else if (lowerLine.includes('warn') || lowerLine.includes('warning')) {
    return 'warn';
  } else if (lowerLine.includes('debug')) {
    return 'debug';
  } else if (lowerLine.includes('info')) {
    return 'info';
  }
  return null;
}

// Format log line with timestamp and level detection
function formatLogLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return null;
  
  const level = detectLogLevel(line);
  const timestamp = new Date().toISOString();
  
  // Try to extract timestamp from log if it exists (common formats)
  let logTimestamp = null;
  const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?)/);
  if (timestampMatch) {
    logTimestamp = timestampMatch[1];
  }
  
  return {
    raw: line,
    level: level,
    timestamp: logTimestamp || timestamp,
    formatted: line
  };
}

// Apply filters and search to logs
function applyLogFilters() {
  const logsContent = document.getElementById('container-logs-content');
  if (!logsContent) return;
  
  const logLines = logsContent.querySelectorAll('.log-line');
  let visibleCount = 0;
  
  logLines.forEach(line => {
    const logData = line.dataset;
    let shouldShow = true;
    
    // Apply level filter
    if (logsState.currentFilter !== 'all') {
      const lineLevel = logData.level || '';
      if (lineLevel !== logsState.currentFilter) {
        shouldShow = false;
      }
    }
    
    // Apply search filter
    if (shouldShow && logsState.searchTerm) {
      const searchLower = logsState.searchTerm.toLowerCase();
      const lineText = line.textContent.toLowerCase();
      if (!lineText.includes(searchLower)) {
        shouldShow = false;
      } else {
        // Highlight search matches
        highlightSearchMatches(line);
      }
    } else {
      // Remove highlight if no search
      removeSearchHighlights(line);
    }
    
    if (shouldShow) {
      line.classList.remove('hidden');
      visibleCount++;
    } else {
      line.classList.add('hidden');
    }
  });
  
  // Update filter button states
  document.querySelectorAll('.logs-filter-btn').forEach(btn => {
    if (btn.dataset.filter === logsState.currentFilter) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// Highlight search matches in log line
function highlightSearchMatches(lineElement) {
  if (!logsState.searchTerm) return;
  
  const contentSpan = lineElement.querySelector('.log-content');
  if (!contentSpan) return;
  
  const originalText = lineElement.dataset.originalText || contentSpan.textContent;
  const searchTerm = logsState.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${searchTerm})`, 'gi');
  
  if (regex.test(originalText)) {
    lineElement.classList.add('highlight');
    const highlighted = escapeHtml(originalText).replace(regex, '<mark style="background: rgba(255, 212, 59, 0.4); color: var(--text-primary);">$1</mark>');
    contentSpan.innerHTML = highlighted;
  }
}

// Remove search highlights
function removeSearchHighlights(lineElement) {
  lineElement.classList.remove('highlight');
  const contentSpan = lineElement.querySelector('.log-content');
  if (contentSpan) {
    // Restore original text (escape HTML)
    const originalText = lineElement.dataset.originalText || contentSpan.textContent;
    contentSpan.innerHTML = escapeHtml(originalText);
  }
}

// Scroll to bottom if auto-scroll is enabled
function scrollLogsToBottom() {
  if (logsState.autoScroll && !logsState.paused) {
    const logsContent = document.getElementById('container-logs-content');
    if (logsContent) {
      logsContent.scrollTop = logsContent.scrollHeight;
    }
  }
}

// Set up logs tab
document.addEventListener('DOMContentLoaded', () => {
  const logsTab = document.getElementById('logs-tab');
  if (logsTab) {
    logsTab.addEventListener('shown.bs.tab', () => {
      if (currentContainerDetails) {
        const logsContent = document.getElementById('container-logs-content');
        if (logsContent) {
          // Reset state
          logsState = {
            paused: false,
            autoScroll: true,
            currentFilter: 'all',
            searchTerm: '',
            allLogs: []
          };
          
          // Reset UI controls
          const pauseBtn = document.getElementById('logs-pause-btn');
          if (pauseBtn) {
            pauseBtn.innerHTML = '<i class="fas fa-pause"></i> Pause';
            pauseBtn.title = 'Pause';
          }
          
          const searchInput = document.getElementById('logs-search-input');
          if (searchInput) {
            searchInput.value = '';
          }
          
          const clearSearchBtn = document.getElementById('logs-clear-search');
          if (clearSearchBtn) {
            clearSearchBtn.style.display = 'none';
          }
          
          const autoScrollCheckbox = document.getElementById('logs-auto-scroll');
          if (autoScrollCheckbox) {
            autoScrollCheckbox.checked = true;
          }
          
          // Reset filter buttons
          document.querySelectorAll('.logs-filter-btn').forEach(btn => {
            if (btn.dataset.filter === 'all') {
              btn.classList.add('active');
            } else {
              btn.classList.remove('active');
            }
          });
          
          logsContent.innerHTML = '<div class="text-muted text-center logs-loading">Loading logs...</div>';
          sendCommand('logs', { id: currentContainerDetails.Id });
          
          // Set up enhanced log handler
          window.handleLogOutput = (logData) => {
            const rawLine = atob(logData.data);
            const loadingEl = logsContent.querySelector('.logs-loading');
            if (loadingEl) {
              logsContent.innerHTML = '';
            }
            
            // Format log line
            const formattedLog = formatLogLine(rawLine);
            if (!formattedLog) return;
            
            // Store log
            logsState.allLogs.push(formattedLog);
            
            // Create log element
            const logElement = document.createElement('div');
            logElement.className = 'log-line';
            logElement.dataset.level = formattedLog.level || '';
            
            // Add level class
            if (formattedLog.level) {
              logElement.classList.add(formattedLog.level);
              logElement.dataset.level = formattedLog.level;
            }
            
            // Build log content
            let logHTML = '';
            if (formattedLog.level) {
              logHTML += `<span class="log-level-badge ${formattedLog.level}">${formattedLog.level}</span>`;
            }
            logHTML += `<span class="log-content">${escapeHtml(formattedLog.formatted)}</span>`;
            
            logElement.innerHTML = logHTML;
            // Store original text for search highlighting
            logElement.dataset.originalText = formattedLog.formatted;
            logsContent.appendChild(logElement);
            
            // Apply current filters
            applyLogFilters();
            
            // Auto-scroll if enabled
            scrollLogsToBottom();
          };
        }
      }
    });
  }
  
  // Set up logs controls
  const pauseBtn = document.getElementById('logs-pause-btn');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      logsState.paused = !logsState.paused;
      pauseBtn.innerHTML = logsState.paused 
        ? '<i class="fas fa-play"></i> Resume'
        : '<i class="fas fa-pause"></i> Pause';
      pauseBtn.title = logsState.paused ? 'Resume' : 'Pause';
    });
  }
  
  const clearBtn = document.getElementById('logs-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const logsContent = document.getElementById('container-logs-content');
      if (logsContent) {
        showConfirmModal('Clear all logs?', () => {
          logsContent.innerHTML = '';
          logsState.allLogs = [];
        });
      }
    });
  }
  
  const copyBtn = document.getElementById('logs-copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const logsContent = document.getElementById('container-logs-content');
      if (logsContent) {
        const allText = Array.from(logsContent.querySelectorAll('.log-line:not(.hidden)'))
          .map(line => line.textContent)
          .join('\n');
        copyToClipboard(allText, copyBtn);
      }
    });
  }
  
  const downloadBtn = document.getElementById('logs-download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const logsContent = document.getElementById('container-logs-content');
      if (logsContent && currentContainerDetails) {
        const allText = Array.from(logsContent.querySelectorAll('.log-line:not(.hidden)'))
          .map(line => line.textContent)
          .join('\n');
        
        const blob = new Blob([allText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `container-${currentContainerDetails.Id.substring(0, 12)}-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    });
  }
  
  // Auto-scroll toggle
  const autoScrollCheckbox = document.getElementById('logs-auto-scroll');
  if (autoScrollCheckbox) {
    autoScrollCheckbox.addEventListener('change', (e) => {
      logsState.autoScroll = e.target.checked;
      if (logsState.autoScroll) {
        scrollLogsToBottom();
      }
    });
  }
  
  // Search input
  const searchInput = document.getElementById('logs-search-input');
  const clearSearchBtn = document.getElementById('logs-clear-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      logsState.searchTerm = e.target.value;
      if (logsState.searchTerm) {
        clearSearchBtn.style.display = 'block';
      } else {
        clearSearchBtn.style.display = 'none';
      }
      applyLogFilters();
    });
  }
  
  if (clearSearchBtn) {
    clearSearchBtn.addEventListener('click', () => {
      searchInput.value = '';
      logsState.searchTerm = '';
      clearSearchBtn.style.display = 'none';
      applyLogFilters();
    });
  }
  
  // Filter buttons
  document.querySelectorAll('.logs-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      logsState.currentFilter = btn.dataset.filter;
      applyLogFilters();
    });
  });
  
  // Set up stats tab
  const statsTab = document.getElementById('stats-tab');
  if (statsTab) {
    statsTab.addEventListener('shown.bs.tab', () => {
      if (currentContainerDetails) {
        updateContainerDetailsStats(currentContainerDetails);
      }
    });
    
    statsTab.addEventListener('hidden.bs.tab', () => {
      // Clean up charts when leaving stats tab
      if (cpuChart) {
        cpuChart.destroy();
        cpuChart = null;
      }
      if (memoryChart) {
        memoryChart.destroy();
        memoryChart = null;
      }
    });
  }
  
  // Terminal state for details tab
  let detailsTerminalSession = null;
  let terminalFontSize = 14;
  let terminalTheme = 'dark';
  
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
  
  // Initialize terminal for details tab
  function initDetailsTerminal(containerId) {
    if (!window.Terminal || !window.FitAddon) {
      console.error('[ERROR] Terminal libraries not loaded');
      return;
    }
    
    const terminalContainer = document.getElementById('container-terminal-xterm');
    if (!terminalContainer) return;
    
    // Clean up existing terminal if any
    if (detailsTerminalSession) {
      cleanupDetailsTerminal();
    }
    
    // Get FitAddon constructor
    const FitAddonConstructor = window.FitAddon.FitAddon || window.FitAddon;
    
    const xterm = new window.Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: terminalFontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: terminalThemes[terminalTheme],
      scrollback: 10000,
    });
    
    const fitAddon = new FitAddonConstructor();
    xterm.loadAddon(fitAddon);
    
    terminalContainer.innerHTML = '';
    xterm.open(terminalContainer);
    fitAddon.fit();
    
    // Handle terminal input
    const onDataDisposable = xterm.onData((data) => {
      if (!window.activePeer) {
        console.error('[ERROR] No active peer connection.');
        return;
      }
      const encoded = btoa(unescape(encodeURIComponent(data)));
      window.activePeer.write(JSON.stringify({
        type: 'terminalInput',
        containerId,
        data: encoded,
        encoding: 'base64',
      }));
    });
    
    // Handle resize
    const resizeListener = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', resizeListener);
    
    detailsTerminalSession = {
      xterm,
      fitAddon,
      onDataDisposable,
      containerId,
      resizeListener
    };
    
    // Request terminal start from server
    if (window.activePeer) {
      window.activePeer.write(JSON.stringify({
        command: 'startTerminal',
        args: { containerId }
      }));
    }
    
    // Update font size display
    updateTerminalFontSizeDisplay();
  }
  
  // Cleanup terminal for details tab
  function cleanupDetailsTerminal() {
    if (detailsTerminalSession) {
      if (detailsTerminalSession.xterm) {
        detailsTerminalSession.xterm.dispose();
      }
      if (detailsTerminalSession.onDataDisposable) {
        detailsTerminalSession.onDataDisposable.dispose();
      }
      if (detailsTerminalSession.resizeListener) {
        window.removeEventListener('resize', detailsTerminalSession.resizeListener);
      }
      detailsTerminalSession = null;
    }
  }
  
  // Append terminal output
  function appendDetailsTerminalOutput(data, encoding = 'base64') {
    if (!detailsTerminalSession) return;
    
    let text = data;
    if (encoding === 'base64') {
      try {
        text = decodeURIComponent(escape(atob(data)));
      } catch (e) {
        console.error('Base64 decode failed', e);
        return;
      }
    }
    
    detailsTerminalSession.xterm.write(text);
  }
  
  // Update font size display
  function updateTerminalFontSizeDisplay() {
    const display = document.getElementById('terminal-font-size-display');
    if (display) {
      display.textContent = terminalFontSize;
    }
  }
  
  // Apply terminal theme
  function applyTerminalTheme(theme) {
    terminalTheme = theme;
    if (detailsTerminalSession && detailsTerminalSession.xterm) {
      detailsTerminalSession.xterm.options.theme = terminalThemes[theme];
    }
  }
  
  // Set up terminal tab
  const terminalTab = document.getElementById('terminal-tab');
  if (terminalTab) {
    terminalTab.addEventListener('shown.bs.tab', () => {
      if (currentContainerDetails) {
        initDetailsTerminal(currentContainerDetails.Id);
      }
    });
    
    terminalTab.addEventListener('hidden.bs.tab', () => {
      cleanupDetailsTerminal();
    });
  }
  
  // Terminal controls
  const terminalFontDecreaseBtn = document.getElementById('terminal-font-decrease');
  const terminalFontIncreaseBtn = document.getElementById('terminal-font-increase');
  const terminalFontResetBtn = document.getElementById('terminal-font-reset');
  const terminalCopyBtn = document.getElementById('terminal-copy-btn');
  const terminalClearBtn = document.getElementById('terminal-clear-btn');
  const terminalThemeSelect = document.getElementById('terminal-theme-select');
  
  if (terminalFontDecreaseBtn) {
    terminalFontDecreaseBtn.addEventListener('click', () => {
      if (terminalFontSize > 8) {
        terminalFontSize -= 2;
        if (detailsTerminalSession && detailsTerminalSession.xterm) {
          detailsTerminalSession.xterm.options.fontSize = terminalFontSize;
        }
        updateTerminalFontSizeDisplay();
      }
    });
  }
  
  if (terminalFontIncreaseBtn) {
    terminalFontIncreaseBtn.addEventListener('click', () => {
      if (terminalFontSize < 24) {
        terminalFontSize += 2;
        if (detailsTerminalSession && detailsTerminalSession.xterm) {
          detailsTerminalSession.xterm.options.fontSize = terminalFontSize;
        }
        updateTerminalFontSizeDisplay();
      }
    });
  }
  
  if (terminalFontResetBtn) {
    terminalFontResetBtn.addEventListener('click', () => {
      terminalFontSize = 14;
      if (detailsTerminalSession && detailsTerminalSession.xterm) {
        detailsTerminalSession.xterm.options.fontSize = terminalFontSize;
      }
      updateTerminalFontSizeDisplay();
    });
  }
  
  if (terminalCopyBtn) {
    terminalCopyBtn.addEventListener('click', () => {
      if (detailsTerminalSession && detailsTerminalSession.xterm) {
        const selection = detailsTerminalSession.xterm.getSelection();
        if (selection) {
          copyToClipboard(selection, terminalCopyBtn);
        } else {
          showAlert('info', 'No text selected');
        }
      }
    });
  }
  
  if (terminalClearBtn) {
    terminalClearBtn.addEventListener('click', () => {
      if (detailsTerminalSession && detailsTerminalSession.xterm && confirm('Clear terminal?')) {
        detailsTerminalSession.xterm.clear();
      }
    });
  }
  
  if (terminalThemeSelect) {
    terminalThemeSelect.value = terminalTheme;
    terminalThemeSelect.addEventListener('change', (e) => {
      applyTerminalTheme(e.target.value);
    });
  }
  
  // Handle terminal output for details tab
  window.handleDetailsTerminalOutput = (data, containerId, encoding) => {
    if (detailsTerminalSession && detailsTerminalSession.containerId === containerId) {
      appendDetailsTerminalOutput(data, encoding);
    }
  };
});

// Helper function for confirmation modals
function showConfirmModal(message, onConfirm) {
  const modal = new bootstrap.Modal(document.getElementById('confirmModal'));
  const messageEl = document.getElementById('confirmModalMessage');
  const confirmBtn = document.getElementById('confirmModalBtn');
  
  messageEl.textContent = message;
  
  // Remove old listeners
  if (confirmBtn && confirmBtn.parentNode) {
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    
    newConfirmBtn.addEventListener('click', () => {
      modal.hide();
      if (typeof onConfirm === 'function') {
        onConfirm();
      }
    });
  } else {
    console.warn('[WARNING] confirmModalBtn not found in DOM, skipping listener setup');
  }
  
  modal.show();
}

// Bulk Operations Functions
function getSelectedContainers() {
  const checkboxes = document.querySelectorAll('.container-checkbox:checked');
  const selected = Array.from(checkboxes).map(cb => {
    // Try dataset first, fallback to getAttribute for compatibility
    const id = cb.dataset.containerId || cb.getAttribute('data-container-id');
    if (!id) {
      console.warn('[WARN] Checkbox missing container ID:', cb);
    }
    return id;
  }).filter(id => id); // Filter out any undefined/null values
  console.log('[DEBUG] getSelectedContainers - found', selected.length, 'selected containers');
  return selected;
}

function getSelectedImages() {
  const checkboxes = document.querySelectorAll('.image-checkbox:checked');
  return Array.from(checkboxes).map(cb => cb.dataset.imageId);
}

function updateBulkActionsToolbar() {
  const selected = getSelectedContainers();
  const toolbar = document.getElementById('bulk-actions-toolbar');
  const countEl = document.getElementById('selected-count');
  
  if (toolbar && countEl) {
    if (selected.length > 0) {
      toolbar.style.display = 'block';
      countEl.textContent = selected.length;
    } else {
      toolbar.style.display = 'none';
    }
  }
}

function updateBulkActionsImagesToolbar() {
  const selected = getSelectedImages();
  const toolbar = document.getElementById('bulk-actions-images-toolbar');
  const countEl = document.getElementById('selected-images-count');
  
  if (toolbar && countEl) {
    if (selected.length > 0) {
      toolbar.style.display = 'block';
      countEl.textContent = selected.length;
    } else {
      toolbar.style.display = 'none';
    }
  }
}

function toggleSelectAllContainers(checkbox) {
  const checkboxes = document.querySelectorAll('.container-checkbox');
  checkboxes.forEach(cb => {
    cb.checked = checkbox.checked;
  });
  updateBulkActionsToolbar();
}

function toggleSelectAllImages(checkbox) {
  const checkboxes = document.querySelectorAll('.image-checkbox');
  checkboxes.forEach(cb => {
    cb.checked = checkbox.checked;
  });
  updateBulkActionsImagesToolbar();
}

function clearContainerSelection() {
  document.querySelectorAll('.container-checkbox').forEach(cb => cb.checked = false);
  document.getElementById('select-all-containers').checked = false;
  updateBulkActionsToolbar();
}

function clearImageSelection() {
  document.querySelectorAll('.image-checkbox').forEach(cb => cb.checked = false);
  document.getElementById('select-all-images').checked = false;
  updateBulkActionsImagesToolbar();
}

async function bulkStartContainers() {
  const selected = getSelectedContainers();
  console.log('[DEBUG] bulkStartContainers - selected containers:', selected);
  if (selected.length === 0) {
    console.warn('[WARN] No containers selected');
    return;
  }
  
  await new Promise((resolve) => {
    showConfirmModal(`Start ${selected.length} container(s)?`, resolve);
  });
  
  showStatusIndicator(`Starting ${selected.length} container(s)...`);
  
  try {
    sendCommand('bulkContainerOperation', { containerIds: selected, operation: 'start' });
    const response = await waitForPeerResponse('Bulk operation completed');
    const successCount = response.results.filter(r => r.success).length;
    const failCount = response.results.filter(r => !r.success).length;
    showAlert('success', `Started ${successCount} container(s)${failCount > 0 ? `, ${failCount} failed` : ''}`);
    clearContainerSelection();
    setTimeout(() => sendCommand('listContainers'), 1000);
  } catch (error) {
    console.error('[ERROR] Bulk start failed:', error);
    showAlert('danger', error.message || 'Failed to start containers');
  } finally {
    hideStatusIndicator();
  }
}

async function bulkStopContainers() {
  const selected = getSelectedContainers();
  console.log('[DEBUG] bulkStopContainers - selected containers:', selected);
  if (selected.length === 0) {
    console.warn('[WARN] No containers selected');
    return;
  }
  
  let confirmed = false;
  await new Promise((resolve) => {
    showConfirmModal(`Stop ${selected.length} container(s)?`, () => {
      confirmed = true;
      resolve();
    });
    const modalEl = document.getElementById('confirmModal');
    if (modalEl) {
      modalEl.addEventListener('hidden.bs.modal', () => {
        if (!confirmed) resolve();
      }, { once: true });
    }
  });
  if (!confirmed) return;
  
  showStatusIndicator(`Stopping ${selected.length} container(s)...`);
  
  try {
    sendCommand('bulkContainerOperation', { containerIds: selected, operation: 'stop' });
    const response = await waitForPeerResponse('Bulk operation completed');
    const successCount = response.results.filter(r => r.success).length;
    const failCount = response.results.filter(r => !r.success).length;
    showAlert('success', `Stopped ${successCount} container(s)${failCount > 0 ? `, ${failCount} failed` : ''}`);
    clearContainerSelection();
    setTimeout(() => sendCommand('listContainers'), 1000);
  } catch (error) {
    console.error('[ERROR] Bulk stop failed:', error);
    showAlert('danger', error.message || 'Failed to stop containers');
  } finally {
    hideStatusIndicator();
  }
}

async function bulkRemoveContainers() {
  const selected = getSelectedContainers();
  console.log('[DEBUG] bulkRemoveContainers - selected containers:', selected);
  if (selected.length === 0) {
    console.warn('[WARN] No containers selected');
    return;
  }
  
  let confirmed = false;
  await new Promise((resolve) => {
    showConfirmModal(`Remove ${selected.length} container(s)? This action cannot be undone.`, () => {
      confirmed = true;
      resolve();
    });
    const modalEl = document.getElementById('confirmModal');
    if (modalEl) {
      modalEl.addEventListener('hidden.bs.modal', () => {
        if (!confirmed) resolve();
      }, { once: true });
    }
  });
  if (!confirmed) return;
  
  showStatusIndicator(`Removing ${selected.length} container(s)...`);
  
  try {
    sendCommand('bulkContainerOperation', { containerIds: selected, operation: 'remove' });
    const response = await waitForPeerResponse('Bulk operation completed');
    const successCount = response.results.filter(r => r.success).length;
    const failCount = response.results.filter(r => !r.success).length;
    showAlert('success', `Removed ${successCount} container(s)${failCount > 0 ? `, ${failCount} failed` : ''}`);
    clearContainerSelection();
    setTimeout(() => sendCommand('listContainers'), 1000);
  } catch (error) {
    console.error('[ERROR] Bulk remove failed:', error);
    showAlert('danger', error.message || 'Failed to remove containers');
  } finally {
    hideStatusIndicator();
  }
}

// Exec terminal function - uses regular terminal infrastructure
function startExecTerminal(containerId, execId) {
  if (!window.activePeer) {
    console.error('[ERROR] No active peer connection.');
    return;
  }

  // Reuse terminal infrastructure for exec
  // The server already handles exec output streaming via execOutput/execErrorOutput
  startTerminal(containerId, `Exec: ${containerId.substring(0, 12)}`);
  
  // Store exec ID for input handling
  if (window.openTerminals[containerId]) {
    window.openTerminals[containerId].execId = execId;
  }
}

async function bulkRemoveImages() {
  const selected = getSelectedImages();
  if (selected.length === 0) return;
  
  let confirmed = false;
  await new Promise((resolve) => {
    showConfirmModal(`Remove ${selected.length} image(s)? This action cannot be undone.`, () => {
      confirmed = true;
      resolve();
    });
    const modalEl = document.getElementById('confirmModal');
    if (modalEl) {
      modalEl.addEventListener('hidden.bs.modal', () => {
        if (!confirmed) resolve();
      }, { once: true });
    }
  });
  if (!confirmed) return;
  
  showStatusIndicator(`Removing ${selected.length} image(s)...`);
  let completed = 0;
  let failed = 0;
  
  for (const imageId of selected) {
    try {
      sendCommand('removeImage', { id: imageId, force: true });
      await new Promise(resolve => setTimeout(resolve, 500));
      completed++;
    } catch (error) {
      failed++;
      console.error(`Failed to remove image ${imageId}:`, error);
    }
  }
  
  hideStatusIndicator();
  showAlert('success', `Removed ${completed} image(s)${failed > 0 ? `, ${failed} failed` : ''}`);
  clearImageSelection();
  setTimeout(() => loadImages(), 1000);
}

// Deploy View Functions
let deployViewTemplates = [];

async function loadDeployView() {
  const templateListContainer = document.getElementById('deploy-template-list-container');
  if (!templateListContainer) return;
  
  // Initialize template deployer to set up form handlers
  if (typeof initTemplateDeployer === 'function') {
    initTemplateDeployer();
  }
  
  // Set up deploy view form handler (will be set up when form becomes visible or on DOMContentLoaded)
  // Try to set it up now, but it will also be set up when template is selected
  setTimeout(() => setupDeployViewFormHandler(), 100);
  
  // Set up network mode change handler for deploy view
  const networkMode = document.getElementById('deploy-network-mode');
  const customNetworkContainer = document.getElementById('deploy-custom-network-container');
  if (networkMode && customNetworkContainer && networkMode.parentNode) {
    // Remove existing listeners by cloning
    const newNetworkMode = networkMode.cloneNode(true);
    networkMode.parentNode.replaceChild(newNetworkMode, networkMode);
    
    newNetworkMode.addEventListener('change', (e) => {
      if (e.target.value === 'container') {
        customNetworkContainer.style.display = 'block';
        const input = customNetworkContainer.querySelector('input');
        if (input) input.placeholder = 'container-name';
      } else if (e.target.value !== 'host' && e.target.value !== 'none' && e.target.value !== 'bridge') {
        customNetworkContainer.style.display = 'block';
        const input = customNetworkContainer.querySelector('input');
        if (input) input.placeholder = 'network-name';
      } else {
        customNetworkContainer.style.display = 'none';
      }
    });
  }
  
  // Show loading state
  templateListContainer.innerHTML = '<div class="text-center text-muted py-4"><i class="fas fa-spinner fa-spin me-2"></i>Loading templates...</div>';
  
  try {
    // Fetch templates
    const response = await fetch('https://raw.githubusercontent.com/Lissy93/portainer-templates/main/templates.json');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    deployViewTemplates = data.templates || [];
    displayDeployTemplateList(deployViewTemplates);
  } catch (error) {
    console.error('[ERROR] Failed to fetch templates:', error.message);
    templateListContainer.innerHTML = '<div class="text-center text-danger py-4"><i class="fas fa-exclamation-triangle me-2"></i>Failed to load templates</div>';
  }
}

function displayDeployTemplateList(templates) {
  const templateListContainer = document.getElementById('deploy-template-list-container');
  const searchInput = document.getElementById('deploy-template-search-input');
  
  if (!templateListContainer) return;
  
  if (!templates || templates.length === 0) {
    templateListContainer.innerHTML = '<div class="text-center text-muted py-4">No templates available</div>';
    return;
  }
  
  // Create a list similar to the modal template list
  const list = document.createElement('ul');
  list.className = 'list-group';
  
  templates.forEach(template => {
    const listItem = document.createElement('li');
    listItem.className = 'list-group-item d-flex justify-content-between align-items-center';
    listItem.style.cursor = 'pointer';
    listItem.style.transition = 'all 0.2s';
    listItem.innerHTML = `
      <div class="d-flex align-items-center">
        ${template.logo ? `<img src="${template.logo}" alt="Logo" class="me-3" style="width: 32px; height: 32px; object-fit: contain;">` : '<i class="fas fa-cube me-3 text-muted"></i>'}
        <div>
          <div class="fw-bold">${template.title || 'Untitled'}</div>
          <small class="text-muted">${template.description || 'No description'}</small>
        </div>
      </div>
      <button class="btn btn-primary btn-sm deploy-template-btn-view">
        <i class="fas fa-rocket me-1"></i>Deploy
      </button>
    `;
    
    // Add hover effect
    listItem.addEventListener('mouseenter', () => {
      listItem.style.background = 'var(--bg-hover)';
    });
    listItem.addEventListener('mouseleave', () => {
      listItem.style.background = '';
    });
    
    // Handle click
    const deployBtn = listItem.querySelector('.deploy-template-btn-view');
    deployBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectTemplateForDeploy(template);
    });
    
    listItem.addEventListener('click', () => {
      selectTemplateForDeploy(template);
    });
    
    list.appendChild(listItem);
  });
  
  templateListContainer.innerHTML = '';
  templateListContainer.appendChild(list);
  
  // Set up search functionality
  if (searchInput && searchInput.parentNode) {
    // Remove existing listener if any
    const newSearchInput = searchInput.cloneNode(true);
    searchInput.parentNode.replaceChild(newSearchInput, searchInput);
    
    newSearchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      const items = list.querySelectorAll('.list-group-item');
      items.forEach(item => {
        const title = item.querySelector('.fw-bold')?.textContent?.toLowerCase() || '';
        const desc = item.querySelector('.text-muted')?.textContent?.toLowerCase() || '';
        if (title.includes(query) || desc.includes(query)) {
          item.style.display = '';
        } else {
          item.style.display = 'none';
        }
      });
    });
  }
}

function selectTemplateForDeploy(template) {
  // Show the deploy form section
  const formSection = document.getElementById('deploy-form-section');
  if (formSection) {
    formSection.style.display = 'block';
    formSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  
  // Initialize template deployer if needed
  if (typeof initTemplateDeployer === 'function') {
    initTemplateDeployer();
  }
  
  // Set up form handler when form becomes visible
  setupDeployViewFormHandler();
  
  // Populate form with template data (similar to openDeployModal but without showing modal)
  if (template) {
    // Reset counters (these are in templateDeploy.js scope, but we'll handle form reset)
    const form = document.getElementById('deploy-view-form');
    if (form) form.reset();
    
    // Clear all array containers
    ['deploy-ports-container', 'deploy-volumes-container', 'deploy-env', 'deploy-labels-container',
     'deploy-dns-container', 'deploy-extra-hosts-container', 'deploy-devices-container',
     'deploy-capabilities-container', 'deploy-security-opts-container', 'deploy-log-opts-container',
     'deploy-sysctls-container', 'deploy-ulimits-container', 'deploy-tmpfs-container'].forEach(id => {
        const container = document.getElementById(id);
        if (container) container.innerHTML = '';
    });

    // Populate basic fields
    const deployImage = document.getElementById('deploy-image');
    if (deployImage && template.image) {
      deployImage.value = template.image;
    }

    // Populate ports from template
    console.log('[CRITICAL] selectTemplateForDeploy - template.ports:', template.ports);
    if (template.ports && Array.isArray(template.ports) && typeof addPortMapping === 'function') {
      console.log('[CRITICAL] Processing ports array in selectTemplateForDeploy:', template.ports);
      template.ports.forEach((port, index) => {
        console.log(`[CRITICAL] Processing port ${index}:`, port, 'Type:', typeof port);
        if (port != null && port !== undefined) {
          // Convert port to string format that addPortMapping expects
          let portValue;
          if (typeof port === 'string') {
            portValue = port.trim();
          } else if (typeof port === 'number') {
            portValue = String(port);
          } else if (typeof port === 'object' && (port.container || port.target)) {
            // Port object format: { container: "5000", protocol: "tcp", host: "8080" }
            const containerPort = port.container || port.target;
            const protocol = port.protocol || 'tcp';
            const hostPort = port.host || port.published || '';
            portValue = hostPort ? `${hostPort}:${containerPort}/${protocol}` : `${containerPort}/${protocol}`;
          } else {
            portValue = String(port);
          }
          console.log(`[CRITICAL] Calling addPortMapping with portValue:`, portValue);
          addPortMapping(portValue);
        } else {
          console.warn(`[WARN] Skipping null/undefined port at index ${index}`);
        }
      });
    } else {
      console.log('[CRITICAL] No ports to populate or addPortMapping not available');
    }

    // Populate volumes from template
    if (template.volumes && Array.isArray(template.volumes) && typeof addVolumeMount === 'function') {
      template.volumes.forEach(volume => {
        addVolumeMount();
        const container = document.getElementById('deploy-volumes-container');
        const lastInput = container?.lastElementChild?.querySelector('input');
        if (lastInput && volume.bind && volume.container) {
          lastInput.value = `${volume.bind}:${volume.container}${volume.mode ? ':' + volume.mode : ''}`;
        }
      });
    }

    // Populate environment variables from template
    if (template.env && Array.isArray(template.env) && typeof addEnvVar === 'function') {
      template.env.forEach(env => {
        addEnvVar();
        const container = document.getElementById('deploy-env');
        const items = container.querySelectorAll('.array-item');
        const lastItem = items[items.length - 1];
        if (lastItem) {
          const keyInput = lastItem.querySelector('[data-env-key]');
          const valueInput = lastItem.querySelector('[data-env-value]');
          if (keyInput) keyInput.value = env.name || '';
          if (valueInput) valueInput.value = env.default || '';
        }
      });
    }
    
    // Update preview if function exists
    if (typeof updatePreview === 'function') {
      updatePreview();
    }
  }
}

function resetDeployView() {
  const formSection = document.getElementById('deploy-form-section');
  if (formSection) {
    formSection.style.display = 'none';
  }
  
  const viewForm = document.getElementById('deploy-view-form');
  if (viewForm) {
    viewForm.reset();
    
    // Clear all array containers (same as modal reset)
    ['deploy-ports-container', 'deploy-volumes-container', 'deploy-env', 'deploy-labels-container',
     'deploy-dns-container', 'deploy-extra-hosts-container', 'deploy-devices-container',
     'deploy-capabilities-container', 'deploy-security-opts-container', 'deploy-log-opts-container',
     'deploy-sysctls-container', 'deploy-ulimits-container', 'deploy-tmpfs-container'].forEach(id => {
        const container = document.getElementById(id);
        if (container) container.innerHTML = '';
    });
  }
  
  const searchInput = document.getElementById('deploy-template-search-input');
  if (searchInput) {
    searchInput.value = '';
    // Re-display all templates
    if (deployViewTemplates.length > 0) {
      displayDeployTemplateList(deployViewTemplates);
    }
  }
}

// Set up deploy view form submit handler
let deployViewFormHandlerSetup = false;

function setupDeployViewFormHandler() {
  const deployViewForm = document.getElementById('deploy-view-form');
  if (!deployViewForm) {
    console.warn('[WARN] Deploy view form not found, will retry when form is visible');
    return;
  }
  
  // Check if handler is already attached by looking for a data attribute
  if (deployViewForm.dataset.handlerAttached === 'true') {
    console.log('[INFO] Form handler already attached');
    return;
  }
  
  console.log('[INFO] Setting up deploy view form handler');
  attachFormHandler(deployViewForm);
  deployViewForm.dataset.handlerAttached = 'true';
  deployViewFormHandlerSetup = true;
}

function attachFormHandler(form) {
  if (!form) return;
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    
    console.log('[INFO] Deploy view form submitted');
    
    // Check if collectFormData is available (from templateDeploy.js)
    if (typeof collectFormData !== 'function') {
      console.error('[ERROR] collectFormData function not available. Type:', typeof collectFormData);
      console.log('[DEBUG] Available functions:', {
        collectFormData: typeof collectFormData,
        deployDockerContainer: typeof deployDockerContainer,
        validateFormData: typeof validateFormData
      });
      showAlert('danger', 'Form collection function not available. Please refresh the page.');
      return false;
    }
    
    // Use the existing collectFormData function - it works with the same field IDs
    let formData;
    try {
      console.log('[DEBUG] Calling collectFormData...');
      formData = collectFormData();
      console.log('[DEBUG] Collected form data:', formData);
    } catch (collectError) {
      console.error('[ERROR] Failed to collect form data:', collectError);
      console.error('[ERROR] Error stack:', collectError.stack);
      showAlert('danger', 'Failed to collect form data. Check console for details.');
      return false;
    }
      
      // Validate
      if (typeof validateFormData === 'function') {
        try {
          const errors = validateFormData(formData);
          if (errors.length > 0) {
            showAlert('danger', errors.join(' '));
            return false;
          }
        } catch (validateError) {
          console.error('[ERROR] Validation error:', validateError);
        }
      }
      
      if (!formData.containerName || !formData.image) {
        showAlert('danger', 'Container name and image are required.');
        return false;
      }
      
      const containerName = formData.containerName;
      
      // Add notification
      if (typeof notificationManager !== 'undefined') {
        notificationManager.add('info', `Creating container "${containerName}"...`, { autoDismiss: false });
      }
      showStatusIndicator('Preparing container configuration...');
      
      try {
        // Deploy using the existing function
        if (typeof deployDockerContainer === 'function') {
          // Update message when starting deployment
          updateStatusIndicator('Creating container...');
          
          const successResponse = await deployDockerContainer(formData);
          
          if (successResponse && successResponse.success) {
            // Update message to indicate we're transferring
            updateStatusIndicator('Transferring you to the container');
            
            if (typeof notificationManager !== 'undefined') {
              notificationManager.add('success', `Container "${containerName}" created successfully!`);
            }
            showAlert('success', successResponse.message || 'Container deployed successfully!');
            
            // Reset form
            resetDeployView();
            
            // Wait for container list to update, then navigate to container details
            // Keep spinner visible during this time
            setTimeout(() => {
              if (window.sendCommand) {
                window.sendCommand('listContainers');
                
                // Wait a bit for containers to load, then find and navigate to the new container
                setTimeout(() => {
                  hideStatusIndicator();
                  navigateToNewContainer(containerName);
                }, 1500);
              } else {
                hideStatusIndicator();
              }
            }, 500);
          } else {
            hideStatusIndicator();
            throw new Error(successResponse?.error || 'Deployment failed');
          }
        } else {
          hideStatusIndicator();
          throw new Error('deployDockerContainer function not available');
        }
      } catch (error) {
        hideStatusIndicator();
        console.error('[ERROR] Failed to deploy container:', error);
        if (typeof notificationManager !== 'undefined') {
          notificationManager.add('danger', `Failed to create container "${containerName}"`);
        }
        showAlert('danger', error.message || 'Failed to deploy container.');
      }
    
    return false;
  });
  
  console.log('[INFO] Deploy view form handler attached');
}

function navigateToNewContainer(containerName) {
  console.log(`[INFO] Looking for newly created container: ${containerName}`);
  
  // Set up a handler to catch the container list response and find the new container
  const originalHandler = window.handlePeerResponse;
  let containerFound = false;
  
  const findContainerHandler = (response) => {
    if (response.type === 'containers' && response.data && !containerFound) {
      const newContainer = response.data.find(c => {
        const name = c.Names?.[0]?.replace(/^\//, '') || '';
        return name === containerName;
      });
      
      if (newContainer) {
        console.log(`[INFO] Found new container, navigating to details: ${containerName}`);
        containerFound = true;
        
        // Restore original handler first
        window.handlePeerResponse = originalHandler;
        
        // Navigate to container details
        if (typeof showContainerDetails === 'function') {
          showContainerDetails(newContainer);
        } else {
          console.error('[ERROR] showContainerDetails function not available');
        }
        return;
      }
    }
    
    // Not the response we're looking for, pass to original handler
    if (typeof originalHandler === 'function') {
      originalHandler(response);
    }
  };
  
  window.handlePeerResponse = findContainerHandler;
  
  // Request container list
  if (window.activePeer && typeof sendCommand === 'function') {
    sendCommand('listContainers');
  }
  
  // Timeout after 10 seconds
  setTimeout(() => {
    if (window.handlePeerResponse === findContainerHandler && !containerFound) {
      window.handlePeerResponse = originalHandler;
      console.warn('[WARN] Timeout waiting for new container to appear. Navigating to containers view.');
      navigateToView('containers');
    }
  }, 10000);
}

// Expose to window
window.pullImage = pullImage;
window.createNetwork = createNetwork;
window.createVolume = createVolume;
window.showContainerDetails = showContainerDetails;
window.resetDeployView = resetDeployView;
window.navigateToNewContainer = navigateToNewContainer;
window.updateBulkActionsToolbar = updateBulkActionsToolbar;
window.updateBulkActionsImagesToolbar = updateBulkActionsImagesToolbar;
window.toggleSelectAllContainers = toggleSelectAllContainers;
window.toggleSelectAllImages = toggleSelectAllImages;
window.clearContainerSelection = clearContainerSelection;
window.clearImageSelection = clearImageSelection;
window.bulkStartContainers = bulkStartContainers;
window.bulkStopContainers = bulkStopContainers;
window.bulkRemoveContainers = bulkRemoveContainers;
window.bulkRemoveImages = bulkRemoveImages;
window.filterImages = filterImages;



// Collapse Sidebar Functionality - set up in DOMContentLoaded

function handlePeerData(data, topicId, peer) {
  try {
    // Parse the incoming data
    const response = JSON.parse(data.toString());
    console.log(`[DEBUG] Received data from peer (topic: ${topicId}): ${JSON.stringify(response)}`);
    console.log(response.message)
    
    // Handle errors first - check for error responses before processing
    if (response.error) {
      const errorMessage = handleErrorResponse(response);
      // Error has been sent to notification center, but continue processing
      // in case there are other handlers that need to see the error
    }
    
    if (response.success && response.message && typeof response.message === 'string' && response.message.includes('deployed successfully')) {
      console.log(`[INFO] Template deployed successfully: ${response.message}`);
      closeAllModals(); // Close all modals after successful deployment

      hideStatusIndicator();
      startStatsInterval(); // Restart stats polling
      showAlert('success', response.message);
      hideStatusIndicator();

    }
    // Ensure the data is for the active connection
    if (!connections[topicId]) {
      console.warn(`[WARN] No connection found for topic: ${topicId}. Ignoring data.`);
      return;
    }

    if (peer !== connections[topicId].peer) {
      console.warn(`[WARN] Ignoring data from a non-active peer for topic: ${topicId}`);
      return;
    }

    // Delegate handling based on the response type
    switch (response.type) {
      case 'allStats':
        console.log('[INFO] Received aggregated stats for all containers.');
        response.data.forEach((stats) => updateContainerStats(stats));
        break;

      case 'containers':
        console.log('[INFO] Processing container list...');
        renderContainers(response.data, topicId); // Render containers specific to this topic
        // Update dashboard stats if on dashboard view
        if (currentView === 'dashboard') {
          updateDashboardStats(response.data, null, null);
        }
        break;

      case 'terminalOutput':
        console.log('[INFO] Appending terminal output...');
        appendTerminalOutput(response.data, response.containerId, response.encoding);
        // Also handle details terminal if active
        if (window.handleDetailsTerminalOutput) {
          window.handleDetailsTerminalOutput(response.data, response.containerId, response.encoding);
        }
        break;

      case 'execOutput':
        console.log('[INFO] Appending exec output...');
        appendTerminalOutput(response.data, response.containerId, response.encoding);
        break;

      case 'execErrorOutput':
        console.log('[INFO] Appending exec error output...');
        appendTerminalOutput(response.data, response.containerId, response.encoding);
        break;

      case 'stacks':
        console.log('[INFO] Handling stacks list...');
        window.currentStacksData = response.data;
        renderStacks(response.data);
        
        // Check if we have a pending stack inspect
        if (window.pendingStackInspect) {
          const { stackName } = window.pendingStackInspect;
          delete window.pendingStackInspect;
          hideStatusIndicator();
          
          const stack = response.data.find(s => s.name === stackName);
          if (stack) {
            formatAndPopulateStackModal(stack);
            const modalTitle = document.getElementById('stackInspectModalLabel');
            if (modalTitle) {
              modalTitle.innerHTML = `<i class="fas fa-info-circle me-2"></i>Stack Information: ${stackName}`;
            }
            
            const modal = new bootstrap.Modal(document.getElementById('stackInspectModal'));
            modal.show();
            
            document.getElementById('stack-inspect-formatted-view').style.display = 'block';
            document.getElementById('stack-inspect-json-view').style.display = 'none';
          }
        }
        break;

      case 'containerConfig':
        console.log('[INFO] Handling container configuration...');
        if (window.inspectContainerCallback) {
          window.inspectContainerCallback(response.data);
          window.inspectContainerCallback = null; // Reset the callback
        }
        break;

      case 'logs':
        console.log('[INFO] Handling logs output...');
        if (window.handleLogOutput) {
          window.handleLogOutput(response);
        }
        break;

      case 'systemInfo':
        console.log('[INFO] Handling system information...');
        updateSystemInfo(response.data);
        break;

      case 'images':
        console.log('[INFO] Handling images list...');
        renderImages(response.data);
        // Update dashboard stats if on dashboard view
        if (currentView === 'dashboard') {
          updateDashboardStats(null, response.data, null);
        }
        break;

      case 'networks':
        console.log('[INFO] Handling networks list...');
        renderNetworks(response.data);
        // Update dashboard stats if on dashboard view
        if (currentView === 'dashboard') {
          updateDashboardStats(null, null, response.data);
        }
        break;

      case 'volumes':
        console.log('[INFO] Handling volumes list...');
        // Store in cache and render
        let volumesToRender = null;
        if (response.data && Array.isArray(response.data)) {
          volumesToRender = response.data;
        } else if (response.volumes && Array.isArray(response.volumes)) {
          // Fallback for old format
          volumesToRender = response.volumes;
        }
        
        if (volumesToRender !== null) {
          // Always update store first (this will trigger subscriptions)
          volumesStore.set(volumesToRender);
          // Always render if on volumes view to ensure UI is updated
          if (currentView === 'volumes') {
            renderVolumes(volumesToRender);
          }
        } else {
          console.warn('[WARN] Received volumes message but no valid volumes data found');
        }
        break;

      case 'imageConfig':
        console.log(`[INFO] Handling imageConfig...`);
        if (response.data && window.pendingImageInspect) {
          const { imageId } = window.pendingImageInspect;
          delete window.pendingImageInspect;
          hideStatusIndicator();
          
          const modalTitle = document.getElementById('imageInspectModalLabel');
          if (modalTitle) {
            const repoTag = response.data.RepoTags?.[0] || imageId.substring(0, 12);
            modalTitle.innerHTML = `<i class="fas fa-info-circle me-2"></i>Image Information: ${repoTag}`;
          }
          
          formatAndPopulateImageModal(response.data);
          window.currentImageInspectConfig = response.data;
          
          const modal = new bootstrap.Modal(document.getElementById('imageInspectModal'));
          modal.show();
          
          document.getElementById('image-inspect-formatted-view').style.display = 'block';
          document.getElementById('image-inspect-json-view').style.display = 'none';
        }
        break;
        
      case 'networkConfig':
        console.log(`[INFO] Handling networkConfig...`);
        if (response.data && window.pendingNetworkInspect) {
          const { networkId } = window.pendingNetworkInspect;
          delete window.pendingNetworkInspect;
          hideStatusIndicator();
          
          const modalTitle = document.getElementById('networkInspectModalLabel');
          if (modalTitle) {
            const networkName = response.data.Name || networkId.substring(0, 12);
            modalTitle.innerHTML = `<i class="fas fa-info-circle me-2"></i>Network Information: ${networkName}`;
          }
          
          formatAndPopulateNetworkModal(response.data);
          window.currentNetworkInspectConfig = response.data;
          
          const modal = new bootstrap.Modal(document.getElementById('networkInspectModal'));
          modal.show();
          
          document.getElementById('network-inspect-formatted-view').style.display = 'block';
          document.getElementById('network-inspect-json-view').style.display = 'none';
        }
        break;
        
      case 'volumeConfig':
        console.log(`[INFO] Handling volumeConfig...`);
        if (response.data && window.pendingVolumeInspect) {
          const { volumeName } = window.pendingVolumeInspect;
          delete window.pendingVolumeInspect;
          hideStatusIndicator();
          
          const modalTitle = document.getElementById('volumeInspectModalLabel');
          if (modalTitle) {
            modalTitle.innerHTML = `<i class="fas fa-info-circle me-2"></i>Volume Information: ${volumeName}`;
          }
          
          formatAndPopulateVolumeModal(response.data);
          window.currentVolumeInspectConfig = response.data;
          
          const modal = new bootstrap.Modal(document.getElementById('volumeInspectModal'));
          modal.show();
          
          document.getElementById('volume-inspect-formatted-view').style.display = 'block';
          document.getElementById('volume-inspect-json-view').style.display = 'none';
        }
        break;

      default:
        // Check if this is a directory browser response (no type field, but has contents)
        if (response.success && Array.isArray(response.contents) && response.path !== undefined) {
          // This is a directory browser response, let the directory handler process it
          // Don't warn about it
        } 
        // Check if this is a volumes list response (no type field, but has volumes array)
        else if (response.success && Array.isArray(response.volumes)) {
          // This is a volumes list response, let the volume handler process it
          // Don't warn about it
        } else {
          console.warn(`[WARN] Unhandled response type: ${response.type}`);
        }
        break;
    }

    // Handle volumes responses - update cache and route to handlers if needed
    // Check for volumes in response (both new format with type and old format)
    // Note: This is a fallback for responses that weren't handled in the switch statement above
    // The 'volumes' case in the switch should have already handled type: 'volumes' responses
    let volumesArray = null;
    if (response && response.type !== 'volumes' && response.success === true && Array.isArray(response.volumes)) {
      // Old format volumes response that wasn't caught by switch
      volumesArray = response.volumes;
    }
    
    if (volumesArray !== null) {
      // Always update the cache first (this will trigger subscriptions)
      volumesStore.set(volumesArray);
      
      // Render if on volumes view
      if (currentView === 'volumes') {
        renderVolumes(volumesArray);
      }
      
      // Route to active volume selectors if they exist (for deploy modal)
      if (window.activeVolumeHandlers && window.activeVolumeHandlers.size > 0) {
        for (const [volumeId, handlerInfo] of window.activeVolumeHandlers.entries()) {
          const state = handlerInfo?.state;
          // Process if not received yet
          if (state && !state.volumesReceived) {
            if (handlerInfo.protectedHandler && typeof handlerInfo.protectedHandler === 'function') {
              handlerInfo.protectedHandler(response);
            } else if (handlerInfo.handler && typeof handlerInfo.handler === 'function') {
              handlerInfo.handler(response);
            }
          }
        }
      }
    }

    // Handle peer response callback if defined
    // This allows custom handlers (like directory browser) to process responses
    if (typeof window.handlePeerResponse === 'function') {
      window.handlePeerResponse(response);
    }
  } catch (err) {
    // Catch and log any parsing or processing errors
    console.error(`[ERROR] Failed to process peer data: ${err.message}`);
    console.error(`[DEBUG] Raw data received: ${data.toString()}`);
    showAlert('danger', 'Failed to process peer data. Check the console for details.');
  }
}







// Add a new connection - event listener set up in DOMContentLoaded

function addConnection(topicHex) {
  console.log(`[DEBUG] Adding connection with topic: ${topicHex}`);

  if (Object.keys(connections).length === 0) {
    hideWelcomePage();
  }

  const topic = b4a.from(topicHex, 'hex');
  const topicId = topicHex.substring(0, 12);

  connections[topicId] = { 
    topic, 
    peer: null, 
    swarm: null, 
    topicHex,
    alias: null,
    connectedAt: null,
    lastHealthCheck: null,
    latency: null,
    healthStatus: 'unknown'
  };
  saveConnections(); // Save updated connections to cookies

  const connectionItem = document.createElement('li');
  connectionItem.className = 'list-group-item d-flex align-items-center justify-content-between';
  connectionItem.dataset.topicId = topicId;
  const displayName = connections[topicId].alias || topicId;
  connectionItem.innerHTML = `
  <div class="connection-item row align-items-center px-2 py-1 border-bottom bg-dark text-light">
    <!-- Connection Info -->
    <div class="col-7 connection-info">
      <span class="d-flex align-items-center">
        <span class="connection-status ${connections[topicId].peer ? 'status-connected' : 'status-disconnected'}"></span>
        <span class="connection-name text-truncate">${displayName}</span>
        ${connections[topicId].latency ? `<small class="text-muted ms-1 flex-shrink-0">(${connections[topicId].latency}ms)</small>` : ''}
      </span>
    </div>
    <!-- Action Buttons -->
    <div class="col-5 d-flex justify-content-end flex-shrink-0">
      <div class="btn-group btn-group-sm">
        <button class="btn btn-outline-primary docker-terminal-btn p-1" title="Open Terminal">
          <i class="fas fa-terminal"></i>
        </button>
        <button class="btn btn-outline-danger disconnect-btn p-1" title="Disconnect">
          <i class="fas fa-plug"></i>
        </button>
      </div>
    </div>
  </div>
`;
  // Add Docker Terminal button event listener
  connectionItem.querySelector('.docker-terminal-btn')?.addEventListener('click', (event) => {
    event.stopPropagation();

    console.log('[DEBUG] Docker terminal button clicked.');

    if (!topicId) {
      console.error('[ERROR] Missing topicId. Cannot proceed.');
      return;
    }

    const connection = connections[topicId];
    console.log(`[DEBUG] Retrieved connection for topicId: ${topicId}`, connection);

    if (connection && connection.peer) {
      try {
        console.log(`[DEBUG] Starting Docker terminal for topicId: ${topicId}`);
        startDockerTerminal(topicId, connection.peer);

        const dockerTerminalModal = document.getElementById('dockerTerminalModal');
        if (dockerTerminalModal) {
          const modalInstance = new bootstrap.Modal(dockerTerminalModal);
          modalInstance.show();
          console.log('[DEBUG] Docker Terminal modal displayed.');
        } else {
          console.error('[ERROR] Docker Terminal modal not found in the DOM.');
        }
      } catch (error) {
        console.error(`[ERROR] Failed to start Docker CLI terminal for topicId: ${topicId}`, error);
      }
    } else {
      console.warn(`[WARNING] No active peer found for topicId: ${topicId}. Unable to start Docker CLI terminal.`);
    }
  });


  connectionItem.querySelector('span').addEventListener('click', () => switchConnection(topicId));
  connectionItem.querySelector('.disconnect-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    disconnectConnection(topicId, connectionItem);
  });
  refreshContainerStats();

  connectionList.appendChild(connectionItem);

  const swarm = new Hyperswarm();
  connections[topicId].swarm = swarm;

  swarm.join(topic, { client: true, server: false });

  swarm.on('connection', (peer) => {
    console.log(`[INFO] Connected to peer for topic: ${topicHex}`);
    if (connections[topicId].peer) {
      peer.destroy();
      return;
    }
    connections[topicId].peer = peer;
    connections[topicId].connectedAt = Date.now();
    connections[topicId].healthStatus = 'healthy';
    updateConnectionStatus(topicId, true);
    startHealthMonitoring(topicId);

    // Store peer data handler reference for cleanup
    const peerDataHandler = (data) => handlePeerData(data, topicId, peer);
    peer.on('data', peerDataHandler);
    connections[topicId].peerDataHandler = peerDataHandler; // Store for cleanup
    
    peer.on('close', () => {
      updateConnectionStatus(topicId, false);
      // Remove peer data handler
      if (connections[topicId] && connections[topicId].peerDataHandler) {
        peer.removeListener('data', connections[topicId].peerDataHandler);
        delete connections[topicId].peerDataHandler;
      }
      if (window.activePeer === peer) {
        window.activePeer = null;
        dashboard.classList.add('hidden');
        containerList.innerHTML = '';
        stopStatsInterval(); // Stop stats polling
      }
    });
    if (!window.activePeer) {
      switchConnection(topicId);
    }
    startStatsInterval();
    
    // Hide welcome page and show dashboard
    hideWelcomePage();
  });

  // Collapse the sidebar after adding a connection
  // Use cached DOM elements
  if (sidebar && !sidebar.classList.contains('collapsed')) {
    sidebar.classList.add('collapsed');
    if (collapseSidebarBtn) {
      collapseSidebarBtn.innerHTML = '&gt;';
    }
    console.log('[DEBUG] Sidebar collapsed after adding connection');
  }
}


// Function to open the template deploy modal
function openTemplateDeployModal(topicId) {
  // Pass the topic ID or other connection-specific info if needed
  console.log(`[INFO] Preparing template deploy modal for topic: ${topicId}`);

  // Ensure the modal fetches templates
  fetchTemplates(); // Refresh template list

  // Show the modal
  const templateDeployModal = new bootstrap.Modal(document.getElementById('templateDeployModal'));
  templateDeployModal.show();
}


// Initialize connections from cookies on page load
document.addEventListener('DOMContentLoaded', () => {
  // Initialize DOM elements immediately
  containerList = document.getElementById('container-list');
  connectionList = document.getElementById('connection-list');
  addConnectionForm = document.getElementById('add-connection-form');
  newConnectionTopic = document.getElementById('new-connection-topic');
  connectionTitle = document.getElementById('connection-title');
  dashboard = document.getElementById('dashboard');
  welcomePage = document.getElementById('welcome-page');
  sidebar = document.getElementById('sidebar');
  collapseSidebarBtn = document.getElementById('collapse-sidebar-btn');
  alertContainer = document.getElementById('alert-container');
  
  // Initialize modal elements
  duplicateModalElement = document.getElementById('duplicateModal');
  if (duplicateModalElement && typeof bootstrap !== 'undefined') {
    duplicateModal = new bootstrap.Modal(duplicateModalElement);
  }
  duplicateContainerForm = document.getElementById('duplicate-container-form');
  
  hideStatusIndicator();
  
  // Initialize notification tray early - available globally regardless of connection status
  initNotificationTray();
  
  // Set up deploy view form handler on DOMContentLoaded
  setTimeout(() => {
    setupDeployViewFormHandler();
    setupDeployStackHandler();
    setupBuildImageHandler();
    
    // Also add a direct button click handler as fallback
    const deployButton = document.querySelector('#deploy-view-form button[type="submit"]');
    if (deployButton) {
      deployButton.addEventListener('click', (e) => {
        e.preventDefault();
        const form = document.getElementById('deploy-view-form');
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      });
    }
  }, 500);
  
  // Set up event listeners that depend on DOM elements
  if (addConnectionForm) {
    addConnectionForm.addEventListener('submit', (e) => {
      e.preventDefault();

      const topicHex = newConnectionTopic ? newConnectionTopic.value.trim() : '';
      if (topicHex) {
        addConnection(topicHex);
        if (newConnectionTopic) {
          newConnectionTopic.value = '';
        }
      }
    });
  }
  
  // Set up sidebar collapse functionality
  if (collapseSidebarBtn) {
    collapseSidebarBtn.addEventListener('click', () => {
      if (sidebar) {
        sidebar.classList.toggle('collapsed');
        collapseSidebarBtn.innerHTML = sidebar.classList.contains('collapsed') ? '&gt;' : '&lt;';

        // Toggle Reset Connections Button Visibility
        const resetConnectionsBtn = sidebar.querySelector('.btn-danger');
        if (resetConnectionsBtn) {
          resetConnectionsBtn.style.display = sidebar.classList.contains('collapsed') ? 'none' : 'block';
        }
      }
    });
  }
  
  // Add Reset Connections Button
  if (sidebar) {
    const resetConnectionsBtn = document.createElement('button');
    resetConnectionsBtn.textContent = 'Reset Connections';
    resetConnectionsBtn.className = 'btn btn-danger w-100 mt-2';
    resetConnectionsBtn.addEventListener('click', () => {
      console.log('[INFO] Resetting connections and clearing storage.');
      Object.keys(connections).forEach((topicId) => {
        disconnectConnection(topicId);
      });
      deleteCookie('connections');
      // Also clear localStorage
      try {
        localStorage.removeItem(USE_LOCALSTORAGE_KEY);
        localStorage.removeItem(CONNECTIONS_STORAGE_KEY);
      } catch (err) {
        console.warn(`[WARN] Failed to clear localStorage: ${err.message}`);
      }
      resetConnectionsView();
      showWelcomePage();
      toggleResetButtonVisibility(); // Ensure button visibility is updated
    });
    sidebar.appendChild(resetConnectionsBtn);
  }
  
  // Show UI immediately - default to welcome page
  if (welcomePage) {
    welcomePage.classList.remove('hidden');
  }
  if (dashboard) {
    dashboard.classList.add('hidden');
  }
  
  // Initialize container filtering (lightweight, doesn't block)
  initContainerFiltering();
  
  // Initialize navigation
  initNavigation();
  
  // Notification tray will be initialized after connections are restored
  if (duplicateContainerForm) {
    duplicateContainerForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      let formData;
      try {
        formData = collectDuplicateFormData();
      } catch (collectError) {
        console.error('[ERROR] Failed to collect duplicate form data:', collectError);
        showAlert('danger', 'Failed to collect form data. Check console for details.');
        return;
      }

      // Validate required fields
      if (!formData.containerName || !formData.image) {
        showAlert('danger', 'Container name and image are required.');
        return;
      }

      // Get container name for notifications
      const containerName = formData.containerName || 'container';
      
      // Close modal immediately before async operation
      if (duplicateModal) {
        duplicateModal.hide();
      }
      closeAllModals();
      
      // Add notification for container creation
      notificationManager.add('info', `Creating container "${containerName}"...`, { autoDismiss: false });
      showStatusIndicator('Preparing container configuration...');
      
      try {
        // Use deployContainer command with the collected form data
        // This reuses the same deployment logic
        const originalHandler = window.handlePeerResponse;
        let timeoutId = null;
        let isResolved = false;

        const duplicateHandler = (response) => {
          if (isResolved) {
            if (typeof originalHandler === 'function') {
              originalHandler(response);
            }
            return;
          }

          const isDuplicateResponse = 
            (response.success && response.message && typeof response.message === 'string' && response.message.includes('deployed successfully')) ||
            (response.error && (
                (response.message && typeof response.message === 'string' && response.message.includes('deploy')) ||
                (typeof response.error === 'string' && (response.error.includes('deploy') || response.error.includes('Container')))
            ));

          if (isDuplicateResponse) {
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }

            window.handlePeerResponse = originalHandler;
            isResolved = true;

            if (response.success && response.message && response.message.includes('deployed successfully')) {
              // Update message to indicate we're transferring
              updateStatusIndicator('Transferring you to the container');
              // Update notification to success
              notificationManager.add('success', `Container "${formData.containerName}" created successfully!`);
              showAlert('success', `Container "${formData.containerName}" duplicated successfully!`);
              sendCommand('listContainers');
              
              // Hide spinner after a delay to allow navigation
              setTimeout(() => {
                hideStatusIndicator();
              }, 1500);
            } else if (response.error) {
              hideStatusIndicator();
              const errorMessage = typeof response.error === 'string' 
                ? response.error 
                : (response.error?.message || response.error?.toString() || 'Unknown error');
              // Update notification to error
              notificationManager.add('danger', `Failed to create container "${formData.containerName}"`);
              showAlert('danger', errorMessage);
            }
          } else {
            if (typeof originalHandler === 'function') {
              originalHandler(response);
            }
          }
        };

        window.handlePeerResponse = duplicateHandler;

        // Update message when starting deployment
        updateStatusIndicator('Creating container...');

        if (typeof window.sendCommand === 'function') {
          window.sendCommand('deployContainer', formData);
        } else {
          window.handlePeerResponse = originalHandler;
          hideStatusIndicator();
          showAlert('danger', 'sendCommand is not available. Please ensure app.js is loaded.');
          return;
        }

        timeoutId = setTimeout(() => {
          if (!isResolved) {
            window.handlePeerResponse = originalHandler;
            isResolved = true;
            hideStatusIndicator();
            // Update notification to timeout error
            notificationManager.add('danger', `Failed to create container "${containerName}" (timeout)`);
            showAlert('danger', 'Duplication timed out. No response from server.');
          }
        }, 60000);
      } catch (error) {
        hideStatusIndicator();
        console.error('[ERROR] Failed to duplicate container:', error);
        // Update notification to error
        notificationManager.add('danger', `Failed to create container "${containerName}"`);
        showAlert('danger', error.message || 'Failed to duplicate container. Check console for details.');
      }
    });
  }
  
  // Restore connections synchronously (like old version for faster boot)
  try {
    const savedConnections = loadConnections();
    console.log('[INFO] Loading saved connections:', savedConnections);

    // Restore saved connections with error handling
    Object.keys(savedConnections).forEach((topicId) => {
      try {
        let topicHex = savedConnections[topicId].topic;
        // Ensure topicHex is a string
        if (typeof topicHex !== 'string') {
          topicHex = b4a.toString(topicHex, 'hex');
        }
        addConnection(topicHex);
      } catch (err) {
        console.error(`[ERROR] Failed to restore connection ${topicId}: ${err.message}`);
      }
    });

    if (Object.keys(connections).length > 0) {
      hideWelcomePage();
      startStatsInterval(); // Start stats polling for active peers
    } else {
      showWelcomePage();
    }
    assertVisibility(); // Ensure visibility reflects the restored connections
    // Notification tray is already initialized globally in DOMContentLoaded
  } catch (err) {
    console.error(`[ERROR] Failed to initialize connections: ${err.message}`);
    showWelcomePage(); // Show welcome page on error
    // Notification tray is already initialized globally in DOMContentLoaded
  }
});


function disconnectConnection(topicId, connectionItem) {
  const connection = connections[topicId];
  if (!connection) {
    console.error(`[ERROR] No connection found for topicId: ${topicId}`);
    return;
  }

  // Clean up terminals
  if (window.openTerminals[topicId]) {
    console.log(`[INFO] Closing terminals for topic: ${topicId}`);
    window.openTerminals[topicId].forEach((terminalId) => {
      try {
        cleanUpTerminal(terminalId);
      } catch (err) {
        console.error(`[ERROR] Failed to clean up terminal ${terminalId}: ${err.message}`);
      }
    });
    delete window.openTerminals[topicId];
  }

  // Stop health monitoring
  if (connection.healthCheckInterval) {
    clearInterval(connection.healthCheckInterval);
  }
  
  // Destroy the peer and swarm
  if (connection.peer) {
    // Remove peer data handler before destroying
    if (connection.peerDataHandler) {
      connection.peer.removeListener('data', connection.peerDataHandler);
    }
    connection.peer.destroy();
  }
  if (connection.swarm) {
    connection.swarm.destroy();
  }

  // Remove from global connections
  delete connections[topicId];

  // Save the updated connections to cookies
  saveConnections();

  // Remove the connection item from the UI
  if (connectionItem) {
    connectionList.removeChild(connectionItem);
  }

  // Reset the connection title if this was the active peer
  if (window.activePeer === connection.peer) {
    window.activePeer = null;

    const connectionTitle = document.getElementById('connection-title');
    if (connectionTitle) {
      connectionTitle.textContent = 'Choose a Connection'; // Reset the title
    }

    const dashboard = document.getElementById('dashboard');
    if (dashboard) {
      dashboard.classList.add('hidden');
    }

    resetContainerList(); // Clear containers
  }

  // Show welcome page if no connections remain
  if (Object.keys(connections).length === 0) {
    showWelcomePage();
  }

  console.log(`[INFO] Disconnected and removed connection: ${topicId}`);
}


// Function to reset the container list
function resetContainerList() {
  containerList.innerHTML = ''; // Clear the existing list
  // Clean up smoothedStats for all containers when list is reset
  Object.keys(smoothedStats).forEach(containerId => {
    delete smoothedStats[containerId];
  });
  console.log('[INFO] Container list cleared.');
}

// Function to reset the connections view
function resetConnectionsView() {
  // Clear the connection list
  connectionList.innerHTML = '';

  // Re-populate the connection list from the `connections` object
  Object.keys(connections).forEach((topicId) => {
    const connectionItem = document.createElement('li');
    connectionItem.className = 'list-group-item d-flex align-items-center justify-content-between';
    connectionItem.dataset.topicId = topicId;
    connectionItem.innerHTML = `
        <span>
          <span class="connection-status ${connections[topicId].peer ? 'status-connected' : 'status-disconnected'}"></span>
        </span>
        <button class="btn btn-sm btn-danger disconnect-btn">Disconnect</button>
      `;

    // Add click event to switch connection
    connectionItem.querySelector('span').addEventListener('click', () => switchConnection(topicId));

    // Add click event to the disconnect button
    const disconnectBtn = connectionItem.querySelector('.disconnect-btn');
    disconnectBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent triggering the switch connection event
      disconnectConnection(topicId, connectionItem);
    });

    connectionList.appendChild(connectionItem);
  });

  console.log('[INFO] Connections view reset.');
}

// Update connection status
function updateConnectionStatus(topicId, isConnected) {
  const connectionItem = document.querySelector(`[data-topic-id="${topicId}"]`);
  if (connectionItem) {
    const statusElement = connectionItem.querySelector('.connection-status');
    if (statusElement) {
      statusElement.className = `connection-status ${isConnected ? 'status-connected' : 'status-disconnected'}`;
    }
  }
}

// Update connection display with alias and latency
function updateConnectionDisplay(topicId) {
  const connectionItem = document.querySelector(`[data-topic-id="${topicId}"]`);
  if (connectionItem) {
    const connection = connections[topicId];
    const nameElement = connectionItem.querySelector('.connection-name');
    const latencyElement = connectionItem.querySelector('.text-muted');
    
    if (nameElement) {
      nameElement.textContent = connection.alias || topicId;
    }
    
    if (latencyElement && connection.latency) {
      latencyElement.textContent = `(${connection.latency}ms)`;
    } else if (latencyElement && !connection.latency) {
      latencyElement.textContent = '';
    }
  }
}

// Health monitoring for connections
function startHealthMonitoring(topicId) {
  const connection = connections[topicId];
  if (!connection) return;
  
  const healthCheckInterval = setInterval(() => {
    if (!connections[topicId] || !connections[topicId].peer) {
      clearInterval(healthCheckInterval);
      return;
    }
    
    const startTime = Date.now();
    try {
      // Send a lightweight ping command
      connections[topicId].peer.write(JSON.stringify({ command: 'listContainers' }));
      
      // Set timeout for health check
      setTimeout(() => {
        if (connections[topicId]) {
          const elapsed = Date.now() - startTime;
          connections[topicId].latency = elapsed;
          connections[topicId].lastHealthCheck = Date.now();
          connections[topicId].healthStatus = elapsed < 5000 ? 'healthy' : 'slow';
          updateConnectionDisplay(topicId);
        }
      }, 100);
    } catch (err) {
      if (connections[topicId]) {
        connections[topicId].healthStatus = 'unhealthy';
        updateConnectionStatus(topicId, false);
      }
      clearInterval(healthCheckInterval);
    }
  }, 10000); // Check every 10 seconds
  
  // Store interval ID for cleanup
  connections[topicId].healthCheckInterval = healthCheckInterval;
}

// Switch between connections
function switchConnection(topicId) {
  const connection = connections[topicId];

  if (!connection || !connection.peer) {
    console.error('[ERROR] No connection found or no active peer.');
    showWelcomePage();
    stopStatsInterval(); // Stop stats interval if no active peer
    return;
  }

  // Update the active peer
  window.activePeer = connection.peer;

  // Clear container list before loading new data
  resetContainerList();

  console.log(`[INFO] Switched to connection: ${topicId}`);

  // Start the stats interval
  startStatsInterval();

  sendCommand('listContainers'); // Request containers for the new connection
}


// Attach switchConnection to the global window object
window.switchConnection = switchConnection;

// Send a command to the active peer
function sendCommand(command, args = {}) {
  if (window.activePeer) {
    const message = JSON.stringify({ command, args });
    console.log(`[DEBUG] Sending command to server: ${message}`);
    window.activePeer.write(message);
  } else {
    // Silently return during initialization - this is expected
    console.debug('[DEBUG] No active peer to send command (this is normal during initialization).');
  }
}

// Attach sendCommand to the global window object
window.sendCommand = sendCommand;

// Cache for DOM queries
const domCache = {
  containerList: null,
  connectionList: null,
  dashboard: null,
  welcomePage: null,
};

// Initialize DOM cache
function initDOMCache() {
  domCache.containerList = document.getElementById('container-list');
  domCache.connectionList = document.getElementById('connection-list');
  domCache.dashboard = document.getElementById('dashboard');
  domCache.welcomePage = document.getElementById('welcome-page');
}

// Initialize cache on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDOMCache);
} else {
  initDOMCache();
}

// Debounce utility
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Container filtering and sorting state
let containerFilterState = {
  search: '',
  status: 'all',
  sort: 'name-asc',
  allContainers: []
};

// Filter and sort containers
function filterAndSortContainers(containers) {
  let filtered = [...containers];
  
  // Apply search filter
  if (containerFilterState.search) {
    const searchLower = containerFilterState.search.toLowerCase();
    filtered = filtered.filter(container => {
      const name = container.Names[0]?.replace(/^\//, '') || '';
      const image = container.Image || '';
      return name.toLowerCase().includes(searchLower) || 
             image.toLowerCase().includes(searchLower);
    });
  }
  
  // Apply status filter
  if (containerFilterState.status !== 'all') {
    filtered = filtered.filter(container => {
      const state = container.State?.toLowerCase() || '';
      return state === containerFilterState.status.toLowerCase();
    });
  }
  
  // Apply sorting
  const [sortField, sortOrder] = containerFilterState.sort.split('-');
  filtered.sort((a, b) => {
    let aVal, bVal;
    
    switch (sortField) {
      case 'name':
        aVal = (a.Names[0]?.replace(/^\//, '') || '').toLowerCase();
        bVal = (b.Names[0]?.replace(/^\//, '') || '').toLowerCase();
        break;
      case 'cpu':
        aVal = smoothedStats[a.Id]?.cpu || 0;
        bVal = smoothedStats[b.Id]?.cpu || 0;
        break;
      case 'memory':
        aVal = smoothedStats[a.Id]?.memory || 0;
        bVal = smoothedStats[b.Id]?.memory || 0;
        break;
      default:
        return 0;
    }
    
    if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });
  
  return filtered;
}

// Helper function to truncate sha256 hash image names for display
function formatImageName(imageName) {
  if (!imageName || imageName === '-') {
    return imageName;
  }
  
  // Check if image name starts with sha256: and is a hash
  if (imageName.startsWith('sha256:')) {
    const hash = imageName.substring(7); // Remove 'sha256:' prefix
    // Check if it's a valid hex hash (64 characters for full SHA256)
    if (/^[a-f0-9]{64}$/i.test(hash)) {
      // Truncate to first 12 characters (standard Docker short hash) + '...'
      return `sha256:${hash.substring(0, 12)}...`;
    }
  }
  
  return imageName;
}

// Render the container list with optimized DOM manipulation
function renderContainers(containers, topicId) {
  if (!window.activePeer || !connections[topicId] || window.activePeer !== connections[topicId].peer) {
    console.warn('[WARN] Active peer mismatch or invalid connection. Skipping container rendering.');
    return;
  }

  console.log(`[INFO] Rendering ${containers.length} containers for topic: ${topicId}`);
  
  // Get current container IDs before clearing
  const currentContainerIds = new Set(containers.map(c => c.Id));
  
  // Clean up smoothedStats for containers that no longer exist
  Object.keys(smoothedStats).forEach(containerId => {
    if (!currentContainerIds.has(containerId)) {
      delete smoothedStats[containerId];
    }
  });
  
  // Filter and sort containers
  const filteredContainers = filterAndSortContainers(containers);
  
  // Use DocumentFragment for batch DOM updates
  const fragment = document.createDocumentFragment();
  const listElement = domCache.containerList || containerList;

  filteredContainers.forEach((container) => {
    const name = container.Names[0]?.replace(/^\//, '') || 'Unknown'; // Avoid undefined Names
    const image = formatImageName(container.Image || '-');
    const containerId = container.Id;
    const ipAddress = container.ipAddress || 'No IP Assigned';
    if (ipAddress === 'No IP Assigned') {
      console.warn(`[WARN] IP address missing for container ${container.Id}. Retrying...`);
      sendCommand('inspectContainer', { id: container.Id });
    }

    const row = document.createElement('tr');
    row.dataset.containerId = containerId; // Store container ID for reference
    const state = container.State || 'Unknown';
    const stateLower = state.toLowerCase();
    const statusClass = stateLower === 'running' ? 'status-running' : 
                        stateLower === 'exited' || stateLower === 'stopped' ? 'status-exited' :
                        stateLower === 'created' ? 'status-created' :
                        stateLower === 'restarting' ? 'status-restarting' : '';
    
    row.innerHTML = `
    <td>
      <input type="checkbox" class="container-checkbox" data-container-id="${containerId}">
    </td>
    <td>
      <div class="d-flex align-items-center gap-2">
        <span class="container-name-display" data-container-id="${containerId}" style="cursor: pointer; user-select: none;">${name}</span>
        <button class="btn btn-outline-info action-rename p-1" title="Rename" style="font-size: 0.75rem;">
          <i class="fas fa-edit"></i>
        </button>
        <a href="#" class="container-name-link d-none" data-container-id="${containerId}">${name}</a>
      </div>
    </td>
    <td>${image}</td>
    <td><span class="badge ${statusClass}">${state}</span></td>
    <td class="cpu">
      <div class="stats-container">
        <span class="stats-value">0.00%</span>
        <div class="stats-bar-container">
          <div class="stats-bar cpu-bar" style="width: 0%"></div>
        </div>
      </div>
    </td>
    <td class="memory">
      <div class="stats-container">
        <span class="stats-value">0.00 MB</span>
        <div class="stats-bar-container">
          <div class="stats-bar memory-bar" style="width: 0%"></div>
        </div>
      </div>
    </td>
    <td class="ip-address">${ipAddress}</td>
    <td>
      <div class="btn-group btn-group-sm">
        <button class="btn btn-outline-success action-start p-1" title="Start" ${container.State === 'running' ? 'disabled' : ''}>
          <i class="fas fa-play"></i>
        </button>
        <button class="btn btn-outline-info action-restart p-1" title="Restart" ${container.State !== 'running' ? 'disabled' : ''}>
          <i class="fas fa-redo"></i>
        </button>
        <button class="btn btn-outline-warning action-stop p-1" title="Stop" ${container.State !== 'running' ? 'disabled' : ''}>
          <i class="fas fa-stop"></i>
        </button>
        <button class="btn btn-outline-secondary action-pause p-1" title="Pause" ${container.State !== 'running' ? 'disabled' : ''}>
          <i class="fas fa-pause"></i>
        </button>
        <button class="btn btn-outline-primary action-logs p-1" title="Logs">
  <i class="fas fa-list-alt"></i>
</button>
        <button class="btn btn-outline-primary action-terminal p-1" title="Terminal" ${container.State !== 'running' ? 'disabled' : ''}>
          <i class="fas fa-terminal"></i>
        </button>
        <button class="btn btn-outline-info action-inspect p-1" title="Inspect">
          <i class="fas fa-info-circle"></i>
        </button>
        <button class="btn btn-outline-secondary action-duplicate p-1" title="Duplicate">
          <i class="fas fa-clone"></i>
        </button>
        <button class="btn btn-outline-danger action-remove p-1" title="Remove">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </td>
  `;

    fragment.appendChild(row);
    // Add event listener for checkbox
    const checkbox = row.querySelector('.container-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', () => updateBulkActionsToolbar());
    }
    // Add event listener for duplicate button
    const duplicateBtn = row.querySelector('.action-duplicate');
    duplicateBtn.addEventListener('click', () => openDuplicateModal(container));
    // Add event listener for clickable container name (hidden link for details view)
    const nameLink = row.querySelector('.container-name-link');
    if (nameLink) {
      nameLink.addEventListener('click', (e) => {
        e.preventDefault();
        showContainerDetails(container);
      });
    }
    
    // Add event listener for container name display (single click to view details)
    const nameDisplay = row.querySelector('.container-name-display');
    if (nameDisplay) {
      nameDisplay.addEventListener('click', (e) => {
        e.preventDefault();
        showContainerDetails(container);
      });
    }
    // Add event listeners for action buttons
    addActionListeners(row, container);
  });
  
  // Clear and append fragment in one operation
  listElement.innerHTML = '';
  listElement.appendChild(fragment);
}



function addActionListeners(row, container) {
  const startBtn = row.querySelector('.action-start');
  const stopBtn = row.querySelector('.action-stop');
  const pauseBtn = row.querySelector('.action-pause');
  const removeBtn = row.querySelector('.action-remove');
  const terminalBtn = row.querySelector('.action-terminal');
  const restartBtn = row.querySelector('.action-restart');
  const inspectBtn = row.querySelector('.action-inspect');
  const renameBtn = row.querySelector('.action-rename');
  const commitBtn = row.querySelector('.action-commit');
  const execBtn = row.querySelector('.action-exec');

  // Start Button
  startBtn.addEventListener('click', async () => {
    showStatusIndicator(`Starting container "${container.Names[0]}"...`);
    sendCommand('startContainer', { id: container.Id });

    const expectedMessageFragment = `Container ${container.Id} started`;

    try {
      const response = await waitForPeerResponse(expectedMessageFragment);
      console.log('[DEBUG] Start container response:', response);

      showAlert('success', response.message);

      // Refresh the container list to update states
      sendCommand('listContainers');

      // Restart stats interval
      startStatsInterval();
    } catch (error) {
      console.error('[ERROR] Failed to start container:', error.message);
      showAlert('danger', error.message || 'Failed to start container.');
    } finally {
      console.log('[DEBUG] Hiding status indicator in startBtn finally block');
      hideStatusIndicator();
    }
  });


  stopBtn.addEventListener('click', async () => {
    showStatusIndicator(`Stopping container "${container.Names[0]}"...`);
    sendCommand('stopContainer', { id: container.Id });

    const expectedMessageFragment = `Container ${container.Id} stopped`;

    try {
      const response = await waitForPeerResponse(expectedMessageFragment);
      console.log('[DEBUG] Stop container response:', response);

      showAlert('success', response.message);

      // Refresh the container list to update states
      sendCommand('listContainers');

      // Restart stats interval
      startStatsInterval();
    } catch (error) {
      console.error('[ERROR] Failed to stop container:', error.message);
      showAlert('danger', error.message || 'Failed to stop container.');
    } finally {
      console.log('[DEBUG] Hiding status indicator in stopBtn finally block');
      hideStatusIndicator();
    }
  });



  // Restart Button
  restartBtn.addEventListener('click', async () => {
    showStatusIndicator(`Restarting container "${container.Names[0]}"...`);
    sendCommand('restartContainer', { id: container.Id });

    const expectedMessageFragment = `Container ${container.Id} restarted`;

    try {
      const response = await waitForPeerResponse(expectedMessageFragment);
      console.log('[DEBUG] Restart container response:', response);

      showAlert('success', response.message);

      // Refresh the container list to update states
      sendCommand('listContainers');
    } catch (error) {
      console.error('[ERROR] Failed to restart container:', error.message);
      showAlert('danger', error.message || 'Failed to restart container.');
    } finally {
      console.log('[DEBUG] Hiding status indicator in restartBtn finally block');
      hideStatusIndicator();
    }
  });

  // Pause Button
  if (pauseBtn) {
    pauseBtn.addEventListener('click', async () => {
      showStatusIndicator(`Pausing container "${container.Names[0]}"...`);
      sendCommand('pauseContainer', { id: container.Id });

      const expectedMessageFragment = `Container ${container.Id} paused`;

      try {
        const response = await waitForPeerResponse(expectedMessageFragment);
        showAlert('success', response.message);
        sendCommand('listContainers');
      } catch (error) {
        console.error('[ERROR] Failed to pause container:', error.message);
        showAlert('danger', error.message || 'Failed to pause container.');
      } finally {
        hideStatusIndicator();
      }
    });
  }

  // Rename Button - Inline Edit
  if (renameBtn) {
    renameBtn.addEventListener('click', () => {
      const nameDisplay = row.querySelector('.container-name-display');
      if (!nameDisplay) return;
      
      const currentName = nameDisplay.textContent.trim();
      const originalName = currentName;
      
      // Create input field
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentName;
      input.className = 'form-control form-control-sm bg-dark text-white';
      input.style.width = '200px';
      input.style.display = 'inline-block';
      
      // Replace display with input
      const parent = nameDisplay.parentElement;
      const nameDisplayClone = nameDisplay.cloneNode(true);
      nameDisplay.style.display = 'none';
      parent.insertBefore(input, nameDisplay);
      
      // Focus and select
      input.focus();
      input.select();
      
      // Track rename state to prevent multiple attempts
      let isRenaming = false;
      let checkInterval = null;
      let originalHandler = null;
      
      // Save function
      const saveName = async () => {
        // Prevent multiple calls
        if (isRenaming) {
          return;
        }
        
        const newName = input.value.trim();
        
        // Early return if name is empty
        if (!newName) {
          showAlert('danger', 'Container name cannot be empty');
          parent.removeChild(input);
          nameDisplay.textContent = originalName;
          nameDisplay.style.display = '';
          return;
        }
        
        // Early return if name unchanged - no need to rename
        if (newName === originalName) {
          parent.removeChild(input);
          nameDisplay.style.display = '';
          return;
        }
        
        // Set renaming flag
        isRenaming = true;
        sendCommand('renameContainer', { id: container.Id, name: newName });

        const expectedMessageFragment = `Container renamed to "${newName}"`;
        let renameHandled = false;

        // Set up response handler
        originalHandler = window.handlePeerResponse;
        const responseHandler = (response) => {
          if (!renameHandled && response && response.success && response.message && response.message.includes(expectedMessageFragment)) {
            renameHandled = true;
            // Clear interval if it exists
            if (checkInterval) {
              clearInterval(checkInterval);
              checkInterval = null;
            }
            showAlert('success', response.message);
            sendCommand('listContainers');
            // Restore original handler
            if (typeof originalHandler === 'function') {
              window.handlePeerResponse = originalHandler;
            } else {
              window.handlePeerResponse = null;
            }
            isRenaming = false;
          } else if (typeof originalHandler === 'function') {
            originalHandler(response);
          }
        };
        
        window.handlePeerResponse = responseHandler;

        // Also listen for container list updates as confirmation (backup)
        checkInterval = setInterval(() => {
          const nameDisplays = document.querySelectorAll('.container-name-display');
          nameDisplays.forEach(display => {
            if (!renameHandled && display.textContent.trim() === newName && display.dataset.containerId === container.Id) {
              renameHandled = true;
              clearInterval(checkInterval);
              checkInterval = null;
              showAlert('success', `Container renamed to "${newName}"`);
              // Restore original handler
              if (typeof originalHandler === 'function') {
                window.handlePeerResponse = originalHandler;
              } else {
                window.handlePeerResponse = null;
              }
              isRenaming = false;
            }
          });
        }, 500);

        // Clean up interval after 10 seconds
        setTimeout(() => {
          if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
          }
          if (isRenaming) {
            isRenaming = false;
          }
        }, 10000);
        
        // Restore display immediately (input will be removed)
        parent.removeChild(input);
        nameDisplay.style.display = '';
      };
      
      // Cancel function
      const cancelEdit = () => {
        parent.removeChild(input);
        nameDisplay.style.display = '';
      };
      
      // Handle Enter key
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!isRenaming && input.parentElement) {
            saveName();
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelEdit();
        }
      });
      
      // Handle blur (click outside) - use setTimeout to allow other events to process first
      input.addEventListener('blur', () => {
        setTimeout(() => {
          // Only save if input is still in DOM and we're not already renaming
          if (!isRenaming && input.parentElement) {
            saveName();
          }
        }, 150);
      });
    });
  }

  const logsBtn = row.querySelector('.action-logs');
  logsBtn.addEventListener('click', () => openLogModal(container.Id));

  function openLogModal(containerId) {
    console.log(`[INFO] Opening logs modal for container: ${containerId}`);

    const modal = new bootstrap.Modal(document.getElementById('logsModal'));
    const logContainer = document.getElementById('logs-container');

    // Clear any existing logs
    logContainer.innerHTML = '';

    // Request previous logs
    sendCommand('logs', { id: containerId });

    // Listen for logs
    window.handleLogOutput = (logData) => {
      const logLine = atob(logData.data); // Decode base64 logs
      const logElement = document.createElement('pre');
      logElement.textContent = logLine;
      logContainer.appendChild(logElement);

      // Scroll to the bottom
      logContainer.scrollTop = logContainer.scrollHeight;
    };

    // Show the modal
    modal.show();
  }

  // Remove Button
  removeBtn.addEventListener('click', async () => {
    const deleteModal = new bootstrap.Modal(document.getElementById('deleteModal'));
    deleteModal.show();

    const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    confirmDeleteBtn.onclick = async () => {
      // Close modal immediately before async operation
      deleteModal.hide();
      closeAllModals();
      
      const containerName = container.Names[0]?.replace(/^\//, '') || container.Id.substring(0, 12);
      
      // Add notification for container deletion
      notificationManager.add('info', `Deleting container "${containerName}"...`, { autoDismiss: false });
      showStatusIndicator(`Deleting container "${container.Names[0]}"...`);

      // Check if the container has active terminals
      if (window.openTerminals[container.Id]) {
        console.log(`[INFO] Closing active terminals for container: ${container.Id}`);
        window.openTerminals[container.Id].forEach((terminalId) => {
          try {
            cleanUpTerminal(terminalId);
          } catch (err) {
            console.error(`[ERROR] Failed to clean up terminal ${terminalId}: ${err.message}`);
          }
        });
        delete window.openTerminals[container.Id];
      }

      // Hide the terminal modal if it is active
      const terminalModal = document.getElementById('terminal-modal');
      if (terminalModal.style.display === 'flex') {
        console.log(`[INFO] Hiding terminal modal for container: ${container.Id}`);
        terminalModal.style.display = 'none';
      }


      terminalModal.addEventListener('shown.bs.modal', () => {
        terminal.focus();
      });

      sendCommand('removeContainer', { id: container.Id });

      const expectedMessageFragment = `Container ${container.Id} removed`;

      try {
        const response = await waitForPeerResponse(expectedMessageFragment);
        console.log('[DEBUG] Remove container response:', response);

        // Update notification to success
        notificationManager.add('success', `Container "${containerName}" deleted successfully`);
        showAlert('success', response.message);

        // Refresh the container list to update states
        sendCommand('listContainers');
      } catch (error) {
        console.error('[ERROR] Failed to delete container:', error.message);
        // Update notification to error
        notificationManager.add('danger', `Failed to delete container "${containerName}"`);
        showAlert('danger', error.message || `Failed to delete container "${container.Names[0]}".`);
      } finally {
        console.log('[DEBUG] Hiding status indicator in removeBtn finally block');
        hideStatusIndicator();
      }
    };
  });


  terminalBtn.addEventListener('click', () => {
    console.log(`[DEBUG] Opening terminal for container ID: ${container.Id}`);
    try {
      startTerminal(container.Id, container.Names[0] || container.Id);
    } catch (error) {
      console.error(`[ERROR] Failed to start terminal for container ${container.Id}: ${error.message}`);
      showAlert('danger', `Failed to start terminal: ${error.message}`);
    }
  });

  // Inspect Button
  if (inspectBtn) {
    inspectBtn.addEventListener('click', () => {
      openInspectModal(container);
    });
  }
}


function updateContainerStats(stats) {
  if (!stats || !stats.id || typeof stats.cpu === 'undefined' || typeof stats.memory === 'undefined') {
    console.error('[ERROR] Invalid stats object:', stats);
    return;
  }

  console.log(`[DEBUG] Updating stats for container ID: ${stats.id}`);

  const row = containerList?.querySelector(`tr[data-container-id="${stats.id}"]`);
  if (row) {
    // Ensure the IP address is added or retained from existing row
    const existingIpAddress = row.querySelector('.ip-address')?.textContent || 'No IP Assigned';
    stats.ip = stats.ip || existingIpAddress;

    const smoothed = smoothStats(stats.id, stats);
    updateStatsUI(row, smoothed);
  }
  
  // Update container details stats if we're on that view
  if (currentView === 'container-details' && currentContainerDetails && currentContainerDetails.Id === stats.id) {
    const cpuEl = document.getElementById('detail-cpu');
    const memoryEl = document.getElementById('detail-memory');
    const smoothed = smoothStats(stats.id, stats);
    
    if (cpuEl) cpuEl.textContent = `${smoothed.cpu.toFixed(2)}%`;
    if (memoryEl) memoryEl.textContent = `${(smoothed.memory / (1024 * 1024)).toFixed(2)} MB`;
  }
}

// Batch stats updates
let pendingStatsUpdates = [];

// Debounced stats update function with visualization
const debouncedStatsUpdate = debounce((updates) => {
  requestAnimationFrame(() => {
    for (const { row, stats } of updates) {
      const cpuEl = row.querySelector('.cpu .stats-value');
      const cpuBar = row.querySelector('.cpu-bar');
      const memoryEl = row.querySelector('.memory .stats-value');
      const memoryBar = row.querySelector('.memory-bar');
      const ipEl = row.querySelector('.ip-address');
      
      if (cpuEl) {
        const cpuPercent = stats.cpu.toFixed(2) || '0.00';
        cpuEl.textContent = `${cpuPercent}%`;
        if (cpuBar) {
          // Cap at 100% for visualization
          const width = Math.min(100, parseFloat(cpuPercent));
          cpuBar.style.width = `${width}%`;
        }
      }
      
      if (memoryEl) {
        const memoryMB = (stats.memory / (1024 * 1024)).toFixed(2) || '0.00';
        memoryEl.textContent = `${memoryMB} MB`;
        if (memoryBar) {
          // Calculate memory percentage (assuming reasonable max of 8GB for visualization)
          const maxMemory = 8 * 1024 * 1024 * 1024; // 8GB
          const memoryPercent = Math.min(100, (stats.memory / maxMemory) * 100);
          memoryBar.style.width = `${memoryPercent}%`;
        }
      }
      
      if (ipEl) ipEl.textContent = stats.ip;
    }
  });
}, 100); // Debounce to 100ms

function updateStatsUI(row, stats) {
  pendingStatsUpdates.push({ row, stats });
  
  // Trigger debounced update
  debouncedStatsUpdate(pendingStatsUpdates);
  
  // Clear pending updates after processing (they're processed in the debounced function)
  setTimeout(() => {
    if (pendingStatsUpdates.length > 0) {
      pendingStatsUpdates = [];
    }
  }, 200);
}



// Function to open the Duplicate Modal with container configurations
function openDuplicateModal(container) {
  console.log(`[INFO] Opening Duplicate Modal for container: ${container.Id}`);

  showStatusIndicator('Fetching container configuration...');

  // Send a command to inspect the container
  sendCommand('inspectContainer', { id: container.Id });

  // Listen for the inspectContainer response
  window.inspectContainerCallback = (config) => {
    hideStatusIndicator();

    if (!config) {
      console.error('[ERROR] Failed to retrieve container configuration.');
      showAlert('danger', 'Failed to retrieve container configuration.');
      return;
    }

    console.log(`[DEBUG] Retrieved container configuration: ${JSON.stringify(config)}`);

    // Parse configuration and populate the accordion form
    try {
      // Clear the form first
      const form = document.getElementById('duplicate-container-form');
      if (form) form.reset();
      
      // Populate all fields using the helper function
      populateDuplicateForm(config);
      
      // Set up network mode change handler for duplicate modal
      const networkMode = document.getElementById('duplicate-network-mode');
      const customNetworkContainer = document.getElementById('duplicate-custom-network-container');
      if (networkMode && customNetworkContainer && networkMode.parentNode) {
        // Remove existing listeners by cloning and replacing
        const newNetworkMode = networkMode.cloneNode(true);
        networkMode.parentNode.replaceChild(newNetworkMode, networkMode);
        
        newNetworkMode.addEventListener('change', (e) => {
          if (e.target.value === 'container') {
            customNetworkContainer.style.display = 'block';
            const input = customNetworkContainer.querySelector('input');
            if (input) input.placeholder = 'container-name';
          } else if (e.target.value !== 'host' && e.target.value !== 'none' && e.target.value !== 'bridge') {
            customNetworkContainer.style.display = 'block';
            const input = customNetworkContainer.querySelector('input');
            if (input) input.placeholder = 'network-name';
          } else {
            customNetworkContainer.style.display = 'none';
          }
        });
      }

      // Show the duplicate modal
      if (duplicateModal) {
        duplicateModal.show();
      }
    } catch (error) {
      console.error(`[ERROR] Failed to populate modal fields: ${error.message}`);
      showAlert('danger', 'Failed to populate container configuration fields.');
    }
  };
}

// Function to open the Inspect Modal with container information
function openInspectModal(container) {
  console.log(`[INFO] Opening Inspect Modal for container: ${container.Id}`);

  showStatusIndicator('Fetching container information...');

  // Store the original callback if it exists
  const originalCallback = window.inspectContainerCallback;

  // Send a command to inspect the container
  sendCommand('inspectContainer', { id: container.Id });

  // Listen for the inspectContainer response
  window.inspectContainerCallback = (config) => {
    hideStatusIndicator();

    // Restore original callback
    window.inspectContainerCallback = originalCallback;

    if (!config) {
      console.error('[ERROR] Failed to retrieve container configuration.');
      showAlert('danger', 'Failed to retrieve container configuration.');
      return;
    }

    try {
      // Update modal title with container name
      const modalTitle = document.getElementById('containerInspectModalLabel');
      const containerName = container.Names[0]?.replace(/^\//, '') || container.Id.substring(0, 12);
      if (modalTitle) {
        modalTitle.innerHTML = `<i class="fas fa-info-circle me-2"></i>Container Information: ${containerName}`;
      }

      // Format and populate the modal
      formatAndPopulateInspectModal(config);

      // Store config for JSON view
      window.currentInspectConfig = config;

      // Show the modal
      const inspectModal = new bootstrap.Modal(document.getElementById('containerInspectModal'));
      inspectModal.show();

      // Reset view to formatted view
      document.getElementById('inspect-formatted-view').style.display = 'block';
      document.getElementById('inspect-json-view').style.display = 'none';
      document.getElementById('toggle-json-view').innerHTML = '<i class="fas fa-code"></i> Raw JSON';
    } catch (error) {
      console.error(`[ERROR] Failed to populate inspect modal: ${error.message}`);
      showAlert('danger', 'Failed to populate container information.');
    }
  };
}

// Format and populate the inspect modal with container configuration
function formatAndPopulateInspectModal(config) {
  // Overview Section
  populateOverviewSection(config);
  
  // Configuration Section
  populateConfigSection(config);
  
  // Networking Section
  populateNetworkingSection(config);
  
  // Storage Section
  populateStorageSection(config);
  
  // Resources Section
  populateResourcesSection(config);
  
  // Security Section
  populateSecuritySection(config);
  
  // Runtime Section
  populateRuntimeSection(config);
  
  // Health & Logging Section
  populateHealthSection(config);
  
  // Labels & Metadata Section
  populateLabelsSection(config);
}

// Helper function to render key-value pairs
function renderKeyValue(key, value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  return `
    <div class="inspect-key-value">
      <div class="inspect-key">${escapeHtml(key)}</div>
      <div class="inspect-value">${formatValue(value)}</div>
    </div>
  `;
}

// Helper function to format values
function formatValue(value) {
  if (value === null || value === undefined) {
    return '<span class="text-muted">Not set</span>';
  }
  if (typeof value === 'boolean') {
    const badgeClass = value ? 'inspect-badge-success' : 'inspect-badge-danger';
    const text = value ? 'Yes' : 'No';
    return `<span class="inspect-badge ${badgeClass}">${text}</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '<span class="text-muted">None</span>';
    }
    return `<ul class="inspect-list">${value.map(item => `<li class="inspect-list-item">${escapeHtml(String(item))}</li>`).join('')}</ul>`;
  }
  if (typeof value === 'object') {
    return `<pre style="margin: 0; font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  }
  return escapeHtml(String(value));
}

// Helper function to escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Populate Overview Section
function populateOverviewSection(config) {
  const content = document.getElementById('inspect-overview-content');
  if (!content) return;

  const name = config.Name?.replace(/^\//, '') || 'Unknown';
  const image = config.Config?.Image || 'Unknown';
  const state = config.State?.Status || 'Unknown';
  const created = config.Created ? new Date(config.Created).toLocaleString() : 'Unknown';
  const started = config.State?.StartedAt ? new Date(config.State.StartedAt).toLocaleString() : 'Not started';
  const id = config.Id || 'Unknown';
  const restartCount = config.RestartCount || 0;

  content.innerHTML = `
    ${renderKeyValue('Name', name)}
    ${renderKeyValue('ID', id.substring(0, 12))}
    ${renderKeyValue('Image', image)}
    ${renderKeyValue('Status', state)}
    ${renderKeyValue('Created', created)}
    ${renderKeyValue('Started', started)}
    ${renderKeyValue('Restart Count', restartCount)}
  `;
}

// Populate Configuration Section
function populateConfigSection(config) {
  const content = document.getElementById('inspect-config-content');
  if (!content) return;

  const cmd = config.Config?.Cmd || [];
  const entrypoint = config.Config?.Entrypoint || [];
  const workingDir = config.Config?.WorkingDir || '';
  const user = config.Config?.User || '';
  const env = config.Config?.Env || [];
  const exposedPorts = config.Config?.ExposedPorts ? Object.keys(config.Config.ExposedPorts) : [];

  let html = '';
  html += renderKeyValue('Command', cmd.length > 0 ? cmd.join(' ') : 'Not set');
  html += renderKeyValue('Entrypoint', entrypoint.length > 0 ? entrypoint.join(' ') : 'Not set');
  html += renderKeyValue('Working Directory', workingDir);
  html += renderKeyValue('User', user);
  html += renderKeyValue('Environment Variables', env);
  html += renderKeyValue('Exposed Ports', exposedPorts);

  content.innerHTML = html || '<div class="inspect-section-empty">No configuration data available</div>';
}

// Populate Networking Section
function populateNetworkingSection(config) {
  const content = document.getElementById('inspect-networking-content');
  if (!content) return;

  const networkMode = config.HostConfig?.NetworkMode || 'default';
  const networks = config.NetworkSettings?.Networks || {};
  const ports = config.NetworkSettings?.Ports || {};
  const dns = config.HostConfig?.Dns || [];
  const extraHosts = config.HostConfig?.ExtraHosts || [];

  // Format port bindings
  const portBindings = [];
  if (ports) {
    Object.keys(ports).forEach(port => {
      const bindings = ports[port];
      if (bindings && bindings.length > 0) {
        bindings.forEach(binding => {
          portBindings.push(`${binding.HostIp || '0.0.0.0'}:${binding.HostPort} -> ${port}`);
        });
      }
    });
  }

  // Format network IPs
  const networkIPs = [];
  Object.keys(networks).forEach(netName => {
    const net = networks[netName];
    if (net.IPAddress) {
      networkIPs.push(`${netName}: ${net.IPAddress}`);
    }
  });

  let html = '';
  html += renderKeyValue('Network Mode', networkMode);
  html += renderKeyValue('IP Addresses', networkIPs.length > 0 ? networkIPs : ['No IP assigned']);
  html += renderKeyValue('Port Mappings', portBindings.length > 0 ? portBindings : ['No port mappings']);
  html += renderKeyValue('DNS Servers', dns);
  html += renderKeyValue('Extra Hosts', extraHosts);

  content.innerHTML = html || '<div class="inspect-section-empty">No networking data available</div>';
}

// Populate Storage Section
function populateStorageSection(config) {
  const content = document.getElementById('inspect-storage-content');
  if (!content) return;

  const mounts = config.Mounts || [];
  const binds = config.HostConfig?.Binds || [];
  const tmpfs = config.HostConfig?.Tmpfs || {};

  // Format mounts
  const mountList = mounts.map(mount => {
    return `${mount.Source} -> ${mount.Destination} (${mount.Type}${mount.Mode ? ', ' + mount.Mode : ''})`;
  });

  // Format tmpfs
  const tmpfsList = Object.keys(tmpfs).map(path => {
    return `${path}: ${tmpfs[path]}`;
  });

  let html = '';
  html += renderKeyValue('Volume Mounts', mountList.length > 0 ? mountList : binds);
  html += renderKeyValue('Tmpfs Mounts', tmpfsList.length > 0 ? tmpfsList : ['None']);

  content.innerHTML = html || '<div class="inspect-section-empty">No storage data available</div>';
}

// Populate Resources Section
function populateResourcesSection(config) {
  const content = document.getElementById('inspect-resources-content');
  if (!content) return;

  const cpuShares = config.HostConfig?.CpuShares || 0;
  const cpuQuota = config.HostConfig?.CpuQuota || 0;
  const cpuPeriod = config.HostConfig?.CpuPeriod || 0;
  const memory = config.HostConfig?.Memory || 0;
  const memorySwap = config.HostConfig?.MemorySwap || 0;
  const memoryReservation = config.HostConfig?.MemoryReservation || 0;
  const devices = config.HostConfig?.Devices || [];
  const cpusetCpus = config.HostConfig?.CpusetCpus || '';
  const cpusetMems = config.HostConfig?.CpusetMems || '';

  // Format CPU
  let cpuInfo = '';
  if (cpuQuota > 0 && cpuPeriod > 0) {
    cpuInfo = `${(cpuQuota / cpuPeriod).toFixed(2)} cores`;
  } else if (cpuShares > 0) {
    cpuInfo = `${cpuShares} shares`;
  } else {
    cpuInfo = 'Unlimited';
  }

  // Format memory
  const formatMemory = (bytes) => {
    if (bytes === 0) return 'Unlimited';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  // Format devices
  const deviceList = devices.map(device => {
    return `${device.PathOnHost} -> ${device.PathInContainer}${device.CgroupPermissions ? ' (' + device.CgroupPermissions + ')' : ''}`;
  });

  let html = '';
  html += renderKeyValue('CPU Limit', cpuInfo);
  html += renderKeyValue('CPU Shares', cpuShares > 0 ? cpuShares : 'Default');
  html += renderKeyValue('CPU Set CPUs', cpusetCpus || 'All');
  html += renderKeyValue('CPU Set Memory', cpusetMems || 'All');
  html += renderKeyValue('Memory Limit', formatMemory(memory));
  html += renderKeyValue('Memory Reservation', formatMemory(memoryReservation));
  html += renderKeyValue('Memory Swap', formatMemory(memorySwap));
  html += renderKeyValue('Device Mappings', deviceList.length > 0 ? deviceList : ['None']);

  content.innerHTML = html || '<div class="inspect-section-empty">No resource data available</div>';
}

// Populate Security Section
function populateSecuritySection(config) {
  const content = document.getElementById('inspect-security-content');
  if (!content) return;

  const privileged = config.HostConfig?.Privileged || false;
  const readonlyRootfs = config.HostConfig?.ReadonlyRootfs || false;
  const capabilities = config.HostConfig?.CapAdd || [];
  const securityOpts = config.HostConfig?.SecurityOpt || [];
  const user = config.Config?.User || '';

  let html = '';
  html += renderKeyValue('Privileged Mode', privileged);
  html += renderKeyValue('Read-only Root Filesystem', readonlyRootfs);
  html += renderKeyValue('User', user || 'Default');
  html += renderKeyValue('Added Capabilities', capabilities.length > 0 ? capabilities : ['None']);
  html += renderKeyValue('Security Options', securityOpts.length > 0 ? securityOpts : ['None']);

  content.innerHTML = html || '<div class="inspect-section-empty">No security data available</div>';
}

// Populate Runtime Section
function populateRuntimeSection(config) {
  const content = document.getElementById('inspect-runtime-content');
  if (!content) return;

  const restartPolicy = config.HostConfig?.RestartPolicy?.Name || 'no';
  const restartMaxRetries = config.HostConfig?.RestartPolicy?.MaximumRetryCount || 0;
  const autoRemove = config.HostConfig?.AutoRemove || false;
  const tty = config.Config?.Tty || false;
  const stdinOpen = config.Config?.OpenStdin || false;
  const attachStdin = config.Config?.AttachStdin || false;
  const attachStdout = config.Config?.AttachStdout || false;
  const attachStderr = config.Config?.AttachStderr || false;
  const init = config.HostConfig?.Init || false;

  let html = '';
  html += renderKeyValue('Restart Policy', restartPolicy + (restartMaxRetries > 0 ? ` (max retries: ${restartMaxRetries})` : ''));
  html += renderKeyValue('Auto Remove', autoRemove);
  html += renderKeyValue('TTY', tty);
  html += renderKeyValue('Interactive (Stdin Open)', stdinOpen);
  html += renderKeyValue('Init Process', init);
  html += renderKeyValue('Attach Stdin', attachStdin);
  html += renderKeyValue('Attach Stdout', attachStdout);
  html += renderKeyValue('Attach Stderr', attachStderr);

  content.innerHTML = html || '<div class="inspect-section-empty">No runtime data available</div>';
}

// Populate Health & Logging Section
function populateHealthSection(config) {
  const content = document.getElementById('inspect-health-content');
  if (!content) return;

  const healthcheck = config.Config?.Healthcheck || null;
  const logDriver = config.HostConfig?.LogConfig?.Type || 'default';
  const logOpts = config.HostConfig?.LogConfig?.Config || {};

  let html = '';
  
  if (healthcheck) {
    const test = healthcheck.Test || [];
    const interval = healthcheck.Interval || 0;
    const timeout = healthcheck.Timeout || 0;
    const retries = healthcheck.Retries || 0;
    const startPeriod = healthcheck.StartPeriod || 0;

    html += renderKeyValue('Health Check Command', test.length > 0 ? test.join(' ') : 'Not set');
    html += renderKeyValue('Health Check Interval', interval > 0 ? `${interval / 1000000000}s` : 'Not set');
    html += renderKeyValue('Health Check Timeout', timeout > 0 ? `${timeout / 1000000000}s` : 'Not set');
    html += renderKeyValue('Health Check Retries', retries);
    html += renderKeyValue('Health Check Start Period', startPeriod > 0 ? `${startPeriod / 1000000000}s` : 'Not set');
  } else {
    html += renderKeyValue('Health Check', 'Not configured');
  }

  html += renderKeyValue('Log Driver', logDriver);
  html += renderKeyValue('Log Options', Object.keys(logOpts).length > 0 ? logOpts : {});

  content.innerHTML = html || '<div class="inspect-section-empty">No health or logging data available</div>';
}

// Populate Labels & Metadata Section
function populateLabelsSection(config) {
  const content = document.getElementById('inspect-labels-content');
  if (!content) return;

  const labels = config.Config?.Labels || {};
  const created = config.Created ? new Date(config.Created).toLocaleString() : 'Unknown';
  const path = config.Path || '';
  const args = config.Args || [];
  const driver = config.Driver || '';

  // Format labels
  const labelList = Object.keys(labels).map(key => `${key}=${labels[key]}`);

  let html = '';
  html += renderKeyValue('Labels', labelList.length > 0 ? labelList : ['None']);
  html += renderKeyValue('Created', created);
  html += renderKeyValue('Path', path);
  html += renderKeyValue('Arguments', args.length > 0 ? args : ['None']);
  html += renderKeyValue('Driver', driver);

  content.innerHTML = html || '<div class="inspect-section-empty">No labels or metadata available</div>';
}

// ============ Image Inspect Functions ============

function openImageInspectModal(imageId) {
  console.log(`[INFO] Opening Image Inspect Modal for image: ${imageId}`);
  showStatusIndicator('Fetching image information...');
  sendCommand('inspectImage', { id: imageId });
  window.pendingImageInspect = { imageId };
}

function formatAndPopulateImageModal(config) {
  if (!config) return;
  
  // Store config for JSON view
  window.currentImageInspectConfig = config;
  
  // Populate Overview
  populateImageOverviewSection(config);
  
  // Populate Configuration
  populateImageConfigSection(config);
  
  // Populate History & Layers
  populateImageHistorySection(config);
}

function populateImageOverviewSection(config) {
  const content = document.getElementById('image-overview-content');
  if (!content) return;
  
  const id = config.Id || 'Unknown';
  const tags = config.RepoTags || [];
  const size = config.Size || 0;
  const virtualSize = config.VirtualSize || 0;
  const created = config.Created ? new Date(config.Created).toLocaleString() : 'Unknown';
  const architecture = config.Architecture || 'Unknown';
  const os = config.Os || 'Unknown';
  
  const formatSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };
  
  let html = '';
  html += renderKeyValue('ID', id.substring(0, 12));
  html += renderKeyValue('Tags', tags.length > 0 ? tags : ['<none>']);
  html += renderKeyValue('Size', formatSize(size));
  html += renderKeyValue('Virtual Size', formatSize(virtualSize));
  html += renderKeyValue('Created', created);
  html += renderKeyValue('Architecture', architecture);
  html += renderKeyValue('OS', os);
  
  content.innerHTML = html || '<div class="inspect-section-empty">No overview data available</div>';
}

function populateImageConfigSection(config) {
  const content = document.getElementById('image-config-content');
  if (!content) return;
  
  const cmd = config.Config?.Cmd || [];
  const entrypoint = config.Config?.Entrypoint || [];
  const env = config.Config?.Env || [];
  const exposedPorts = config.Config?.ExposedPorts ? Object.keys(config.Config.ExposedPorts) : [];
  const workingDir = config.Config?.WorkingDir || '';
  const user = config.Config?.User || '';
  const labels = config.Config?.Labels || {};
  
  let html = '';
  html += renderKeyValue('Command', cmd.length > 0 ? cmd.join(' ') : 'Not set');
  html += renderKeyValue('Entrypoint', entrypoint.length > 0 ? entrypoint.join(' ') : 'Not set');
  html += renderKeyValue('Working Directory', workingDir || 'Not set');
  html += renderKeyValue('User', user || 'Default');
  html += renderKeyValue('Environment Variables', env.length > 0 ? env : ['None']);
  html += renderKeyValue('Exposed Ports', exposedPorts.length > 0 ? exposedPorts : ['None']);
  
  const labelList = Object.keys(labels).map(key => `${key}=${labels[key]}`);
  html += renderKeyValue('Labels', labelList.length > 0 ? labelList : ['None']);
  
  content.innerHTML = html || '<div class="inspect-section-empty">No configuration data available</div>';
}

function populateImageHistorySection(config) {
  const content = document.getElementById('image-history-content');
  if (!content) return;
  
  const rootfs = config.RootFS || {};
  const layers = rootfs.Layers || [];
  const history = config.History || [];
  
  let html = '';
  
  if (layers.length > 0) {
    html += '<div class="mb-3"><strong>Layers:</strong></div>';
    html += '<ul class="inspect-list">';
    layers.forEach((layer, index) => {
      html += `<li class="inspect-list-item">${layer.substring(0, 20)}...</li>`;
    });
    html += '</ul>';
  }
  
  if (history.length > 0) {
    html += '<div class="mt-3"><strong>History:</strong></div>';
    history.forEach((h, index) => {
      if (h.created) {
        html += `<div class="mb-2"><strong>${new Date(h.created * 1000).toLocaleString()}:</strong></div>`;
        html += `<div class="text-muted mb-3">${h.created_by || 'Unknown command'}</div>`;
      }
    });
  }
  
  content.innerHTML = html || '<div class="inspect-section-empty">No history or layer data available</div>';
}

// ============ Network Inspect Functions ============

function openNetworkInspectModal(networkId) {
  console.log(`[INFO] Opening Network Inspect Modal for network: ${networkId}`);
  showStatusIndicator('Fetching network information...');
  sendCommand('inspectNetwork', { id: networkId });
  window.pendingNetworkInspect = { networkId };
}

function formatAndPopulateNetworkModal(config) {
  if (!config) return;
  
  // Store config for JSON view
  window.currentNetworkInspectConfig = config;
  
  // Populate Overview
  populateNetworkOverviewSection(config);
  
  // Populate Configuration
  populateNetworkConfigSection(config);
  
  // Populate Containers
  populateNetworkContainersSection(config);
}

function populateNetworkOverviewSection(config) {
  const content = document.getElementById('network-overview-content');
  if (!content) return;
  
  const id = config.Id || 'Unknown';
  const name = config.Name || 'Unknown';
  const driver = config.Driver || 'Unknown';
  const scope = config.Scope || 'local';
  const created = config.Created ? new Date(config.Created).toLocaleString() : 'Unknown';
  const internal = config.Internal || false;
  const attachable = config.Attachable || false;
  
  let html = '';
  html += renderKeyValue('ID', id.substring(0, 12));
  html += renderKeyValue('Name', name);
  html += renderKeyValue('Driver', driver);
  html += renderKeyValue('Scope', scope);
  html += renderKeyValue('Created', created);
  html += renderKeyValue('Internal', internal);
  html += renderKeyValue('Attachable', attachable);
  
  content.innerHTML = html || '<div class="inspect-section-empty">No overview data available</div>';
}

function populateNetworkConfigSection(config) {
  const content = document.getElementById('network-config-content');
  if (!content) return;
  
  const ipam = config.IPAM || {};
  const ipamConfig = ipam.Config || [];
  const options = config.Options || {};
  const labels = config.Labels || {};
  const enableIPv6 = config.EnableIPv6 || false;
  
  let html = '';
  
  if (ipamConfig.length > 0) {
    html += '<div class="mb-3"><strong>IPAM Configuration:</strong></div>';
    ipamConfig.forEach((ipam, index) => {
      if (ipam.Subnet) html += renderKeyValue(`Subnet ${index + 1}`, ipam.Subnet);
      if (ipam.Gateway) html += renderKeyValue(`Gateway ${index + 1}`, ipam.Gateway);
      if (ipam.IPRange) html += renderKeyValue(`IP Range ${index + 1}`, ipam.IPRange);
    });
  }
  
  html += renderKeyValue('Enable IPv6', enableIPv6);
  html += renderKeyValue('Options', Object.keys(options).length > 0 ? options : {});
  
  const labelList = Object.keys(labels).map(key => `${key}=${labels[key]}`);
  html += renderKeyValue('Labels', labelList.length > 0 ? labelList : ['None']);
  
  content.innerHTML = html || '<div class="inspect-section-empty">No configuration data available</div>';
}

function populateNetworkContainersSection(config) {
  const content = document.getElementById('network-containers-content');
  if (!content) return;
  
  const containers = config.Containers || {};
  const containerList = Object.keys(containers).map(key => {
    const container = containers[key];
    return `${container.Name || key}: ${container.IPv4Address || 'No IP'}`;
  });
  
  let html = '';
  html += renderKeyValue('Connected Containers', containerList.length > 0 ? containerList : ['None']);
  
  content.innerHTML = html || '<div class="inspect-section-empty">No container data available</div>';
}

// ============ Volume Inspect Functions ============

function openVolumeInspectModal(volumeName) {
  console.log(`[INFO] Opening Volume Inspect Modal for volume: ${volumeName}`);
  showStatusIndicator('Fetching volume information...');
  sendCommand('inspectVolume', { name: volumeName });
  window.pendingVolumeInspect = { volumeName };
}

function formatAndPopulateVolumeModal(config) {
  if (!config) return;
  
  // Store config for JSON view
  window.currentVolumeInspectConfig = config;
  
  // Populate Overview
  populateVolumeOverviewSection(config);
  
  // Populate Configuration
  populateVolumeConfigSection(config);
  
  // Populate Usage (if available from volumes store)
  populateVolumeUsageSection(config);
}

function populateVolumeOverviewSection(config) {
  const content = document.getElementById('volume-overview-content');
  if (!content) return;
  
  const name = config.Name || 'Unknown';
  const driver = config.Driver || 'Unknown';
  const mountpoint = config.Mountpoint || 'Unknown';
  const created = config.CreatedAt ? new Date(config.CreatedAt).toLocaleString() : 'Unknown';
  const scope = config.Scope || 'local';
  
  let html = '';
  html += renderKeyValue('Name', name);
  html += renderKeyValue('Driver', driver);
  html += renderKeyValue('Mountpoint', mountpoint);
  html += renderKeyValue('Created', created);
  html += renderKeyValue('Scope', scope);
  
  content.innerHTML = html || '<div class="inspect-section-empty">No overview data available</div>';
}

function populateVolumeConfigSection(config) {
  const content = document.getElementById('volume-config-content');
  if (!content) return;
  
  const options = config.Options || {};
  const labels = config.Labels || {};
  
  let html = '';
  html += renderKeyValue('Driver Options', Object.keys(options).length > 0 ? options : {});
  
  const labelList = Object.keys(labels).map(key => `${key}=${labels[key]}`);
  html += renderKeyValue('Labels', labelList.length > 0 ? labelList : ['None']);
  
  content.innerHTML = html || '<div class="inspect-section-empty">No configuration data available</div>';
}

function populateVolumeUsageSection(config) {
  const content = document.getElementById('volume-usage-content');
  if (!content) return;
  
  // Try to get usage from volumes store
  const volumesStore = window.volumesStore;
  let usage = [];
  
  if (volumesStore && volumesStore.data) {
    const volume = volumesStore.data.find(v => v.Name === config.Name);
    if (volume && volume.Usage) {
      usage = volume.Usage.map(u => `${u.containerName} (${u.mountPoint})`);
    }
  }
  
  let html = '';
  html += renderKeyValue('Used By Containers', usage.length > 0 ? usage : ['Not in use']);
  
  content.innerHTML = html || '<div class="inspect-section-empty">No usage data available</div>';
}

// ============ Stack Inspect Functions ============

function openStackInspectModal(stackName) {
  console.log(`[INFO] Opening Stack Inspect Modal for stack: ${stackName}`);
  showStatusIndicator('Fetching stack information...');
  
  // Get stack data from current stacks list
  if (window.currentStacksData) {
    const stack = window.currentStacksData.find(s => s.name === stackName);
    if (stack) {
      formatAndPopulateStackModal(stack);
      const modal = new bootstrap.Modal(document.getElementById('stackInspectModal'));
      modal.show();
      hideStatusIndicator();
      return;
    }
  }
  
  // If not in cache, reload stacks
  sendCommand('listStacks');
  window.pendingStackInspect = { stackName };
}

function formatAndPopulateStackModal(stackData) {
  if (!stackData) return;
  
  // Store data for JSON view
  window.currentStackInspectConfig = stackData;
  
  // Populate Overview
  populateStackOverviewSection(stackData);
  
  // Populate Services
  populateStackServicesSection(stackData);
  
  // Populate Containers
  populateStackContainersSection(stackData);
}

function populateStackOverviewSection(stackData) {
  const content = document.getElementById('stack-overview-content');
  if (!content) return;
  
  const name = stackData.name || 'Unknown';
  const services = stackData.services || [];
  const containers = stackData.containers || [];
  const runningCount = containers.filter(c => c.state === 'running').length;
  const totalCount = containers.length;
  
  let html = '';
  html += renderKeyValue('Stack Name', name);
  html += renderKeyValue('Services', services.length > 0 ? services.join(', ') : 'None');
  html += renderKeyValue('Total Containers', totalCount);
  html += renderKeyValue('Running Containers', runningCount);
  html += renderKeyValue('Status', runningCount === totalCount && totalCount > 0 ? 'All running' : `${runningCount}/${totalCount} running`);
  
  content.innerHTML = html || '<div class="inspect-section-empty">No overview data available</div>';
}

function populateStackServicesSection(stackData) {
  const content = document.getElementById('stack-services-content');
  if (!content) return;
  
  const services = stackData.services || [];
  
  let html = '';
  if (services.length > 0) {
    html += '<ul class="inspect-list">';
    services.forEach(service => {
      html += `<li class="inspect-list-item">${service}</li>`;
    });
    html += '</ul>';
  } else {
    html = '<div class="inspect-section-empty">No services defined</div>';
  }
  
  content.innerHTML = html;
}

function populateStackContainersSection(stackData) {
  const content = document.getElementById('stack-containers-content');
  if (!content) return;
  
  const containers = stackData.containers || [];
  
  let html = '';
  if (containers.length > 0) {
    html += '<ul class="inspect-list">';
    containers.forEach(container => {
      const stateBadge = container.state === 'running' ? 'text-success' : 'text-danger';
      html += `<li class="inspect-list-item">
        <strong>${container.name}</strong> 
        <span class="${stateBadge}">(${container.state})</span>
        <br><small class="text-muted">Image: ${container.image}</small>
      </li>`;
    });
    html += '</ul>';
  } else {
    html = '<div class="inspect-section-empty">No containers in stack</div>';
  }
  
  content.innerHTML = html;
}


function showWelcomePage() {
  // Use cached DOM elements
  if (welcomePage) {
    welcomePage.classList.remove('hidden');
  }

  // Hide all views
  document.querySelectorAll('.view').forEach(view => {
    view.classList.add('hidden');
  });

  if (connectionTitle) {
    connectionTitle.textContent = '';
  } else {
    console.warn('[WARN] Connection title element not found!');
  }
}

function hideWelcomePage() {
  // Use cached DOM elements
  if (welcomePage) {
    console.log('[DEBUG] Hiding welcome page');
    welcomePage.classList.add('hidden'); // Hide the welcome page
  } else {
    console.error('[ERROR] Welcome page element not found!');
  }

  // Show dashboard view by default
  navigateToView('dashboard');
}

function assertVisibility() {
  // Use cached DOM elements
  // Return early if DOM elements haven't been initialized
  if (!welcomePage || !dashboard) {
    console.warn('[WARN] Cannot assert visibility: DOM elements not initialized');
    return;
  }
  
  if (Object.keys(connections).length === 0) {
    console.assert(!welcomePage.classList.contains('hidden'), '[ASSERTION FAILED] Welcome page should be visible.');
    console.assert(dashboard.classList.contains('hidden'), '[ASSERTION FAILED] Dashboard should be hidden.');
  } else {
    console.assert(welcomePage.classList.contains('hidden'), '[ASSERTION FAILED] Welcome page should be hidden.');
    console.assert(!dashboard.classList.contains('hidden'), '[ASSERTION FAILED] Dashboard should be visible.');
  }
}
// Attach startTerminal to the global window object
window.startTerminal = startTerminal;

// Handle window unload to clean up swarms and peers
window.addEventListener('beforeunload', () => {
  for (const topicId in connections) {
    const connection = connections[topicId];
    if (connection.peer) {
      connection.peer.destroy();
    }
    if (connection.swarm) {
      connection.swarm.destroy();
    }
  }
});

// Initialize Inspect Modal Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  // Container Inspect Modal - Toggle JSON View
  const toggleJsonViewBtn = document.getElementById('toggle-json-view');
  if (toggleJsonViewBtn) {
    toggleJsonViewBtn.addEventListener('click', () => {
      const formattedView = document.getElementById('inspect-formatted-view');
      const jsonView = document.getElementById('inspect-json-view');
      const jsonContent = document.getElementById('inspect-json-content');
      
      if (formattedView.style.display === 'none') {
        formattedView.style.display = 'block';
        jsonView.style.display = 'none';
        toggleJsonViewBtn.innerHTML = '<i class="fas fa-code"></i> Raw JSON';
      } else {
        formattedView.style.display = 'none';
        jsonView.style.display = 'block';
        toggleJsonViewBtn.innerHTML = '<i class="fas fa-list"></i> Formatted View';
        
        if (window.currentInspectConfig && jsonContent.textContent === '') {
          jsonContent.textContent = JSON.stringify(window.currentInspectConfig, null, 2);
        }
      }
    });
  }

  // Container Inspect Modal - Copy JSON to Clipboard
  const copyJsonBtn = document.getElementById('copy-json-btn');
  if (copyJsonBtn) {
    copyJsonBtn.addEventListener('click', async () => {
      if (!window.currentInspectConfig) {
        showAlert('warning', 'No container configuration available to copy.');
        return;
      }

      try {
        const jsonString = JSON.stringify(window.currentInspectConfig, null, 2);
        await navigator.clipboard.writeText(jsonString);
        showAlert('success', 'Container configuration copied to clipboard!');
      } catch (error) {
        console.error('[ERROR] Failed to copy to clipboard:', error);
        showAlert('danger', 'Failed to copy to clipboard.');
      }
    });
  }
  
  // Image Inspect Modal - Toggle JSON View
  const toggleImageJsonViewBtn = document.getElementById('toggle-image-json-view');
  if (toggleImageJsonViewBtn) {
    toggleImageJsonViewBtn.addEventListener('click', () => {
      const formattedView = document.getElementById('image-inspect-formatted-view');
      const jsonView = document.getElementById('image-inspect-json-view');
      const jsonContent = document.getElementById('image-inspect-json-content');
      
      if (formattedView.style.display === 'none') {
        formattedView.style.display = 'block';
        jsonView.style.display = 'none';
        toggleImageJsonViewBtn.innerHTML = '<i class="fas fa-code"></i> Raw JSON';
      } else {
        formattedView.style.display = 'none';
        jsonView.style.display = 'block';
        toggleImageJsonViewBtn.innerHTML = '<i class="fas fa-list"></i> Formatted View';
        
        if (window.currentImageInspectConfig && jsonContent.textContent === '') {
          jsonContent.textContent = JSON.stringify(window.currentImageInspectConfig, null, 2);
        }
      }
    });
  }
  
  // Image Inspect Modal - Copy JSON
  const copyImageJsonBtn = document.getElementById('copy-image-json-btn');
  if (copyImageJsonBtn) {
    copyImageJsonBtn.addEventListener('click', async () => {
      if (!window.currentImageInspectConfig) {
        showAlert('warning', 'No image configuration available to copy.');
        return;
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(window.currentImageInspectConfig, null, 2));
        showAlert('success', 'Image configuration copied to clipboard!');
      } catch (err) {
        console.error('Failed to copy image configuration:', err);
        showAlert('danger', 'Failed to copy image configuration.');
      }
    });
  }
  
  // Network Inspect Modal - Toggle JSON View
  const toggleNetworkJsonViewBtn = document.getElementById('toggle-network-json-view');
  if (toggleNetworkJsonViewBtn) {
    toggleNetworkJsonViewBtn.addEventListener('click', () => {
      const formattedView = document.getElementById('network-inspect-formatted-view');
      const jsonView = document.getElementById('network-inspect-json-view');
      const jsonContent = document.getElementById('network-inspect-json-content');
      
      if (formattedView.style.display === 'none') {
        formattedView.style.display = 'block';
        jsonView.style.display = 'none';
        toggleNetworkJsonViewBtn.innerHTML = '<i class="fas fa-code"></i> Raw JSON';
      } else {
        formattedView.style.display = 'none';
        jsonView.style.display = 'block';
        toggleNetworkJsonViewBtn.innerHTML = '<i class="fas fa-list"></i> Formatted View';
        
        if (window.currentNetworkInspectConfig && jsonContent.textContent === '') {
          jsonContent.textContent = JSON.stringify(window.currentNetworkInspectConfig, null, 2);
        }
      }
    });
  }
  
  // Network Inspect Modal - Copy JSON
  const copyNetworkJsonBtn = document.getElementById('copy-network-json-btn');
  if (copyNetworkJsonBtn) {
    copyNetworkJsonBtn.addEventListener('click', async () => {
      if (!window.currentNetworkInspectConfig) {
        showAlert('warning', 'No network configuration available to copy.');
        return;
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(window.currentNetworkInspectConfig, null, 2));
        showAlert('success', 'Network configuration copied to clipboard!');
      } catch (err) {
        console.error('Failed to copy network configuration:', err);
        showAlert('danger', 'Failed to copy network configuration.');
      }
    });
  }
  
  // Volume Inspect Modal - Toggle JSON View
  const toggleVolumeJsonViewBtn = document.getElementById('toggle-volume-json-view');
  if (toggleVolumeJsonViewBtn) {
    toggleVolumeJsonViewBtn.addEventListener('click', () => {
      const formattedView = document.getElementById('volume-inspect-formatted-view');
      const jsonView = document.getElementById('volume-inspect-json-view');
      const jsonContent = document.getElementById('volume-inspect-json-content');
      
      if (formattedView.style.display === 'none') {
        formattedView.style.display = 'block';
        jsonView.style.display = 'none';
        toggleVolumeJsonViewBtn.innerHTML = '<i class="fas fa-code"></i> Raw JSON';
      } else {
        formattedView.style.display = 'none';
        jsonView.style.display = 'block';
        toggleVolumeJsonViewBtn.innerHTML = '<i class="fas fa-list"></i> Formatted View';
        
        if (window.currentVolumeInspectConfig && jsonContent.textContent === '') {
          jsonContent.textContent = JSON.stringify(window.currentVolumeInspectConfig, null, 2);
        }
      }
    });
  }
  
  // Volume Inspect Modal - Copy JSON
  const copyVolumeJsonBtn = document.getElementById('copy-volume-json-btn');
  if (copyVolumeJsonBtn) {
    copyVolumeJsonBtn.addEventListener('click', async () => {
      if (!window.currentVolumeInspectConfig) {
        showAlert('warning', 'No volume configuration available to copy.');
        return;
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(window.currentVolumeInspectConfig, null, 2));
        showAlert('success', 'Volume configuration copied to clipboard!');
      } catch (err) {
        console.error('Failed to copy volume configuration:', err);
        showAlert('danger', 'Failed to copy volume configuration.');
      }
    });
  }
  
  // Stack Inspect Modal - Toggle JSON View
  const toggleStackJsonViewBtn = document.getElementById('toggle-stack-json-view');
  if (toggleStackJsonViewBtn) {
    toggleStackJsonViewBtn.addEventListener('click', () => {
      const formattedView = document.getElementById('stack-inspect-formatted-view');
      const jsonView = document.getElementById('stack-inspect-json-view');
      const jsonContent = document.getElementById('stack-inspect-json-content');
      
      if (formattedView.style.display === 'none') {
        formattedView.style.display = 'block';
        jsonView.style.display = 'none';
        toggleStackJsonViewBtn.innerHTML = '<i class="fas fa-code"></i> Raw JSON';
      } else {
        formattedView.style.display = 'none';
        jsonView.style.display = 'block';
        toggleStackJsonViewBtn.innerHTML = '<i class="fas fa-list"></i> Formatted View';
        
        if (window.currentStackInspectConfig && jsonContent.textContent === '') {
          jsonContent.textContent = JSON.stringify(window.currentStackInspectConfig, null, 2);
        }
      }
    });
  }
  
  // Stack Inspect Modal - Copy JSON
  const copyStackJsonBtn = document.getElementById('copy-stack-json-btn');
  if (copyStackJsonBtn) {
    copyStackJsonBtn.addEventListener('click', async () => {
      if (!window.currentStackInspectConfig) {
        showAlert('warning', 'No stack configuration available to copy.');
        return;
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(window.currentStackInspectConfig, null, 2));
        showAlert('success', 'Stack configuration copied to clipboard!');
      } catch (err) {
        console.error('Failed to copy stack configuration:', err);
        showAlert('danger', 'Failed to copy stack configuration.');
      }
    });
  }
});

/**
 * Initialize notification tray
 */
function initNotificationTray() {
  // Guard: prevent multiple initializations
  if (notificationTrayInitialized) {
    return;
  }

  const trayToggle = document.getElementById('notification-tray-toggle');
  const notificationPanel = document.getElementById('notification-panel');
  const closePanelBtn = document.getElementById('close-panel-btn');
  const markAllReadBtn = document.getElementById('mark-all-read-btn');
  const clearAllBtn = document.getElementById('clear-all-btn');
  const notificationList = document.getElementById('notification-list');
  const notificationBadge = document.getElementById('notification-badge');
  const filterButtons = document.querySelectorAll('.notification-filter-btn');

  if (!trayToggle || !notificationPanel) {
    console.warn('[WARN] Notification tray elements not found.');
    return;
  }

  // Mark as initialized before setting up event listeners
  notificationTrayInitialized = true;

  let currentFilter = 'all';

  // Format timestamp for display
  function formatTimestamp(timestamp) {
    const now = new Date();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  }

  // Get icon for notification type
  function getNotificationIcon(type) {
    const icons = {
      success: 'fa-check-circle',
      danger: 'fa-exclamation-circle',
      warning: 'fa-exclamation-triangle',
      info: 'fa-info-circle'
    };
    return icons[type] || 'fa-bell';
  }

  // Render notifications
  function renderNotifications() {
    const notifications = notificationManager.getNotifications({ type: currentFilter });
    
    if (notifications.length === 0) {
      notificationList.innerHTML = `
        <div class="notification-empty">
          <i class="fas fa-bell-slash"></i>
          <p>No notifications</p>
        </div>
      `;
      return;
    }

    notificationList.innerHTML = notifications.map(notification => {
      const icon = getNotificationIcon(notification.type);
      const timestamp = formatTimestamp(notification.timestamp);
      const unreadClass = notification.read ? '' : 'unread';
      
      return `
        <div class="notification-item ${notification.type} ${unreadClass}" data-id="${notification.id}">
          <div class="notification-icon">
            <i class="fas ${icon}"></i>
          </div>
          <div class="notification-content">
            <p class="notification-message">${escapeHtml(notification.message)}</p>
            <p class="notification-timestamp">${timestamp}</p>
          </div>
          <div class="notification-actions">
            ${!notification.read ? `
              <button class="notification-action mark-read-btn" data-id="${notification.id}" title="Mark as read">
                <i class="fas fa-check"></i>
              </button>
            ` : ''}
            <button class="notification-action dismiss-btn" data-id="${notification.id}" title="Dismiss">
              <i class="fas fa-times"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Update badge
  function updateBadge() {
    const unreadCount = notificationManager.getUnreadCount();
    if (unreadCount > 0) {
      notificationBadge.textContent = unreadCount > 99 ? '99+' : unreadCount;
      notificationBadge.style.display = 'flex';
    } else {
      notificationBadge.textContent = '';
      notificationBadge.style.display = 'none';
    }
  }

  // Toggle panel
  function togglePanel() {
    notificationPanel.classList.toggle('hidden');
    if (!notificationPanel.classList.contains('hidden')) {
      // Mark all as read when opening panel
      notificationManager.markAllAsRead();
      updateBadge();
      renderNotifications();
    }
  }

  // Handle notification actions using event delegation
  notificationList.addEventListener('click', (e) => {
    const target = e.target.closest('.notification-action');
    if (!target) return;

    const notificationId = target.dataset.id;
    if (!notificationId) return;

    if (target.classList.contains('mark-read-btn')) {
      notificationManager.markAsRead(notificationId);
      renderNotifications();
      updateBadge();
    } else if (target.classList.contains('dismiss-btn')) {
      notificationManager.remove(notificationId);
      renderNotifications();
      updateBadge();
    }
  });

  // Event listeners
  trayToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel();
  });

  if (closePanelBtn) {
    closePanelBtn.addEventListener('click', () => {
      notificationPanel.classList.add('hidden');
    });
  }

  if (markAllReadBtn) {
    markAllReadBtn.addEventListener('click', () => {
      notificationManager.markAllAsRead();
      renderNotifications();
      updateBadge();
    });
  }

  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      showConfirmModal('Are you sure you want to clear all notifications?', () => {
        notificationManager.clearAll();
        renderNotifications();
        updateBadge();
      });
    });
  }

  // Filter buttons
  filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      filterButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderNotifications();
    });
  });

  // Close panel when clicking outside
  document.addEventListener('click', (e) => {
    if (!notificationPanel.classList.contains('hidden') &&
        !notificationPanel.contains(e.target) &&
        !trayToggle.contains(e.target)) {
      notificationPanel.classList.add('hidden');
    }
  });

  // Subscribe to notification changes
  notificationManager.subscribe((notifications, unreadCount) => {
    updateBadge();
    if (!notificationPanel.classList.contains('hidden')) {
      renderNotifications();
    }
  });

  // Initial render (will trigger storage load if needed)
  // Use a small delay to ensure DOM is ready
  setTimeout(() => {
    updateBadge();
    renderNotifications();
  }, 0);
}