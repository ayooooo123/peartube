export default {
  app: {
    name: 'PearTube',
    identifier: 'com.peartube.desktop',
    version: '0.1.0',
  },
  build: {
    bun: {
      entrypoint: 'src/bun/index.ts',
    },
    views: {
      app: {
        entrypoint: 'src/view/index.ts',
      },
    },
    copy: {
      // Expo web export
      'pear': 'views/app',
      // Bare worker (compiled by desktop:worker script)
      'pear/build/workers': 'workers',
      // Node modules needed by the Bare worker at runtime
      'pear/node_modules': 'node_modules',
    },
  },
}
