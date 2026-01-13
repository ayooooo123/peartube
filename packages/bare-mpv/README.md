# bare-mpv

Native libmpv bindings for Bare Runtime. Enables video playback with universal codec support in Pear Desktop applications.

## Installation

```bash
npm install bare-mpv
```

## Usage

```javascript
const { MpvPlayer } = require('bare-mpv')

const player = new MpvPlayer()
player.loadFile('/path/to/video.mkv')
player.play()
```

## Prebuilds

Pre-compiled binaries are available for:

| Platform | Architecture | Status |
|----------|-------------|--------|
| macOS    | arm64       | Available |
| macOS    | x64         | CI Build |
| Linux    | x64         | CI Build |
| Linux    | arm64       | CI Build |
| Windows  | x64         | CI Build |
| Windows  | arm64       | CI Build |

If a prebuild isn't available for your platform, the addon will be compiled from source during install. The build uses the bundled mpv submodule and does not rely on a system libmpv.

## Building from Source

### Prerequisites

All platforms require:
- Node.js 18+
- CMake 3.25+
- A C++17 compiler
- Meson + pkg-config
- Python 3
- Git submodules initialized

### Build

```bash
git submodule update --init --recursive packages/bare-mpv/vendor/mpv
cd packages/bare-mpv
npm install
npx bare-make generate
npx bare-make build
npx bare-make install
```

## CI/CD

Prebuilds are automatically generated via GitHub Actions when changes are pushed to `packages/bare-mpv/`. The workflow:

1. Builds on macOS (arm64 + x64), Linux (x64 + arm64), Windows (x64 + arm64)
2. Collects all `.bare` files into a combined artifact
3. Uploads as release assets

To trigger a manual build, use the "Run workflow" button in GitHub Actions.

## API

### `new MpvPlayer()`

Creates a new mpv player instance.

### `player.loadFile(path)`

Load a video file for playback.

### `player.play()`

Start or resume playback.

### `player.pause()`

Pause playback.

### `player.seek(seconds)`

Seek to a position in seconds.

### `player.setProperty(name, value)`

Set an mpv property (e.g., 'volume', 'speed').

### `player.getProperty(name)`

Get an mpv property value.

### `player.observeProperty(name, callback)`

Watch a property for changes.

### `player.destroy()`

Clean up resources and close the player.

## License

MIT
