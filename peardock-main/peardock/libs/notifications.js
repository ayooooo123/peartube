/**
 * Notification Manager
 * Centralized notification system with persistence and tray support
 */

const STORAGE_KEY = 'peardock_notifications';
const MAX_NOTIFICATIONS = 100; // Limit stored notifications

class NotificationManager {
  constructor() {
    this.notifications = [];
    this.listeners = [];
    this._storageLoaded = false;
    // Defer loading from storage to not block initialization
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => this.loadFromStorage(), { timeout: 1000 });
    } else {
      // Fallback for browsers without requestIdleCallback
      setTimeout(() => this.loadFromStorage(), 0);
    }
  }

  /**
   * Load notifications from localStorage
   */
  loadFromStorage() {
    if (this._storageLoaded) return;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Convert date strings back to Date objects
        this.notifications = parsed.map(n => ({
          ...n,
          timestamp: new Date(n.timestamp)
        }));
        // Limit to most recent notifications
        this.notifications = this.notifications.slice(-MAX_NOTIFICATIONS);
      }
      this._storageLoaded = true;
      // Notify listeners after loading
      this.notify();
    } catch (err) {
      console.error('[ERROR] Failed to load notifications from storage:', err);
      this.notifications = [];
      this._storageLoaded = true;
    }
  }

  /**
   * Save notifications to localStorage
   */
  saveToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.notifications));
    } catch (err) {
      console.error('[ERROR] Failed to save notifications to storage:', err);
    }
  }

  /**
   * Subscribe to notification changes
   * @param {Function} callback - Callback function
   */
  subscribe(callback) {
    this.listeners.push(callback);
    // Immediately notify with current state
    callback(this.notifications, this.getUnreadCount());
  }

  /**
   * Unsubscribe from notification changes
   * @param {Function} callback - Callback function to remove
   */
  unsubscribe(callback) {
    this.listeners = this.listeners.filter(listener => listener !== callback);
  }

  /**
   * Notify all subscribers
   */
  notify() {
    this.listeners.forEach(callback => {
      try {
        callback(this.notifications, this.getUnreadCount());
      } catch (err) {
        console.error('[ERROR] Notification listener error:', err);
      }
    });
  }

  /**
   * Add a new notification
   * @param {string} type - Notification type (success, danger, warning, info)
   * @param {string} message - Notification message
   * @param {Object} options - Additional options (autoDismiss, duration, etc.)
   * @returns {string} Notification ID
   */
  add(type, message, options = {}) {
    const id = this.generateId();
    const notification = {
      id,
      type,
      message,
      timestamp: new Date(),
      read: false,
      autoDismiss: options.autoDismiss !== false, // Default to true
      duration: options.duration || 5000
    };

    this.notifications.unshift(notification); // Add to beginning
    this.notifications = this.notifications.slice(0, MAX_NOTIFICATIONS); // Limit size
    this.saveToStorage();
    this.notify();

    // Auto-dismiss if enabled
    if (notification.autoDismiss) {
      setTimeout(() => {
        this.remove(id);
      }, notification.duration);
    }

    return id;
  }

  /**
   * Remove a notification
   * @param {string} id - Notification ID
   */
  remove(id) {
    this.notifications = this.notifications.filter(n => n.id !== id);
    this.saveToStorage();
    this.notify();
  }

  /**
   * Mark notification as read
   * @param {string} id - Notification ID
   */
  markAsRead(id) {
    const notification = this.notifications.find(n => n.id === id);
    if (notification && !notification.read) {
      notification.read = true;
      this.saveToStorage();
      this.notify();
    }
  }

  /**
   * Mark all notifications as read
   */
  markAllAsRead() {
    let changed = false;
    this.notifications.forEach(n => {
      if (!n.read) {
        n.read = true;
        changed = true;
      }
    });
    if (changed) {
      this.saveToStorage();
      this.notify();
    }
  }

  /**
   * Clear all notifications
   */
  clearAll() {
    this.notifications = [];
    this.saveToStorage();
    this.notify();
  }

  /**
   * Get unread count
   * @returns {number} Number of unread notifications
   */
  getUnreadCount() {
    // Ensure storage is loaded
    if (!this._storageLoaded) {
      this.loadFromStorage();
    }
    return this.notifications.filter(n => !n.read).length;
  }

  /**
   * Get notifications with optional filtering
   * @param {Object} filters - Filter options (type, read)
   * @returns {Array} Filtered notifications
   */
  getNotifications(filters = {}) {
    // Ensure storage is loaded
    if (!this._storageLoaded) {
      this.loadFromStorage();
    }
    
    let filtered = [...this.notifications];

    if (filters.type && filters.type !== 'all') {
      filtered = filtered.filter(n => n.type === filters.type);
    }

    if (filters.read !== undefined) {
      filtered = filtered.filter(n => n.read === filters.read);
    }

    return filtered;
  }

  /**
   * Generate unique ID for notification
   * @returns {string} Unique ID
   */
  generateId() {
    return `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Create singleton instance
const notificationManager = new NotificationManager();

export default notificationManager;

