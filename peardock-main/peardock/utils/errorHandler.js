/**
 * Centralized error handling utility
 */

// Removed CONFIG import to avoid TDZ errors - use constant directly
const UNKNOWN_ERROR_CODE = 'UNKNOWN_ERROR';

/**
 * Get the unknown error code
 * @returns {string} - Unknown error code
 */
function getUnknownErrorCode() {
  return UNKNOWN_ERROR_CODE;
}

/**
 * Error types
 */
export const ErrorType = {
  VALIDATION: 'VALIDATION',
  NETWORK: 'NETWORK',
  PERMISSION: 'PERMISSION',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Standardized error response format
 */
export class AppError extends Error {
  constructor(message, type = ErrorType.UNKNOWN, code = null, details = null) {
    super(message);
    this.name = 'AppError';
    this.type = type;
    this.code = code || getUnknownErrorCode();
    this.details = details;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      error: this.message,
      type: this.type,
      code: this.code,
      timestamp: this.timestamp,
      ...(this.details && { details: this.details })
    };
  }
}

/**
 * Create standardized error response
 * @param {Error|AppError} error - Error object
 * @param {boolean} includeDetails - Whether to include error details
 * @returns {Object} - Standardized error response
 */
export function createErrorResponse(error, includeDetails = false) {
  if (error instanceof AppError) {
    const response = {
      error: error.message,
      code: error.code,
      type: error.type,
    };
    
    if (includeDetails && error.details) {
      response.details = error.details;
    }
    
    return response;
  }

  // Handle standard Error objects
  const errorType = error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET'
    ? ErrorType.NETWORK
    : error.code === 'EACCES' || error.code === 'EPERM'
    ? ErrorType.PERMISSION
    : ErrorType.UNKNOWN;

  return {
    error: error.message || 'An unexpected error occurred',
    code: error.code || getUnknownErrorCode(),
    type: errorType,
  };
}

/**
 * Sanitize error message for client display
 * @param {string} message - Error message
 * @returns {string} - Sanitized message
 */
export function sanitizeErrorMessage(message) {
  if (!message || typeof message !== 'string') {
    return 'An error occurred. Please try again.';
  }

  // Remove sensitive information patterns
  const sensitivePatterns = [
    /\/var\/run\/docker\.sock/g,
    /\/root\//g,
    /\/home\/[^\/]+/g,
    /password[=:]\s*\S+/gi,
    /token[=:]\s*\S+/gi,
    /key[=:]\s*\S+/gi,
  ];

  let sanitized = message;
  for (const pattern of sensitivePatterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  // Truncate long messages
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 197) + '...';
  }

  return sanitized;
}

/**
 * Handle error with retry logic
 * @param {Function} fn - Function to execute
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} delayMs - Delay between retries in milliseconds
 * @returns {Promise} - Function result or error
 */
export async function withRetry(fn, maxRetries = 3, delayMs = 1000) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Don't retry on certain error types
      if (error instanceof AppError) {
        if (error.type === ErrorType.VALIDATION || error.type === ErrorType.PERMISSION) {
          throw error;
        }
      }
      
      // If not the last attempt, wait before retrying
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
  }
  
  throw lastError;
}

/**
 * Log error with context
 * @param {Error|AppError} error - Error to log
 * @param {Object} context - Additional context
 */
export function logError(error, context = {}) {
  const errorInfo = {
    message: error.message,
    stack: error.stack,
    ...context,
  };

  if (error instanceof AppError) {
    errorInfo.type = error.type;
    errorInfo.code = error.code;
  }

  console.error('[ERROR]', JSON.stringify(errorInfo, null, 2));
}

