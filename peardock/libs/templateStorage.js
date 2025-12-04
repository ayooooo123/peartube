/**
 * Local template storage and management
 */

// Storage key for templates (removed CONFIG dependency to avoid TDZ errors)
const STORAGE_KEY = 'peardock_templates';

/**
 * Get the storage key for templates
 * @returns {string} - Storage key
 */
function getStorageKey() {
  return STORAGE_KEY;
}

/**
 * Save template to local storage
 * @param {string} name - Template name
 * @param {Object} template - Template configuration
 */
export function saveTemplate(name, template) {
  try {
    const templates = loadTemplates();
    templates[name] = {
      ...template,
      savedAt: new Date().toISOString(),
      version: templates[name]?.version ? templates[name].version + 1 : 1
    };
    localStorage.setItem(getStorageKey(), JSON.stringify(templates));
    return true;
  } catch (err) {
    console.error('[ERROR] Failed to save template:', err);
    return false;
  }
}

/**
 * Load all templates from local storage
 * @returns {Object} - Templates object
 */
export function loadTemplates() {
  try {
    const stored = localStorage.getItem(getStorageKey());
    return stored ? JSON.parse(stored) : {};
  } catch (err) {
    console.error('[ERROR] Failed to load templates:', err);
    return {};
  }
}

/**
 * Delete template from local storage
 * @param {string} name - Template name
 * @returns {boolean} - True if deleted
 */
export function deleteTemplate(name) {
  try {
    const templates = loadTemplates();
    if (templates[name]) {
      delete templates[name];
      localStorage.setItem(getStorageKey(), JSON.stringify(templates));
      return true;
    }
    return false;
  } catch (err) {
    console.error('[ERROR] Failed to delete template:', err);
    return false;
  }
}

/**
 * Get template by name
 * @param {string} name - Template name
 * @returns {Object|null} - Template or null
 */
export function getTemplate(name) {
  const templates = loadTemplates();
  return templates[name] || null;
}

/**
 * Export templates as JSON
 * @returns {string} - JSON string
 */
export function exportTemplates() {
  return JSON.stringify(loadTemplates(), null, 2);
}

/**
 * Import templates from JSON
 * @param {string} json - JSON string
 * @returns {boolean} - True if imported successfully
 */
export function importTemplates(json) {
  try {
    const imported = JSON.parse(json);
    if (typeof imported !== 'object') {
      throw new Error('Invalid template format');
    }
    
    const existing = loadTemplates();
    const merged = { ...existing, ...imported };
    localStorage.setItem(getStorageKey(), JSON.stringify(merged));
    return true;
  } catch (err) {
    console.error('[ERROR] Failed to import templates:', err);
    return false;
  }
}

/**
 * Get all template names
 * @returns {Array<string>} - Array of template names
 */
export function getTemplateNames() {
  return Object.keys(loadTemplates());
}

