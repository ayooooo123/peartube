# PearTube Drive Engine Spike

Isolated validation package for a possible PearTube rearchitecture:

- one Hyperdrive per identity/channel
- `distributed-drive` for unified metadata discovery/list/read
- `hypercore-blob-server` for sparse HTTP range playback from Hyperdrive files

This package must not be imported by production PearTube code. It exists to validate the golden path before any rewrite.

## Golden path

1. Peer A creates a Hyperdrive channel drive.
2. Peer A writes `/profile.json`, `/videos/v1/video.json`, and `/videos/v1/source.mp4`.
3. Peer B discovers/replicates Peer A's drive.
4. Peer B indexes metadata from the drive/distributed view.
5. Peer B streams `/videos/v1/source.mp4` via `hypercore-blob-server` using HTTP range requests.

See `../../docs/plans/2026-04-24-peartube-drive-engine-spike.md` for the implementation plan.
