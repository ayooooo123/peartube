//! A user-selected MIDI bank, private to this device and never in Corestore.
use std::{fs, path::PathBuf};
use crate::worker::DATA_DIR;

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
mod ios;
mod storage;

const MAX_BYTES: u64 = 256 * 1024 * 1024;

pub fn path() -> Option<PathBuf> {
    let path = DATA_DIR.join("soundfont.sf2");
    path.is_file().then_some(path)
}

pub fn clear() -> Result<(), String> {
    match fs::remove_file(DATA_DIR.join("soundfont.sf2")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}

/// Called by App's coroutine so leaving Settings does not cancel an import.
pub async fn choose() -> Result<bool, String> {
    fs::create_dir_all(&*DATA_DIR).map_err(|e| e.to_string())?;
    let temporary = Temporary(DATA_DIR.join(".soundfont-import.tmp"));
    #[cfg(target_os = "android")]
    let selected = android::pick(temporary.0.clone(), MAX_BYTES).await?;
    #[cfg(target_os = "ios")]
    let selected = ios::pick(temporary.0.clone(), MAX_BYTES).await?;
    #[cfg(target_os = "macos")]
    let selected = if let Some(file) = rfd::AsyncFileDialog::new().add_filter("SoundFont 2", &["sf2"]).pick_file().await {
        stage_file(file.path().to_owned(), temporary.0.clone(), MAX_BYTES).await?;
        true
    } else { false };
    #[cfg(not(any(target_os = "android", target_os = "ios", target_os = "macos")))]
    let selected: bool = Err("SoundFont selection is unavailable on this platform".to_string())?;
    if selected {
        storage::commit(&temporary.0, &DATA_DIR.join("soundfont.sf2")).map_err(|e| e.to_string())?;
    }
    Ok(selected)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(super) async fn stage_file(source: PathBuf, destination: PathBuf, max_bytes: u64) -> Result<(), String> {
    let (tx, rx) = futures_channel::oneshot::channel();
    std::thread::spawn(move || {
        let result = (|| {
            let file = fs::File::open(source)?;
            if file.metadata()?.len() > max_bytes {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "SoundFont exceeds the 256 MiB import limit"));
            }
            storage::stage(file, &destination, max_bytes)
        })().map_err(|e| e.to_string());
        if tx.send(result).is_err() { let _ = fs::remove_file(destination); }
    });
    rx.await.map_err(|_| "SoundFont import stopped".to_string())?
}
