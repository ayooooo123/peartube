/**
 * Shared UI utility functions
 * Used by both app.js and templateDeploy.js to avoid code duplication
 */

import notificationManager from './notifications.js';

/**
 * Close all open Bootstrap modals and clean up any lingering backdrops
 */
export function closeAllModals() {
  // Find and hide all open modals
  const modals = document.querySelectorAll('.modal.show, .modal[style*="display"]');
  modals.forEach(modal => {
    const modalInstance = bootstrap.Modal.getInstance(modal);
    if (modalInstance) {
      modalInstance.hide();
    } else {
      // If no instance exists, create one and hide it
      const newInstance = new bootstrap.Modal(modal);
      newInstance.hide();
    }
    // Also directly hide the modal element as fallback
    modal.classList.remove('show');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    modal.removeAttribute('aria-modal');
  });
  
  // Remove any lingering modal backdrops
  const backdrops = document.querySelectorAll('.modal-backdrop');
  backdrops.forEach(backdrop => {
    backdrop.remove();
  });
  
  // Clean up body classes and styles
  document.body.classList.remove('modal-open');
  document.body.style.paddingRight = '';
  document.body.style.overflow = '';
  
  // Also handle custom terminal modal if it exists
  const terminalModal = document.getElementById('terminal-modal');
  if (terminalModal && terminalModal.style.display !== 'none') {
    terminalModal.style.display = 'none';
  }
}

/**
 * Show status indicator overlay
 * @param {string} message - Message to display
 */
export function showStatusIndicator(message = 'Processing...') {
  // Check if indicator already exists, if so just update the message
  let statusIndicator = document.getElementById('status-indicator');
  if (statusIndicator) {
    updateStatusIndicator(message);
    return;
  }
  
  // Create new indicator if it doesn't exist
  statusIndicator = document.createElement('div');
  statusIndicator.id = 'status-indicator';
  statusIndicator.className = 'position-fixed top-0 start-0 w-100 h-100 d-flex justify-content-center align-items-center bg-dark bg-opacity-75';
  statusIndicator.innerHTML = `
    <div class="text-center">
      <div class="spinner-border text-light" role="status">
        <span class="visually-hidden">Loading...</span>
      </div>
      <p class="mt-3 text-light">${message}</p>
    </div>
  `;
  document.body.appendChild(statusIndicator);
}

/**
 * Update status indicator message
 * @param {string} message - New message to display
 */
export function updateStatusIndicator(message) {
  const statusIndicator = document.getElementById('status-indicator');
  if (statusIndicator) {
    const messageElement = statusIndicator.querySelector('p');
    if (messageElement) {
      messageElement.textContent = message;
    }
  }
}

/**
 * Hide status indicator overlay
 * Safe to call before DOM is ready
 */
export function hideStatusIndicator() {
  // Use requestAnimationFrame to ensure DOM is ready, or check immediately if already loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      const statusIndicator = document.getElementById('status-indicator');
      if (statusIndicator) {
        statusIndicator.remove();
      }
    });
  } else {
    const statusIndicator = document.getElementById('status-indicator');
    if (statusIndicator) {
      statusIndicator.remove();
    }
  }
}

/**
 * Show alert message (now uses notification system)
 * @param {string} type - Alert type (success, danger, warning, info)
 * @param {string} message - Message to display
 * @param {Object} options - Additional options (autoDismiss, duration)
 */
export function showAlert(type, message, options = {}) {
  // Use the new notification system
  notificationManager.add(type, message, options);
}

