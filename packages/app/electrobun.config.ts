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
    copy: {},
    mac: {
      defaultRenderer: 'native',
    },
  },
}
