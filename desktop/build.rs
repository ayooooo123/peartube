//! Prepares the P2P engine this build runs.
//!
//! Default: packs worklet/worker.js for this Mac and links bare-kit, which
//! runs it. Needs `npm ci` at the repo root and `sh worklet/bare-kit.sh darwin`
//! once. The Android app (android/) packs the same worker with android/worklet.mjs.
//!
//! With `--features engine-rust`: fetches the pinned peartube-native library
//! with sync-native.py, checks the app's engine contract against it, and links
//! it. The Rust engine is prebuilt (its 13 sibling crates cannot be built from
//! a git dependency), so nothing here compiles Rust.
//!
//! bare-kit only loads linked addons, so the worker's native addons are
//! linked with bare-link into target/bare-addons/<host> as frameworks, and the
//! bundle loads them by name. A Rust-engine build skips all of that and stages
//! the dylib in target/native/<host> for desktop/bundle.sh.
//!
//! The binary finds what it needs through its rpaths: in place for `cargo run`,
//! and in Contents/Frameworks once desktop/bundle.sh has built PearTube.app.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().unwrap();
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());

    let host = match (env::var("CARGO_CFG_TARGET_OS").unwrap().as_str(), env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str()) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        target => panic!("PearTube's desktop app builds for macOS only, not {target:?}"),
    };

    if env::var_os("CARGO_FEATURE_ENGINE_RUST").is_some() {
        rust_engine(&manifest, root, &out, host);
        return;
    }
    bare_worklet(&manifest, root, &out, host);
}

/// The Rust engine: sync-native.py's pinned library, linked by the C ABI.
fn rust_engine(manifest: &Path, root: &Path, out: &Path, host: &str) {
    for path in ["native.lock", "sync-native.py"] {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }
    println!("cargo:rerun-if-env-changed=PEARTUBE_NATIVE_LOCAL");
    if host != "darwin-arm64" {
        panic!("the pinned Rust engine ships for darwin-arm64 only, not {host}");
    }
    let native = out.join("native");
    let local = env::var_os("PEARTUBE_NATIVE_LOCAL");
    // A local checkout is unpinned on purpose: it cannot drift from itself.
    if local.is_none() {
        run(Command::new("python3").arg(root.join("sync-native.py")).arg("check").arg("--strict").current_dir(root));
    }
    let mut fetch = Command::new("python3");
    fetch.arg(root.join("sync-native.py")).arg("fetch");
    if let Some(local) = &local {
        fetch.arg("--local").arg(local);
    }
    run(fetch.arg(host).arg("header").arg(&native).current_dir(root));

    // The library's install name is @rpath/libpeartube_native_ffi.dylib; the
    // fetched asset carries the release's name, so give it the name it asks for.
    let lib = native.join("libpeartube_native_ffi.dylib");
    if let Ok(entries) = fs::read_dir(&native) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path != lib && path.extension().is_some_and(|ext| ext == "dylib") {
                fs::rename(&path, &lib).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
            }
        }
    }
    assert!(lib.is_file(), "sync-native.py fetch left no dylib in {}", native.display());

    // desktop/bundle.sh copies the library the build linked, local or pinned.
    let stage = manifest.join("target/native").join(host);
    fs::create_dir_all(&stage).unwrap();
    fs::copy(&lib, stage.join("libpeartube_native_ffi.dylib")).unwrap();

    println!("cargo:rustc-link-search=native={}", native.display());
    println!("cargo:rustc-link-lib=dylib=peartube_native_ffi");
    // In place for `cargo run`, and in Contents/Frameworks once bundled.
    for rpath in [native.display().to_string(), "@executable_path/../Frameworks".into()] {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{rpath}");
    }
}

/// The JS engine: worklet/worker.js packed with bare-pack and run by bare-kit.
fn bare_worklet(manifest: &Path, root: &Path, out: &Path, host: &str) {
    let worklet = root.join("worklet");
    for path in ["worker.js", "build.mjs", "pack.cjs", "imports.json", "crypto", "vendor/bare-kit"] {
        println!("cargo:rerun-if-changed={}", worklet.join(path).display());
    }
    for path in ["src", "patches", "package.json", "package-lock.json"] {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }

    // Pack and link one entry graph with identical builtin overrides.
    let bundle = out.join("worker.bundle");
    let addons = manifest.join("target/bare-addons").join(host);
    run(Command::new("node")
        .arg(worklet.join("build.mjs"))
        .arg(host)
        .arg(&bundle)
        .arg(&addons)
        .current_dir(root));

    let kit = worklet.join("vendor/bare-kit/darwin");
    if !kit.join("BareKit.framework").exists() {
        panic!("bare-kit is not built for macOS: run `sh worklet/bare-kit.sh darwin`");
    }
    println!("cargo:rustc-link-search=framework={}", kit.display());
    println!("cargo:rustc-link-lib=framework=BareKit");
    for rpath in [kit.display().to_string(), addons.display().to_string(), "@executable_path/../Frameworks".into()] {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{rpath}");
    }
}

fn run(command: &mut Command) {
    let status = command.status().unwrap_or_else(|err| panic!("{command:?}: {err}"));
    assert!(status.success(), "{command:?} failed: {status}");
}
