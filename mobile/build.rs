//! Packs mobile/worker.js for the target and links bare-kit, which runs it.
//! Needs `npm ci` at the repo root and `sh mobile/setup.sh` once.
//!
//! bare-kit only loads linked addons, so the worker's native addons are
//! linked with bare-link into target/bare-addons/<host>, and the bundle loads
//! them by name:
//! - Android: dx copies every .so on the link line into the APK's jniLibs, so
//!   bare-kit, its libc++ and the addons are all passed as link args.
//!   --as-needed keeps the unreferenced ones out of DT_NEEDED.
//! - iOS: dx does not embed frameworks; mobile/ios.sh embeds them with BareKit.
//! - macOS (development only): the binary's rpath points at them in place.
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().unwrap();
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();
    let simulator = env::var("TARGET").unwrap().ends_with("-sim") || (os == "ios" && arch == "x86_64");

    for path in ["worker.js", "pack.cjs", "imports.json", "vendor/bare-kit", "../src", "../package.json", "../package-lock.json"] {
        println!("cargo:rerun-if-changed={}", manifest.join(path).display());
    }

    let (host, abi) = match (os.as_str(), arch.as_str()) {
        ("android", "aarch64") => ("android-arm64", "arm64-v8a"),
        ("android", "x86_64") => ("android-x64", "x86_64"),
        ("android", "arm") => ("android-arm", "armeabi-v7a"),
        ("android", "x86") => ("android-ia32", "x86"),
        ("ios", "aarch64") if simulator => ("ios-arm64-simulator", ""),
        ("ios", "aarch64") => ("ios-arm64", ""),
        ("ios", "x86_64") => ("ios-x64-simulator", ""),
        ("macos", "aarch64") => ("darwin-arm64", ""),
        ("macos", "x86_64") => ("darwin-x64", ""),
        target => panic!("PearTube mobile does not build for {target:?}"),
    };
    // imports.json maps the Node builtins that LAN discovery's mDNS dependencies
    // require (dgram, os, ...) to their bare-* modules.
    let bundle = out.join("worker.bundle");
    run(Command::new(root.join("node_modules/.bin/bare"))
        .arg(manifest.join("pack.cjs"))
        .args(["--linked", "--host", host, "--imports"])
        .arg(manifest.join("imports.json"))
        .arg("--out")
        .arg(&bundle)
        .arg(manifest.join("worker.js"))
        .current_dir(root));
    let addons = manifest.join("target/bare-addons").join(host);
    link_addons(root, &bundle, host, &addons);

    let kit = manifest.join("vendor/bare-kit");
    if !kit.exists() {
        panic!("bare-kit is missing: run `sh mobile/setup.sh`");
    }
    match os.as_str() {
        "android" => {
            let jni = kit.join("android/bare-kit/jni").join(abi);
            link_arg(&jni.join("libbare-kit.so"));
            link_arg(&jni.join("libc++_shared.so"));
            for so in std::fs::read_dir(addons.join(abi)).unwrap() {
                link_arg(&so.unwrap().path());
            }
        }
        "ios" => {
            let slice = if simulator { "ios-arm64_x86_64-simulator" } else { "ios-arm64" };
            link_framework(&kit.join("ios/BareKit.xcframework").join(slice));
            println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/Frameworks");
        }
        _ => {
            let dir = kit.join("darwin/BareKit.xcframework/macos-arm64_x86_64");
            link_framework(&dir);
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", addons.display());
        }
    }
}

/// bare-link every addon the bundle loads. The bundle header maps each
/// addon's binding.js, at its package root, to a `linked:` library.
fn link_addons(root: &Path, bundle: &Path, host: &str, out: &Path) {
    // "<len>\n<json>\n", where len counts both newlines.
    let bytes = std::fs::read(bundle).unwrap();
    let newline = bytes.iter().position(|&b| b == b'\n').unwrap();
    let len: usize = std::str::from_utf8(&bytes[..newline]).unwrap().parse().unwrap();
    let header: serde_json::Value = serde_json::from_slice(&bytes[newline..newline + len]).unwrap();
    let _ = std::fs::remove_dir_all(out);
    for (file, imports) in header["resolutions"].as_object().unwrap() {
        let linked = imports["."]["addon"].as_str().is_some_and(|addon| addon.starts_with("linked:"));
        if linked {
            let package = root.join(Path::new(file.trim_start_matches('/')).parent().unwrap());
            run(Command::new("node").arg(root.join("node_modules/bare-link/bin.js")).args(["--host", host, "--out"]).arg(out).arg(package));
        }
    }
}

fn link_framework(dir: &Path) {
    println!("cargo:rustc-link-search=framework={}", dir.display());
    println!("cargo:rustc-link-lib=framework=BareKit");
}

fn link_arg(path: &Path) {
    println!("cargo:rustc-link-arg={}", path.display());
}

fn run(command: &mut Command) {
    let status = command.status().unwrap_or_else(|err| panic!("{command:?}: {err}"));
    assert!(status.success(), "{command:?} failed: {status}");
}
