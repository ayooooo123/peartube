// Import must not replace a selected bank on a read error, oversized input,
// invalid RIFF/SF2 header, or truncated data. Stream length is not trusted.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

#[cfg(any(target_os = "macos", target_os = "ios", test))]
pub(super) fn stage(reader: impl Read, destination: &Path, max_bytes: u64) -> io::Result<()> {
    let result = (|| {
        let mut output = File::create(destination)?;
        let copied = io::copy(&mut reader.take(max_bytes.saturating_add(1)), &mut output)?;
        if copied > max_bytes {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "SoundFont exceeds the import size limit"));
        }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(destination); }
    result
}

pub(super) fn commit(temporary: &Path, bank: &Path) -> io::Result<()> {
    let mut file = File::open(temporary)?;
    let mut header = [0; 12];
    file.read_exact(&mut header)?;
    let length = u64::from(u32::from_le_bytes(header[4..8].try_into().unwrap())) + 8;
    if &header[..4] != b"RIFF" || &header[8..] != b"sfbk" || file.metadata()?.len() != length {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Select a complete SoundFont 2 (.sf2) file"));
    }
    drop(file);
    fs::rename(temporary, bank)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor, Read};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("peartube-sf2-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }
    fn container(form: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(4 + payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(form);
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn invalid_and_truncated_selections_keep_the_existing_bank() {
        let dir = Directory::new();
        let bank = dir.0.join("bank.sf2");
        let temporary = dir.0.join("selection.tmp");
        std::fs::write(&bank, b"previous selection").unwrap();
        let valid = container(b"sfbk", b"selected data");
        for bytes in [container(b"WAVE", b"not a bank"), valid[..valid.len() - 1].to_vec(), b"RIFF".to_vec()] {
            std::fs::write(&temporary, bytes).unwrap();
            assert!(commit(&temporary, &bank).is_err());
            assert_eq!(std::fs::read(&bank).unwrap(), b"previous selection");
        }
        std::fs::write(&temporary, &valid).unwrap();
        commit(&temporary, &bank).unwrap();
        assert_eq!(std::fs::read(&bank).unwrap(), valid);
        assert!(!temporary.exists());
    }

    #[test]
    fn streaming_limit_and_read_errors_leave_no_partial_selection() {
        let dir = Directory::new();
        let temporary = dir.0.join("selection.tmp");
        let mut input = Cursor::new(vec![0; 64]);
        assert!(stage(&mut input, &temporary, 24).is_err());
        assert_eq!(input.position(), 25);
        assert!(!temporary.exists());

        struct Broken(bool);
        impl Read for Broken {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                if self.0 { return Err(io::Error::other("source disconnected")); }
                self.0 = true;
                out[0] = 1;
                Ok(1)
            }
        }
        assert!(stage(Broken(false), &temporary, 24).is_err());
        assert!(!temporary.exists());
    }
}
