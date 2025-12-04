/**
 * Loading states and skeleton loaders utility
 */

/**
 * Create skeleton loader for container list
 * @param {number} count - Number of skeleton rows to create
 * @returns {DocumentFragment} - Fragment with skeleton rows
 */
export function createContainerSkeleton(count = 5) {
  const fragment = document.createDocumentFragment();
  
  for (let i = 0; i < count; i++) {
    const row = document.createElement('tr');
    row.className = 'skeleton-row';
    row.innerHTML = `
      <td><div class="skeleton skeleton-text"></div></td>
      <td><div class="skeleton skeleton-text"></div></td>
      <td><div class="skeleton skeleton-badge"></div></td>
      <td><div class="skeleton skeleton-number"></div></td>
      <td><div class="skeleton skeleton-number"></div></td>
      <td><div class="skeleton skeleton-text"></div></td>
      <td><div class="skeleton skeleton-buttons"></div></td>
    `;
    fragment.appendChild(row);
  }
  
  return fragment;
}

/**
 * Show skeleton loader in container list
 * @param {number} count - Number of skeleton rows
 */
export function showContainerSkeleton(count = 5) {
  const containerList = document.getElementById('container-list');
  if (!containerList) return;
  
  containerList.innerHTML = '';
  containerList.appendChild(createContainerSkeleton(count));
}

/**
 * Create progress bar element
 * @param {string} id - Unique ID for the progress bar
 * @param {string} label - Label text
 * @returns {HTMLElement} - Progress bar container
 */
export function createProgressBar(id, label) {
  const container = document.createElement('div');
  container.id = `progress-${id}`;
  container.className = 'progress-container mb-3';
  container.innerHTML = `
    <div class="d-flex justify-content-between mb-1">
      <span>${label}</span>
      <span class="progress-percentage">0%</span>
    </div>
    <div class="progress" style="height: 20px;">
      <div class="progress-bar progress-bar-striped progress-bar-animated" 
           role="progressbar" 
           style="width: 0%"
           aria-valuenow="0" 
           aria-valuemin="0" 
           aria-valuemax="100">
      </div>
    </div>
  `;
  return container;
}

/**
 * Update progress bar
 * @param {string} id - Progress bar ID
 * @param {number} percentage - Progress percentage (0-100)
 * @param {string} message - Optional message to display
 */
export function updateProgressBar(id, percentage, message = '') {
  const container = document.getElementById(`progress-${id}`);
  if (!container) return;
  
  const progressBar = container.querySelector('.progress-bar');
  const percentageText = container.querySelector('.progress-percentage');
  
  if (progressBar) {
    progressBar.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
    progressBar.setAttribute('aria-valuenow', percentage);
  }
  
  if (percentageText) {
    percentageText.textContent = `${Math.round(percentage)}%`;
    if (message) {
      percentageText.textContent += ` - ${message}`;
    }
  }
}

/**
 * Remove progress bar
 * @param {string} id - Progress bar ID
 */
export function removeProgressBar(id) {
  const container = document.getElementById(`progress-${id}`);
  if (container) {
    container.remove();
  }
}

/**
 * @deprecated showOperationStatus has been replaced with the notification system
 * Use notificationManager.add() from './notifications.js' instead
 */



