use crate::archive::{format_of, Format};
use crate::paths;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

pub fn extract(path: &Path, dest: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .ok_or_else(|| format!("Not an archive: {}", path.display()))?;
    let format = format_of(&name).ok_or_else(|| format!("Unsupported archive: {name}"))?;
    prepare_destination(dest)?;
    match format {
        Format::Zip => extract_zip(path, dest),
        Format::Tar => unpack_tar(BufReader::new(open(path)?), dest),
        Format::TarGz => unpack_tar(
            flate2::read::GzDecoder::new(BufReader::new(open(path)?)),
            dest,
        ),
        Format::TarBz2 => unpack_tar(
            bzip2::read::BzDecoder::new(BufReader::new(open(path)?)),
            dest,
        ),
        Format::Gz => extract_single(
            flate2::read::GzDecoder::new(BufReader::new(open(path)?)),
            dest,
            &stem(&name),
        ),
        Format::Bz2 => extract_single(
            bzip2::read::BzDecoder::new(BufReader::new(open(path)?)),
            dest,
            &stem(&name),
        ),
        Format::SevenZ => sevenz_rust2::decompress_file(path, dest)
            .map_err(|error| format!("Could not extract archive: {error}")),
        Format::Rar => extract_rar(path, dest),
        Format::Arc => Err("Extracting ARC archives is not supported yet.".into()),
        Format::Lha => Err("Extracting LZH archives is not supported yet.".into()),
    }
}

fn open(path: &Path) -> Result<File, String> {
    File::open(path).map_err(|error| paths::io_msg(&error, path))
}

fn prepare_destination(dest: &Path) -> Result<(), String> {
    if dest.exists() {
        let meta = fs::metadata(dest).map_err(|error| paths::io_msg(&error, dest))?;
        if !meta.is_dir() {
            return Err(format!("Not a folder: {}", dest.display()));
        }
        return Ok(());
    }
    fs::create_dir_all(dest).map_err(|error| paths::io_msg(&error, dest))
}

fn stem(name: &str) -> String {
    let base = name.rsplit_once('.').map(|(base, _)| base).unwrap_or(name);
    if base.is_empty() {
        "extracted".to_string()
    } else {
        base.to_string()
    }
}

fn extract_zip(path: &Path, dest: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(BufReader::new(open(path)?))
        .map_err(|error| format!("Could not read archive: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Could not read an archive entry: {error}"))?;
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let output = dest.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| paths::io_msg(&error, &output))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| paths::io_msg(&error, parent))?;
        }
        let file = File::create(&output).map_err(|error| paths::io_msg(&error, &output))?;
        let mut writer = BufWriter::new(file);
        std::io::copy(&mut entry, &mut writer)
            .map_err(|error| format!("Could not extract {}: {error}", output.display()))?;
        writer
            .flush()
            .map_err(|error| paths::io_msg(&error, &output))?;
    }
    Ok(())
}

fn unpack_tar<R: Read>(reader: R, dest: &Path) -> Result<(), String> {
    tar::Archive::new(reader)
        .unpack(dest)
        .map_err(|error| format!("Could not extract archive: {error}"))
}

fn extract_single<R: Read>(mut reader: R, dest: &Path, name: &str) -> Result<(), String> {
    let mut probe = [0u8; 512];
    let mut filled = 0;
    while filled < probe.len() {
        match reader.read(&mut probe[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) => return Err(format!("Could not read archive: {error}")),
        }
    }
    // A bare .gz/.bz2 may still wrap a tar stream; unpack it instead of writing a tar file.
    if filled >= 263 && &probe[257..262] == b"ustar" {
        let replayed = std::io::Cursor::new(probe[..filled].to_vec()).chain(reader);
        return unpack_tar(replayed, dest);
    }
    let output = dest.join(name);
    let file = File::create(&output).map_err(|error| paths::io_msg(&error, &output))?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(&probe[..filled])
        .map_err(|error| paths::io_msg(&error, &output))?;
    std::io::copy(&mut reader, &mut writer)
        .map_err(|error| format!("Could not extract {}: {error}", output.display()))?;
    writer
        .flush()
        .map_err(|error| paths::io_msg(&error, &output))
}

// No pure-Rust RAR decoder is available; fall back to an installed bsdtar,
// 7-Zip, or unrar. Windows ships bsdtar as tar.exe, which reads RAR archives.
fn extract_rar(path: &Path, dest: &Path) -> Result<(), String> {
    let archive = path.as_os_str().to_os_string();
    let target = dest.as_os_str().to_os_string();
    let mut seven_zip_output = OsString::from("-o");
    seven_zip_output.push(&target);
    let mut unrar_target = target.clone();
    unrar_target.push(std::path::MAIN_SEPARATOR_STR);
    let candidates: [(&str, Vec<OsString>); 4] = [
        (
            "tar",
            vec!["-xf".into(), archive.clone(), "-C".into(), target.clone()],
        ),
        (
            "bsdtar",
            vec!["-xf".into(), archive.clone(), "-C".into(), target.clone()],
        ),
        (
            "7z",
            vec!["x".into(), "-y".into(), seven_zip_output, archive.clone()],
        ),
        (
            "unrar",
            vec!["x".into(), "-o+".into(), "-y".into(), archive, unrar_target],
        ),
    ];
    for (program, args) in candidates {
        if run_quiet(program, args) {
            return Ok(());
        }
    }
    Err("Could not extract this RAR archive. Install 7-Zip or WinRAR, or extract it with another tool.".into())
}

fn run_quiet(program: &str, args: Vec<OsString>) -> bool {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn archive_extract(path: String, dest: String) -> Result<String, String> {
    let source = paths::canonical(&paths::expand(&path));
    let target = paths::expand(&dest);
    tauri::async_runtime::spawn_blocking(move || {
        extract(&source, &target)?;
        Ok(paths::text(&paths::canonical(&target)))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("altfe-extract-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn derives_stem_for_single_file_archives() {
        assert_eq!(stem("notes.txt.gz"), "notes.txt");
        assert_eq!(stem("archive.bz2"), "archive");
        assert_eq!(stem("noext"), "noext");
    }

    #[test]
    fn extracts_a_stored_zip() {
        use std::io::Write;
        let root = scratch("zip");
        let archive_path = root.join("sample.zip");
        {
            let file = File::create(&archive_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            writer
                .start_file::<_, ()>("folder/hello.txt", Default::default())
                .unwrap();
            writer.write_all(b"hello").unwrap();
            writer.finish().unwrap();
        }
        let dest = root.join("out");
        extract(&archive_path, &dest).unwrap();
        assert_eq!(
            fs::read_to_string(dest.join("folder/hello.txt")).unwrap(),
            "hello"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extracts_a_tar() {
        let root = scratch("tar");
        let archive_path = root.join("sample.tar");
        {
            let file = File::create(&archive_path).unwrap();
            let mut builder = tar::Builder::new(file);
            let mut header = tar::Header::new_gnu();
            header.set_size(5);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "hello.txt", &b"hello"[..])
                .unwrap();
            builder.finish().unwrap();
        }
        let dest = root.join("out");
        extract(&archive_path, &dest).unwrap();
        assert_eq!(fs::read_to_string(dest.join("hello.txt")).unwrap(), "hello");
        let _ = fs::remove_dir_all(&root);
    }
}
