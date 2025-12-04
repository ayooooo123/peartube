/**
 * Rate limiting utility to prevent abuse
 */

class RateLimiter {
  constructor() {
    // Map of peer ID to request timestamps
    this.requests = new Map();
    
    // Configuration
    this.config = {
      maxRequests: 100,        // Max requests per window
      windowMs: 60000,         // 1 minute window
      commandLimits: {
        deployContainer: { max: 5, windowMs: 60000 },    // 5 deployments per minute
        dockerCommand: { max: 30, windowMs: 10000 },     // 30 commands per 10 seconds
        startContainer: { max: 20, windowMs: 60000 },   // 20 starts per minute
        stopContainer: { max: 20, windowMs: 60000 },     // 20 stops per minute
      }
    };
  }

  /**
   * Get peer identifier
   * @param {Object} peer - Peer object
   * @returns {string} - Peer identifier
   */
  getPeerId(peer) {
    return peer.remotePublicKey?.toString('hex') || 'unknown';
  }

  /**
   * Check if request is within rate limit
   * @param {Object} peer - Peer object
   * @param {string} command - Command name
   * @returns {boolean} - True if allowed
   */
  isAllowed(peer, command) {
    const peerId = this.getPeerId(peer);
    const now = Date.now();
    
    // Clean up old entries
    this.cleanup(now);
    
    // Initialize peer entry if needed
    if (!this.requests.has(peerId)) {
      this.requests.set(peerId, {
        general: [],
        commands: {}
      });
    }
    
    const peerData = this.requests.get(peerId);
    
    // Check general rate limit
    const generalWindow = now - this.config.windowMs;
    peerData.general = peerData.general.filter(timestamp => timestamp > generalWindow);
    
    if (peerData.general.length >= this.config.maxRequests) {
      return false;
    }
    
    // Check command-specific rate limit
    if (this.config.commandLimits[command]) {
      const limit = this.config.commandLimits[command];
      const commandWindow = now - limit.windowMs;
      
      if (!peerData.commands[command]) {
        peerData.commands[command] = [];
      }
      
      peerData.commands[command] = peerData.commands[command].filter(
        timestamp => timestamp > commandWindow
      );
      
      if (peerData.commands[command].length >= limit.max) {
        return false;
      }
      
      // Record command request
      peerData.commands[command].push(now);
    }
    
    // Record general request
    peerData.general.push(now);
    
    return true;
  }

  /**
   * Clean up old entries
   * @param {number} now - Current timestamp
   */
  cleanup(now) {
    const maxAge = Math.max(
      this.config.windowMs,
      ...Object.values(this.config.commandLimits).map(l => l.windowMs)
    );
    
    for (const [peerId, peerData] of this.requests.entries()) {
      // Clean general requests
      peerData.general = peerData.general.filter(timestamp => timestamp > now - maxAge);
      
      // Clean command requests
      for (const [command, timestamps] of Object.entries(peerData.commands)) {
        const limit = this.config.commandLimits[command];
        if (limit) {
          peerData.commands[command] = timestamps.filter(
            timestamp => timestamp > now - limit.windowMs
          );
        }
      }
      
      // Remove peer if no active requests
      if (peerData.general.length === 0 && 
          Object.values(peerData.commands).every(arr => arr.length === 0)) {
        this.requests.delete(peerId);
      }
    }
  }

  /**
   * Reset rate limit for a peer (useful for testing or manual override)
   * @param {Object} peer - Peer object
   */
  reset(peer) {
    const peerId = this.getPeerId(peer);
    this.requests.delete(peerId);
  }
}

// Singleton instance
const rateLimiter = new RateLimiter();

export default rateLimiter;





