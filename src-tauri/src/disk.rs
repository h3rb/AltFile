use crate::archive::{Collector, Summary};
use crate::paths;
use std::collections::HashSet;
use std::fs;

const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: u8 = 8;

enum Layout {
    /// ATR body: 128-byte boot sectors followed by `size`-byte sectors.
    Atr { size: usize },
    /// Headerless XFD image with the same boot-sector layout.
    Flat { size: usize },
    /// APE ProSystem: 12 timing bytes then 128 data bytes per sector.
    Pro,
    /// Disk Interchange: present-sector table, data packed in logical order.
    Di {
        map: Vec<Option<(usize, usize)>>,
    },
}

struct Image<'a> {
    data: &'a [u8],
    /// Bytes of a regular data sector.
    sector_size: usize,
    sectors: usize,
    layout: Layout,
}

impl Image<'_> {
    fn sector(&self, number: usize) -> Option<&[u8]> {
        if number == 0 || number > self.sectors {
            return None;
        }
        match &self.layout {
            Layout::Atr { size } | Layout::Flat { size } => {
                let size = *size;
                if number <= 3 {
                    let offset = (number - 1) * 128;
                    self.data.get(offset..offset + 128)
                } else {
                    let offset = 384 + (number - 4) * size;
                    self.data.get(offset..offset + size)
                }
            }
            Layout::Pro => {
                let offset = 16 + (number - 1) * 140 + 12;
                self.data.get(offset..offset + 128)
            }
            Layout::Di { map } => {
                let (offset, len) = map.get(number - 1).copied().flatten()?;
                self.data.get(offset..offset + len)
            }
        }
    }
}

fn u16_at(bytes: &[u8], at: usize) -> Option<usize> {
    Some(u16::from_le_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]) as usize)
}

fn be16_at(bytes: &[u8], at: usize) -> Option<usize> {
    Some(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]) as usize)
}

fn atr(data: &[u8]) -> Option<Image<'_>> {
    if data.len() < 16 + 128 || data[0] != 0x96 || (data[1] & 0x7f) != 0x02 {
        return None;
    }
    let body = u16_at(data, 2)?.checked_mul(16)?;
    if 16 + body > data.len() {
        return None;
    }
    let sector_size = match u16_at(data, 4)? {
        128 => 128,
        256 => 256,
        512 => 512,
        _ => return None,
    };
    let sectors = if body <= 384 {
        body / 128
    } else {
        if (body - 384) % sector_size != 0 {
            return None;
        }
        3 + (body - 384) / sector_size
    };
    if sectors < 368 {
        return None;
    }
    Some(Image {
        data: &data[16..16 + body],
        sector_size,
        sectors,
        layout: Layout::Atr { size: sector_size },
    })
}

fn flat(data: &[u8]) -> Option<Image<'_>> {
    if data.len() < 368 * 128 {
        return None;
    }
    let (sector_size, sectors) = if (data.len() - 384) % 256 == 0 {
        (256, 3 + (data.len() - 384) / 256)
    } else if data.len() % 128 == 0 {
        (128, data.len() / 128)
    } else {
        return None;
    };
    Some(Image {
        data,
        sector_size,
        sectors,
        layout: Layout::Flat { size: sector_size },
    })
}

fn pro(data: &[u8]) -> Option<Image<'_>> {
    if data.len() < 16 + 140 || data[2] != b'P' {
        return None;
    }
    let body = data.len() - 16;
    if body % 140 != 0 || be16_at(data, 0)? != body / 140 {
        return None;
    }
    let sectors = body / 140;
    if sectors < 368 {
        return None;
    }
    Some(Image {
        data,
        sector_size: 128,
        sectors,
        layout: Layout::Pro,
    })
}

fn di(data: &[u8]) -> Option<Image<'_>> {
    if data.len() < 16 + 128 || &data[..4] != b"DI\x20\x02" {
        return None;
    }
    let tracks = *data.get(9)? as usize;
    let per_track = be16_at(data, 10)?;
    let sector_size = be16_at(data, 14)?;
    if tracks == 0 || tracks > 200 || per_track == 0 || per_track > 128 {
        return None;
    }
    if !matches!(sector_size, 128 | 256) {
        return None;
    }
    let table_len = tracks * per_track;
    for header in [16usize, 17] {
        if header + table_len > data.len() {
            continue;
        }
        let table = &data[header..header + table_len];
        let mut map = Vec::with_capacity(table_len);
        let mut offset = header + table_len;
        let mut ok = true;
        for (index, &present) in table.iter().enumerate() {
            if present == 0 {
                map.push(None);
                continue;
            }
            let len = if sector_size == 256 && index < 3 {
                128
            } else {
                sector_size
            };
            if offset + len > data.len() {
                ok = false;
                break;
            }
            map.push(Some((offset, len)));
            offset += len;
        }
        if ok && offset == data.len() {
            return Some(Image {
                data,
                sector_size,
                sectors: table_len,
                layout: Layout::Di { map },
            });
        }
    }
    None
}

fn atari_name(field: &[u8]) -> String {
    let part = |bytes: &[u8]| -> String {
        let mut text = String::new();
        for &byte in bytes {
            if byte == 0 {
                break;
            }
            let ch = char::from(byte & 0x7f);
            text.push(if ch == ' ' || ch.is_ascii_graphic() { ch } else { '?' });
        }
        text.trim().to_string()
    };
    let base = part(&field[..8.min(field.len())]);
    let ext = part(&field[8.min(field.len())..]);
    if base.is_empty() {
        return String::new();
    }
    if ext.is_empty() {
        base
    } else {
        format!("{base}.{ext}")
    }
}

struct Entry {
    name: String,
    dir: bool,
    size: u64,
}

fn read_dir(
    image: &Image,
    first: usize,
    count: usize,
    prefix: &str,
    depth: u8,
    visited: &mut HashSet<usize>,
    subdirs: &mut bool,
    out: &mut Vec<Entry>,
) {
    if depth > MAX_DEPTH || first == 0 || count == 0 {
        return;
    }
    for number in first..first + count.min(64) {
        let Some(sector) = image.sector(number) else {
            continue;
        };
        for entry in sector.chunks_exact(16) {
            let status = entry[0];
            if status & 0x80 == 0 || status & 0x40 != 0 {
                continue;
            }
            let name = atari_name(&entry[5..16]);
            if name.is_empty() {
                continue;
            }
            let is_dir = status & 0x10 != 0;
            let sectors = u16::from_le_bytes([entry[1], entry[2]]) as usize;
            let start = u16::from_le_bytes([entry[3], entry[4]]) as usize;
            let full = format!("{prefix}{name}");
            out.push(Entry {
                name: full.clone(),
                dir: is_dir,
                size: if is_dir {
                    0
                } else {
                    sectors as u64 * image.sector_size as u64
                },
            });
            if out.len() >= MAX_ENTRIES {
                return;
            }
            if is_dir {
                *subdirs = true;
                if start > 0 && visited.insert(start) {
                    read_dir(
                        image,
                        start,
                        sectors.clamp(1, 64),
                        &format!("{full}/"),
                        depth + 1,
                        visited,
                        subdirs,
                        out,
                    );
                }
            }
        }
    }
}

struct Contents {
    filesystem: &'static str,
    entries: Vec<Entry>,
}

fn read_dos(image: &Image) -> Option<Contents> {
    let vtoc = image.sector(360)?;
    if vtoc.len() < 5 || vtoc[0] != 0x02 {
        return None;
    }
    let total = u16::from_le_bytes([vtoc[1], vtoc[2]]) as usize;
    if total < 368 || total > image.sectors {
        return None;
    }
    let mut visited = HashSet::new();
    visited.insert(361);
    let mut subdirs = false;
    let mut entries = Vec::new();
    read_dir(
        image,
        361,
        8,
        "",
        0,
        &mut visited,
        &mut subdirs,
        &mut entries,
    );
    Some(Contents {
        filesystem: if subdirs { "MyDOS" } else { "Atari DOS 2.x" },
        entries,
    })
}

pub(crate) fn summarize(path: &str) -> Option<Summary> {
    let file_path = paths::canonical(&paths::expand(path));
    let meta = fs::metadata(&file_path).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    let name = file_path.file_name()?.to_string_lossy().into_owned();
    let ext = paths::ext_of(&name);
    if ext == "iso" {
        return crate::iso::summarize(path);
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let data = fs::read(&file_path).ok()?;
    let image = match ext.as_str() {
        "atr" => atr(&data),
        "xfd" => flat(&data),
        "pro" => pro(&data),
        "di" => di(&data),
        _ => None,
    }?;
    let contents = read_dos(&image)?;
    let mut col = Collector::new();
    for entry in &contents.entries {
        col.add(&entry.name, entry.dir, entry.size);
    }
    let mut summary = col.finish_named(&ext.to_ascii_uppercase());
    summary.filesystem = Some(contents.filesystem.to_string());
    Some(summary)
}

#[tauri::command]
pub async fn disk_summary(path: String) -> Result<Option<Summary>, String> {
    tauri::async_runtime::spawn_blocking(move || summarize(&path))
        .await
        .map_err(|e| format!("Disc task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("altfe-disk-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn raw_offset(sector: usize) -> usize {
        if sector <= 3 {
            (sector - 1) * 128
        } else {
            384 + (sector - 4) * 128
        }
    }

    fn write_sector(body: &mut [u8], sector: usize, data: &[u8]) {
        let at = raw_offset(sector);
        body[at..at + data.len()].copy_from_slice(data);
    }

    fn entry(field: &mut [u8], status: u8, sectors: u16, first: u16, base: &str, ext: &str) {
        field.fill(0);
        field[0] = status;
        field[1..3].copy_from_slice(&sectors.to_le_bytes());
        field[3..5].copy_from_slice(&first.to_le_bytes());
        let mut name = [b' '; 11];
        for (slot, byte) in base.bytes().take(8).enumerate() {
            name[slot] = byte;
        }
        for (slot, byte) in ext.bytes().take(3).enumerate() {
            name[8 + slot] = byte;
        }
        field[5..16].copy_from_slice(&name);
    }

    fn dos_body() -> Vec<u8> {
        let mut body = vec![0u8; 720 * 128];
        let mut vtoc = [0u8; 128];
        vtoc[0] = 0x02;
        vtoc[1..3].copy_from_slice(&720u16.to_le_bytes());
        write_sector(&mut body, 360, &vtoc);

        let mut dir = [0u8; 128];
        entry(&mut dir[0..16], 0x80, 2, 10, "HELLO", "TXT");
        entry(&mut dir[16..32], 0x90, 1, 20, "DOCS", "");
        write_sector(&mut body, 361, &dir);

        let mut sub = [0u8; 128];
        entry(&mut sub[0..16], 0x80, 1, 12, "README", "TXT");
        write_sector(&mut body, 20, &sub);
        body
    }

    fn atr(body: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 16];
        out[0] = 0x96;
        out[1] = 0x02;
        let paragraphs = (body.len() / 16) as u16;
        out[2..4].copy_from_slice(&paragraphs.to_le_bytes());
        out[4..6].copy_from_slice(&128u16.to_le_bytes());
        out.extend_from_slice(body);
        out
    }

    fn pro(body: &[u8]) -> Vec<u8> {
        let sectors = (body.len() / 128) as u16;
        let mut out = vec![0u8; 16];
        out[0..2].copy_from_slice(&sectors.to_be_bytes());
        out[2] = b'P';
        for sector in body.chunks_exact(128) {
            out.extend_from_slice(&[0u8; 12]);
            out.extend_from_slice(sector);
        }
        out
    }

    fn di(body: &[u8]) -> Vec<u8> {
        let tracks = 40u8;
        let per_track = 18u16;
        let table_len = tracks as usize * per_track as usize;
        let mut out = vec![0u8; 16];
        out[..4].copy_from_slice(b"DI\x20\x02");
        out[9] = tracks;
        out[10..12].copy_from_slice(&per_track.to_be_bytes());
        out[14..16].copy_from_slice(&128u16.to_be_bytes());
        out.extend(std::iter::repeat(1u8).take(table_len));
        out.extend_from_slice(body);
        out
    }

    fn summary(name: &str, bytes: &[u8]) -> Summary {
        let path = temp_file(name, bytes);
        summarize(&path.to_string_lossy()).unwrap()
    }

    #[test]
    fn reads_atr_dos_filesystem() {
        let body = dos_body();
        let summary = summary("demo.atr", &atr(&body));
        assert_eq!(summary.format, "ATR");
        assert_eq!(summary.filesystem.as_deref(), Some("MyDOS"));
        assert_eq!(summary.files, 2);
        assert_eq!(summary.folders, 1);
        assert_eq!(summary.bytes, 384);
        assert_eq!(summary.kind, "Documents");
        assert_eq!(
            summary.top,
            vec!["HELLO.TXT", "DOCS", "DOCS/README.TXT"]
        );
    }

    #[test]
    fn reads_xfd_pro_and_di_images() {
        let body = dos_body();
        let xfd = summary("demo.xfd", &body);
        assert_eq!(xfd.format, "XFD");
        assert_eq!(xfd.files, 2);

        let pro = summary("demo.pro", &pro(&body));
        assert_eq!(pro.format, "PRO");
        assert_eq!(pro.files, 2);

        let di = summary("demo.di", &di(&body));
        assert_eq!(di.format, "DI");
        assert_eq!(di.files, 2);
        assert_eq!(di.folders, 1);
    }

    #[test]
    fn rejects_images_without_a_dos_filesystem() {
        let body = vec![0u8; 720 * 128];
        let path = temp_file("blank.atr", &atr(&body));
        assert!(summarize(&path.to_string_lossy()).is_none());
    }
}
