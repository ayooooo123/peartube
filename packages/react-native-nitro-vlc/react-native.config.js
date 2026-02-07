module.exports = {
  dependency: {
    platforms: {
      android: {
        packageInstance: 'new NitroVLCPackage()',
        sourceDir: './android',
      },
      ios: {
        podspecPath: './react-native-nitro-vlc.podspec',
      },
    },
  },
};
