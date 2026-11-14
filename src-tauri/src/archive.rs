use crate::paths;
use serde::Serialize;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const MAX_SCAN_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ENTRIES: usize = 200_000;
const MAX_CENTRAL_DIR: u64 = 64 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 1024 * 1024;
const MAX_TRACKED_FOLDERS: usize = 100_000;
const MAX_TOP: usize = 6;

const KIND_NAMES: [&str; 7] = [
    "Application",
    "Source Code",
    "Media Files",
    "Documents",
    "Fonts",
    "3D Models",
    "Archives",
];

#[derive(Serialize, Clone, Default)]
pub struct Summary {
    pub format: String,
    pub files: usize,
    pub folders: usize,
    pub bytes: u64,
    pub kind: String,
    pub top: Vec<String>,
    pub truncated: bool,
    pub locked: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Format {
    Zip,
    Tar,
    TarGz,
    TarBz2,
    Gz,
    Bz2,
    Rar,
    SevenZ,
}

fn format_of(name: &str) -> Option<Format> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        return Some(Format::TarGz);
    }
    if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") || lower.ends_with(".tbz") {
        return Some(Format::TarBz2);
    }
    match lower.rsplit('.').next().unwrap_or("") {
        "zip" => Some(Format::Zip),
        "tar" => Some(Format::Tar),
        "gz" => Some(Format::Gz),
        "bz2" => Some(Format::Bz2),
        "rar" => Some(Format::Rar),
        "7z" => Some(Format::SevenZ),
        _ => None,
    }
}

fn format_label(format: Format) -> &'static str {
    match format {
        Format::Zip => "ZIP",
        Format::Tar => "TAR",
        Format::TarGz => "TAR.GZ",
        Format::TarBz2 => "TAR.BZ2",
        Format::Gz => "GZ",
        Format::Bz2 => "BZ2",
        Format::Rar => "RAR",
        Format::SevenZ => "7Z",
    }
}

fn kind_bucket(ext: &str) -> Option<usize> {
    match paths::classify(ext, false) {
        "exe" => Some(0),
        "code" => Some(1),
        "image" | "video" | "audio" => Some(2),
        "doc" => Some(3),
        "font" => Some(4),
        "model" => Some(5),
        "archive" => Some(6),
        _ => None,
    }
}

fn normalize(raw: &str) -> String {
    let mut name = raw.replace('\\', "/");
    while let Some(rest) = name.strip_prefix("./") {
        name = rest.to_string();
    }
    name.trim_start_matches('/').to_string()
}

fn noise(name: &str) -> bool {
    name.starts_with("__MACOSX/") || matches!(name, ".DS_Store" | "Thumbs.db" | "desktop.ini")
}

#[derive(Default)]
struct Collector {
    files: usize,
    folders: HashSet<String>,
    bytes: u64,
    votes: [usize; 7],
    top: Vec<String>,
    entries: usize,
    truncated: bool,
    locked: bool,
}

impl Collector {
    fn add(&mut self, raw: &str, is_dir: bool, size: u64) -> bool {
        let name = normalize(raw);
        if name.is_empty() || noise(&name) {
            return true;
        }
        self.entries += 1;
        if is_dir || name.ends_with('/') {
            let dir = name.trim_end_matches('/');
            if !dir.is_empty() && self.folders.len() < MAX_TRACKED_FOLDERS {
                self.folders.insert(dir.to_string());
            }
        } else {
            self.files += 1;
            self.bytes = self.bytes.saturating_add(size);
            if let Some(bucket) = kind_bucket(&paths::ext_of(&name)) {
                self.votes[bucket] += 1;
            }
        }
        if self.top.len() < MAX_TOP {
            self.top.push(name);
        }
        if self.entries >= MAX_ENTRIES {
            self.truncated = true;
            return false;
        }
        true
    }

    fn guess_kind(&self) -> &'static str {
        if self.files == 0 {
            return if self.folders.is_empty() { "Empty" } else { "Folder Tree" };
        }
        let mut best = 0;
        for (index, &count) in self.votes.iter().enumerate() {
            if count > self.votes[best] {
                best = index;
            }
        }
        if self.votes[best] == 0 {
            "Mixed Files"
        } else {
            KIND_NAMES[best]
        }
    }

    fn finish(self, format: Format, sniffed_tar: bool) -> Summary {
        let label = if sniffed_tar && matches!(format, Format::Gz | Format::Bz2) {
            format_label(match format {
                Format::Gz => Format::TarGz,
                _ => Format::TarBz2,
            })
        } else {
            format_label(format)
        };
        Summary {
            format: label.to_string(),
            files: self.files,
            folders: self.folders.len(),
            bytes: self.bytes,
            kind: if self.locked {
                "Encrypted".to_string()
            } else {
                self.guess_kind().to_string()
            },
            top: self.top,
            truncated: self.truncated,
            locked: self.locked,
        }
    }
}

fn le16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn le64(bytes: &[u8], at: usize) -> u64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(raw)
}

fn contains_tar(prefix: &[u8]) -> bool {
    prefix.len() >= 263 && &prefix[257..262] == b"ustar"
}

fn read_zip(file: &mut File, col: &mut Collector) -> Option<()> {
    let len = file.metadata().ok()?.len();
    if len < 22 {
        return None;
    }
    let tail_len = std::cmp::min(len, 66_000) as usize;
    let mut tail = vec![0u8; tail_len];
    file.seek(SeekFrom::Start(len - tail_len as u64)).ok()?;
    file.read_exact(&mut tail).ok()?;
    let eocd = (0..tail_len.saturating_sub(21))
        .rev()
        .find(|&i| tail[i..i + 4] == *b"PK\x05\x06")?;

    let mut cd_size = le32(&tail, eocd + 12) as u64;
    let mut cd_offset = le32(&tail, eocd + 16) as u64;
    if (cd_size == u32::MAX as u64 || cd_offset == u32::MAX as u64) && eocd >= 20 {
        let locator = eocd - 20;
        if tail[locator..locator + 4] == *b"PK\x06\x07" {
            let record = le64(&tail, locator + 8);
            let mut header = [0u8; 56];
            file.seek(SeekFrom::Start(record)).ok()?;
            if file.read_exact(&mut header).is_ok() && header[0..4] == *b"PK\x06\x06" {
                cd_size = le64(&header, 40);
                cd_offset = le64(&header, 48);
            }
        }
    }

    let limit = std::cmp::min(cd_size, MAX_CENTRAL_DIR);
    if limit < cd_size {
        col.truncated = true;
    }
    let mut dir = vec![0u8; limit as usize];
    file.seek(SeekFrom::Start(cd_offset)).ok()?;
    let mut got = 0;
    while got < dir.len() {
        match file.read(&mut dir[got..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => got += n,
        }
    }
    dir.truncate(got);

    let mut at = 0;
    while at + 46 <= dir.len() {
        if dir[at..at + 4] != *b"PK\x01\x02" {
            break;
        }
        let name_len = le16(&dir, at + 28) as usize;
        let extra_len = le16(&dir, at + 30) as usize;
        let comment_len = le16(&dir, at + 32) as usize;
        let start = at + 46;
        let end = start + name_len;
        if end > dir.len() {
            break;
        }
        let mut size = le32(&dir, at + 24) as u64;
        if size == u32::MAX as u64 {
            if let Some(zip64) = zip64_size(&dir, end, extra_len) {
                size = zip64;
            }
        }
        let flags = le16(&dir, at + 8);
        let name = String::from_utf8_lossy(&dir[start..end]).into_owned();
        let is_dir = name.ends_with('/');
        if !is_dir && flags & 0x0001 != 0 {
            col.locked = true;
        }
        if !col.add(&name, is_dir, size) {
            break;
        }
        at = end + extra_len + comment_len;
    }
    Some(())
}

fn zip64_size(dir: &[u8], start: usize, extra_len: usize) -> Option<u64> {
    let end = std::cmp::min(start + extra_len, dir.len());
    let mut at = start;
    while at + 4 <= end {
        let id = le16(dir, at);
        let len = le16(dir, at + 2) as usize;
        if id == 0x0001 && len >= 8 && at + 4 + 8 <= dir.len() {
            return Some(le64(dir, at + 4));
        }
        at += 4 + len;
    }
    None
}

fn tar_size(field: &[u8]) -> u64 {
    if field[0] & 0x80 != 0 {
        let mut value = (field[0] & 0x7f) as u64;
        for &byte in &field[1..] {
            value = (value << 8) | byte as u64;
        }
        return value;
    }
    let text = String::from_utf8_lossy(field);
    u64::from_str_radix(text.trim_matches(|c: char| c == '\0' || c == ' '), 8).unwrap_or(0)
}

fn tar_text(field: &[u8]) -> String {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).to_string()
}

fn read_exact_budget<R: Read>(reader: &mut R, buf: &mut [u8], budget: &mut u64) -> bool {
    if (buf.len() as u64) > *budget {
        *budget = 0;
        return false;
    }
    if reader.read_exact(buf).is_err() {
        return false;
    }
    *budget -= buf.len() as u64;
    true
}

fn skip_budget<R: Read>(reader: &mut R, bytes: u64, budget: &mut u64) -> bool {
    let mut left = bytes;
    let mut sink = [0u8; 8192];
    while left > 0 {
        let want = std::cmp::min(left, sink.len() as u64) as usize;
        if !read_exact_budget(reader, &mut sink[..want], budget) {
            return false;
        }
        left -= want as u64;
    }
    true
}

fn read_tar<R: Read>(reader: &mut R, col: &mut Collector) -> bool {
    let mut budget = MAX_SCAN_BYTES;
    let mut header = [0u8; 512];
    let mut long_name: Option<String> = None;
    loop {
        if !read_exact_budget(reader, &mut header, &mut budget) {
            if budget == 0 {
                col.truncated = true;
            }
            return false;
        }
        if header.iter().all(|&b| b == 0) {
            return true;
        }
        let size = tar_size(&header[124..136]);
        let padded = size.div_ceil(512) * 512;
        match header[156] {
            b'L' => {
                let cap = std::cmp::min(size, 4096);
                let mut name = vec![0u8; cap as usize];
                if !read_exact_budget(reader, &mut name, &mut budget) {
                    col.truncated = true;
                    return false;
                }
                long_name = Some(tar_text(&name));
                if padded > cap && !skip_budget(reader, padded - cap, &mut budget) {
                    col.truncated = true;
                    return false;
                }
                continue;
            }
            b'x' | b'K' | b'g' => {
                if !skip_budget(reader, padded, &mut budget) {
                    col.truncated = true;
                    return false;
                }
                continue;
            }
            _ => {}
        }
        let name = tar_text(&header[0..100]);
        let prefix = tar_text(&header[345..500]);
        let full = match long_name.take() {
            Some(long) => long,
            None if !prefix.is_empty() => format!("{prefix}/{name}"),
            None => name,
        };
        let is_dir = matches!(header[156], b'5' | b'D') || full.ends_with('/');
        if !col.add(&full, is_dir, size) {
            return true;
        }
        if !skip_budget(reader, padded, &mut budget) {
            col.truncated = true;
            return false;
        }
    }
}

fn gzip_name<R: Read>(reader: &mut R) -> Option<String> {
    let mut fixed = [0u8; 10];
    reader.read_exact(&mut fixed).ok()?;
    if fixed[0] != 0x1f || fixed[1] != 0x8b {
        return None;
    }
    let flags = fixed[3];
    if flags & 0x04 != 0 {
        let mut len = [0u8; 2];
        reader.read_exact(&mut len).ok()?;
        let skip = u16::from_le_bytes(len) as usize;
        let mut sink = [0u8; 1024];
        let mut left = skip;
        while left > 0 {
            let want = std::cmp::min(left, sink.len());
            reader.read_exact(&mut sink[..want]).ok()?;
            left -= want;
        }
    }
    let mut name = String::new();
    if flags & 0x08 != 0 {
        let mut byte = [0u8; 1];
        for _ in 0..1024 {
            reader.read_exact(&mut byte).ok()?;
            if byte[0] == 0 {
                break;
            }
            name.push(byte[0] as char);
        }
    }
    if flags & 0x10 != 0 {
        let mut byte = [0u8; 1];
        for _ in 0..4096 {
            reader.read_exact(&mut byte).ok()?;
            if byte[0] == 0 {
                break;
            }
        }
    }
    if flags & 0x02 != 0 {
        let mut crc = [0u8; 2];
        reader.read_exact(&mut crc).ok()?;
    }
    Some(name)
}

fn gzip_trailer_size(file: &mut File) -> Option<u64> {
    let len = file.metadata().ok()?.len();
    if len < 18 {
        return None;
    }
    file.seek(SeekFrom::Start(len - 4)).ok()?;
    let mut raw = [0u8; 4];
    file.read_exact(&mut raw).ok()?;
    file.seek(SeekFrom::Start(0)).ok()?;
    Some(u32::from_le_bytes(raw) as u64)
}

fn read_gz(mut file: File, col: &mut Collector, fallback: &str) -> bool {
    let size = gzip_trailer_size(&mut file).unwrap_or(0);
    let mut reader = BufReader::new(file);
    let mut name = gzip_name(&mut reader).unwrap_or_default();
    if name.is_empty() {
        name = fallback.to_string();
    }
    // gzip_name consumed the header (and any FNAME/FEXTRA fields), so the rest is raw deflate.
    let mut decoder = flate2::read::DeflateDecoder::new(reader);
    let mut probe = [0u8; 512];
    let mut filled = 0;
    while filled < probe.len() {
        match decoder.read(&mut probe[filled..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => filled += n,
        }
    }
    if contains_tar(&probe[..filled]) {
        let mut replayed = std::io::Cursor::new(probe[..filled].to_vec()).chain(decoder);
        read_tar(&mut replayed, col);
        return true;
    }
    col.add(&name, false, size);
    false
}

fn read_bz2(file: File, col: &mut Collector, fallback: &str) -> bool {
    let reader = BufReader::new(file);
    let mut decoder = bzip2::read::BzDecoder::new(reader);
    let mut probe = [0u8; 512];
    let mut filled = 0;
    while filled < probe.len() {
        match decoder.read(&mut probe[filled..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => filled += n,
        }
    }
    if contains_tar(&probe[..filled]) {
        let mut replayed = std::io::Cursor::new(probe[..filled].to_vec()).chain(decoder);
        read_tar(&mut replayed, col);
        return true;
    }
    col.add(fallback, false, 0);
    false
}

fn read_rar(file: &mut File, col: &mut Collector) -> Option<()> {
    let mut signature = [0u8; 7];
    file.read_exact(&mut signature).ok()?;
    if signature[0..6] != *b"Rar!\x1a\x07" {
        return None;
    }
    match signature[6] {
        0 => read_rar4(file, col),
        1 => {
            let mut high = [0u8; 1];
            file.read_exact(&mut high).ok()?;
            if high[0] == 0 {
                read_rar5(file, col)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn read_rar4(file: &mut File, col: &mut Collector) -> Option<()> {
    loop {
        let mut base = [0u8; 7];
        if file.read_exact(&mut base).is_err() {
            return Some(());
        }
        let head_type = base[2];
        let head_flags = le16(&base, 3);
        let head_size = le16(&base, 5) as usize;
        if head_size < 7 {
            return Some(());
        }
        let has_data = head_flags & 0x8000 != 0;
        let mut add_size = 0u64;
        if has_data {
            let mut raw = [0u8; 4];
            file.read_exact(&mut raw).ok()?;
            add_size = u32::from_le_bytes(raw) as u64;
        }
        let body_len = head_size - 7 - if has_data { 4 } else { 0 };
        let mut body = vec![0u8; std::cmp::min(body_len, MAX_HEADER_BYTES)];
        if !body.is_empty() && file.read_exact(&mut body).is_err() {
            return Some(());
        }
        if body_len > body.len() {
            file.seek(SeekFrom::Current((body_len - body.len()) as i64)).ok()?;
        }
        if head_type == 0x73 {
            if head_flags & 0x0080 != 0 {
                col.locked = true;
                return Some(());
            }
        } else if head_type == 0x74 && body.len() >= 25 {
            let unp_size = le32(&body, 4) as u64;
            let name_len = le16(&body, 19) as usize;
            let mut offset = 25;
            if head_flags & 0x0100 != 0 {
                offset += 8;
            }
            if head_flags & 0x0400 != 0 {
                offset += 8;
            }
            if offset + name_len <= body.len() {
                let name = String::from_utf8_lossy(&body[offset..offset + name_len]).into_owned();
                let is_dir = head_flags & 0x00E0 == 0x00E0;
                if !is_dir && head_flags & 0x0004 != 0 {
                    col.locked = true;
                }
                if !col.add(&name, is_dir, if is_dir { 0 } else { unp_size }) {
                    return Some(());
                }
            }
        } else if head_type == 0x7B {
            return Some(());
        }
        if has_data && add_size > 0 {
            file.seek(SeekFrom::Current(add_size as i64)).ok()?;
        }
    }
}

fn read_rar5(file: &mut File, col: &mut Collector) -> Option<()> {
    let mut crc = [0u8; 4];
    loop {
        if file.read_exact(&mut crc).is_err() {
            return Some(());
        }
        let header_size = match read_vint_file(file) {
            Some(size) => size,
            None => return Some(()),
        };
        if header_size > MAX_HEADER_BYTES as u64 {
            return None;
        }
        let mut header = vec![0u8; header_size as usize];
        if file.read_exact(&mut header).is_err() {
            return Some(());
        }
        let mut cursor = Cursor::new(&header);
        let head_type = cursor.vint()?;
        let flags = cursor.vint()?;
        let extra_size = if flags & 0x0001 != 0 { cursor.vint()? } else { 0 };
        if extra_size > 0 {
            if let Some(start) = header.len().checked_sub(extra_size as usize) {
                if start >= cursor.at && rar5_extra_locked(&header[start..]) {
                    col.locked = true;
                }
            }
        }
        let data_size = if flags & 0x0002 != 0 { cursor.vint()? } else { 0 };
        if head_type == 2 {
            let file_flags = cursor.vint()?;
            let unp_size = cursor.vint()?;
            cursor.vint()?; // attributes
            if file_flags & 0x0002 != 0 {
                cursor.bytes(4)?;
            }
            if file_flags & 0x0004 != 0 {
                cursor.bytes(4)?;
            }
            cursor.vint()?; // compression info
            cursor.vint()?; // host OS
            let name_len = cursor.vint()? as usize;
            let name = String::from_utf8_lossy(cursor.bytes(name_len)?).into_owned();
            let is_dir = file_flags & 0x0001 != 0;
            if !col.add(&name, is_dir, if is_dir { 0 } else { unp_size }) {
                return Some(());
            }
        } else if head_type == 5 {
            return Some(());
        }
        if data_size > 0 {
            file.seek(SeekFrom::Current(data_size as i64)).ok()?;
        }
    }
}

fn rar5_extra_locked(extra: &[u8]) -> bool {
    let mut at = 0;
    while at < extra.len() {
        let mut cursor = Cursor::new(&extra[at..]);
        let Some(size) = cursor.vint() else {
            return false;
        };
        let Some(kind) = cursor.vint() else {
            return false;
        };
        if kind == 1 {
            // File encryption record.
            return true;
        }
        if size == 0 || size as usize > extra.len() - at {
            return false;
        }
        at += size as usize;
    }
    false
}

fn sevenz_error_locked(err: &sevenz_rust2::Error) -> bool {
    match err {
        sevenz_rust2::Error::PasswordRequired | sevenz_rust2::Error::MaybeBadPassword(_) => true,
        // Opening a header-encrypted archive without a password surfaces the header's AES coder.
        sevenz_rust2::Error::UnsupportedCompressionMethod(method) => method.contains("AES"),
        _ => false,
    }
}

fn read_7z(path: &Path, col: &mut Collector) -> Option<()> {
    let file = File::open(path).ok()?;
    let reader = match sevenz_rust2::ArchiveReader::new_with_memory_limit(
        BufReader::new(file),
        sevenz_rust2::Password::empty(),
        64 * 1024,
    ) {
        Ok(reader) => reader,
        Err(err) if sevenz_error_locked(&err) => {
            col.locked = true;
            return Some(());
        }
        Err(_) => return None,
    };
    let archive = reader.archive();
    for (index, entry) in archive.files.iter().enumerate() {
        if entry.is_anti_item {
            continue;
        }
        if !entry.is_directory && archive.is_file_encrypted(index) {
            col.locked = true;
        }
        let size = if entry.is_directory { 0 } else { entry.size };
        if !col.add(&entry.name, entry.is_directory, size) {
            break;
        }
    }
    Some(())
}

fn read_vint_file(file: &mut File) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0;
    for _ in 0..10 {
        let mut byte = [0u8; 1];
        file.read_exact(&mut byte).ok()?;
        value |= ((byte[0] & 0x7f) as u64) << shift;
        if byte[0] & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
    }
    None
}

struct Cursor<'a> {
    buf: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, at: 0 }
    }

    fn vint(&mut self) -> Option<u64> {
        let mut value = 0u64;
        let mut shift = 0;
        for _ in 0..10 {
            let byte = *self.buf.get(self.at)?;
            self.at += 1;
            value |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
            shift += 7;
        }
        None
    }

    fn bytes(&mut self, count: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(count)?;
        let slice = self.buf.get(self.at..end)?;
        self.at = end;
        Some(slice)
    }
}

pub fn summarize(path: &Path) -> Option<Summary> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let format = format_of(&name)?;
    let fallback = name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .filter(|stem| !stem.is_empty())
        .unwrap_or(&name)
        .to_string();
    let mut col = Collector::default();
    let mut sniffed_tar = false;
    match format {
        Format::Zip => read_zip(&mut File::open(path).ok()?, &mut col)?,
        Format::Tar => {
            read_tar(&mut BufReader::new(File::open(path).ok()?), &mut col);
        }
        Format::TarGz => {
            read_tar(
                &mut flate2::read::GzDecoder::new(BufReader::new(File::open(path).ok()?)),
                &mut col,
            );
        }
        Format::TarBz2 => {
            read_tar(
                &mut bzip2::read::BzDecoder::new(BufReader::new(File::open(path).ok()?)),
                &mut col,
            );
        }
        Format::Gz => sniffed_tar = read_gz(File::open(path).ok()?, &mut col, &fallback),
        Format::Bz2 => sniffed_tar = read_bz2(File::open(path).ok()?, &mut col, &fallback),
        Format::Rar => read_rar(&mut File::open(path).ok()?, &mut col)?,
        Format::SevenZ => read_7z(path, &mut col)?,
    }
    if col.entries == 0 && !col.locked && matches!(format, Format::Rar) {
        return None;
    }
    Some(col.finish(format, sniffed_tar))
}

#[tauri::command]
pub async fn archive_summary(path: String) -> Option<Summary> {
    let target = paths::canonical(&paths::expand(&path));
    tauri::async_runtime::spawn_blocking(move || summarize(&target))
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn recognizes_encrypted_sevenz_errors() {
        assert!(sevenz_error_locked(&sevenz_rust2::Error::PasswordRequired));
        assert!(sevenz_error_locked(&sevenz_rust2::Error::MaybeBadPassword(
            std::io::Error::new(std::io::ErrorKind::InvalidData, "crc")
        )));
        assert!(sevenz_error_locked(
            &sevenz_rust2::Error::UnsupportedCompressionMethod("AES256_SHA256".into())
        ));
        assert!(!sevenz_error_locked(
            &sevenz_rust2::Error::UnsupportedCompressionMethod("PPMd".into())
        ));
        assert!(!sevenz_error_locked(&sevenz_rust2::Error::ChecksumVerificationFailed));
    }

    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("altfe-archive-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn gzip(bytes: &[u8], name: Option<&str>) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use std::io::Write;
        let mut builder = flate2::GzBuilder::new();
        if let Some(name) = name {
            builder = builder.filename(name);
        }
        let mut encoder = builder.write(Vec::new(), flate2::Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn bzip(bytes: &[u8]) -> Vec<u8> {
        use bzip2::write::BzEncoder;
        use std::io::Write;
        let mut encoder = BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn zip_bytes(entries: &[(&str, u64)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, size) in entries {
            let offset = out.len() as u32;
            out.extend_from_slice(b"PK\x03\x04");
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&(*size as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());

            central.extend_from_slice(b"PK\x01\x02");
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&(*size as u32).to_le_bytes());
            central.extend_from_slice(&(*size as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    fn zip_encrypted_bytes(name: &str) -> Vec<u8> {
        let name = name.as_bytes();
        let mut out = Vec::new();
        out.extend_from_slice(b"PK\x01\x02");
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0x0001u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&64u32.to_le_bytes());
        out.extend_from_slice(&64u32.to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(name);
        let cd_size = out.len() as u32;
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    fn tar_header(name: &str, size: u64, typeflag: u8) -> [u8; 512] {
        let mut block = [0u8; 512];
        block[..name.len()].copy_from_slice(name.as_bytes());
        block[100..107].copy_from_slice(b"0000644");
        block[108..115].copy_from_slice(b"0000000");
        block[116..123].copy_from_slice(b"0000000");
        block[124..135].copy_from_slice(format!("{:011o}", size).as_bytes());
        block[136..147].copy_from_slice(b"00000000000");
        block[148..156].copy_from_slice(b"        ");
        block[156] = typeflag;
        block[257..263].copy_from_slice(b"ustar\0");
        block[263..265].copy_from_slice(b"00");
        let sum: u32 = block.iter().map(|&b| b as u32).sum();
        block[148..155].copy_from_slice(format!("{:06o}\0", sum).as_bytes());
        block
    }

    fn tar_bytes(entries: &[(&str, u64, u8)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, size, typeflag) in entries {
            out.extend_from_slice(&tar_header(name, *size, *typeflag));
            let padded = size.div_ceil(512) * 512;
            out.extend(std::iter::repeat(0u8).take(padded as usize));
        }
        out.extend(std::iter::repeat(0u8).take(1024));
        out
    }

    fn rar4_header(name: &str, unp_size: u32, is_dir: bool, extra_flags: u16) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&unp_size.to_le_bytes());
        body.push(0);
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        body.push(20);
        body.push(0x30);
        body.extend_from_slice(&(name.len() as u16).to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(name.as_bytes());
        let mut out = Vec::new();
        out.extend_from_slice(&0u16.to_le_bytes());
        out.push(0x74);
        let flags: u16 = (if is_dir { 0x00E0 } else { 0 }) | extra_flags;
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&((7 + body.len()) as u16).to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    fn rar4_bytes(files: &[(&str, u32, bool)]) -> Vec<u8> {
        let mut out = b"Rar!\x1a\x07\x00".to_vec();
        out.extend_from_slice(&0u16.to_le_bytes());
        out.push(0x73);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&13u16.to_le_bytes());
        out.extend_from_slice(&[0u8; 6]);
        for (name, size, is_dir) in files {
            out.extend_from_slice(&rar4_header(name, *size, *is_dir, 0));
        }
        out.extend_from_slice(&0u16.to_le_bytes());
        out.push(0x7B);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&7u16.to_le_bytes());
        out
    }

    fn rar4_encrypted_bytes() -> Vec<u8> {
        let mut out = b"Rar!\x1a\x07\x00".to_vec();
        out.extend_from_slice(&0u16.to_le_bytes());
        out.push(0x73);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&13u16.to_le_bytes());
        out.extend_from_slice(&[0u8; 6]);
        out.extend_from_slice(&rar4_header("secret.txt", 128, false, 0x0004));
        out.extend_from_slice(&0u16.to_le_bytes());
        out.push(0x7B);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&7u16.to_le_bytes());
        out
    }

    fn rar4_header_encrypted_bytes() -> Vec<u8> {
        let mut out = b"Rar!\x1a\x07\x00".to_vec();
        out.extend_from_slice(&0u16.to_le_bytes());
        out.push(0x73);
        out.extend_from_slice(&0x0080u16.to_le_bytes());
        out.extend_from_slice(&13u16.to_le_bytes());
        out.extend_from_slice(&[0u8; 6]);
        out
    }

    fn vint(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value > 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                return out;
            }
        }
    }

    fn rar5_block(kind: u64, flags: u64, body: &[u8]) -> Vec<u8> {
        let mut data = vint(kind);
        data.extend_from_slice(&vint(flags));
        data.extend_from_slice(body);
        let mut out = 0u32.to_le_bytes().to_vec();
        out.extend_from_slice(&vint(data.len() as u64));
        out.extend_from_slice(&data);
        out
    }

    fn rar5_entry(name: &str, size: u64, is_dir: bool) -> Vec<u8> {
        let mut body = vint(0); // extra area size
        body.extend_from_slice(&vint(0)); // data area size
        body.extend_from_slice(&vint(if is_dir { 1 } else { 0 }));
        body.extend_from_slice(&vint(size));
        body.extend_from_slice(&vint(0x20));
        body.extend_from_slice(&vint(0));
        body.extend_from_slice(&vint(0));
        body.extend_from_slice(&vint(name.len() as u64));
        body.extend_from_slice(name.as_bytes());
        rar5_block(2, 0x03, &body)
    }

    fn rar5_bytes(entries: &[(&str, u64, bool)]) -> Vec<u8> {
        let mut out = b"Rar!\x1a\x07\x01\x00".to_vec();
        let mut main = vint(0);
        main.extend_from_slice(&vint(0));
        out.extend(rar5_block(1, 0x05, &main));
        for (name, size, is_dir) in entries {
            out.extend(rar5_entry(name, *size, *is_dir));
        }
        out.extend(rar5_block(5, 0, &vint(0)));
        out
    }

    fn rar5_encrypted_bytes() -> Vec<u8> {
        // One extra-area record: size 2 bytes, type 1 (file encryption).
        let record = [0x02u8, 0x01];
        let name = b"secret.txt";
        let mut body = vint(record.len() as u64);
        body.extend_from_slice(&vint(0));
        body.extend_from_slice(&vint(0));
        body.extend_from_slice(&vint(256));
        body.extend_from_slice(&vint(0x20));
        body.extend_from_slice(&vint(0));
        body.extend_from_slice(&vint(0));
        body.extend_from_slice(&vint(name.len() as u64));
        body.extend_from_slice(name);
        body.extend_from_slice(&record);
        let mut out = b"Rar!\x1a\x07\x01\x00".to_vec();
        let mut main = vint(0);
        main.extend_from_slice(&vint(0));
        out.extend(rar5_block(1, 0x05, &main));
        out.extend(rar5_block(2, 0x03, &body));
        out.extend(rar5_block(5, 0, &vint(0)));
        out
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &byte in bytes {
            crc ^= byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn sevenz_number(value: u64) -> Vec<u8> {
        let mut first = 0u8;
        let mut extra = 0;
        while extra < 8 {
            if value < (1u64 << (7 * (extra + 1))) {
                first |= (value >> (8 * extra)) as u8;
                break;
            }
            first |= 0x80 >> extra;
            extra += 1;
        }
        let mut out = vec![first];
        for index in 0..extra {
            out.push((value >> (8 * index)) as u8);
        }
        out
    }

    fn sevenz_bytes() -> Vec<u8> {
        let names = ["docs", "docs/readme.txt", "empty.txt"];
        let payload = b"hello world";

        let mut header = vec![0x01]; // kHeader
        header.push(0x04); // kMainStreamsInfo
        header.push(0x06); // kPackInfo
        header.extend(sevenz_number(0)); // pack position
        header.extend(sevenz_number(1)); // pack stream count
        header.push(0x09); // kSize
        header.extend(sevenz_number(payload.len() as u64));
        header.push(0x00); // end pack info

        header.push(0x07); // kUnpackInfo
        header.push(0x0B); // kFolder
        header.extend(sevenz_number(1)); // folder count
        header.push(0x00); // folders are inline
        header.extend(sevenz_number(1)); // coder count
        header.push(0x01); // one-byte codec id, simple coder, no attributes
        header.push(0x00); // Copy method
        header.push(0x0C); // kCodersUnpackSize
        header.extend(sevenz_number(payload.len() as u64));
        header.push(0x00); // end unpack info

        header.push(0x08); // kSubStreamsInfo
        header.push(0x00); // end sub streams info
        header.push(0x00); // end main streams info

        let mut name_data = vec![0x00]; // names are inline
        for name in names {
            for unit in name.encode_utf16() {
                name_data.extend_from_slice(&unit.to_le_bytes());
            }
            name_data.extend_from_slice(&[0, 0]);
        }

        header.push(0x05); // kFilesInfo
        header.extend(sevenz_number(names.len() as u64));
        header.push(0x0E); // kEmptyStream
        header.push(0x01); // one byte of bits
        header.push(0xA0); // docs and empty.txt have no stream (most significant bit first)
        header.push(0x0F); // kEmptyFile
        header.push(0x01);
        header.push(0x40); // empty.txt is a file, docs is a folder
        header.push(0x11); // kName
        header.extend(sevenz_number(name_data.len() as u64));
        header.extend_from_slice(&name_data);
        header.push(0x00); // end files info
        header.push(0x00); // end header

        let mut tail = Vec::new();
        tail.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        tail.extend_from_slice(&(header.len() as u64).to_le_bytes());
        tail.extend_from_slice(&crc32(&header).to_le_bytes());

        let mut out = b"7z\xBC\xAF\x27\x1C".to_vec();
        out.extend_from_slice(&[0x00, 0x04]);
        out.extend_from_slice(&crc32(&tail).to_le_bytes());
        out.extend_from_slice(&tail);
        out.extend_from_slice(payload);
        out.extend_from_slice(&header);
        out
    }

    #[test]
    fn recognizes_compound_extensions() {
        assert!(matches!(format_of("a.tar.gz"), Some(Format::TarGz)));
        assert!(matches!(format_of("a.TGZ"), Some(Format::TarGz)));
        assert!(matches!(format_of("a.tar.bz2"), Some(Format::TarBz2)));
        assert!(matches!(format_of("a.tbz2"), Some(Format::TarBz2)));
        assert!(matches!(format_of("a.zip"), Some(Format::Zip)));
        assert!(matches!(format_of("a.rar"), Some(Format::Rar)));
        assert!(matches!(format_of("a.7z"), Some(Format::SevenZ)));
    }

    #[test]
    fn summarizes_zip() {
        let path = temp_file(
            "sample.zip",
            &zip_bytes(&[
                ("src/", 0),
                ("src/main.rs", 120),
                ("src/lib.rs", 80),
                ("README.md", 30),
            ]),
        );
        let summary = summarize(&path).unwrap();
        assert_eq!(summary.format, "ZIP");
        assert_eq!(summary.files, 3);
        assert_eq!(summary.folders, 1);
        assert_eq!(summary.bytes, 230);
        assert_eq!(summary.kind, "Source Code");
        assert_eq!(summary.top.len(), 4);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn summarizes_tar_family() {
        let tar = tar_bytes(&[
            ("app/", 0, b'5'),
            ("app/setup.exe", 4096, b'0'),
            ("app/readme.txt", 12, b'0'),
        ]);
        for (name, bytes, expected) in [
            ("plain.tar", tar.clone(), "TAR"),
            ("plain.tar.gz", gzip(&tar, None), "TAR.GZ"),
            ("plain.tar.bz2", bzip(&tar), "TAR.BZ2"),
        ] {
            let path = temp_file(name, &bytes);
            let summary = summarize(&path).unwrap();
            assert_eq!(summary.format, expected, "{name}");
            assert_eq!(summary.files, 2, "{name}");
            assert_eq!(summary.folders, 1, "{name}");
            assert_eq!(summary.bytes, 4108, "{name}");
            assert_eq!(summary.kind, "Application", "{name}");
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn sniffs_tar_inside_plain_gzip() {
        let tar = tar_bytes(&[("notes/", 0, b'5'), ("notes/todo.txt", 5, b'0')]);
        let path = temp_file("mystery.gz", &gzip(&tar, Some("mystery.tar")));
        let summary = summarize(&path).unwrap();
        assert_eq!(summary.format, "TAR.GZ");
        assert_eq!(summary.files, 1);
        assert_eq!(summary.folders, 1);
        assert_eq!(summary.kind, "Documents");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn summarizes_single_file_gzip() {
        let path = temp_file("solo.gz", &gzip(b"hello world", Some("notes.txt")));
        let summary = summarize(&path).unwrap();
        assert_eq!(summary.format, "GZ");
        assert_eq!(summary.files, 1);
        assert_eq!(summary.folders, 0);
        assert_eq!(summary.bytes, 11);
        assert_eq!(summary.top[0], "notes.txt");
        assert_eq!(summary.kind, "Documents");
        let _ = fs::remove_file(path);

        let unnamed = temp_file("solo.gz", &gzip(b"hello world", None));
        let summary = summarize(&unnamed).unwrap();
        assert_eq!(summary.top[0], "solo");
        let _ = fs::remove_file(unnamed);
    }

    #[test]
    fn summarizes_rar4_entries() {
        let path = temp_file(
            "legacy.rar",
            &rar4_bytes(&[
                ("bin/", 0, true),
                ("bin/tool.exe", 2048, false),
                ("bin/media.mp4", 900, false),
            ]),
        );
        let summary = summarize(&path).unwrap();
        assert_eq!(summary.format, "RAR");
        assert_eq!(summary.files, 2);
        assert_eq!(summary.folders, 1);
        assert_eq!(summary.bytes, 2948);
        assert_eq!(summary.kind, "Application");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn summarizes_rar5_entries() {
        let path = temp_file(
            "modern.rar",
            &rar5_bytes(&[
                ("clip.mp4", 1024, false),
                ("cover.png", 2048, false),
                ("extras/", 0, true),
            ]),
        );
        let summary = summarize(&path).unwrap();
        assert_eq!(summary.format, "RAR");
        assert_eq!(summary.files, 2);
        assert_eq!(summary.folders, 1);
        assert_eq!(summary.bytes, 3072);
        assert_eq!(summary.kind, "Media Files");
        assert_eq!(summary.top[0], "clip.mp4");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn summarizes_sevenz_entries() {
        let path = temp_file("sample.7z", &sevenz_bytes());
        let summary = summarize(&path).unwrap();
        assert_eq!(summary.format, "7Z");
        assert_eq!(summary.files, 2);
        assert_eq!(summary.folders, 1);
        assert_eq!(summary.bytes, 11);
        assert_eq!(summary.kind, "Documents");
        assert_eq!(summary.top, vec!["docs", "docs/readme.txt", "empty.txt"]);
        assert!(!summary.locked);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn flags_encrypted_archives() {
        let zip = temp_file("secret.zip", &zip_encrypted_bytes("secret.txt"));
        let summary = summarize(&zip).unwrap();
        assert!(summary.locked);
        assert_eq!(summary.format, "ZIP");
        assert_eq!(summary.kind, "Encrypted");
        let _ = fs::remove_file(zip);

        let rar4 = temp_file("secret.rar", &rar4_encrypted_bytes());
        assert!(summarize(&rar4).unwrap().locked);
        let _ = fs::remove_file(rar4);

        let headers = temp_file("headers.rar", &rar4_header_encrypted_bytes());
        assert!(summarize(&headers).unwrap().locked);
        let _ = fs::remove_file(headers);

        let rar5 = temp_file("secret5.rar", &rar5_encrypted_bytes());
        assert!(summarize(&rar5).unwrap().locked);
        let _ = fs::remove_file(rar5);
    }

    #[test]
    fn scans_an_empty_zip() {
        let path = temp_file("blank.zip", &zip_bytes(&[]));
        let summary = summarize(&path).unwrap();
        assert_eq!(summary.format, "ZIP");
        assert_eq!(summary.kind, "Empty");
        assert_eq!(summary.files, 0);
        assert_eq!(summary.folders, 0);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_unsupported_and_corrupt_archives() {
        let path = temp_file("thing.7z", b"7z\xbc\xaf\x27\x1cwhatever");
        assert!(summarize(&path).is_none());
        let _ = fs::remove_file(path);
        let path = temp_file("broken.zip", b"PK\x03\x04only a header");
        assert!(summarize(&path).is_none());
        let _ = fs::remove_file(path);
    }
}
