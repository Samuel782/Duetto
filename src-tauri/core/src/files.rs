use std::{fs, io, io::Write, path::{Path, PathBuf}};

/// Passa da un file temporaneo: un arresto a metà non corrompe i dati. `private` limita la lettura
/// al proprietario (su Windows vale la protezione della cartella utente).
pub fn write_atomic(file: &Path, content: &str, private: bool) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut name = file.as_os_str().to_owned();
    name.push(".tmp");
    let tmp = PathBuf::from(name);
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    options.open(&tmp)?.write_all(content.as_bytes())?;
    fs::rename(&tmp, file)
}
