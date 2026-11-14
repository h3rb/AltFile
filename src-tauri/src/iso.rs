use crate::{paths, thumbs, AppState};
use image::DynamicImage;
use serde::Serialize;
use std::fs::File;
use std::io;
use std::path::Path;
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use tauri::State;

const SECTOR: u64 = 2048;
const MAX_DESCRIPTORS: u64 = 64;
const MAX_INF: u64 = 64 * 1024;
const MAX_TEXT: u64 = 4 * 1024;
const MAX_ICON: u64 = 16 * 1024 * 1024;
const MAX_DIR: u64 = 4 * 1024 * 1024;
const ICON_SIZE: u32 = 256;
const ICON_REVISION: &str = "iso-icon-v1";

#[cfg(test)]
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IsoInfo {
    pub label: Option<String>,
    pub icon_url: Option<String>,
    pub icon_from: Option<String>,
}

#[derive(Clone)]
struct Node {
    name: String,
    extent: u64,
    size: u64,
    dir: bool,
}

fn read_chunk(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(buf, offset)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buf, offset)
    }
}

fn read_at(file: &File, offset: u64, len: usize) -> Option<Vec<u8>> {
    let end = offset.checked_add(u64::try_from(len).ok()?)?;
    if end > file.metadata().ok()?.len() {
        return None;
    }
    let mut buf = Vec::new();
    buf.try_reserve_exact(len).ok()?;
    buf.resize(len, 0);
    let mut done = 0;
    while done < len {
        match read_chunk(file, &mut buf[done..], offset + done as u64) {
            Ok(0) => return None,
            Ok(read) => done += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
    Some(buf)
}

fn u16_at(buf: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes(buf.get(off..off + 2)?.try_into().ok()?))
}

fn u32_at(buf: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes(buf.get(off..off + 4)?.try_into().ok()?))
}

fn u64_at(buf: &[u8], off: usize) -> Option<u64> {
    Some(u64::from_le_bytes(buf.get(off..off + 8)?.try_into().ok()?))
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn trim_text(value: &str) -> String {
    value
        .trim_matches(|c: char| c.is_whitespace() || c == '\0' || c == '\u{feff}')
        .replace('\r', "")
}

fn decode_ascii(bytes: &[u8]) -> String {
    let text: String = bytes.iter().map(|&b| b as char).collect();
    text.trim_end().trim_end_matches('\0').trim().to_string()
}

fn decode_ucs2(bytes: &[u8]) -> String {
    let mut text = String::new();
    for pair in bytes.chunks_exact(2) {
        let code = u16::from_be_bytes([pair[0], pair[1]]);
        if code != 0 {
            text.push(char::from_u32(code as u32).unwrap_or('\u{fffd}'));
        }
    }
    text.trim_end().trim().to_string()
}

fn decode_osta(bytes: &[u8]) -> String {
    let Some((&compression, rest)) = bytes.split_first() else {
        return String::new();
    };
    let text = match compression {
        8 => rest.iter().map(|&b| b as char).collect::<String>(),
        16 => {
            let pairs = rest.chunks_exact(2);
            pairs
                .map(|pair| {
                    char::from_u32(u16::from_be_bytes([pair[0], pair[1]]) as u32)
                        .unwrap_or('\u{fffd}')
                })
                .collect::<String>()
        }
        _ => String::new(),
    };
    text.trim_end_matches('\0').trim().to_string()
}

fn iso_name(raw: &[u8], joliet: bool) -> String {
    let mut name = if joliet {
        decode_ucs2(raw)
    } else {
        decode_ascii(raw)
    };
    if let Some(pos) = name.rfind(';') {
        if name[pos + 1..].chars().all(|c| c.is_ascii_digit()) {
            name.truncate(pos);
        }
    }
    if name.ends_with('.') {
        name.pop();
    }
    name
}

struct IsoVolume {
    joliet: bool,
    root: Node,
}

impl IsoVolume {
    fn root(&self) -> Node {
        self.root.clone()
    }

    fn list(&self, file: &File, node: &Node) -> Option<Vec<Node>> {
        if !node.dir {
            return None;
        }
        let data = read_at(
            file,
            node.extent.checked_mul(SECTOR)?,
            node.size.min(MAX_DIR) as usize,
        )?;
        let mut entries = Vec::new();
        let mut pos = 0usize;
        while pos < data.len() {
            let length = data[pos] as usize;
            if length == 0 {
                pos = (pos / SECTOR as usize + 1) * SECTOR as usize;
                continue;
            }
            if length < 34
                || pos + length > data.len()
                || pos % SECTOR as usize + length > SECTOR as usize
            {
                return None;
            }
            let record = &data[pos..pos + length];
            pos += length;
            let mut entry = iso_record(record)?;
            if record[25] & 0x04 != 0 {
                continue;
            }
            let name_len = record[32] as usize;
            if name_len == 0 || 33 + name_len > record.len() {
                return None;
            }
            let raw = &record[33..33 + name_len];
            if name_len == 1 && (raw[0] == 0 || raw[0] == 1) {
                continue;
            }
            entry.name = iso_name(raw, self.joliet);
            if !entry.name.is_empty() {
                entries.push(entry);
            }
        }
        Some(entries)
    }

    fn read(&self, file: &File, node: &Node, max: u64) -> Option<Vec<u8>> {
        if node.dir {
            return None;
        }
        read_at(
            file,
            node.extent.checked_mul(SECTOR)?,
            usize::try_from(node.size.min(max)).ok()?,
        )
    }
}

fn parse_iso(file: &File) -> Option<(IsoVolume, Option<String>)> {
    let mut primary: Option<(Node, String)> = None;
    let mut joliet: Option<(Node, String)> = None;
    for index in 0..MAX_DESCRIPTORS {
        let sector = read_at(file, (16 + index) * SECTOR, SECTOR as usize)?;
        if sector.get(1..6)? != b"CD001" {
            break;
        }
        match sector[0] {
            1 => {
                primary = Some((iso_root(&sector)?, decode_ascii(sector.get(40..72)?)));
            }
            2 => {
                let escape = sector.get(88..91)?;
                if matches!(escape, b"%/@" | b"%/C" | b"%/E") {
                    joliet = Some((iso_root(&sector)?, decode_ucs2(sector.get(40..72)?)));
                }
            }
            255 => break,
            _ => {}
        }
    }
    let (root, label, is_joliet) = match joliet {
        Some((root, label)) => {
            let label = if label.trim().is_empty() {
                primary.as_ref().map(|(_, name)| name.clone())
            } else {
                Some(label)
            };
            (root, label, true)
        }
        None => {
            let (root, label) = primary?;
            (root, Some(label), false)
        }
    };
    Some((
        IsoVolume {
            joliet: is_joliet,
            root,
        },
        label,
    ))
}

fn iso_record(record: &[u8]) -> Option<Node> {
    if record.len() < 34
        || record[0] as usize != record.len()
        || record[25] & 0x80 != 0
        || record[26] != 0
        || record[27] != 0
    {
        return None;
    }
    Some(Node {
        name: String::new(),
        extent: (u32_at(record, 2)? as u64).checked_add(record[1] as u64)?,
        size: u32_at(record, 10)? as u64,
        dir: record[25] & 0x02 != 0,
    })
}

fn iso_root(sector: &[u8]) -> Option<Node> {
    // Both copies of the ISO logical block size must describe our sector size.
    if sector.get(128..132)? != [0x00, 0x08, 0x08, 0x00] {
        return None;
    }
    let root = iso_record(sector.get(156..190)?)?;
    root.dir.then_some(root)
}

struct UdfVolume {
    partition: u64,
    partition_len: u64,
    block: u64,
    root_lb: u64,
}

impl UdfVolume {
    fn root(&self) -> Node {
        Node {
            name: String::new(),
            extent: self.root_lb,
            size: 0,
            dir: true,
        }
    }

    fn partition_offset(&self, lb: u64, len: u64) -> Option<u64> {
        let relative = lb.checked_mul(self.block)?;
        if relative.checked_add(len)? > self.partition_len.checked_mul(self.block)? {
            return None;
        }
        self.partition
            .checked_mul(self.block)?
            .checked_add(relative)
    }

    fn read_partition(&self, file: &File, lb: u64, len: u64) -> Option<Vec<u8>> {
        read_at(
            file,
            self.partition_offset(lb, len)?,
            usize::try_from(len).ok()?,
        )
    }

    fn long_ad(&self, data: &[u8], offset: usize) -> Option<(u64, u64)> {
        let raw_len = u32_at(data, offset)?;
        if raw_len >> 30 != 0 || u16_at(data, offset + 8)? != 0 {
            return None;
        }
        let lb = u32_at(data, offset + 4)? as u64;
        let len = raw_len as u64;
        self.partition_offset(lb, len)?;
        Some((lb, len))
    }

    fn file_entry(&self, file: &File, lb: u64) -> Option<Vec<u8>> {
        let entry = self.read_partition(file, lb, self.block)?;
        if !matches!(u16_at(&entry, 0)?, 261 | 266) {
            return None;
        }
        Some(entry)
    }

    fn file_data(&self, file: &File, lb: u64, max: u64, dir: bool) -> Option<Vec<u8>> {
        let entry = self.file_entry(file, lb)?;
        if entry[27] != if dir { 4 } else { 5 } {
            return None;
        }
        let info_len = u64_at(&entry, 56)?;
        let flags = u16_at(&entry, 34)?;
        // Extended File Entries have extra fields before their allocation lengths.
        let base = if u16_at(&entry, 0)? == 266 {
            216usize
        } else {
            176usize
        };
        let ext_attr_len = u32_at(&entry, base - 8)? as usize;
        let alloc_len = u32_at(&entry, base - 4)? as usize;
        let start = base.checked_add(ext_attr_len)?;
        let allocation = entry.get(start..start.checked_add(alloc_len)?)?;
        let limit = info_len.min(max);
        let mut out = Vec::new();
        match flags & 0x7 {
            3 => {
                if info_len > alloc_len as u64 {
                    return None;
                }
                out.extend_from_slice(allocation.get(..usize::try_from(limit).ok()?)?);
            }
            0 | 1 => {
                let long = flags & 0x7 == 1;
                let stride = if long { 16 } else { 8 };
                if alloc_len % stride != 0 {
                    return None;
                }
                for descriptor in allocation.chunks_exact(stride) {
                    let (lb, length) = if long {
                        self.long_ad(descriptor, 0)?
                    } else {
                        let raw_len = u32_at(descriptor, 0)?;
                        if raw_len >> 30 != 0 {
                            // Sparse, unrecorded, and continuation extents need separate handling.
                            return None;
                        }
                        (u32_at(descriptor, 4)? as u64, raw_len as u64)
                    };
                    self.partition_offset(lb, length)?;
                    let want = length.min(limit - out.len() as u64);
                    if want != 0 {
                        out.extend_from_slice(&self.read_partition(file, lb, want)?);
                    }
                }
            }
            _ => return None,
        }
        (out.len() as u64 == limit).then_some(out)
    }

    fn list(&self, file: &File, node: &Node) -> Option<Vec<Node>> {
        if !node.dir {
            return None;
        }
        let data = self.file_data(file, node.extent, MAX_DIR, true)?;
        let mut entries = Vec::new();
        let mut pos = 0usize;
        while pos < data.len() {
            let header = data.get(pos..pos.checked_add(38)?)?;
            if u16_at(header, 0)? != 257 {
                return None;
            }
            let flags = header[18];
            let name_len = header[19] as usize;
            let impl_len = u16_at(header, 36)? as usize;
            let total = 38usize.checked_add(impl_len)?.checked_add(name_len)?;
            let end = pos.checked_add(total)?;
            let next = pos.checked_add((total + 3) & !3)?;
            if next > data.len() {
                return None;
            }
            if u16_at(header, 28)? != 0 {
                return None;
            }
            if flags & 0x0c == 0 {
                let (lb, length) = self.long_ad(header, 20)?;
                if length < self.block {
                    return None;
                }
                let name = decode_osta(data.get(pos + 38 + impl_len..end)?);
                if !name.is_empty() {
                    entries.push(Node {
                        name,
                        extent: lb,
                        size: 0,
                        dir: flags & 0x02 != 0,
                    });
                }
            }
            pos = next;
        }
        Some(entries)
    }

    fn read(&self, file: &File, node: &Node, max: u64) -> Option<Vec<u8>> {
        if node.dir {
            return None;
        }
        self.file_data(file, node.extent, max, false)
    }
}

fn decode_dstring(bytes: &[u8]) -> Option<String> {
    let (&length, padded) = bytes.split_last()?;
    if length == 0 {
        return Some(String::new());
    }
    let encoded = padded.get(..length as usize)?;
    match encoded.first()? {
        8 => {}
        16 if (encoded.len() - 1) % 2 == 0 => {}
        _ => return None,
    }
    Some(decode_osta(encoded))
}

fn parse_udf(file: &File) -> Option<(UdfVolume, Option<String>)> {
    let anchor = read_at(file, 256 * SECTOR, SECTOR as usize)?;
    if u16_at(&anchor, 0)? != 2 {
        return None;
    }
    let sequence_len = u32_at(&anchor, 16)? as u64;
    let sequence_lb = u32_at(&anchor, 20)? as u64;
    if sequence_len < SECTOR || sequence_len % SECTOR != 0 {
        return None;
    }
    let mut partitions = Vec::new();
    let mut logical = None;
    let count = (sequence_len / SECTOR).min(MAX_DESCRIPTORS);
    for index in 0..count {
        let sector = read_at(file, (sequence_lb + index) * SECTOR, SECTOR as usize)?;
        match u16_at(&sector, 0)? {
            5 => partitions.push((
                u16_at(&sector, 22)?,
                u32_at(&sector, 188)? as u64,
                u32_at(&sector, 192)? as u64,
            )),
            6 => {
                // Only a single, local type-1 physical partition map is supported.
                if u32_at(&sector, 212)? as u64 != SECTOR
                    || u32_at(&sector, 264)? != 6
                    || u32_at(&sector, 268)? != 1
                    || sector[440] != 1
                    || sector[441] != 6
                    || u16_at(&sector, 442)? != 1
                {
                    return None;
                }
                logical = Some(sector);
            }
            8 => break,
            _ => {}
        }
    }
    let logical = logical?;
    let number = u16_at(&logical, 444)?;
    let mut matching = partitions
        .into_iter()
        .filter(|(part, _, _)| *part == number);
    let (_, partition, partition_len) = matching.next()?;
    if matching.next().is_some()
        || partition_len == 0
        || partition.checked_add(partition_len)?.checked_mul(SECTOR)? > file.metadata().ok()?.len()
    {
        return None;
    }
    let mut volume = UdfVolume {
        partition,
        partition_len,
        block: SECTOR,
        root_lb: 0,
    };
    let (fsd_lb, fsd_len) = volume.long_ad(&logical, 248)?;
    if fsd_len < SECTOR {
        return None;
    }
    let fsd = volume.read_partition(file, fsd_lb, SECTOR)?;
    if u16_at(&fsd, 0)? != 256 {
        return None;
    }
    let (root_lb, root_len) = volume.long_ad(&fsd, 400)?;
    if root_len < SECTOR {
        return None;
    }
    volume.root_lb = root_lb;
    let label = decode_dstring(logical.get(84..212)?)?;
    Some((volume, Some(label)))
}

enum Volume {
    Iso(IsoVolume),
    Udf(UdfVolume),
}

impl Volume {
    fn root(&self) -> Node {
        match self {
            Volume::Iso(volume) => volume.root(),
            Volume::Udf(volume) => volume.root(),
        }
    }

    fn list(&self, file: &File, node: &Node) -> Option<Vec<Node>> {
        match self {
            Volume::Iso(volume) => volume.list(file, node),
            Volume::Udf(volume) => volume.list(file, node),
        }
    }

    fn read(&self, file: &File, node: &Node, max: u64) -> Option<Vec<u8>> {
        match self {
            Volume::Iso(volume) => volume.read(file, node, max),
            Volume::Udf(volume) => volume.read(file, node, max),
        }
    }
}

struct Disc {
    volumes: Vec<Volume>,
    label: Option<String>,
}

impl Disc {
    fn open(file: &File) -> Option<Disc> {
        let mut volumes = Vec::new();
        let mut label = None;
        if let Some((volume, name)) = parse_iso(file) {
            if name
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                label = name;
            }
            volumes.push(Volume::Iso(volume));
        }
        if let Some((volume, name)) = parse_udf(file) {
            if label.is_none() {
                label = name;
            }
            volumes.push(Volume::Udf(volume));
        }
        if volumes.is_empty() {
            return None;
        }
        Some(Disc { volumes, label })
    }

    fn resolve(&self, file: &File, path: &str) -> Option<(usize, Node)> {
        if path.contains([':', '\0'])
            || path
                .as_bytes()
                .get(..2)
                .is_some_and(|prefix| prefix.iter().all(|byte| matches!(byte, b'/' | b'\\')))
        {
            return None;
        }
        let parts: Vec<&str> = path
            .split(['\\', '/'])
            .filter(|part| !part.is_empty() && *part != ".")
            .take(17)
            .collect();
        if parts.is_empty() || parts.len() > 16 || parts.contains(&"..") {
            return None;
        }
        for (index, volume) in self.volumes.iter().enumerate() {
            let mut node = volume.root();
            let mut visited = std::collections::HashSet::new();
            visited.insert(node.extent);
            let mut matched = true;
            for part in &parts {
                if !node.dir {
                    matched = false;
                    break;
                }
                let Some(children) = volume.list(file, &node) else {
                    matched = false;
                    break;
                };
                match children
                    .into_iter()
                    .find(|entry| entry.name.eq_ignore_ascii_case(part))
                {
                    Some(next) => {
                        if next.dir && !visited.insert(next.extent) {
                            matched = false;
                            break;
                        }
                        node = next;
                    }
                    None => {
                        matched = false;
                        break;
                    }
                }
            }
            if matched {
                return Some((index, node));
            }
        }
        None
    }

    fn read(&self, file: &File, path: &str, max: u64) -> Option<Vec<u8>> {
        let (index, node) = self.resolve(file, path)?;
        self.read_node(file, index, &node, max)
    }

    fn read_node(&self, file: &File, index: usize, node: &Node, max: u64) -> Option<Vec<u8>> {
        self.volumes.get(index)?.read(file, node, max)
    }

    fn root_files(&self, file: &File) -> Vec<(usize, Node)> {
        let mut files = Vec::new();
        for (index, volume) in self.volumes.iter().enumerate() {
            let Some(children) = volume.list(file, &volume.root()) else {
                continue;
            };
            for node in children {
                if !node.dir {
                    files.push((index, node));
                }
            }
        }
        files
    }
}

#[derive(Default)]
struct LaunchInfo {
    icon: Option<String>,
    label: Option<String>,
}

fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| {
                if bytes[0] == 0xff {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        return String::from_utf16_lossy(&units);
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.trim_start_matches('\u{feff}').to_string(),
        Err(_) => bytes.iter().map(|&byte| char::from(byte)).collect(),
    }
}

fn unquote(value: &str) -> &str {
    let value = value.trim();
    for quote in ['"', '\''] {
        if let Some(rest) = value.strip_prefix(quote) {
            if let Some(end) = rest.find(quote) {
                return rest[..end].trim();
            }
            return rest.trim();
        }
    }
    value
}

fn parse_autorun(text: &str) -> LaunchInfo {
    let mut info = LaunchInfo::default();
    let native = match std::env::consts::ARCH {
        "x86_64" => "autorun.amd64",
        "aarch64" => "autorun.arm64",
        _ => "autorun.x86",
    };
    let mut priority = 1;
    let (mut icon_priority, mut label_priority) = (0, 0);
    for raw in text.lines() {
        let line = raw.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(section) = line
            .strip_prefix('[')
            .and_then(|s| s.split_once(']').map(|p| p.0))
        {
            priority = match section.trim().to_ascii_lowercase().as_str() {
                s if s == native => 3,
                "autorun" => 2,
                ".shellclassinfo" => 1,
                _ => 0,
            };
            continue;
        }
        if priority == 0 {
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let value = raw.trim();
        if value.is_empty() {
            continue;
        }
        match key.trim().to_ascii_lowercase().as_str() {
            "icon" | "iconresource" | "iconfile" if priority > icon_priority => {
                info.icon = Some(value.to_string());
                icon_priority = priority;
            }
            "label" | "localizedresourcename"
                if priority > label_priority && !value.starts_with('@') =>
            {
                info.label = Some(unquote(value).to_string());
                label_priority = priority;
            }
            _ => {}
        }
    }
    info
}

fn icon_path(value: &str) -> Option<(String, i32)> {
    let value = value.trim();
    let (path, suffix) = if value.starts_with(['"', '\'']) {
        let quote = value.chars().next()?;
        let end = value[1..].find(quote)? + 1;
        (&value[1..end], value[end + 1..].trim())
    } else if let Some((path, index)) = value.rsplit_once(',') {
        if index.trim().parse::<i32>().is_ok() {
            (path, &value[path.len()..])
        } else {
            (value, "")
        }
    } else {
        (value, "")
    };
    let index = if suffix.is_empty() {
        0
    } else {
        suffix.strip_prefix(',')?.trim().parse::<i32>().ok()?
    };
    if path.trim().is_empty() {
        return None;
    }
    Some((path.trim().replace('/', "\\"), index))
}

fn clean_label(raw: &str) -> Option<String> {
    let label = trim_text(raw);
    if label.is_empty() {
        return None;
    }
    let generic = [
        "cdrom",
        "cd-rom",
        "cd_rom",
        "cd rom",
        "iso",
        "iso9660",
        "iso image",
        "new",
        "untitled",
        "udf volume",
    ];
    if generic.contains(&label.to_ascii_lowercase().as_str()) {
        return None;
    }
    let mut clipped: String = label.chars().take(96).collect();
    if clipped.len() < label.len() {
        clipped.push('…');
    }
    Some(clipped)
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn decode_icon(name: &str, index: i32, bytes: &[u8]) -> Option<DynamicImage> {
    let ext = paths::ext_of(name);
    let ico;
    let data = if matches!(ext.as_str(), "exe" | "dll" | "icl") {
        ico = pe_icon(bytes, index)?;
        ico.as_slice()
    } else if matches!(
        ext.as_str(),
        "ico" | "png" | "bmp" | "jpg" | "jpeg" | "gif" | "webp"
    ) {
        bytes
    } else {
        return None;
    };
    let mut reader = image::ImageReader::new(std::io::Cursor::new(data))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().ok()
}

fn resource_children(root: &[u8], offset: usize) -> Option<Vec<(u32, u32)>> {
    let count = u16_at(root, offset + 12)? as usize + u16_at(root, offset + 14)? as usize;
    if count > 1024 {
        return None;
    }
    let table = root.get(offset + 16..offset + 16 + count * 8)?;
    table
        .chunks_exact(8)
        .map(|entry| Some((u32_at(entry, 0)?, u32_at(entry, 4)?)))
        .collect()
}

fn pe_icon(bytes: &[u8], index: i32) -> Option<Vec<u8>> {
    if bytes.get(..2)? != b"MZ" {
        return None;
    }
    let pe = u32_at(bytes, 60)? as usize;
    if bytes.get(pe..pe + 4)? != b"PE\0\0" {
        return None;
    }
    let section_count = u16_at(bytes, pe + 6)? as usize;
    if section_count == 0 || section_count > 96 {
        return None;
    }
    let optional_size = u16_at(bytes, pe + 20)? as usize;
    let optional = bytes.get(pe + 24..pe + 24 + optional_size)?;
    let directory = match u16_at(optional, 0)? {
        0x10b => 96,
        0x20b => 112,
        _ => return None,
    };
    if u32_at(optional, directory - 4)? < 3 {
        return None;
    }
    let root_rva = u32_at(optional, directory + 16)?;
    let root_len = u32_at(optional, directory + 20)? as usize;
    let sections_start = pe + 24 + optional_size;
    let sections = bytes.get(sections_start..sections_start + section_count * 40)?;
    let data_at = |rva: u32, length: usize| -> Option<&[u8]> {
        for section in sections.chunks_exact(40) {
            let address = u32_at(section, 12)?;
            let raw_len = u32_at(section, 16)? as usize;
            let raw = u32_at(section, 20)? as usize;
            if let Some(relative) = rva.checked_sub(address) {
                let relative = relative as usize;
                if relative.checked_add(length)? <= raw_len {
                    return bytes.get(raw + relative..raw + relative + length);
                }
            }
        }
        None
    };
    let root = data_at(root_rva, root_len)?;
    let types = resource_children(root, 0)?;
    let groups_offset = types.iter().find(|(id, _)| *id == 14)?.1;
    let icons_offset = types.iter().find(|(id, _)| *id == 3)?.1;
    if groups_offset & 0x8000_0000 == 0 || icons_offset & 0x8000_0000 == 0 {
        return None;
    }
    let groups = resource_children(root, (groups_offset & 0x7fff_ffff) as usize)?;
    let icons = resource_children(root, (icons_offset & 0x7fff_ffff) as usize)?;
    let (_, group_offset) = if index < 0 {
        groups.iter().find(|(id, _)| *id == index.unsigned_abs())?
    } else {
        groups.get(index as usize)?
    };
    let resource_data = |offset: u32| -> Option<&[u8]> {
        if offset & 0x8000_0000 == 0 {
            return None;
        }
        let languages = resource_children(root, (offset & 0x7fff_ffff) as usize)?;
        let (_, data) = languages.first()?;
        if data & 0x8000_0000 != 0 {
            return None;
        }
        let offset = *data as usize;
        data_at(u32_at(root, offset)?, u32_at(root, offset + 4)? as usize)
    };
    let group = resource_data(*group_offset)?;
    if u16_at(group, 0)? != 0 || u16_at(group, 2)? != 1 {
        return None;
    }
    let count = u16_at(group, 4)? as usize;
    if count == 0 || count > 256 {
        return None;
    }
    let entries = group.get(6..6 + count * 14)?;
    let mut out = vec![0u8; 6 + count * 16];
    out[..6].copy_from_slice(&group[..6]);
    for (i, entry) in entries.chunks_exact(14).enumerate() {
        let id = u16_at(entry, 12)? as u32;
        let (_, offset) = icons.iter().find(|(icon_id, _)| *icon_id == id)?;
        let data = resource_data(*offset)?;
        if data.len() != u32_at(entry, 8)? as usize || out.len() + data.len() > MAX_ICON as usize {
            return None;
        }
        let offset = out.len() as u32;
        let start = 6 + i * 16;
        out[start..start + 12].copy_from_slice(&entry[..12]);
        out[start + 12..start + 16].copy_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(data);
    }
    Some(out)
}

fn root_icons(disc: &Disc, file: &File) -> Vec<(usize, Node)> {
    let mut icons: Vec<(u8, String, usize, Node)> = disc
        .root_files(file)
        .into_iter()
        .filter(|(_, node)| paths::ext_of(&node.name) == "ico")
        .map(|(index, node)| {
            let rank = match node.name.to_ascii_lowercase().as_str() {
                "autorun.ico" | "cdrom.ico" | "disc.ico" | "setup.ico" => 0,
                _ => 1,
            };
            (rank, node.name.to_ascii_lowercase(), index, node)
        })
        .collect();
    icons.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    icons
        .into_iter()
        .map(|(_, _, index, node)| (index, node))
        .collect()
}

fn inspect(thumb_dir: &Path, path: &str) -> Option<IsoInfo> {
    let file_path = paths::canonical(&paths::expand(path));
    let meta = std::fs::metadata(&file_path).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    let name = file_path.file_name()?.to_string_lossy().into_owned();
    if paths::ext_of(&name) != "iso" {
        return None;
    }
    let file = File::open(&file_path).ok()?;
    let disc = Disc::open(&file)?;

    let mut configs: Vec<_> = disc
        .root_files(&file)
        .into_iter()
        .filter(|(_, node)| matches!(paths::ext_of(&node.name).as_str(), "inf" | "ini"))
        .collect();
    configs.sort_by_key(|(_, node)| {
        let name = node.name.to_ascii_lowercase();
        let priority = match name.as_str() {
            "autorun.inf" => 0,
            "autorun.ini" => 1,
            "desktop.ini" => 2,
            _ => 3,
        };
        (priority, name)
    });
    let mut launch_label = None;
    let mut icon_image = None;
    let mut icon_from = None;
    for (index, node) in configs.into_iter().take(16) {
        let Some(bytes) = disc.read_node(&file, index, &node, MAX_INF) else {
            continue;
        };
        let launch = parse_autorun(&decode_text(&bytes));
        if launch_label.is_none() {
            launch_label = launch.label.as_deref().and_then(clean_label);
        }
        if icon_image.is_none() {
            if let Some((icon, resource_index)) = launch.icon.as_deref().and_then(icon_path) {
                if let Some(bytes) = disc.read(&file, &icon, MAX_ICON) {
                    let icon_name = icon.rsplit('\\').next().unwrap_or(&icon);
                    icon_image = decode_icon(icon_name, resource_index, &bytes);
                    if icon_image.is_some() {
                        icon_from = Some(icon);
                    }
                }
            }
        }
        if icon_image.is_some() && launch_label.is_some() {
            break;
        }
    }
    if icon_image.is_none() {
        for (index, node) in root_icons(&disc, &file).into_iter().take(16) {
            let Some(bytes) = disc.read_node(&file, index, &node, MAX_ICON) else {
                continue;
            };
            if let Some(image) = decode_icon(&node.name, 0, &bytes) {
                icon_image = Some(image);
                icon_from = Some(node.name.clone());
                break;
            }
        }
    }

    let cache_name = format!(
        "{}.png",
        blake3::hash(
            format!(
                "{ICON_REVISION}|{}|{}|{}",
                paths::text(&file_path),
                meta.len(),
                mtime_ms(&meta)
            )
            .as_bytes()
        )
        .to_hex()
    );
    let icon_url = icon_image.and_then(|image| {
        let cached = thumb_dir.join(&cache_name);
        if cached.is_file() {
            return Some(thumbs::url_for(&cache_name));
        }
        thumbs::store_image(thumb_dir, &cache_name, &image, ICON_SIZE)
            .ok()
            .map(|_| thumbs::url_for(&cache_name))
    });

    let label = launch_label
        .or_else(|| {
            disc.read(&file, ".disk/info", MAX_TEXT)
                .and_then(|bytes| first_line(&decode_text(&bytes)))
                .and_then(|line| clean_label(&line))
        })
        .or_else(|| disc.label.as_deref().and_then(clean_label));

    Some(IsoInfo {
        label,
        icon_url,
        icon_from,
    })
}

#[tauri::command]
pub async fn iso_info(state: State<'_, AppState>, path: String) -> Result<Option<IsoInfo>, String> {
    let dir = state.thumb_dir.clone();
    tauri::async_runtime::spawn_blocking(move || inspect(&dir, &path))
        .await
        .map_err(|e| format!("ISO task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;
    use std::io::Write;
    use std::path::PathBuf;

    fn temp_file(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "altfe-iso-{}-{}-{tag}",
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        path
    }

    fn put(bytes: &mut [u8], offset: usize, data: &[u8]) {
        bytes[offset..offset + data.len()].copy_from_slice(data);
    }

    fn dir_record(name: &[u8], lba: u32, size: u32, flags: u8) -> Vec<u8> {
        let mut record = vec![0u8; 33 + name.len()];
        record[0] = (33 + name.len() + (name.len() % 2 == 0) as usize) as u8;
        record[1] = 0;
        put(&mut record, 2, &lba.to_le_bytes());
        put(&mut record, 6, &lba.to_be_bytes());
        put(&mut record, 10, &size.to_le_bytes());
        put(&mut record, 14, &size.to_be_bytes());
        record[25] = flags;
        record[28] = 1;
        record[29] = 0;
        record[32] = name.len() as u8;
        put(&mut record, 33, name);
        if name.len() % 2 == 0 {
            record.push(0);
        }
        record
    }

    fn root_record(lba: u32, size: u32) -> Vec<u8> {
        dir_record(&[0], lba, size, 0x02)
    }

    fn icon_bytes() -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(16, 16, image::Rgba([20, 120, 240, 255]));
        let mut out = Vec::new();
        image::codecs::ico::IcoEncoder::new(&mut out)
            .write_image(image.as_raw(), 16, 16, image::ExtendedColorType::Rgba8)
            .unwrap();
        out
    }

    fn build_iso(autorun: &str, icon: &[u8]) -> Vec<u8> {
        let sectors = 24;
        let mut bytes = vec![0u8; sectors * SECTOR as usize];

        let pvd = 16 * SECTOR as usize;
        bytes[pvd] = 1;
        put(&mut bytes, pvd + 1, b"CD001");
        bytes[pvd + 6] = 1;
        put(&mut bytes, pvd + 128, &(SECTOR as u16).to_le_bytes());
        put(&mut bytes, pvd + 130, &(SECTOR as u16).to_be_bytes());
        put(&mut bytes, pvd + 40, b"TEST_DISC");
        put(&mut bytes, pvd + 156, &root_record(20, SECTOR as u32));

        let terminator = 17 * SECTOR as usize;
        bytes[terminator] = 255;
        put(&mut bytes, terminator + 1, b"CD001");
        bytes[terminator + 6] = 1;

        let root = 20 * SECTOR as usize;
        let dot = dir_record(&[0], 20, SECTOR as u32, 0x02);
        let dotdot = dir_record(&[1], 20, SECTOR as u32, 0x02);
        let inf = dir_record(b"AUTORUN.INF;1", 21, autorun.len() as u32, 0);
        let ico = dir_record(b"CDROM.ICO;1", 22, icon.len() as u32, 0);
        let mut pos = root;
        for record in [dot, dotdot, inf, ico] {
            put(&mut bytes, pos, &record);
            pos += record.len();
        }

        put(&mut bytes, 21 * SECTOR as usize, autorun.as_bytes());
        put(&mut bytes, 22 * SECTOR as usize, icon);
        bytes
    }

    #[test]
    fn parses_autorun_sections_and_quoting() {
        let info = parse_autorun(
            "; comment\r\n[AutoRun.Amd64]\r\nopen=setup.exe\r\nicon=setup.exe,0\r\n\r\n[AutoRun]\r\nlabel=\"Demo Disc\"\r\nicon=\"sources\\boot.ico\",2\r\n",
        );
        assert_eq!(
            info.icon.as_deref(),
            Some(if cfg!(target_arch = "x86_64") {
                "setup.exe,0"
            } else {
                "\"sources\\boot.ico\",2"
            })
        );
        assert_eq!(info.label.as_deref(), Some("Demo Disc"));
    }

    #[test]
    fn cleans_icon_paths() {
        assert_eq!(icon_path("\"a\\b.ico\",0"), Some(("a\\b.ico".into(), 0)));
        assert_eq!(
            icon_path("icons/disc.ico, 12"),
            Some(("icons\\disc.ico".into(), 12))
        );
        assert_eq!(icon_path("setup.exe"), Some(("setup.exe".into(), 0)));
        assert_eq!(
            icon_path("\"icons/a,b.dll\",-123"),
            Some(("icons\\a,b.dll".into(), -123))
        );
        assert_eq!(icon_path(""), None);
    }

    #[test]
    fn rejects_generic_labels() {
        assert_eq!(clean_label("  CDROM  "), None);
        assert_eq!(
            clean_label("Ubuntu 24.04 LTS amd64").as_deref(),
            Some("Ubuntu 24.04 LTS amd64")
        );
    }

    fn build_pe(ico: &[u8]) -> Vec<u8> {
        let pixels = &ico[22..];
        let mut resource = vec![0u8; 160 + pixels.len() + 20];
        let group = 160 + pixels.len();
        for (at, count) in [(0, 2u16), (32, 1), (56, 1), (80, 1), (104, 1)] {
            put(&mut resource, at + 14, &count.to_le_bytes());
        }
        for (at, id, target) in [(16, 3u32, 32u32), (24, 14, 56), (48, 7, 80), (72, 123, 104)] {
            put(&mut resource, at, &id.to_le_bytes());
            put(&mut resource, at + 4, &(0x8000_0000 | target).to_le_bytes());
        }
        for (at, target) in [(96, 128u32), (120, 144)] {
            put(&mut resource, at, &1033u32.to_le_bytes());
            put(&mut resource, at + 4, &target.to_le_bytes());
        }
        put(&mut resource, 128, &(4096u32 + 160).to_le_bytes());
        put(&mut resource, 132, &(pixels.len() as u32).to_le_bytes());
        put(&mut resource, 144, &(4096u32 + group as u32).to_le_bytes());
        put(&mut resource, 148, &20u32.to_le_bytes());
        put(&mut resource, 160, pixels);
        put(&mut resource, group, &ico[..6]);
        put(&mut resource, group + 6, &ico[6..18]);
        put(&mut resource, group + 18, &7u16.to_le_bytes());
        let mut bytes = vec![0u8; 512];
        put(&mut bytes, 0, b"MZ");
        put(&mut bytes, 60, &128u32.to_le_bytes());
        put(&mut bytes, 128, b"PE\0\0");
        put(&mut bytes, 134, &1u16.to_le_bytes());
        put(&mut bytes, 148, &224u16.to_le_bytes());
        put(&mut bytes, 152, &0x10bu16.to_le_bytes());
        put(&mut bytes, 244, &16u32.to_le_bytes());
        put(&mut bytes, 264, &4096u32.to_le_bytes());
        put(&mut bytes, 268, &(resource.len() as u32).to_le_bytes());
        put(&mut bytes, 388, &4096u32.to_le_bytes());
        put(&mut bytes, 392, &(resource.len() as u32).to_le_bytes());
        put(&mut bytes, 396, &512u32.to_le_bytes());
        bytes.extend_from_slice(&resource);
        bytes
    }

    #[test]
    fn extracts_pe_icons_by_index_and_resource_id_without_loading_code() {
        let ico = icon_bytes();
        let pe = build_pe(&ico);
        assert_eq!(pe_icon(&pe, 0).unwrap(), ico);
        assert_eq!(pe_icon(&pe, -123).unwrap(), ico);
        assert!(pe_icon(&pe, -124).is_none());
        assert!(pe_icon(&pe, 1).is_none());
        assert!(decode_icon("setup.exe", 0, &pe).is_some());
        assert!(pe_icon(&pe[..300], 0).is_none());
        assert!(decode_icon("bad.ico", 0, b"not an icon").is_none());
    }

    #[test]
    fn decodes_unicode_ini_and_ignores_launch_commands() {
        let text = "[autorun]\nlabel=Disc 日本語\nopen=bad.exe\nshellexecute=bad.cmd";
        let mut utf16 = vec![0xff, 0xfe];
        for unit in text.encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        let info = parse_autorun(&decode_text(&utf16));
        assert_eq!(info.label.as_deref(), Some("Disc 日本語"));
        assert!(info.icon.is_none());
        let utf8 = parse_autorun("\u{feff}[autorun]\nlabel=Disc\n[ignored]\nicon=no.ico");
        assert_eq!(utf8.label.as_deref(), Some("Disc"));
        assert!(utf8.icon.is_none());
        let desktop = parse_autorun(
            "[.ShellClassInfo]\nIconResource=\"icons\\disc.dll\",-123\nLocalizedResourceName=Demo",
        );
        assert_eq!(
            desktop.icon.as_deref().and_then(icon_path),
            Some(("icons\\disc.dll".into(), -123))
        );
    }

    #[test]
    fn falls_back_to_root_icon_and_volume_label() {
        let icon = icon_bytes();
        let iso = build_iso("[autorun]\nicon=missing.ico\n", &icon);
        let path = temp_file("fallback.iso");
        std::fs::write(&path, &iso).unwrap();
        let dir = temp_file("fallback-thumbs");
        let info = inspect(&dir, &path.to_string_lossy()).unwrap();
        assert_eq!(info.label.as_deref(), Some("TEST_DISC"));
        assert_eq!(info.icon_from.as_deref(), Some("CDROM.ICO"));
        assert!(info.icon_url.is_some());
        let bad_icon = build_iso("[autorun]\nicon=CDROM.ICO\nlabel=Label only", b"corrupt");
        std::fs::write(&path, bad_icon).unwrap();
        let info = inspect(&dir, &path.to_string_lossy()).unwrap();
        assert_eq!(info.label.as_deref(), Some("Label only"));
        assert!(info.icon_url.is_none());
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_iso9660_label_autorun_and_icon() {
        let icon = icon_bytes();
        let iso = build_iso("[autorun]\r\nicon=cdrom.ico\r\nlabel=Demo Disc\r\n", &icon);
        let iso_path = temp_file("disk.iso");
        std::fs::File::create(&iso_path)
            .unwrap()
            .write_all(&iso)
            .unwrap();

        let file = std::fs::File::open(&iso_path).unwrap();
        let disc = Disc::open(&file).unwrap();
        assert_eq!(disc.label.as_deref(), Some("TEST_DISC"));
        let autorun = disc.read(&file, "AUTORUN.INF", MAX_INF).unwrap();
        assert_eq!(
            decode_text(&autorun),
            "[autorun]\r\nicon=cdrom.ico\r\nlabel=Demo Disc\r\n"
        );
        let (index, node) = root_icons(&disc, &file).into_iter().next().unwrap();
        assert_eq!(node.name, "CDROM.ICO");
        let fetched = disc.read_node(&file, index, &node, MAX_ICON).unwrap();
        assert_eq!(fetched, icon);

        let thumb_dir = temp_file("thumbs");
        std::fs::create_dir_all(&thumb_dir).unwrap();
        let info = inspect(&thumb_dir, &iso_path.to_string_lossy()).unwrap();
        assert_eq!(info.label.as_deref(), Some("Demo Disc"));
        assert_eq!(info.icon_from.as_deref(), Some("cdrom.ico"));
        assert!(info.icon_url.is_some());
        assert!(info.icon_url.unwrap().ends_with(".png"));

        let _ = std::fs::remove_file(&iso_path);
        let _ = std::fs::remove_dir_all(&thumb_dir);
    }

    #[test]
    fn reads_joliet_names() {
        let mut bytes = vec![0u8; 24 * SECTOR as usize];
        let pvd = 16 * SECTOR as usize;
        bytes[pvd] = 1;
        put(&mut bytes, pvd + 1, b"CD001");
        bytes[pvd + 6] = 1;
        put(&mut bytes, pvd + 128, &(SECTOR as u16).to_le_bytes());
        put(&mut bytes, pvd + 130, &(SECTOR as u16).to_be_bytes());
        put(&mut bytes, pvd + 40, b"ISO_LABEL");
        put(&mut bytes, pvd + 156, &root_record(20, SECTOR as u32));

        let svd = 17 * SECTOR as usize;
        bytes[svd] = 2;
        put(&mut bytes, svd + 1, b"CD001");
        bytes[svd + 6] = 1;
        put(&mut bytes, svd + 128, &(SECTOR as u16).to_le_bytes());
        put(&mut bytes, svd + 130, &(SECTOR as u16).to_be_bytes());
        put(&mut bytes, svd + 40, &decode_ucs2_bytes("Joliet Disc"));
        put(&mut bytes, svd + 88, b"%/E");
        put(&mut bytes, svd + 156, &root_record(21, SECTOR as u32));

        let terminator = 18 * SECTOR as usize;
        bytes[terminator] = 255;
        put(&mut bytes, terminator + 1, b"CD001");

        let joliet_name = decode_ucs2_bytes("Read Me.txt");
        let root = 21 * SECTOR as usize;
        let dot = dir_record(&[0], 21, SECTOR as u32, 0x02);
        let dotdot = dir_record(&[1], 21, SECTOR as u32, 0x02);
        let inf = dir_record(&joliet_name, 22, 4, 0);
        let mut pos = root;
        for record in [dot, dotdot, inf] {
            put(&mut bytes, pos, &record);
            pos += record.len();
        }
        put(&mut bytes, 22 * SECTOR as usize, b"test");

        let path = temp_file("joliet.iso");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(&bytes)
            .unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let disc = Disc::open(&file).unwrap();
        assert_eq!(disc.label.as_deref(), Some("Joliet Disc"));
        let data = disc.read(&file, "read me.txt", MAX_INF).unwrap();
        assert_eq!(data, b"test");
        let _ = std::fs::remove_file(&path);
    }

    fn with_reader_image<T>(bytes: &[u8], check: impl FnOnce(&File) -> T) -> T {
        let path = temp_file("reader.iso");
        std::fs::write(&path, bytes).unwrap();
        let file = File::open(&path).unwrap();
        let result = check(&file);
        drop(file);
        std::fs::remove_file(path).unwrap();
        result
    }

    const READER_UDF_PARTITION: usize = 272;
    const READER_UDF_PD: usize = 258 * SECTOR as usize;
    const READER_UDF_LVD: usize = 259 * SECTOR as usize;
    const READER_PAYLOAD: &[u8] = b"reader payload";

    fn reader_udf_fid(name: &str, lb: u32, dir: bool) -> Vec<u8> {
        let name_len = name.len() + 1;
        let mut fid = vec![0; (38 + name_len + 3) & !3];
        put(&mut fid, 0, &257u16.to_le_bytes());
        put(&mut fid, 16, &1u16.to_le_bytes());
        fid[18] = if dir { 2 } else { 0 };
        fid[19] = name_len as u8;
        put(&mut fid, 20, &(SECTOR as u32).to_le_bytes());
        put(&mut fid, 24, &lb.to_le_bytes());
        fid[38] = 8;
        put(&mut fid, 39, name.as_bytes());
        fid
    }

    fn reader_udf_entry(
        bytes: &mut [u8],
        lb: u32,
        tag: u16,
        dir: bool,
        kind: u16,
        data: &[u8],
        data_lb: u32,
    ) {
        let offset = (READER_UDF_PARTITION + lb as usize) * SECTOR as usize;
        let entry = &mut bytes[offset..offset + SECTOR as usize];
        entry.fill(0);
        put(entry, 0, &tag.to_le_bytes());
        entry[27] = if dir { 4 } else { 5 };
        put(entry, 34, &kind.to_le_bytes());
        put(entry, 56, &(data.len() as u64).to_le_bytes());
        let base = if tag == 266 { 216 } else { 176 };
        if tag == 266 {
            put(entry, 64, &(data.len() as u64).to_le_bytes());
        }
        let alloc_len = match kind {
            0 => 8,
            1 => 16,
            3 => data.len(),
            _ => panic!("unsupported fixture allocation kind"),
        };
        put(entry, base - 4, &(alloc_len as u32).to_le_bytes());
        if kind == 3 {
            put(entry, base, data);
        } else {
            put(entry, base, &(data.len() as u32).to_le_bytes());
            put(entry, base + 4, &data_lb.to_le_bytes());
            put(
                bytes,
                (READER_UDF_PARTITION + data_lb as usize) * SECTOR as usize,
                data,
            );
        }
    }

    fn build_reader_udf(tag: u16, kind: u16) -> Vec<u8> {
        let mut bytes = vec![0; (READER_UDF_PARTITION + 16) * SECTOR as usize];
        let anchor = 256 * SECTOR as usize;
        put(&mut bytes, anchor, &2u16.to_le_bytes());
        put(&mut bytes, anchor + 16, &(4 * SECTOR as u32).to_le_bytes());
        put(&mut bytes, anchor + 20, &257u32.to_le_bytes());
        let pvd = 257 * SECTOR as usize;
        put(&mut bytes, pvd, &1u16.to_le_bytes());
        put(&mut bytes, pvd + 24, b"\x08WRONG_PVD");
        bytes[pvd + 55] = 10;
        put(&mut bytes, READER_UDF_PD, &5u16.to_le_bytes());
        put(&mut bytes, READER_UDF_PD + 22, &7u16.to_le_bytes());
        put(
            &mut bytes,
            READER_UDF_PD + 188,
            &(READER_UDF_PARTITION as u32).to_le_bytes(),
        );
        put(&mut bytes, READER_UDF_PD + 192, &16u32.to_le_bytes());
        let lvd = READER_UDF_LVD;
        put(&mut bytes, lvd, &6u16.to_le_bytes());
        put(&mut bytes, lvd + 84, b"\x08Physical Disc");
        bytes[lvd + 211] = 14;
        put(&mut bytes, lvd + 212, &(SECTOR as u32).to_le_bytes());
        put(&mut bytes, lvd + 248, &(SECTOR as u32).to_le_bytes());
        put(&mut bytes, lvd + 264, &6u32.to_le_bytes());
        put(&mut bytes, lvd + 268, &1u32.to_le_bytes());
        put(&mut bytes, lvd + 440, &[1, 6, 1, 0, 7, 0]);
        put(&mut bytes, 260 * SECTOR as usize, &8u16.to_le_bytes());
        let fsd = READER_UDF_PARTITION * SECTOR as usize;
        put(&mut bytes, fsd, &256u16.to_le_bytes());
        put(&mut bytes, fsd + 400, &(SECTOR as u32).to_le_bytes());
        put(&mut bytes, fsd + 404, &1u32.to_le_bytes());
        reader_udf_entry(
            &mut bytes,
            1,
            tag,
            true,
            kind,
            &reader_udf_fid("payload", 3, false),
            2,
        );
        reader_udf_entry(&mut bytes, 3, tag, false, kind, READER_PAYLOAD, 4);
        bytes
    }

    #[test]
    fn reader_requires_exact_bounded_reads() {
        with_reader_image(b"abcd", |file| {
            assert_eq!(read_at(file, 1, 3).unwrap(), b"bcd");
            assert_eq!(read_at(file, 4, 0).unwrap(), b"");
            assert!(read_at(file, 1, 4).is_none());
            assert!(read_at(file, 5, 0).is_none());
            assert!(read_at(file, u64::MAX, 2).is_none());
            assert!(read_at(file, 0, usize::MAX).is_none());
        });
    }

    #[test]
    fn reader_iso_accounts_for_extended_attributes_and_truncation() {
        let mut bytes = build_iso("abcdef", &[]);
        let root = 16 * SECTOR as usize + 156;
        bytes[root + 1] = 1;
        put(&mut bytes, root + 2, &19u32.to_le_bytes());
        put(&mut bytes, root + 6, &19u32.to_be_bytes());
        let inf = 20 * SECTOR as usize + 68;
        bytes[inf + 1] = 1;
        put(&mut bytes, inf + 2, &20u32.to_le_bytes());
        put(&mut bytes, inf + 6, &20u32.to_be_bytes());
        with_reader_image(&bytes, |file| {
            let disc = Disc::open(file).unwrap();
            assert_eq!(
                disc.read(file, "\\autorun.inf", MAX_INF).unwrap(),
                b"abcdef"
            );
        });
        bytes.truncate(21 * SECTOR as usize + 3);
        with_reader_image(&bytes, |file| {
            let disc = Disc::open(file).unwrap();
            assert!(disc.read(file, "autorun.inf", MAX_INF).is_none());
            assert_eq!(disc.read(file, "autorun.inf", 3).unwrap(), b"abc");
        });
    }

    #[test]
    fn reader_iso_rejects_unsupported_records_and_block_sizes() {
        for (offset, value) in [(25, 0x80), (26, 1), (27, 1)] {
            let mut bytes = build_iso("data", &[]);
            bytes[20 * SECTOR as usize + 68 + offset] = value;
            with_reader_image(&bytes, |file| {
                assert!(Disc::open(file)
                    .unwrap()
                    .read(file, "autorun.inf", MAX_INF)
                    .is_none());
            });
            let mut bytes = build_iso("data", &[]);
            bytes[16 * SECTOR as usize + 156 + offset] |= value;
            with_reader_image(&bytes, |file| assert!(parse_iso(file).is_none()));
        }
        for offset in [128, 130] {
            let mut bytes = build_iso("data", &[]);
            bytes[16 * SECTOR as usize + offset] = 1;
            with_reader_image(&bytes, |file| assert!(parse_iso(file).is_none()));
        }
    }

    #[test]
    fn reader_iso_checks_joliet_escape_levels() {
        for escape in [b"%/@", b"%/C", b"%/E", b"%/X"] {
            let mut bytes = build_iso("data", &[]);
            let pvd = 16 * SECTOR as usize;
            let svd = 17 * SECTOR as usize;
            bytes.copy_within(pvd..pvd + SECTOR as usize, svd);
            bytes[svd] = 2;
            bytes[svd + 40..svd + 72].fill(0);
            put(&mut bytes, svd + 40, &decode_ucs2_bytes("Joliet"));
            put(&mut bytes, svd + 88, escape);
            let end = 18 * SECTOR as usize;
            bytes[end] = 255;
            put(&mut bytes, end + 1, b"CD001");
            with_reader_image(&bytes, |file| {
                let (_, label) = parse_iso(file).unwrap();
                assert_eq!(
                    label.as_deref(),
                    Some(if escape == b"%/X" {
                        "TEST_DISC"
                    } else {
                        "Joliet"
                    })
                );
            });
        }
    }

    #[test]
    fn reader_iso_rejects_records_crossing_sector_boundaries() {
        let mut bytes = build_iso("", &[]);
        let pvd = 16 * SECTOR as usize;
        put(&mut bytes, pvd + 156, &root_record(20, 2 * SECTOR as u32));
        let root = 20 * SECTOR as usize;
        bytes[root..root + 2 * SECTOR as usize].fill(0);
        let filler = dir_record(&vec![b'X'; 219], 22, 4, 0);
        assert_eq!(filler.len(), 252);
        for index in 0..8 {
            put(&mut bytes, root + index * filler.len(), &filler);
        }
        put(
            &mut bytes,
            root + 2016,
            &dir_record(b"AUTORUN.INF;1", 22, 4, 0),
        );
        put(&mut bytes, 22 * SECTOR as usize, b"data");
        with_reader_image(&bytes, |file| {
            let (volume, _) = parse_iso(file).unwrap();
            assert!(volume.list(file, &volume.root()).is_none());
        });
        bytes[root..root + 2 * SECTOR as usize].fill(0);
        put(
            &mut bytes,
            root + SECTOR as usize,
            &dir_record(b"AUTORUN.INF;1", 22, 4, 0),
        );
        with_reader_image(&bytes, |file| {
            assert_eq!(
                Disc::open(file)
                    .unwrap()
                    .read(file, "autorun.inf", MAX_INF)
                    .unwrap(),
                b"data"
            );
        });
    }

    #[test]
    fn reader_udf_reads_physical_short_long_and_inline_fe_and_efe() {
        for tag in [261, 266] {
            for kind in [0, 1, 3] {
                with_reader_image(&build_reader_udf(tag, kind), |file| {
                    let disc = Disc::open(file).unwrap();
                    assert_eq!(disc.label.as_deref(), Some("Physical Disc"));
                    assert_eq!(
                        disc.read(file, "\\PAYLOAD", MAX_INF).unwrap(),
                        READER_PAYLOAD
                    );
                    assert_eq!(disc.read(file, "./payload", 4).unwrap(), b"read");
                    assert!(disc.read(file, "missing", MAX_INF).is_none());
                });
            }
        }
    }

    #[test]
    fn reader_udf_rejects_unverified_maps_and_out_of_partition_icbs() {
        let lvd = READER_UDF_LVD;
        let pd = READER_UDF_PD;
        let fsd = READER_UDF_PARTITION * SECTOR as usize;
        let cases = [
            (lvd + 440, vec![2]),
            (lvd + 441, vec![64]),
            (lvd + 442, 2u16.to_le_bytes().to_vec()),
            (lvd + 444, 8u16.to_le_bytes().to_vec()),
            (lvd + 264, 0u32.to_le_bytes().to_vec()),
            (lvd + 264, 64u32.to_le_bytes().to_vec()),
            (lvd + 268, 0u32.to_le_bytes().to_vec()),
            (lvd + 268, 2u32.to_le_bytes().to_vec()),
            (lvd + 212, 4096u32.to_le_bytes().to_vec()),
            (lvd + 252, 16u32.to_le_bytes().to_vec()),
            (lvd + 256, 1u16.to_le_bytes().to_vec()),
            (
                lvd + 248,
                (SECTOR as u32 | 0x4000_0000).to_le_bytes().to_vec(),
            ),
            (pd + 192, 0u32.to_le_bytes().to_vec()),
            (pd + 192, 17u32.to_le_bytes().to_vec()),
            (pd + 188, u32::MAX.to_le_bytes().to_vec()),
            (fsd + 404, 16u32.to_le_bytes().to_vec()),
            (fsd + 408, 1u16.to_le_bytes().to_vec()),
            (lvd + 211, vec![128]),
            (256 * SECTOR as usize + 16, 0u32.to_le_bytes().to_vec()),
        ];
        for (offset, replacement) in cases {
            let mut bytes = build_reader_udf(261, 0);
            put(&mut bytes, offset, &replacement);
            with_reader_image(&bytes, |file| {
                assert!(
                    parse_udf(file).is_none(),
                    "accepted invalid UDF field at {offset}"
                );
            });
        }
        let bytes = build_reader_udf(261, 0);
        for length in [256 * SECTOR as usize + 20, bytes.len() - 1] {
            with_reader_image(&bytes[..length], |file| assert!(parse_udf(file).is_none()));
        }
    }

    #[test]
    fn reader_udf_rejects_invalid_entries_and_incomplete_allocations() {
        let file_offset = (READER_UDF_PARTITION + 3) * SECTOR as usize;
        for tag in [261, 266] {
            let base = if tag == 266 { 216 } else { 176 };
            for kind in [0, 1, 3] {
                let cases = [
                    (0, 260u16.to_le_bytes().to_vec()),
                    (27, vec![4]),
                    (27, vec![12]),
                    (34, 2u16.to_le_bytes().to_vec()),
                    (34, 4u16.to_le_bytes().to_vec()),
                    (base - 8, u32::MAX.to_le_bytes().to_vec()),
                    (base - 4, u32::MAX.to_le_bytes().to_vec()),
                    (base - 4, 1u32.to_le_bytes().to_vec()),
                    (56, (READER_PAYLOAD.len() as u64 + 1).to_le_bytes().to_vec()),
                ];
                for (offset, replacement) in cases {
                    let mut bytes = build_reader_udf(tag, kind);
                    put(&mut bytes, file_offset + offset, &replacement);
                    with_reader_image(&bytes, |file| {
                        let disc = Disc::open(file).unwrap();
                        assert!(
                            disc.read(file, "payload", MAX_INF).is_none(),
                            "accepted tag {tag}, kind {kind}, field {offset}"
                        );
                    });
                }
                let mut bytes = build_reader_udf(tag, kind);
                bytes[(READER_UDF_PARTITION + 1) * SECTOR as usize + 27] = 5;
                with_reader_image(&bytes, |file| {
                    let (volume, _) = parse_udf(file).unwrap();
                    assert!(volume.list(file, &volume.root()).is_none());
                });
            }
        }
    }

    #[test]
    fn reader_udf_rejects_sparse_continuation_and_foreign_extents() {
        let file_offset = (READER_UDF_PARTITION + 3) * SECTOR as usize;
        for kind in [0, 1] {
            let stride = if kind == 1 { 16 } else { 8 };
            for extent_type in 1u32..=3 {
                for invalid_first in [true, false] {
                    let mut bytes = build_reader_udf(261, kind);
                    let descriptor = bytes[file_offset + 176..file_offset + 176 + stride].to_vec();
                    put(&mut bytes, file_offset + 176 + stride, &descriptor);
                    put(
                        &mut bytes,
                        file_offset + 172,
                        &(2 * stride as u32).to_le_bytes(),
                    );
                    let offset = file_offset + 176 + if invalid_first { 0 } else { stride };
                    put(
                        &mut bytes,
                        offset,
                        &((READER_PAYLOAD.len() as u32) | (extent_type << 30)).to_le_bytes(),
                    );
                    with_reader_image(&bytes, |file| {
                        assert!(Disc::open(file).unwrap().read(file, "payload", 4).is_none());
                    });
                }
            }
            for (lb, len) in [(16, 4), (15, SECTOR as u32 + 1)] {
                let mut bytes = build_reader_udf(261, kind);
                put(&mut bytes, file_offset + 176, &len.to_le_bytes());
                put(&mut bytes, file_offset + 180, &(lb as u32).to_le_bytes());
                with_reader_image(&bytes, |file| {
                    assert!(Disc::open(file).unwrap().read(file, "payload", 1).is_none());
                });
            }
        }
        let mut bytes = build_reader_udf(261, 1);
        put(&mut bytes, file_offset + 184, &1u16.to_le_bytes());
        with_reader_image(&bytes, |file| {
            assert!(Disc::open(file)
                .unwrap()
                .read(file, "payload", MAX_INF)
                .is_none());
        });
        for (field, value) in [(28, 1), (24, 16)] {
            let mut bytes = build_reader_udf(261, 3);
            let fid = (READER_UDF_PARTITION + 1) * SECTOR as usize + 176;
            put(&mut bytes, fid + field, &(value as u32).to_le_bytes());
            with_reader_image(&bytes, |file| {
                let (volume, _) = parse_udf(file).unwrap();
                assert!(volume.list(file, &volume.root()).is_none());
            });
        }
    }

    #[test]
    fn reader_udf_reads_recorded_extents_without_silent_short_reads() {
        let file_offset = (READER_UDF_PARTITION + 3) * SECTOR as usize;
        for kind in [0, 1] {
            let stride = if kind == 1 { 16 } else { 8 };
            let mut bytes = build_reader_udf(261, kind);
            put(&mut bytes, file_offset + 56, &8u64.to_le_bytes());
            put(
                &mut bytes,
                file_offset + 172,
                &(2 * stride as u32).to_le_bytes(),
            );
            put(&mut bytes, file_offset + 176, &3u32.to_le_bytes());
            put(&mut bytes, file_offset + 176 + stride, &5u32.to_le_bytes());
            put(&mut bytes, file_offset + 180 + stride, &5u32.to_le_bytes());
            put(
                &mut bytes,
                (READER_UDF_PARTITION + 4) * SECTOR as usize,
                b"abc",
            );
            put(
                &mut bytes,
                (READER_UDF_PARTITION + 5) * SECTOR as usize,
                b"defgh",
            );
            with_reader_image(&bytes, |file| {
                let disc = Disc::open(file).unwrap();
                assert_eq!(disc.read(file, "payload", MAX_INF).unwrap(), b"abcdefgh");
                assert_eq!(disc.read(file, "payload", 6).unwrap(), b"abcdef");
            });
        }
        let mut bytes = build_reader_udf(261, 0);
        let volume = with_reader_image(&bytes, |file| parse_udf(file).unwrap().0);
        bytes.truncate((READER_UDF_PARTITION + 4) * SECTOR as usize + 5);
        with_reader_image(&bytes, |file| {
            let node = Node {
                name: "payload".into(),
                extent: 3,
                size: 0,
                dir: false,
            };
            assert!(volume.read(file, &node, MAX_INF).is_none());
            assert_eq!(volume.read(file, &node, 4).unwrap(), b"read");
        });
    }

    #[test]
    fn reader_udf_bounds_inline_data_and_directory_records() {
        for tag in [261, 266] {
            let base = if tag == 266 { 216 } else { 176 };
            let mut bytes = build_reader_udf(tag, 3);
            let file_offset = (READER_UDF_PARTITION + 3) * SECTOR as usize;
            put(&mut bytes, file_offset + base - 4, &3u32.to_le_bytes());
            with_reader_image(&bytes, |file| {
                assert!(Disc::open(file).unwrap().read(file, "payload", 4).is_none());
            });
            let mut bytes = build_reader_udf(tag, 3);
            let root = (READER_UDF_PARTITION + 1) * SECTOR as usize;
            bytes[root + base + 19] = 255;
            with_reader_image(&bytes, |file| {
                let (volume, _) = parse_udf(file).unwrap();
                assert!(volume.list(file, &volume.root()).is_none());
            });
        }
        assert_eq!(decode_dstring(&[8, b'A', 0xff, 0, 2]).as_deref(), Some("A"));
        assert_eq!(decode_dstring(&[16, 0, b'A', 0, 3]).as_deref(), Some("A"));
        assert!(decode_dstring(&[8, b'A', 4]).is_none());
        assert!(decode_dstring(&[16, 0, 2]).is_none());
    }

    #[test]
    fn reader_udf_skips_deleted_fids_without_following_their_cleared_icbs() {
        let mut bytes = build_reader_udf(261, 3);
        let mut entries = reader_udf_fid("removed", 0, false);
        entries[18] = 4;
        entries[20..36].fill(0);
        entries.extend(reader_udf_fid("payload", 3, false));
        reader_udf_entry(&mut bytes, 1, 261, true, 3, &entries, 0);
        with_reader_image(&bytes, |file| {
            assert_eq!(
                Disc::open(file)
                    .unwrap()
                    .read(file, "payload", MAX_INF)
                    .unwrap(),
                READER_PAYLOAD
            );
        });
    }

    #[test]
    fn reader_rejects_traversal_network_paths_and_directory_cycles() {
        let mut bytes = build_reader_udf(261, 3);
        let mut root = reader_udf_fid("payload", 3, false);
        root.extend(reader_udf_fid("..", 5, true));
        root.extend(reader_udf_fid("loop", 1, true));
        root.extend(reader_udf_fid("child", 5, true));
        root.extend(reader_udf_fid("C:payload", 3, false));
        reader_udf_entry(&mut bytes, 1, 261, true, 3, &root, 2);
        let mut child = reader_udf_fid("payload", 3, false);
        child.extend(reader_udf_fid("back", 1, true));
        reader_udf_entry(&mut bytes, 5, 261, true, 3, &child, 0);
        with_reader_image(&bytes, |file| {
            let disc = Disc::open(file).unwrap();
            for path in [
                "payload",
                "\\payload",
                "/payload",
                ".\\payload",
                "child/payload",
            ] {
                assert_eq!(disc.read(file, path, MAX_INF).unwrap(), READER_PAYLOAD);
            }
            for path in [
                "../payload",
                "..\\payload",
                "child/../payload",
                "C:payload",
                "//payload",
                "\\\\payload",
                "/\\payload",
                "\\/payload",
                "loop/payload",
                "child/back/payload",
            ] {
                assert!(disc.read(file, path, MAX_INF).is_none(), "accepted {path}");
            }
            assert!(disc.resolve(file, "loop").is_none());
            assert!(disc.resolve(file, "child/back").is_none());
        });
    }

    #[test]
    fn reader_caps_path_components_at_sixteen() {
        let mut bytes = build_reader_udf(261, 3);
        bytes.resize((READER_UDF_PARTITION + 32) * SECTOR as usize, 0);
        put(&mut bytes, READER_UDF_PD + 192, &32u32.to_le_bytes());
        reader_udf_entry(
            &mut bytes,
            1,
            261,
            true,
            3,
            &reader_udf_fid("d", 5, true),
            0,
        );
        for lb in 5..=19 {
            let mut entries = reader_udf_fid("payload", 3, false);
            if lb < 19 {
                entries.extend(reader_udf_fid("d", lb + 1, true));
            }
            reader_udf_entry(&mut bytes, lb, 261, true, 3, &entries, 0);
        }
        let allowed = format!("{}payload", "d/".repeat(15));
        with_reader_image(&bytes, |file| {
            assert_eq!(
                Disc::open(file)
                    .unwrap()
                    .read(file, &allowed, MAX_INF)
                    .unwrap(),
                READER_PAYLOAD
            );
        });
        reader_udf_entry(
            &mut bytes,
            19,
            261,
            true,
            3,
            &reader_udf_fid("d", 20, true),
            0,
        );
        reader_udf_entry(
            &mut bytes,
            20,
            261,
            true,
            3,
            &reader_udf_fid("payload", 3, false),
            0,
        );
        with_reader_image(&bytes, |file| {
            let disc = Disc::open(file).unwrap();
            assert!(disc
                .read(file, &format!("{}payload", "d/".repeat(16)), MAX_INF)
                .is_none());
        });
    }

    fn decode_ucs2_bytes(value: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for unit in value.encode_utf16() {
            out.extend_from_slice(&unit.to_be_bytes());
        }
        out
    }
}
