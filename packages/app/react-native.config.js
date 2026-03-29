module.exports = {
  dependencies: {
    'react-native-mpv': {
      platforms: {
        // Android playback now uses react-native-video/Media3.
        // Keeping react-native-mpv linked on Android ships a second FFmpeg
        // stack and breaks packaging with duplicate libavcodec.so binaries.
        android: null,
      },
    },
  },
}
