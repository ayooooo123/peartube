/**
 * Structured logging utility with levels and rotation
 */

import fs from 'fs';
import path from 'path';

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const LOG_LEVEL_NAMES = ['ERROR', 'WARN', 'INFO', 'DEBUG'];

class Logger {
  constructor(options = {}) {
    this.level = options.level || (process.env.NODE_ENV === 'production' ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG);
    this.enableFileLogging = options.enableFileLogging || false;
    this.logDir = options.logDir || './logs';
    this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB
    this.maxFiles = options.maxFiles || 5;
    
    if (this.enableFileLogging) {
      this.ensureLogDirectory();
      this.currentLogFile = this.getLogFileName();
    }
  }

  ensureLogDirectory() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  getLogFileName() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `peardock-${date}.log`);
  }

  rotateLogFile() {
    if (!this.enableFileLogging) return;

    try {
      const stats = fs.statSync(this.currentLogFile);
      if (stats.size > this.maxFileSize) {
        // Rotate: move current to archive
        const archiveName = this.currentLogFile.replace('.log', `-${Date.now()}.log`);
        fs.renameSync(this.currentLogFile, archiveName);
        
        // Clean up old files
        this.cleanupOldLogs();
        
        // Create new log file
        this.currentLogFile = this.getLogFileName();
      }
    } catch (err) {
      // File doesn't exist yet, that's okay
    }
  }

  cleanupOldLogs() {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith('peardock-') && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.logDir, f),
          time: fs.statSync(path.join(this.logDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      // Keep only the most recent maxFiles
      if (files.length > this.maxFiles) {
        files.slice(this.maxFiles).forEach(file => {
          try {
            fs.unlinkSync(file.path);
          } catch (err) {
            console.error(`Failed to delete old log file: ${file.name}`, err);
          }
        });
      }
    } catch (err) {
      console.error('Failed to cleanup old logs:', err);
    }
  }

  formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${LOG_LEVEL_NAMES[level]}] ${message}${metaStr}`;
  }

  writeToFile(message) {
    if (!this.enableFileLogging) return;

    try {
      this.rotateLogFile();
      fs.appendFileSync(this.currentLogFile, message + '\n');
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }

  log(level, message, meta = {}) {
    if (level > this.level) return;

    const formatted = this.formatMessage(level, message, meta);
    
    // Console output
    switch (level) {
      case LOG_LEVELS.ERROR:
        console.error(formatted);
        break;
      case LOG_LEVELS.WARN:
        console.warn(formatted);
        break;
      case LOG_LEVELS.INFO:
        console.log(formatted);
        break;
      case LOG_LEVELS.DEBUG:
        console.log(formatted);
        break;
    }

    // File output
    this.writeToFile(formatted);
  }

  error(message, meta) {
    this.log(LOG_LEVELS.ERROR, message, meta);
  }

  warn(message, meta) {
    this.log(LOG_LEVELS.WARN, message, meta);
  }

  info(message, meta) {
    this.log(LOG_LEVELS.INFO, message, meta);
  }

  debug(message, meta) {
    this.log(LOG_LEVELS.DEBUG, message, meta);
  }
}

// Create singleton instance
const logger = new Logger({
  enableFileLogging: process.env.ENABLE_FILE_LOGGING === 'true',
  level: process.env.LOG_LEVEL === 'ERROR' ? LOG_LEVELS.ERROR :
         process.env.LOG_LEVEL === 'WARN' ? LOG_LEVELS.WARN :
         process.env.LOG_LEVEL === 'INFO' ? LOG_LEVELS.INFO :
         LOG_LEVELS.DEBUG,
});

export default logger;





