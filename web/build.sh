#!/bin/sh
# Compiles peartube-media's WASM engine wet and tight into web/assets/peartube_web.wasm (+ .gz).
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p "$ROOT/web/assets"
# Panic locations embed source paths; map the build machine's cargo home and checkout to fixed names.
REMAP="target.wasm32-unknown-unknown.rustflags=[\"--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo\", \"--remap-path-prefix=$ROOT=/peartube\"]"
(cd "$ROOT/web" && cargo build --config "$ROOT/web/.cargo/config.toml" --config "$REMAP" --target wasm32-unknown-unknown --release)
cp "$ROOT/web/target/wasm32-unknown-unknown/release/peartube_web.wasm" "$ROOT/web/assets/peartube_web.wasm"
gzip -9 -c "$ROOT/web/assets/peartube_web.wasm" > "$ROOT/web/assets/peartube_web.wasm.gz"
# The pins this build came from; test/ui.e2e.js fails when web/Cargo.lock has moved on without a rebuild.
shasum -a 256 "$ROOT/web/Cargo.lock" | cut -d' ' -f1 > "$ROOT/web/assets/peartube_web.lock.sha256"
ls -lh "$ROOT/web/assets/peartube_web.wasm" "$ROOT/web/assets/peartube_web.wasm.gz"
