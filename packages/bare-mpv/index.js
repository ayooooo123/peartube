/**
 * bare-mpv - High-level JavaScript API for libmpv video playback
 * Enables universal codec support (AC3, DTS, etc.) on Pear desktop
 */

const binding = require('./binding')

class MpvPlayer {
  constructor() {
    this._handle = binding.create()
    this._renderCtx = null
    this._width = 0
    this._height = 0
    this._initialized = false
  }

  _processEvents() {
    if (!this._handle) return 0
    if (typeof binding.processEvents !== 'function') return 0
    return binding.processEvents(this._handle)
  }

  /**
   * Initialize the mpv player
   * @returns {number} Status code (0 = success)
   */
  initialize() {
    if (this._initialized) return 0
    const status = binding.initialize(this._handle)
    this._initialized = status === 0
    return status
  }

  /**
   * Load and play a video file
   * @param {string} url - URL or path to the video file
   */
  loadFile(url) {
    if (!this._initialized) this.initialize()
    const status = binding.command(this._handle, ['loadfile', url])
    this._processEvents()
    return status
  }

  /**
   * Start/resume playback
   */
  play() {
    const status = binding.setProperty(this._handle, 'pause', false)
    this._processEvents()
    return status
  }

  /**
   * Pause playback
   */
  pause() {
    const status = binding.setProperty(this._handle, 'pause', true)
    this._processEvents()
    return status
  }

  /**
   * Stop playback
   */
  stop() {
    const status = binding.command(this._handle, ['stop'])
    this._processEvents()
    return status
  }

  /**
   * Seek to absolute position
   * @param {number} seconds - Position in seconds
   */
  seek(seconds) {
    const status = binding.command(this._handle, ['seek', String(seconds), 'absolute'])
    this._processEvents()
    return status
  }

  /**
   * Seek relative to current position
   * @param {number} seconds - Offset in seconds (positive = forward, negative = backward)
   */
  seekRelative(seconds) {
    const status = binding.command(this._handle, ['seek', String(seconds), 'relative'])
    this._processEvents()
    return status
  }

  /**
   * Get current playback position in seconds
   */
  get currentTime() {
    this._processEvents()
    const val = binding.getProperty(this._handle, 'time-pos')
    return typeof val === 'number' ? val : 0
  }

  /**
   * Get video duration in seconds
   */
  get duration() {
    this._processEvents()
    const val = binding.getProperty(this._handle, 'duration')
    return typeof val === 'number' ? val : 0
  }

  /**
   * Check if playback is paused
   */
  get paused() {
    this._processEvents()
    return binding.getProperty(this._handle, 'pause') === true
  }

  /**
   * Get/set volume (0-100)
   */
  get volume() {
    this._processEvents()
    const val = binding.getProperty(this._handle, 'volume')
    return typeof val === 'number' ? val : 100
  }

  set volume(value) {
    binding.setProperty(this._handle, 'volume', Math.max(0, Math.min(100, value)))
  }

  /**
   * Get/set mute state
   */
  get muted() {
    this._processEvents()
    return binding.getProperty(this._handle, 'mute') === true
  }

  set muted(value) {
    binding.setProperty(this._handle, 'mute', !!value)
  }

  /**
   * Get video width
   */
  get videoWidth() {
    this._processEvents()
    const val = binding.getProperty(this._handle, 'width')
    return typeof val === 'number' ? val : 0
  }

  /**
   * Get video height
   */
  get videoHeight() {
    this._processEvents()
    const val = binding.getProperty(this._handle, 'height')
    return typeof val === 'number' ? val : 0
  }

  /**
   * Check if video has ended
   */
  get ended() {
    this._processEvents()
    return binding.getProperty(this._handle, 'eof-reached') === true
  }

  /**
   * Initialize software renderer at specified dimensions
   * @param {number} width - Render width in pixels
   * @param {number} height - Render height in pixels
   */
  initRender(width, height) {
    if (this._renderCtx) {
      binding.renderFree(this._renderCtx)
    }
    this._width = width
    this._height = height
    this._renderCtx = binding.renderCreate(this._handle, width, height)
    return this._renderCtx !== null
  }

  /**
   * Check if a new frame is available for rendering
   * @returns {boolean} True if frame should be re-rendered
   */
  needsRender() {
    if (!this._renderCtx) return false
    this._processEvents()
    return binding.renderUpdate(this._renderCtx)
  }

  /**
   * Render current frame to RGBA pixel buffer
   * @returns {Uint8Array|null} RGBA pixel data (width * height * 4 bytes)
   */
  renderFrame() {
    if (!this._renderCtx) return null
    this._processEvents()
    return binding.renderFrame(this._renderCtx)
  }

  /**
   * Get the render dimensions
   */
  get renderWidth() {
    return this._width
  }

  get renderHeight() {
    return this._height
  }

  /**
   * Destroy the player and free resources
   */
  destroy() {
    if (this._renderCtx) {
      binding.renderFree(this._renderCtx)
      this._renderCtx = null
    }
    if (this._handle) {
      binding.destroy(this._handle)
      this._handle = null
    }
    this._initialized = false
  }

  /**
   * Set an mpv property
   * @param {string} name - Property name
   * @param {*} value - Property value
   */
  setProperty(name, value) {
    const status = binding.setProperty(this._handle, name, value)
    this._processEvents()
    return status
  }

  /**
   * Get an mpv property
   * @param {string} name - Property name
   * @returns {*} Property value
   */
  getProperty(name) {
    this._processEvents()
    return binding.getProperty(this._handle, name)
  }

  /**
   * Execute an mpv command
   * @param {string[]} args - Command arguments
   */
  command(args) {
    const status = binding.command(this._handle, args)
    this._processEvents()
    return status
  }
}

module.exports = { MpvPlayer }
