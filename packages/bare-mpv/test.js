/**
 * Simple test for bare-mpv addon
 */

const { MpvPlayer } = require('./index')

console.log('Creating MpvPlayer...')
const player = new MpvPlayer()

console.log('Initializing...')
const status = player.initialize()
console.log('Initialize status:', status)

// Test loading a simple video URL (will fail without network, but tests the binding)
console.log('Testing loadFile...')
try {
  player.loadFile('https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4')
  console.log('loadFile succeeded')
} catch (e) {
  console.log('loadFile error:', e.message)
}

// Wait a bit for video to start loading
setTimeout(() => {
  console.log('duration:', player.duration)
  console.log('currentTime:', player.currentTime)
  console.log('paused:', player.paused)

  console.log('Destroying player...')
  player.destroy()
  console.log('Test complete!')
  process.exit(0)
}, 2000)
