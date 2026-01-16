# bare-mpv

Native libmpv bindings for Bare Runtime. Enables video playback with universal codec support in Pear Desktop applications.

## Installation

```bash
npm install bare-mpv
```

The package includes prebuilt binaries for common platforms. If a prebuild isn't available, it will attempt to build from source (see [Building from Source](#building-from-source)).

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
| macOS    | arm64       | CI Build |
| macOS    | x64         | CI Build |
| Linux    | x64         | CI Build |
| Linux    | arm64       | CI Build |
| Windows  | x64         | CI Build |
| Windows  | arm64       | CI Build |

All prebuilds are statically linked against the vendored mpv library and do not require a system libmpv installation.

## Building from Source

If no prebuild is available for your platform, you'll need to build from source. The build system compiles mpv and all dependencies from the vendored submodule.

### Prerequisites

#### All Platforms
- Node.js 18+
- CMake 3.25+
- Ninja build system
- Meson build system
- pkg-config
- Python 3
- C++17 compiler (Clang recommended)
- NASM (for assembly optimizations)

#### macOS
```bash
brew install cmake ninja meson pkg-config nasm
```

#### Linux (Debian/Ubuntu)
```bash
sudo apt-get install cmake ninja-build pkg-config meson python3 nasm \
  libdrm-dev libasound2-dev libpulse-dev
```

#### Linux (Fedora/RHEL)
```bash
sudo dnf install cmake ninja-build pkg-config meson python3 nasm \
  libdrm-devel alsa-lib-devel pulseaudio-libs-devel
```

#### Windows

Windows builds require MSYS2:

1. Install [MSYS2](https://www.msys2.org/)
2. Open MSYS2 MINGW64 terminal and install dependencies:
```bash
pacman -S base-devel git mingw-w64-x86_64-toolchain mingw-w64-x86_64-cmake \
  mingw-w64-x86_64-ninja mingw-w64-x86_64-meson mingw-w64-x86_64-pkg-config \
  mingw-w64-x86_64-nasm mingw-w64-x86_64-python
```

### Build Steps

```bash
# Clone with submodules (if cloning fresh)
git clone --recursive <repo-url>

# Or initialize submodules in existing clone
git submodule update --init --recursive

# Navigate to bare-mpv
cd packages/bare-mpv

# Install npm dependencies
npm install

# Build (single command)
npm run build

# Or step by step:
npx bare-make generate
npx bare-make build
npx bare-make install
```

The built addon will be placed in `prebuilds/<platform>-<arch>/bare-mpv.bare`.

## CI/CD

Prebuilds are automatically generated via GitHub Actions when changes are pushed to `packages/bare-mpv/`. The workflow:

1. Builds statically-linked binaries on macOS (arm64 + x64), Linux (x64 + arm64), Windows (x64 + arm64)
2. Compiles mpv and all dependencies from the vendored submodule
3. Collects all `.bare` files into a combined artifact
4. Uploads as release assets

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
