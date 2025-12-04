/**
 * Input validation and sanitization utilities for server-side security
 */

import path from 'path';

/**
 * Validates Docker image name against Docker naming conventions
 * @param {string} image - Docker image name
 * @returns {boolean} - True if valid
 */
function isValidImageName(image) {
  if (!image || typeof image !== 'string') return false;
  
  // Docker image name pattern: [registry/][namespace/]name[:tag]
  // Allowed characters: lowercase letters, numbers, dots, hyphens, underscores, slashes, colons
  const imagePattern = /^([a-z0-9._-]+\/)*[a-z0-9._-]+(:[a-zA-Z0-9._-]+)?$/;
  
  // Max length check
  if (image.length > 255) return false;
  
  return imagePattern.test(image);
}

/**
 * Validates container name against Docker naming conventions
 * @param {string} name - Container name
 * @returns {boolean} - True if valid
 */
function isValidContainerName(name) {
  if (!name || typeof name !== 'string') return false;
  
  // Container names: alphanumeric, dashes, underscores, dots
  // Must start and end with alphanumeric
  const namePattern = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
  
  // Length constraints (1-63 characters for hostname compatibility)
  if (name.length < 1 || name.length > 63) return false;
  
  return namePattern.test(name);
}

/**
 * Sanitizes environment variable name
 * @param {string} name - Environment variable name
 * @returns {string|null} - Sanitized name or null if invalid
 */
function sanitizeEnvVarName(name) {
  if (!name || typeof name !== 'string') return null;
  
  // Environment variable names: letters, numbers, underscores
  // Must start with letter or underscore
  const sanitized = name.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized)) return null;
  if (sanitized.length > 100) return null; // Reasonable limit
  
  return sanitized;
}

/**
 * Sanitizes environment variable value
 * @param {string} value - Environment variable value
 * @returns {string} - Sanitized value
 */
function sanitizeEnvVarValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  
  // Remove null bytes and control characters (except newline, tab)
  return value.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '').trim();
}

/**
 * Validates port mapping format
 * @param {string} portMapping - Port mapping string (e.g., "8080:80/tcp")
 * @returns {boolean} - True if valid
 */
function isValidPortMapping(portMapping) {
  if (!portMapping || typeof portMapping !== 'string') return false;
  
  // Format: [hostPort:]containerPort[/protocol]
  const portPattern = /^(\d+)?:?\d+\/(tcp|udp)$/;
  if (!portPattern.test(portMapping)) return false;
  
  const parts = portMapping.split(':');
  if (parts.length === 2) {
    const [hostPort, rest] = parts;
    const port = parseInt(hostPort, 10);
    if (port < 1 || port > 65535) return false;
  }
  
  const containerPort = parseInt(parts[parts.length - 1].split('/')[0], 10);
  return containerPort >= 1 && containerPort <= 65535;
}

/**
 * Validates volume mount format
 * @param {string} volume - Volume mount string (e.g., "/host:/container:ro")
 * @returns {boolean} - True if valid
 */
function isValidVolumeMount(volume) {
  if (!volume || typeof volume !== 'string') return false;
  if (!volume.includes(':')) return false;
  
  const parts = volume.split(':');
  if (parts.length < 2 || parts.length > 3) return false;
  
  // Check for path traversal attempts
  if (parts.some(part => part.includes('..'))) return false;
  
  // Basic path validation
  const pathPattern = /^(\/[^\/]+)*\/?$/;
  return parts.slice(0, 2).every(part => pathPattern.test(part) || part.startsWith('/'));
}

/**
 * Sanitizes label key
 * @param {string} key - Label key
 * @returns {string|null} - Sanitized key or null if invalid
 */
function sanitizeLabelKey(key) {
  if (!key || typeof key !== 'string') return null;
  
  // Docker label keys: alphanumeric, dots, hyphens, underscores
  const sanitized = key.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(sanitized)) return null;
  if (sanitized.length > 250) return null;
  
  return sanitized;
}

/**
 * Sanitizes label value
 * @param {string} value - Label value
 * @returns {string} - Sanitized value
 */
function sanitizeLabelValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  
  // Remove null bytes
  return value.replace(/\x00/g, '').trim();
}

/**
 * Validates hostname
 * @param {string} hostname - Hostname string
 * @returns {boolean} - True if valid
 */
function isValidHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  
  // Hostname: alphanumeric, dots, hyphens
  // Max 253 characters total, each label max 63
  const hostnamePattern = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  
  if (hostname.length > 253) return false;
  
  return hostnamePattern.test(hostname);
}

/**
 * Validates DNS server IP address
 * @param {string} dns - DNS server IP
 * @returns {boolean} - True if valid
 */
function isValidDnsServer(dns) {
  if (!dns || typeof dns !== 'string') return false;
  
  // IPv4 pattern
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Pattern.test(dns)) {
    const parts = dns.split('.');
    return parts.every(part => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
  }
  
  // IPv6 pattern (simplified)
  const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  return ipv6Pattern.test(dns);
}

/**
 * Sanitizes string input by removing dangerous characters
 * @param {string} input - Input string
 * @param {number} maxLength - Maximum length
 * @returns {string} - Sanitized string
 */
function sanitizeString(input, maxLength = 1000) {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') return String(input);
  
  // Remove null bytes and control characters
  let sanitized = input.replace(/[\x00-\x1F\x7F]/g, '').trim();
  
  // Enforce max length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  
  return sanitized;
}

/**
 * Validates numeric input within range
 * @param {any} value - Input value
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number|null} - Validated number or null
 */
function validateNumber(value, min = -Infinity, max = Infinity) {
  if (value === null || value === undefined || value === '') return null;
  
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(num)) return null;
  
  if (num < min || num > max) return null;
  
  return num;
}

/**
 * Validates URL format
 * @param {string} url - URL string
 * @returns {boolean} - True if valid URL
 */
function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates email format
 * @param {string} email - Email string
 * @returns {boolean} - True if valid email
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailPattern.test(email);
}

/**
 * Validates IP address (IPv4 or IPv6)
 * @param {string} ip - IP address string
 * @returns {boolean} - True if valid IP
 */
function isValidIpAddress(ip) {
  if (!ip || typeof ip !== 'string') return false;
  
  // IPv4
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Pattern.test(ip)) {
    const parts = ip.split('.');
    return parts.every(part => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
  }
  
  // IPv6 (simplified)
  const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  return ipv6Pattern.test(ip);
}

/**
 * Validates that a value is in a list of allowed options
 * @param {any} value - Value to validate
 * @param {Array} options - Array of allowed options
 * @returns {boolean} - True if value is in options
 */
function isValidSelectOption(value, options) {
  if (!options || !Array.isArray(options)) return true; // If no options specified, allow any value
  
  // Handle both simple arrays and object arrays with value property
  const optionValues = options.map(opt => {
    if (typeof opt === 'object' && opt.value !== undefined) {
      return String(opt.value);
    }
    return String(opt);
  });
  
  return optionValues.includes(String(value));
}

/**
 * Validates that preset values haven't been modified
 * @param {Object} envVar - Environment variable object with name, value, and preset flag
 * @param {Object} templateEnv - Template environment variable definition
 * @returns {boolean} - True if preset value is unchanged or not preset
 */
function isValidPresetValue(envVar, templateEnv) {
  if (!templateEnv || templateEnv.preset !== true) return true; // Not a preset, allow changes
  
  if (!envVar.preset) return false; // Preset value was marked as non-preset
  
  const expectedValue = templateEnv.default || templateEnv.set || '';
  return String(envVar.value) === String(expectedValue);
}

/**
 * Validates numeric range
 * @param {any} value - Value to validate
 * @param {number} min - Minimum value (optional)
 * @param {number} max - Maximum value (optional)
 * @returns {boolean} - True if value is within range
 */
function isValidNumericRange(value, min, max) {
  if (value === null || value === undefined || value === '') return true; // Empty is valid (handled by required check)
  
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(num)) return false;
  
  if (min !== undefined && num < min) return false;
  if (max !== undefined && num > max) return false;
  
  return true;
}

/**
 * Validates directory path for file browser
 * @param {string} path - Directory path
 * @returns {boolean} - True if valid
 */
function isValidDirectoryPath(path) {
  if (!path || typeof path !== 'string') return false;
  
  // Prevent path traversal
  if (path.includes('..')) return false;
  
  // Must be absolute path
  if (!path.startsWith('/')) return false;
  
  // Basic length check
  if (path.length > 4096) return false;
  
  return true;
}

/**
 * Sanitizes directory path for safe filesystem access
 * @param {string} path - Directory path
 * @returns {string} - Sanitized path
 */
function sanitizeDirectoryPath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    console.warn('[WARN] sanitizeDirectoryPath: Invalid input, returning /');
    return '/';
  }
  
  // Remove null bytes and control characters
  let sanitized = inputPath.replace(/[\x00-\x1F\x7F]/g, '').trim();
  
  // If empty after cleaning, return root
  if (!sanitized) {
    console.warn('[WARN] sanitizeDirectoryPath: Empty after cleaning, returning /');
    return '/';
  }
  
  // Resolve to absolute path and prevent traversal
  try {
    // If already absolute, use as-is (path.resolve will normalize it)
    // If relative, resolve from current working directory
    sanitized = path.resolve(sanitized);
    
    console.log(`[DEBUG] sanitizeDirectoryPath: Resolved "${inputPath}" to "${sanitized}"`);
    
    // Ensure it's still absolute after resolution
    if (!path.isAbsolute(sanitized)) {
      console.warn(`[WARN] sanitizeDirectoryPath: Resolved path is not absolute: "${sanitized}", returning /`);
      return '/';
    }
    
    // Additional safety: prevent access to sensitive directories
    // This is a basic check - you may want to add more restrictions
    const sensitivePaths = ['/etc', '/sys', '/proc', '/dev'];
    for (const sensitive of sensitivePaths) {
      if (sanitized.startsWith(sensitive) && sanitized !== sensitive) {
        // Allow root level but not deeper
        console.warn(`[WARN] sanitizeDirectoryPath: Blocked access to sensitive path: "${sanitized}"`);
        return '/';
      }
    }
    
    console.log(`[DEBUG] sanitizeDirectoryPath: Final sanitized path: "${sanitized}"`);
    return sanitized;
  } catch (error) {
    console.warn(`[WARN] Path sanitization error for "${inputPath}":`, error.message);
    return '/';
  }
}

export {
  isValidImageName,
  isValidContainerName,
  sanitizeEnvVarName,
  sanitizeEnvVarValue,
  isValidPortMapping,
  isValidVolumeMount,
  sanitizeLabelKey,
  sanitizeLabelValue,
  isValidHostname,
  isValidDnsServer,
  sanitizeString,
  validateNumber,
  isValidUrl,
  isValidEmail,
  isValidIpAddress,
  isValidSelectOption,
  isValidPresetValue,
  isValidNumericRange,
  isValidDirectoryPath,
  sanitizeDirectoryPath
};



