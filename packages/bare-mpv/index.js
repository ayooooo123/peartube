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
    return binding.command(this._handle, ['loadfile', url])
  }

  /**
   * Start/resume playback
   */
  play() {
    return binding.setProperty(this._handle, 'pause', false)
  }

  /**
   * Pause playback
   */
  pause() {
    return binding.setProperty(this._handle, 'pause', true)
  }

  /**
   * Stop playback
   */
  stop() {
    return binding.command(this._handle, ['stop'])
  }

  /**
   * Seek to absolute position
   * @param {number} seconds - Position in seconds
   */
  seek(seconds) {
    return binding.command(this._handle, ['seek', String(seconds), 'absolute'])
  }

  /**
   * Seek relative to current position
   * @param {number} seconds - Offset in seconds (positive = forward, negative = backward)
   */
  seekRelative(seconds) {
    return binding.command(this._handle, ['seek', String(seconds), 'relative'])
  }

  /**
   * Get current playback position in seconds
   */
  get currentTime() {
    const val = binding.getProperty(this._handle, 'time-pos')
    return typeof val === 'number' ? val : 0
  }

  /**
   * Get video duration in seconds
   */
  get duration() {
    const val = binding.getProperty(this._handle, 'duration')
    return typeof val === 'number' ? val : 0
  }

  /**
   * Check if playback is paused
   */
  get paused() {
    return binding.getProperty(this._handle, 'pause') === true
  }

  /**
   * Get/set volume (0-100)
   */
  get volume() {
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
    return binding.getProperty(this._handle, 'mute') === true
  }

  set muted(value) {
    binding.setProperty(this._handle, 'mute', !!value)
  }

  /**
   * Get video width
   */
  get videoWidth() {
    const val = binding.getProperty(this._handle, 'width')
    return typeof val === 'number' ? val : 0
  }

  /**
   * Get video height
   */
  get videoHeight() {
    const val = binding.getProperty(this._handle, 'height')
    return typeof val === 'number' ? val : 0
  }

  /**
   * Check if video has ended
   */
  get ended() {
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
    return binding.renderUpdate(this._renderCtx)
  }

  /**
   * Render current frame to RGBA pixel buffer
   * @returns {Uint8Array|null} RGBA pixel data (width * height * 4 bytes)
   */
  renderFrame() {
    if (!this._renderCtx) return null
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
    return binding.setProperty(this._handle, name, value)
  }

  /**
   * Get an mpv property
   * @param {string} name - Property name
   * @returns {*} Property value
   */
  getProperty(name) {
    return binding.getProperty(this._handle, name)
  }

  /**
   * Execute an mpv command
   * @param {string[]} args - Command arguments
   */
  command(args) {
    return binding.command(this._handle, args)
  }
}

module.exports = { MpvPlayer }
