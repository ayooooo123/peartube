# @peartube/engine

Bare-first PearTube core engine prototype.

This package is the production-bound version of the drive-engine spike. It owns Hyperdrive/Corestore/blob-server mechanics and should expose typed APIs to host adapters/UI. Do not import React Native, Expo, Pear UI, or desktop-native code here.

Initial validated architecture:

- Hyperdrive = identity/channel filesystem source of truth
- hypercore-blob-server = sparse HTTP playback from Hyperdrive files
- engine validator/indexer = trusted app state boundary
- distributed-drive/custom registry = later discovery/index helper, not video byte path
