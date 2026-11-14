use crate::mesh::{Facet, MeshBounds};
use serde::Serialize;
use std::cell::Cell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;

const MAX_ENTRY_BYTES: u64 = 192 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 384 * 1024 * 1024;
const MAX_MODEL_FILES: usize = 512;
const MAX_VERTICES: usize = 8_000_000;
const MAX_TRIANGLES: usize = 8_000_000;
const MAX_DEPTH: usize = 16;
const MAX_INSTANCES: usize = 100_000;
const MAX_PAINT_DEPTH: usize = 32;
const MAX_MATERIALS: usize = 12;

const PALETTE: [[u8; 3]; 7] = [
    [255, 128, 0],
    [30, 136, 229],
    [67, 160, 71],
    [229, 57, 53],
    [253, 216, 53],
    [142, 36, 170],
    [0, 172, 193],
];

type Mat = [f64; 12];
type Corners = [[f64; 3]; 3];

const IDENTITY: Mat = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0];

fn le16(bytes: &[u8], at: usize) -> Option<usize> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as usize)
}

fn le32(bytes: &[u8], at: usize) -> Option<usize> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?) as usize)
}

fn part_key(name: &str) -> String {
    let raw = name.as_bytes();
    let mut decoded = Vec::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' && index + 2 < raw.len() {
            if let Ok(byte) = u8::from_str_radix(&name[index + 1..index + 3], 16) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(raw[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded)
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_lowercase()
}

struct Entry {
    method: u16,
    packed: usize,
    local: usize,
}

struct Zip<'a> {
    bytes: &'a [u8],
    entries: HashMap<String, Entry>,
    budget: Cell<u64>,
}

impl<'a> Zip<'a> {
    fn open(bytes: &'a [u8]) -> Option<Self> {
        if !bytes.starts_with(b"PK\x03\x04") {
            return None;
        }
        let low = bytes.len().saturating_sub(66_000);
        let eocd = (low..bytes.len().saturating_sub(21))
            .rev()
            .find(|&start| bytes[start..start + 4] == *b"PK\x05\x06")?;
        let count = le16(bytes, eocd + 10)?;
        let mut cursor = le32(bytes, eocd + 16)?;
        let mut entries = HashMap::with_capacity(count);
        for _ in 0..count {
            if bytes.get(cursor..cursor + 4)? != b"PK\x01\x02" {
                break;
            }
            let method = le16(bytes, cursor + 10)? as u16;
            let packed = le32(bytes, cursor + 20)?;
            let name_len = le16(bytes, cursor + 28)?;
            let extra_len = le16(bytes, cursor + 30)?;
            let comment_len = le16(bytes, cursor + 32)?;
            let local = le32(bytes, cursor + 42)?;
            let name = bytes.get(cursor + 46..cursor + 46 + name_len)?;
            entries.insert(
                part_key(&String::from_utf8_lossy(name)),
                Entry {
                    method,
                    packed,
                    local,
                },
            );
            cursor += 46 + name_len + extra_len + comment_len;
        }
        Some(Zip {
            bytes,
            entries,
            budget: Cell::new(MAX_PACKAGE_BYTES),
        })
    }

    fn read(&self, key: &str) -> Option<Vec<u8>> {
        let entry = self.entries.get(key)?;
        let local = entry.local;
        if self.bytes.get(local..local + 4)? != b"PK\x03\x04" {
            return None;
        }
        let data = local + 30 + le16(self.bytes, local + 26)? + le16(self.bytes, local + 28)?;
        let raw = self.bytes.get(data..data.checked_add(entry.packed)?)?;
        let limit = self.budget.get().min(MAX_ENTRY_BYTES);
        let out = match entry.method {
            0 if raw.len() as u64 <= limit => raw.to_vec(),
            8 => {
                let mut out = Vec::new();
                flate2::read::DeflateDecoder::new(raw)
                    .take(limit)
                    .read_to_end(&mut out)
                    .ok()?;
                out
            }
            _ => return None,
        };
        self.budget
            .set(self.budget.get().saturating_sub(out.len() as u64));
        Some(out)
    }

    fn text(&self, key: &str) -> Option<String> {
        self.read(key).map(|bytes| {
            String::from_utf8(bytes)
                .unwrap_or_else(|error| String::from_utf8_lossy(&error.into_bytes()).into_owned())
        })
    }
}

struct Tag<'a> {
    name: &'a str,
    attrs: &'a str,
    close: bool,
    rest: &'a str,
}

struct Tags<'a> {
    text: &'a str,
    pos: usize,
}

fn tags(text: &str) -> Tags<'_> {
    Tags { text, pos: 0 }
}

impl<'a> Iterator for Tags<'a> {
    type Item = Tag<'a>;

    fn next(&mut self) -> Option<Tag<'a>> {
        loop {
            let start = self.pos + self.text.get(self.pos..)?.find('<')?;
            let rest = &self.text[start + 1..];
            if rest.starts_with("!--") {
                self.pos = start + 1 + rest.find("-->")? + 3;
                continue;
            }
            if rest.starts_with("![CDATA[") {
                self.pos = start + 1 + rest.find("]]>")? + 3;
                continue;
            }
            let mut quote = 0u8;
            let end = rest.bytes().position(|byte| {
                if quote != 0 {
                    if byte == quote {
                        quote = 0;
                    }
                    false
                } else if byte == b'"' || byte == b'\'' {
                    quote = byte;
                    false
                } else {
                    byte == b'>'
                }
            })?;
            self.pos = start + 1 + end + 1;
            let inner = &rest[..end];
            if inner.starts_with('?') || inner.starts_with('!') {
                continue;
            }
            let (close, inner) = match inner.strip_prefix('/') {
                Some(stripped) => (true, stripped),
                None => (false, inner),
            };
            let inner = inner.strip_suffix('/').unwrap_or(inner);
            let split = inner
                .find(|c: char| c.is_ascii_whitespace())
                .unwrap_or(inner.len());
            let qualified = &inner[..split];
            return Some(Tag {
                name: local_name(qualified),
                attrs: &inner[split..],
                close,
                rest: &self.text[self.pos..],
            });
        }
    }
}

fn local_name(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

struct Attrs<'a> {
    rest: &'a str,
}

fn attrs(text: &str) -> Attrs<'_> {
    Attrs { rest: text }
}

impl<'a> Iterator for Attrs<'a> {
    type Item = (&'a str, &'a str);

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let text = self.rest.trim_start();
            let eq = text.find('=')?;
            let name = text[..eq].trim_end();
            let after = text[eq + 1..].trim_start();
            let quote = after.chars().next()?;
            if quote != '"' && quote != '\'' {
                self.rest = after;
                continue;
            }
            let body = &after[1..];
            let close = body.find(quote)?;
            self.rest = &body[close + 1..];
            return Some((local_name(name), &body[..close]));
        }
    }
}

fn attr<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    attrs(text).find(|(name, _)| *name == key).map(|(_, value)| value)
}

fn number<T: std::str::FromStr>(text: &str, key: &str) -> Option<T> {
    attr(text, key)?.trim().parse().ok()
}

fn text_of(tag: &Tag) -> String {
    unescape(&tag.rest[..tag.rest.find('<').unwrap_or(tag.rest.len())])
}

fn unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.trim().to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let decoded = rest.find(';').filter(|&semi| semi <= 10).and_then(|semi| {
            let entity = &rest[1..semi];
            let ch = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ => entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                    .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                    .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                    .and_then(char::from_u32),
            };
            ch.map(|ch| (ch, semi))
        });
        match decoded {
            Some((ch, semi)) => {
                out.push(ch);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out.trim().to_owned()
}

fn parse_color(text: &str) -> Option<[u8; 3]> {
    let hex = text.trim().trim_matches('"').strip_prefix('#')?;
    if !(hex.len() == 6 || hex.len() == 8) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

fn hex_color(color: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", color[0], color[1], color[2])
}

fn mix(colors: &[([u8; 3], f32)]) -> Option<[u8; 3]> {
    let total: f32 = colors.iter().map(|(_, weight)| weight.max(0.0)).sum();
    if total <= 0.0 {
        return None;
    }
    let mut sum = [0.0f32; 3];
    for (color, weight) in colors {
        for channel in 0..3 {
            sum[channel] += color[channel] as f32 * weight.max(0.0);
        }
    }
    Some(sum.map(|value| (value / total).round().clamp(0.0, 255.0) as u8))
}

fn unit_scale(unit: &str) -> f64 {
    match unit {
        "micron" => 0.001,
        "centimeter" => 10.0,
        "inch" => 25.4,
        "foot" => 304.8,
        "meter" => 1000.0,
        _ => 1.0,
    }
}

fn parse_transform(text: &str) -> Mat {
    let values: Vec<f64> = text
        .split_ascii_whitespace()
        .filter_map(|value| value.parse().ok())
        .collect();
    if values.len() != 12 || !values.iter().all(|v| v.is_finite()) {
        return IDENTITY;
    }
    let mut out = IDENTITY;
    out.copy_from_slice(&values);
    out
}

fn apply(m: &Mat, p: [f32; 3]) -> [f64; 3] {
    let (x, y, z) = (p[0] as f64, p[1] as f64, p[2] as f64);
    [
        x * m[0] + y * m[3] + z * m[6] + m[9],
        x * m[1] + y * m[4] + z * m[7] + m[10],
        x * m[2] + y * m[5] + z * m[8] + m[11],
    ]
}

/// Row-vector composition: the result applies `first`, then `then`.
fn compose(first: &Mat, then: &Mat) -> Mat {
    let mut out = [0.0; 12];
    for row in 0..4 {
        for col in 0..3 {
            let mut sum = (0..3)
                .map(|k| first[row * 3 + k] * then[k * 3 + col])
                .sum::<f64>();
            if row == 3 {
                sum += then[9 + col];
            }
            out[row * 3 + col] = sum;
        }
    }
    out
}

#[derive(Clone, Copy)]
struct Tri {
    v: [u32; 3],
    swatch: u32,
    paint: u32,
}

#[derive(Default)]
struct Mesh {
    verts: Vec<[f32; 3]>,
    tris: Vec<Tri>,
    paint: Vec<Box<str>>,
}

#[derive(Clone)]
struct Item {
    path: Option<String>,
    object: u32,
    transform: Mat,
}

#[derive(Default)]
struct Object {
    other: bool,
    mesh: Option<Mesh>,
    components: Vec<Item>,
}

struct Swatch {
    color: [u8; 3],
    label: String,
}

struct ModelFile {
    unit: String,
    objects: HashMap<u32, Object>,
    build: Vec<Item>,
    meta: HashMap<String, String>,
    swatches: Vec<Swatch>,
}

enum Group {
    Base,
    Color,
    Composite { material: u32, indices: Vec<u32> },
    Multi { pids: Vec<u32> },
    Texture,
}

struct Open {
    id: u32,
    object: Object,
    pid: Option<u32>,
    pindex: Option<u32>,
}

fn item_of(attrs_text: &str) -> Option<Item> {
    Some(Item {
        path: attr(attrs_text, "path").map(unescape),
        object: number(attrs_text, "objectid")?,
        transform: attr(attrs_text, "transform").map_or(IDENTITY, parse_transform),
    })
}

fn swatch_for(
    swatches: &mut Vec<Swatch>,
    blends: &mut HashMap<[u8; 3], u32>,
    color: [u8; 3],
    label: &str,
) -> u32 {
    *blends.entry(color).or_insert_with(|| {
        swatches.push(Swatch {
            color,
            label: label.to_owned(),
        });
        swatches.len() as u32
    })
}

fn parse_model(text: &str) -> ModelFile {
    let mut unit = String::from("millimeter");
    let mut objects = HashMap::new();
    let mut build = Vec::new();
    let mut meta = HashMap::new();
    let mut swatches: Vec<Swatch> = Vec::new();
    let mut groups: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut group: Option<(u32, Group, Vec<u32>)> = None;
    let mut blends: HashMap<[u8; 3], u32> = HashMap::new();
    let mut open: Option<Open> = None;
    let mut in_build = false;
    let mut total_verts = 0usize;
    let mut total_tris = 0usize;

    let flush = |open: &mut Option<Open>, objects: &mut HashMap<u32, Object>| {
        if let Some(done) = open.take() {
            objects.insert(done.id, done.object);
        }
    };

    for tag in tags(text) {
        match (tag.name, tag.close) {
            ("vertex", false) => {
                let Some(mesh) = open.as_mut().and_then(|o| o.object.mesh.as_mut()) else {
                    continue;
                };
                if total_verts >= MAX_VERTICES {
                    continue;
                }
                let mut point = [f32::NAN; 3];
                for (key, value) in attrs(tag.attrs) {
                    let axis = match key {
                        "x" => 0,
                        "y" => 1,
                        "z" => 2,
                        _ => continue,
                    };
                    point[axis] = value.trim().parse().unwrap_or(f32::NAN);
                }
                mesh.verts.push(point);
                total_verts += 1;
            }
            ("triangle", false) => {
                let Some(current) = open.as_mut() else {
                    continue;
                };
                let (object_pid, object_pindex) = (current.pid, current.pindex);
                let Some(mesh) = current.object.mesh.as_mut() else {
                    continue;
                };
                if total_tris >= MAX_TRIANGLES {
                    continue;
                }
                let mut v = [u32::MAX; 3];
                let mut pid = None;
                let mut p = [None; 3];
                let mut paint = None;
                for (key, value) in attrs(tag.attrs) {
                    match key {
                        "v1" => v[0] = value.trim().parse().unwrap_or(u32::MAX),
                        "v2" => v[1] = value.trim().parse().unwrap_or(u32::MAX),
                        "v3" => v[2] = value.trim().parse().unwrap_or(u32::MAX),
                        "pid" => pid = value.trim().parse::<u32>().ok(),
                        "p1" => p[0] = value.trim().parse::<u32>().ok(),
                        "p2" => p[1] = value.trim().parse::<u32>().ok(),
                        "p3" => p[2] = value.trim().parse::<u32>().ok(),
                        "paint_color" | "mmu_segmentation" if !value.trim().is_empty() => {
                            paint = Some(value.trim())
                        }
                        _ => {}
                    }
                }
                if v.iter().any(|&index| index as usize >= mesh.verts.len()) {
                    continue;
                }
                let swatch = triangle_swatch(
                    &groups,
                    &mut swatches,
                    &mut blends,
                    pid.or(object_pid),
                    [p[0].or(if pid.is_none() { object_pindex } else { None }), p[1], p[2]],
                );
                let paint = match paint {
                    Some(code) => {
                        mesh.paint.push(code.into());
                        mesh.paint.len() as u32
                    }
                    None => 0,
                };
                mesh.tris.push(Tri { v, swatch, paint });
                total_tris += 1;
            }
            ("model", false) => {
                if let Some(value) = attr(tag.attrs, "unit") {
                    unit = value.trim().to_owned();
                }
            }
            ("metadata", false) => {
                if let Some(name) = attr(tag.attrs, "name") {
                    let value = text_of(&tag);
                    if !value.is_empty() && meta.len() < 64 {
                        meta.insert(name.to_ascii_lowercase(), value);
                    }
                }
            }
            ("basematerials", false) => {
                group = number(tag.attrs, "id").map(|id| (id, Group::Base, Vec::new()))
            }
            ("colorgroup", false) => {
                group = number(tag.attrs, "id").map(|id| (id, Group::Color, Vec::new()))
            }
            ("texture2dgroup", false) => {
                group = number(tag.attrs, "id").map(|id| (id, Group::Texture, Vec::new()))
            }
            ("compositematerials", false) => {
                group = number(tag.attrs, "id").map(|id| {
                    let indices = attr(tag.attrs, "matindices")
                        .unwrap_or("")
                        .split_ascii_whitespace()
                        .filter_map(|value| value.parse().ok())
                        .collect();
                    let material = number(tag.attrs, "matid").unwrap_or(u32::MAX);
                    (id, Group::Composite { material, indices }, Vec::new())
                })
            }
            ("multiproperties", false) => {
                group = number(tag.attrs, "id").map(|id| {
                    let pids = attr(tag.attrs, "pids")
                        .unwrap_or("")
                        .split_ascii_whitespace()
                        .filter_map(|value| value.parse().ok())
                        .collect();
                    (id, Group::Multi { pids }, Vec::new())
                })
            }
            ("base", false) | ("color", false) | ("tex2coord", false) | ("composite", false)
            | ("multi", false) => {
                let Some((_, kind, list)) = group.as_mut() else {
                    continue;
                };
                let entry = match (kind, tag.name) {
                    (Group::Base, "base") => attr(tag.attrs, "displaycolor")
                        .and_then(parse_color)
                        .map_or(0, |color| {
                            let label = attr(tag.attrs, "name")
                                .map(unescape)
                                .filter(|name| !name.is_empty())
                                .unwrap_or_else(|| String::from("Material"));
                            swatches.push(Swatch { color, label });
                            swatches.len() as u32
                        }),
                    (Group::Color, "color") => attr(tag.attrs, "color")
                        .and_then(parse_color)
                        .map_or(0, |color| swatch_for(&mut swatches, &mut blends, color, "Color")),
                    (Group::Composite { material, indices }, "composite") => {
                        let weights: Vec<f32> = attr(tag.attrs, "values")
                            .unwrap_or("")
                            .split_ascii_whitespace()
                            .filter_map(|value| value.parse().ok())
                            .collect();
                        let parts: Vec<([u8; 3], f32)> = indices
                            .iter()
                            .zip(weights)
                            .filter_map(|(index, weight)| {
                                let swatch = *groups.get(&*material)?.get(*index as usize)?;
                                (swatch > 0).then(|| (swatches[swatch as usize - 1].color, weight))
                            })
                            .collect();
                        mix(&parts).map_or(0, |color| {
                            swatch_for(&mut swatches, &mut blends, color, "Composite")
                        })
                    }
                    (Group::Multi { pids }, "multi") => attr(tag.attrs, "pindices")
                        .unwrap_or("")
                        .split_ascii_whitespace()
                        .filter_map(|value| value.parse::<usize>().ok())
                        .zip(pids.iter())
                        .find_map(|(index, pid)| {
                            groups.get(pid)?.get(index).copied().filter(|&s| s > 0)
                        })
                        .unwrap_or(0),
                    (Group::Texture, "tex2coord") => 0,
                    _ => continue,
                };
                list.push(entry);
            }
            ("basematerials", true)
            | ("colorgroup", true)
            | ("texture2dgroup", true)
            | ("compositematerials", true)
            | ("multiproperties", true) => {
                if let Some((id, _, list)) = group.take() {
                    groups.insert(id, list);
                }
            }
            ("object", false) => {
                flush(&mut open, &mut objects);
                if let Some(id) = number(tag.attrs, "id") {
                    open = Some(Open {
                        id,
                        object: Object {
                            other: attr(tag.attrs, "type") == Some("other"),
                            ..Object::default()
                        },
                        pid: number(tag.attrs, "pid"),
                        pindex: number(tag.attrs, "pindex"),
                    });
                }
            }
            ("object", true) => flush(&mut open, &mut objects),
            ("mesh", false) => {
                if let Some(current) = open.as_mut() {
                    current.object.mesh.get_or_insert_with(Mesh::default);
                }
            }
            ("component", false) => {
                if let (Some(current), Some(item)) = (open.as_mut(), item_of(tag.attrs)) {
                    current.object.components.push(item);
                }
            }
            ("build", close) => in_build = !close,
            ("item", false) if in_build => {
                if let Some(item) = item_of(tag.attrs) {
                    build.push(item);
                }
            }
            _ => {}
        }
    }
    flush(&mut open, &mut objects);
    ModelFile {
        unit,
        objects,
        build,
        meta,
        swatches,
    }
}

fn triangle_swatch(
    groups: &HashMap<u32, Vec<u32>>,
    swatches: &mut Vec<Swatch>,
    blends: &mut HashMap<[u8; 3], u32>,
    pid: Option<u32>,
    p: [Option<u32>; 3],
) -> u32 {
    let Some(group) = pid.and_then(|pid| groups.get(&pid)) else {
        return 0;
    };
    let first = p[0].unwrap_or(0);
    let pick = |index: Option<u32>| {
        group
            .get(index.unwrap_or(first) as usize)
            .copied()
            .unwrap_or(0)
    };
    let corners = [pick(Some(first)), pick(p[1]), pick(p[2])];
    if corners[0] == corners[1] && corners[1] == corners[2] {
        return corners[0];
    }
    let parts: Vec<([u8; 3], f32)> = corners
        .iter()
        .filter(|&&swatch| swatch > 0)
        .map(|&swatch| (swatches[swatch as usize - 1].color, 1.0))
        .collect();
    mix(&parts).map_or(0, |color| swatch_for(swatches, blends, color, "Blend"))
}

struct Part {
    extruder: u32,
    printable: bool,
}

struct Volume {
    first: u32,
    last: u32,
    extruder: u32,
    printable: bool,
}

#[derive(Default)]
struct ConfigObject {
    extruder: u32,
    parts: HashMap<u32, Part>,
    volumes: Vec<Volume>,
}

struct Filament {
    color: [u8; 3],
    kind: String,
}

#[derive(Default)]
struct Config {
    objects: HashMap<u32, ConfigObject>,
    plate: Option<HashSet<u32>>,
    plates: usize,
    filaments: Vec<Filament>,
}

fn extruder_value(value: Option<&str>) -> u32 {
    value.and_then(|v| v.trim().parse().ok()).unwrap_or(0)
}

fn parse_object_config(text: &str, config: &mut Config) {
    let mut object: Option<(u32, ConfigObject)> = None;
    let mut part: Option<(u32, Part)> = None;
    let mut volume: Option<Volume> = None;
    let mut plate: Option<(u32, Vec<u32>)> = None;
    let mut plates: Vec<(u32, Vec<u32>)> = Vec::new();
    let mut in_instance = false;
    for tag in tags(text) {
        match (tag.name, tag.close) {
            ("object", false) => {
                object = number(tag.attrs, "id").map(|id| (id, ConfigObject::default()))
            }
            ("object", true) => {
                if let Some((id, done)) = object.take() {
                    config.objects.insert(id, done);
                }
            }
            ("part", false) => {
                part = number(tag.attrs, "id").map(|id| {
                    let printable = attr(tag.attrs, "subtype").map_or(true, |s| s == "normal_part");
                    (
                        id,
                        Part {
                            extruder: 0,
                            printable,
                        },
                    )
                })
            }
            ("part", true) => {
                if let (Some((id, done)), Some((_, owner))) = (part.take(), object.as_mut()) {
                    owner.parts.insert(id, done);
                }
            }
            ("volume", false) => {
                volume = Some(Volume {
                    first: number(tag.attrs, "firstid").unwrap_or(0),
                    last: number(tag.attrs, "lastid").unwrap_or(u32::MAX),
                    extruder: 0,
                    printable: true,
                })
            }
            ("volume", true) => {
                if let (Some(done), Some((_, owner))) = (volume.take(), object.as_mut()) {
                    owner.volumes.push(done);
                }
            }
            ("plate", false) => plate = Some((u32::MAX, Vec::new())),
            ("plate", true) => plates.extend(plate.take()),
            ("model_instance", close) => in_instance = !close,
            ("metadata", false) => {
                let key = attr(tag.attrs, "key").unwrap_or("");
                let value = attr(tag.attrs, "value");
                if let Some((id, members)) = plate.as_mut() {
                    match key {
                        "object_id" if in_instance => {
                            members.extend(value.and_then(|v| v.trim().parse::<u32>().ok()))
                        }
                        "plater_id" => *id = extruder_value(value),
                        _ => {}
                    }
                } else if let Some(current) = volume.as_mut() {
                    match key {
                        "extruder" => current.extruder = extruder_value(value),
                        "volume_type" => current.printable = value == Some("ModelPart"),
                        _ => {}
                    }
                } else if key == "extruder" {
                    if let Some((_, current)) = part.as_mut() {
                        current.extruder = extruder_value(value);
                    } else if let Some((_, current)) = object.as_mut() {
                        current.extruder = extruder_value(value);
                    }
                }
            }
            _ => {}
        }
    }
    config.plates = config.plates.max(plates.len());
    if let Some((_, members)) = plates
        .into_iter()
        .filter(|(_, members)| !members.is_empty())
        .min_by_key(|(id, _)| *id)
    {
        config.plate = Some(members.into_iter().collect());
    }
}

fn filament_list(colors: &[String], kinds: &[String]) -> Vec<Filament> {
    colors
        .iter()
        .enumerate()
        .map(|(index, color)| Filament {
            color: parse_color(color).unwrap_or(PALETTE[index % PALETTE.len()]),
            kind: kinds.get(index).cloned().unwrap_or_default(),
        })
        .collect()
}

fn bambu_filaments(text: &str) -> Vec<Filament> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let list = |key: &str| -> Vec<String> {
        json.get(key)
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().unwrap_or("").to_owned())
                    .collect()
            })
            .unwrap_or_default()
    };
    filament_list(&list("filament_colour"), &list("filament_type"))
}

fn prusa_filaments(text: &str) -> Vec<Filament> {
    let mut values: HashMap<&str, Vec<String>> = HashMap::new();
    for line in text.lines() {
        let line = line.trim_start_matches(';').trim();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if matches!(key, "filament_colour" | "extruder_colour" | "filament_type") {
            values.insert(
                key,
                value
                    .split(';')
                    .map(|part| part.trim().trim_matches('"').to_owned())
                    .collect(),
            );
        }
    }
    let empty = Vec::new();
    let filament = values.get("filament_colour").unwrap_or(&empty);
    let extruder = values.get("extruder_colour").unwrap_or(&empty);
    let count = filament.len().max(extruder.len());
    let colors: Vec<String> = (0..count)
        .map(|index| {
            extruder
                .get(index)
                .filter(|color| parse_color(color).is_some())
                .or_else(|| filament.get(index))
                .cloned()
                .unwrap_or_default()
        })
        .collect();
    filament_list(&colors, values.get("filament_type").unwrap_or(&empty))
}

fn read_config(zip: &Zip) -> Config {
    let mut config = Config::default();
    for key in [
        "metadata/model_settings.config",
        "metadata/slic3r_pe_model.config",
    ] {
        if let Some(text) = zip.text(key) {
            parse_object_config(&text, &mut config);
        }
    }
    if let Some(text) = zip.text("metadata/project_settings.config") {
        config.filaments = bambu_filaments(&text);
    }
    if config.filaments.is_empty() {
        if let Some(text) = zip.text("metadata/slic3r_pe.config") {
            config.filaments = prusa_filaments(&text);
        }
    }
    config
}

fn root_part(zip: &Zip) -> Option<String> {
    if let Some(rels) = zip.text("_rels/.rels") {
        for tag in tags(&rels) {
            if tag.close || tag.name != "Relationship" {
                continue;
            }
            if !attr(tag.attrs, "Type").is_some_and(|ty| ty.trim().ends_with("/3dmodel")) {
                continue;
            }
            if let Some(target) = attr(tag.attrs, "Target") {
                let key = part_key(&unescape(target));
                if zip.entries.contains_key(&key) {
                    return Some(key);
                }
            }
        }
    }
    let mut models: Vec<&String> = zip
        .entries
        .keys()
        .filter(|key| key.ends_with(".model"))
        .collect();
    models.sort_by_key(|key| (!key.ends_with("3dmodel.model"), key.len(), key.as_str()));
    models.first().map(|key| key.to_string())
}

struct Package {
    files: Vec<ModelFile>,
    index: HashMap<String, usize>,
    config: Config,
}

struct Instance<'a> {
    file: usize,
    mesh: &'a Mesh,
    matrix: Mat,
    extruder: u32,
    volumes: &'a [Volume],
}

impl Instance<'_> {
    /// The extruder printing a triangle, or None when it belongs to a modifier volume.
    fn extruder_for(&self, triangle: usize) -> Option<u32> {
        if self.volumes.is_empty() {
            return Some(self.extruder);
        }
        let volume = self
            .volumes
            .iter()
            .find(|v| v.first as usize <= triangle && triangle <= v.last as usize);
        match volume {
            Some(volume) if !volume.printable => None,
            Some(volume) if volume.extruder > 0 => Some(volume.extruder),
            _ => Some(self.extruder),
        }
    }
}

fn referenced_paths(file: &ModelFile) -> Vec<String> {
    file.objects
        .values()
        .flat_map(|object| object.components.iter())
        .chain(file.build.iter())
        .filter_map(|item| item.path.as_deref().map(part_key))
        .collect()
}

impl Package {
    fn open(bytes: &[u8]) -> Option<Package> {
        let Some(zip) = Zip::open(bytes) else {
            let file = parse_model(&String::from_utf8_lossy(bytes));
            if file.objects.is_empty() {
                return None;
            }
            return Some(Package {
                files: vec![file],
                index: HashMap::new(),
                config: Config::default(),
            });
        };
        let root_key = root_part(&zip)?;
        let root = parse_model(&zip.text(&root_key)?);
        let mut queue: VecDeque<String> = referenced_paths(&root).into();
        let mut index = HashMap::from([(root_key, 0)]);
        let mut files = vec![root];
        while let Some(key) = queue.pop_front() {
            if index.contains_key(&key) || files.len() >= MAX_MODEL_FILES {
                continue;
            }
            let Some(text) = zip.text(&key) else {
                continue;
            };
            let file = parse_model(&text);
            drop(text);
            queue.extend(referenced_paths(&file));
            index.insert(key, files.len());
            files.push(file);
        }
        let config = read_config(&zip);
        Some(Package {
            files,
            index,
            config,
        })
    }

    fn file_of(&self, path: Option<&str>, fallback: usize) -> Option<usize> {
        match path {
            Some(path) => self.index.get(&part_key(path)).copied(),
            None => Some(fallback),
        }
    }

    fn instances(&self) -> (Vec<Instance<'_>>, usize) {
        let root = &self.files[0];
        let items: Vec<Item> = if root.build.is_empty() {
            let referenced: HashSet<u32> = root
                .objects
                .values()
                .flat_map(|object| object.components.iter())
                .filter(|item| item.path.is_none())
                .map(|item| item.object)
                .collect();
            let mut ids: Vec<u32> = root
                .objects
                .keys()
                .copied()
                .filter(|id| !referenced.contains(id))
                .collect();
            ids.sort_unstable();
            ids.into_iter()
                .map(|object| Item {
                    path: None,
                    object,
                    transform: IDENTITY,
                })
                .collect()
        } else {
            let plate = self.config.plate.as_ref();
            let chosen: Vec<Item> = root
                .build
                .iter()
                .filter(|item| plate.is_none_or(|members| members.contains(&item.object)))
                .cloned()
                .collect();
            if chosen.is_empty() {
                root.build.clone()
            } else {
                chosen
            }
        };
        let mut out = Vec::new();
        for item in &items {
            let Some(file) = self.file_of(item.path.as_deref(), 0) else {
                continue;
            };
            let config = self.config.objects.get(&item.object);
            let extruder = config.map_or(0, |c| c.extruder);
            self.visit(file, item.object, item.transform, extruder, config, 0, &mut out);
        }
        (out, items.len())
    }

    #[allow(clippy::too_many_arguments)]
    fn visit<'a>(
        &'a self,
        file: usize,
        id: u32,
        matrix: Mat,
        extruder: u32,
        config: Option<&'a ConfigObject>,
        depth: usize,
        out: &mut Vec<Instance<'a>>,
    ) {
        if depth > MAX_DEPTH || out.len() >= MAX_INSTANCES {
            return;
        }
        let Some(object) = self.files[file].objects.get(&id) else {
            return;
        };
        if object.other {
            return;
        }
        if let Some(mesh) = &object.mesh {
            let volumes = match (depth, config) {
                (0, Some(config)) => &config.volumes[..],
                _ => &[],
            };
            out.push(Instance {
                file,
                mesh,
                matrix,
                extruder,
                volumes,
            });
        }
        for component in &object.components {
            let mut part_extruder = extruder;
            if depth == 0 {
                if let Some(part) = config.and_then(|c| c.parts.get(&component.object)) {
                    if !part.printable {
                        continue;
                    }
                    if part.extruder > 0 {
                        part_extruder = part.extruder;
                    }
                }
            }
            let Some(target) = self.file_of(component.path.as_deref(), file) else {
                continue;
            };
            let world = compose(&component.transform, &matrix);
            self.visit(target, component.object, world, part_extruder, None, depth + 1, out);
        }
    }

    fn extruder_shade(&self, extruder: u32) -> Option<([u8; 3], (u32, u32))> {
        let extruder = extruder.max(1);
        let key = (0, extruder);
        match self.config.filaments.get(extruder as usize - 1) {
            Some(filament) => Some((filament.color, key)),
            None if extruder == 1 => None,
            None => Some((PALETTE[(extruder as usize - 2) % PALETTE.len()], key)),
        }
    }

    fn shade_label(&self, key: (u32, u32)) -> String {
        match key {
            (0, extruder) => match self.config.filaments.get(extruder as usize - 1) {
                Some(filament) if !filament.kind.is_empty() => {
                    format!("Filament {extruder} · {}", filament.kind)
                }
                Some(_) => format!("Filament {extruder}"),
                None => format!("Extruder {extruder}"),
            },
            (file, swatch) => self.files[file as usize - 1].swatches[swatch as usize - 1]
                .label
                .clone(),
        }
    }
}

struct Nibbles<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Nibbles<'_> {
    fn next(&mut self) -> Option<u8> {
        while self.pos > 0 {
            self.pos -= 1;
            if let Some(digit) = (self.bytes[self.pos] as char).to_digit(16) {
                return Some(digit as u8);
            }
        }
        None
    }
}

fn midpoint(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5]
}

/// Decodes one node of the PrusaSlicer/Bambu TriangleSelector bitstream, which is a
/// hex string read back to front with children stored last-to-first.
fn paint_node(
    reader: &mut Nibbles,
    tri: Corners,
    depth: usize,
    out: &mut Vec<(Corners, u32)>,
) -> Option<()> {
    let code = reader.next()?;
    let sides = code & 3;
    if sides == 0 {
        let mut state = (code >> 2) as u32;
        if state == 3 {
            let next = reader.next()?;
            state = if next == 15 {
                reader.next()? as u32 + 18
            } else {
                next as u32 + 3
            };
        }
        out.push((tri, state));
        return Some(());
    }
    let special = ((code >> 2) & 3) as usize;
    if depth >= MAX_PAINT_DEPTH || special > 2 {
        return None;
    }
    let (v0, v1, v2) = (tri[special], tri[(special + 1) % 3], tri[(special + 2) % 3]);
    let mut children = [[[0.0; 3]; 3]; 4];
    let count = match sides {
        1 => {
            let m = midpoint(v1, v2);
            children[0] = [v0, v1, m];
            children[1] = [m, v2, v0];
            2
        }
        2 => {
            let a = midpoint(v0, v1);
            let b = midpoint(v2, v0);
            children[0] = [v0, a, b];
            children[1] = [a, v1, b];
            children[2] = [v1, v2, b];
            3
        }
        _ => {
            let a = midpoint(v0, v1);
            let b = midpoint(v1, v2);
            let c = midpoint(v2, v0);
            children[0] = [v0, a, c];
            children[1] = [a, v1, b];
            children[2] = [b, v2, c];
            children[3] = [a, b, c];
            4
        }
    };
    for child in children[..count].iter().rev() {
        paint_node(reader, *child, depth + 1, out)?;
    }
    Some(())
}

fn decode_paint(code: &str, tri: Corners) -> Vec<(Corners, u32)> {
    let mut reader = Nibbles {
        bytes: code.as_bytes(),
        pos: code.len(),
    };
    let mut out = Vec::new();
    if paint_node(&mut reader, tri, 0, &mut out).is_none() || out.is_empty() {
        return vec![(tri, 0)];
    }
    out
}

#[derive(Serialize)]
pub struct Material {
    name: String,
    color: String,
    share: f64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    title: Option<String>,
    designer: Option<String>,
    application: Option<String>,
    unit: String,
    objects: usize,
    parts: usize,
    plates: usize,
    triangles: usize,
    sampled: bool,
    painted: usize,
    extent: Option<[f64; 3]>,
    materials: Vec<Material>,
}

pub struct Scene {
    pub facets: Vec<Facet>,
    pub info: Info,
}

fn finite(corners: &Corners) -> bool {
    corners.iter().all(|p| p.iter().all(|v| v.is_finite()))
}

fn area(c: &Corners) -> f64 {
    let u = [c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]];
    let v = [c[2][0] - c[0][0], c[2][1] - c[0][1], c[2][2] - c[0][2]];
    let x = u[1] * v[2] - u[2] * v[1];
    let y = u[2] * v[0] - u[0] * v[2];
    let z = u[0] * v[1] - u[1] * v[0];
    0.5 * (x * x + y * y + z * z).sqrt()
}

type Shade = ([u8; 3], (u32, u32));

#[derive(Default)]
struct FastHasher(u64);

impl std::hash::Hasher for FastHasher {
    fn finish(&self) -> u64 {
        let mut x = self.0;
        x ^= x >> 33;
        x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
        x ^ (x >> 33)
    }

    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.write_u64(u64::from(byte));
        }
    }

    fn write_u64(&mut self, value: u64) {
        self.0 = (self.0.rotate_left(5) ^ value).wrapping_mul(0x517c_c1b7_2722_0a95);
    }

    fn write_usize(&mut self, value: usize) {
        self.write_u64(value as u64);
    }
}

type FastBuild = std::hash::BuildHasherDefault<FastHasher>;

#[derive(Default)]
struct Tally {
    usage: HashMap<(u32, u32), ([u8; 3], f64)>,
    total: f64,
}

impl Tally {
    fn add(&mut self, corners: &Corners, shade: Option<Shade>) {
        let size = area(corners);
        self.total += size;
        if let Some((color, key)) = shade {
            self.usage.entry(key).or_insert((color, 0.0)).1 += size;
        }
    }
}

/// Streams every printable triangle (painted regions split into their leaves) in world
/// space; the sink returns false to stop early, which makes this return false.
fn emit(
    package: &Package,
    instances: &[Instance],
    mut sink: impl FnMut(Corners, Option<Shade>) -> bool,
) -> bool {
    for instance in instances {
        let mesh = instance.mesh;
        let swatches = &package.files[instance.file].swatches;
        for (index, tri) in mesh.tris.iter().enumerate() {
            let Some(extruder) = instance.extruder_for(index) else {
                continue;
            };
            let corners = tri.v.map(|v| apply(&instance.matrix, mesh.verts[v as usize]));
            if !finite(&corners) {
                continue;
            }
            let base = if tri.swatch > 0 {
                let swatch = &swatches[tri.swatch as usize - 1];
                Some((swatch.color, (instance.file as u32 + 1, tri.swatch)))
            } else {
                package.extruder_shade(extruder)
            };
            if tri.paint > 0 {
                for (leaf, state) in decode_paint(&mesh.paint[tri.paint as usize - 1], corners) {
                    let shade = if state == 0 {
                        base
                    } else {
                        package.extruder_shade(state)
                    };
                    if !sink(leaf, shade) {
                        return false;
                    }
                }
            } else if !sink(corners, base) {
                return false;
            }
        }
    }
    true
}

fn world_box(instances: &[Instance]) -> Option<([f64; 3], [f64; 3])> {
    let mut low = [f64::MAX; 3];
    let mut high = [f64::MIN; 3];
    let mut seen = false;
    for instance in instances {
        for (index, tri) in instance.mesh.tris.iter().enumerate() {
            if instance.extruder_for(index).is_none() {
                continue;
            }
            for vertex in tri.v {
                let point = apply(&instance.matrix, instance.mesh.verts[vertex as usize]);
                if !point.iter().all(|v| v.is_finite()) {
                    continue;
                }
                seen = true;
                for axis in 0..3 {
                    low[axis] = low[axis].min(point[axis]);
                    high[axis] = high[axis].max(point[axis]);
                }
            }
        }
    }
    seen.then_some((low, high))
}

fn to_facet(points: [[f64; 3]; 3], shade: Option<Shade>) -> Facet {
    Facet {
        points: points.map(|p| p.map(|v| v as f32)),
        color: shade.map(|(color, _)| color),
    }
}

const CELL_MASK: u64 = 0x1f_ffff;

fn deposit(
    cells: &mut HashMap<u64, ([f64; 3], u32), FastBuild>,
    (key, sum, count): (u64, [f64; 3], u32),
) {
    let slot = cells.entry(key).or_insert(([0.0; 3], 0));
    for axis in 0..3 {
        slot.0[axis] += sum[axis];
    }
    slot.1 += count;
}

/// Vertices referenced by printable triangles, or None when every triangle is printable.
fn used_vertices(instance: &Instance) -> Option<Vec<bool>> {
    if instance.volumes.is_empty() {
        return None;
    }
    let mut used = vec![false; instance.mesh.verts.len()];
    for (index, tri) in instance.mesh.tris.iter().enumerate() {
        if instance.extruder_for(index).is_some() {
            for vertex in tri.v {
                used[vertex as usize] = true;
            }
        }
    }
    Some(used)
}

/// Vertex-clustering simplification: corners snap to the averaged position of their grid
/// cell, collapsed and duplicate triangles drop out, and the grid coarsens until the result
/// fits. Unlike skipping triangles, this keeps surfaces closed.
fn simplify(
    package: &Package,
    instances: &[Instance],
    (low, high): ([f64; 3], [f64; 3]),
    budget: usize,
    cap: usize,
) -> (Vec<Facet>, Tally) {
    let span = (0..3)
        .map(|axis| high[axis] - low[axis])
        .fold(0.0f64, f64::max)
        .max(1e-9);
    let target = (budget / 2).max(1);
    let total_points: usize = instances.iter().map(|i| i.mesh.verts.len()).sum();
    let used: Vec<Option<Vec<bool>>> = instances.iter().map(used_vertices).collect();
    let mut resolution = (target as f64).sqrt().clamp(4.0, 1_000_000.0);
    let mut grown = false;
    loop {
        let cell = span / resolution;
        let key = |p: &[f64; 3]| -> u64 {
            let q = |axis: usize| (((p[axis] - low[axis]) / cell).max(0.0) as u64).min(CELL_MASK);
            q(0) | q(1) << 21 | q(2) << 42
        };

        let mut cells: HashMap<u64, ([f64; 3], u32), FastBuild> =
            HashMap::with_capacity_and_hasher(target + 1, FastBuild::default());
        let mut seen = 0usize;
        let mut fits = true;
        let mut run: Option<(u64, [f64; 3], u32)> = None;
        'scan: for (instance, used) in instances.iter().zip(&used) {
            for (index, vertex) in instance.mesh.verts.iter().enumerate() {
                if used.as_ref().is_some_and(|used| !used[index]) {
                    continue;
                }
                let point = apply(&instance.matrix, *vertex);
                if !point.iter().all(|v| v.is_finite()) {
                    continue;
                }
                seen += 1;
                let k = key(&point);
                match &mut run {
                    Some((current, sum, count)) if *current == k => {
                        for axis in 0..3 {
                            sum[axis] += point[axis];
                        }
                        *count += 1;
                    }
                    _ => {
                        if let Some(done) = run.replace((k, point, 1)) {
                            deposit(&mut cells, done);
                            if cells.len() > target {
                                fits = false;
                                break 'scan;
                            }
                        }
                    }
                }
            }
        }
        if let Some(done) = run.take() {
            deposit(&mut cells, done);
        }
        if !fits && resolution > 2.0 {
            let projected = cells.len() as f64 * (total_points.max(seen) as f64 / seen.max(1) as f64);
            resolution = (resolution * ((target as f64 / projected).sqrt() * 0.95).min(0.9)).max(2.0);
            grown = true;
            continue;
        }
        if !grown && cells.len() * 3 < target {
            grown = true;
            resolution *= ((target as f64 / cells.len().max(1) as f64).sqrt() * 0.9).min(8.0);
            continue;
        }
        grown = true;
        for (sum, count) in cells.values_mut() {
            *sum = sum.map(|v| v / f64::from(*count));
        }
        let at = |k: u64| -> [f64; 3] {
            match cells.get(&k) {
                Some(slot) => slot.0,
                None => {
                    let q = [k & CELL_MASK, (k >> 21) & CELL_MASK, k >> 42];
                    [0, 1, 2].map(|axis| low[axis] + (q[axis] as f64 + 0.5) * cell)
                }
            }
        };

        let mut tally = Tally::default();
        let mut kept: HashSet<[u64; 3], FastBuild> =
            HashSet::with_capacity_and_hasher(budget, FastBuild::default());
        let mut facets = Vec::with_capacity(budget);
        let fits = emit(package, instances, |corners, shade| {
            tally.add(&corners, shade);
            let keys = corners.map(|p| key(&p));
            if keys[0] == keys[1] || keys[1] == keys[2] || keys[0] == keys[2] {
                return true;
            }
            let mut sorted = keys;
            sorted.sort_unstable();
            if kept.insert(sorted) {
                facets.push(to_facet(keys.map(at), shade));
            }
            facets.len() < cap
        });
        if fits || resolution <= 2.0 {
            return (facets, tally);
        }
        resolution = (resolution * 0.75).max(2.0);
    }
}

/// Loads every printable instance of the first plate, colored by spec materials, slicer
/// extruder assignments and painted multi-material regions, within a facet budget.
pub fn load(bytes: &[u8], budget: usize) -> Option<Scene> {
    let package = Package::open(bytes)?;
    let (instances, objects) = package.instances();

    let mut weight = 0usize;
    let mut triangles = 0usize;
    let mut painted = 0usize;
    for instance in &instances {
        for (index, tri) in instance.mesh.tris.iter().enumerate() {
            if instance.extruder_for(index).is_none() {
                continue;
            }
            triangles += 1;
            if tri.paint > 0 {
                painted += 1;
                weight += instance.mesh.paint[tri.paint as usize - 1].len().max(1);
            } else {
                weight += 1;
            }
        }
    }
    let world = world_box(&instances)?;

    let budget = budget.max(1);
    let cap = budget + budget / 2;
    let mut exact = None;
    if weight <= budget {
        let mut tally = Tally::default();
        let mut facets = Vec::with_capacity(weight);
        let complete = emit(&package, &instances, |corners, shade| {
            tally.add(&corners, shade);
            facets.push(to_facet(corners, shade));
            facets.len() < cap
        });
        if complete {
            exact = Some((facets, tally));
        }
    }
    let sampled = exact.is_none();
    let (facets, tally) =
        exact.unwrap_or_else(|| simplify(&package, &instances, world, budget, cap));
    if facets.is_empty() {
        return None;
    }

    let mut materials: Vec<((u32, u32), [u8; 3], f64)> = tally
        .usage
        .into_iter()
        .map(|(key, (color, size))| (key, color, size))
        .collect();
    materials.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.0.cmp(&b.0)));
    let root = &package.files[0];
    let scale = unit_scale(&root.unit);
    let (low, high) = world;
    let meta = |key: &str| root.meta.get(key).cloned();
    let info = Info {
        title: meta("title"),
        designer: meta("designer"),
        application: meta("application"),
        unit: root.unit.clone(),
        objects,
        parts: instances.len(),
        plates: package.config.plates,
        triangles,
        sampled,
        painted,
        extent: Some([0, 1, 2].map(|axis| (high[axis] - low[axis]) * scale)),
        materials: materials
            .into_iter()
            .take(MAX_MATERIALS)
            .map(|(key, color, size)| Material {
                name: package.shade_label(key),
                color: hex_color(color),
                share: if tally.total > 0.0 { size / tally.total } else { 0.0 },
            })
            .collect(),
    };
    Some(Scene { facets, info })
}

/// World-space extents of the printable geometry, in millimeters.
pub fn bounds(bytes: &[u8]) -> Option<MeshBounds> {
    let package = Package::open(bytes)?;
    let (instances, _) = package.instances();
    let (low, high) = world_box(&instances)?;
    let scale = unit_scale(&package.files[0].unit);
    Some(MeshBounds {
        width: (high[0] - low[0]) * scale,
        height: (high[1] - low[1]) * scale,
        depth: (high[2] - low[2]) * scale,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRIANGLE: &str = r#"<mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>"#;

    fn zip(files: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write;
        let mut out = Vec::new();
        let mut directory = Vec::new();
        for (name, text) in files {
            let mut packed = Vec::new();
            {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(&mut packed, flate2::Compression::fast());
                encoder.write_all(text.as_bytes()).unwrap();
            }
            let local = out.len() as u32;
            out.extend_from_slice(b"PK\x03\x04");
            out.extend_from_slice(&[20, 0, 0, 0, 8, 0]);
            out.extend_from_slice(&[0; 8]);
            out.extend_from_slice(&(packed.len() as u32).to_le_bytes());
            out.extend_from_slice(&(text.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&packed);

            directory.extend_from_slice(b"PK\x01\x02");
            directory.extend_from_slice(&[20, 0, 20, 0, 0, 0, 8, 0]);
            directory.extend_from_slice(&[0; 8]);
            directory.extend_from_slice(&(packed.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(text.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(name.len() as u16).to_le_bytes());
            directory.extend_from_slice(&[0; 12]);
            directory.extend_from_slice(&local.to_le_bytes());
            directory.extend_from_slice(name.as_bytes());
        }
        let offset = out.len() as u32;
        out.extend_from_slice(&directory);
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(directory.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    #[test]
    fn reads_plain_model_triangles() {
        let xml = format!(r#"<?xml version="1.0"?><model><resources><object id="1">{TRIANGLE}</object></resources></model>"#);
        let scene = load(xml.as_bytes(), 100).unwrap();
        assert_eq!(scene.facets.len(), 1);
        assert_eq!(scene.facets[0].points[2], [0.0, 1.0, 0.0]);
        assert!(scene.facets[0].color.is_none());
        assert_eq!(scene.info.objects, 1);
    }

    #[test]
    fn reads_objects_separately_without_build() {
        let xml = r#"<model>
<object id="1"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/>
</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
<object id="2"><mesh><vertices>
<vertex x="5" y="5" z="5"/><vertex x="6" y="5" z="5"/><vertex x="6" y="6" z="5"/>
</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
</model>"#;
        let scene = load(xml.as_bytes(), 100).unwrap();
        assert_eq!(scene.facets.len(), 2);
        assert_eq!(scene.facets[1].points[0], [5.0, 5.0, 5.0]);
    }

    #[test]
    fn applies_build_and_component_transforms_across_parts() {
        let root = r#"<?xml version="1.0"?>
<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
<metadata name="Title">Bracket &amp; Arm</metadata>
<resources><object id="9" type="model"><components>
<component p:path="/3D/Objects/object_1.model" objectid="1" transform="2 0 0 0 2 0 0 0 2 0 0 0"/>
</components></object></resources>
<build><item objectid="9" transform="1 0 0 0 1 0 0 0 1 10 20 30"/></build></model>"#;
        let part = format!(r#"<model><resources><object id="1">{TRIANGLE}</object></resources></model>"#);
        let rels = r#"<Relationships><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>"#;
        let archive = zip(&[
            ("_rels/.rels", rels),
            ("3D/3dmodel.model", root),
            ("3D/Objects/object_1.model", &part),
        ]);
        let scene = load(&archive, 100).unwrap();
        assert_eq!(scene.facets.len(), 1);
        assert_eq!(scene.facets[0].points[1], [12.0, 20.0, 30.0]);
        assert_eq!(scene.info.title.as_deref(), Some("Bracket & Arm"));
        let extents = bounds(&archive).unwrap();
        assert_eq!((extents.width, extents.height), (2.0, 2.0));
    }

    #[test]
    fn colors_triangles_from_materials() {
        let xml = r##"<model xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"><resources>
<basematerials id="1"><base name="Red PLA" displaycolor="#FF0000FF"/><base name="Blue" displaycolor="#0000FF"/></basematerials>
<m:colorgroup id="2"><m:color color="#00FF00"/></m:colorgroup>
<object id="3" pid="1" pindex="1"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
</vertices><triangles>
<triangle v1="0" v2="1" v3="2"/>
<triangle v1="0" v2="1" v3="2" pid="1" p1="0"/>
<triangle v1="0" v2="1" v3="2" pid="2" p1="0"/>
<triangle v1="0" v2="1" v3="2" pid="1" p1="0" p2="1" p3="1"/>
</triangles></mesh></object></resources></model>"##;
        let scene = load(xml.as_bytes(), 100).unwrap();
        let colors: Vec<_> = scene.facets.iter().map(|f| f.color.unwrap()).collect();
        assert_eq!(
            colors,
            vec![[0, 0, 255], [255, 0, 0], [0, 255, 0], [85, 0, 170]]
        );
        assert!(scene.info.materials.iter().any(|m| m.name == "Red PLA"));
    }

    #[test]
    fn decodes_painted_segmentation() {
        let tri = [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0]];
        let single = decode_paint("4", tri);
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].1, 1);

        let split = decode_paint("481", tri);
        assert_eq!(split.len(), 2);
        assert_eq!(split[0].1, 2);
        assert_eq!(split[1].1, 1);
        assert_eq!(split[1].0, [tri[0], tri[1], [1.0, 1.0, 0.0]]);

        assert_eq!(decode_paint("2C", tri)[0].1, 5);
        assert_eq!(decode_paint("zz", tri), vec![(tri, 0)]);
    }

    #[test]
    fn colors_bambu_parts_and_paint_from_filaments() {
        let root = r#"<model xmlns:p="p"><resources><object id="5"><components>
<component p:path="/3D/Objects/object_1.model" objectid="1"/>
<component p:path="/3D/Objects/object_1.model" objectid="2"/>
<component p:path="/3D/Objects/object_1.model" objectid="3"/>
</components></object></resources><build><item objectid="5"/></build></model>"#;
        let part = r#"<model><resources>
<object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
<triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
<object id="2"><mesh><vertices><vertex x="0" y="0" z="1"/><vertex x="1" y="0" z="1"/><vertex x="0" y="1" z="1"/></vertices>
<triangles><triangle v1="0" v2="1" v3="2" paint_color="481"/></triangles></mesh></object>
<object id="3"><mesh><vertices><vertex x="0" y="0" z="2"/><vertex x="1" y="0" z="2"/><vertex x="0" y="1" z="2"/></vertices>
<triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
</resources></model>"#;
        let settings = r#"<config><object id="5"><metadata key="extruder" value="1"/>
<part id="1" subtype="normal_part"><metadata key="extruder" value="2"/></part>
<part id="2" subtype="normal_part"><metadata key="extruder" value="1"/></part>
<part id="3" subtype="modifier_part"><metadata key="extruder" value="2"/></part>
</object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="5"/></model_instance></plate></config>"#;
        let project = r##"{"filament_colour":["#FF10E1FF","#FFE302"],"filament_type":["PLA","PETG"]}"##;
        let archive = zip(&[
            ("3D/3dmodel.model", root),
            ("3D/Objects/object_1.model", part),
            ("Metadata/model_settings.config", settings),
            ("Metadata/project_settings.config", project),
        ]);
        let scene = load(&archive, 100).unwrap();
        let colors: Vec<_> = scene.facets.iter().map(|f| f.color.unwrap()).collect();
        assert_eq!(colors, vec![[255, 227, 2], [255, 227, 2], [255, 16, 225]]);
        assert_eq!(scene.info.painted, 1);
        assert_eq!(scene.info.parts, 2);
        assert_eq!(scene.info.plates, 1);
        assert!(scene.info.materials.iter().any(|m| m.name == "Filament 2 · PETG"));
    }

    #[test]
    fn skips_prusa_modifier_volumes() {
        let root = r#"<model unit="centimeter"><resources><object id="1" type="model"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="9" y="9" z="9"/>
</vertices><triangles>
<triangle v1="0" v2="1" v3="2"/>
<triangle v1="0" v2="1" v3="3"/>
</triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#;
        let config = r#"<config><object id="1" instances_count="1">
<volume firstid="0" lastid="0"><metadata type="volume" key="volume_type" value="ModelPart"/><metadata type="volume" key="extruder" value="2"/></volume>
<volume firstid="1" lastid="1"><metadata type="volume" key="volume_type" value="ParameterModifier"/></volume>
</object></config>"#;
        let settings = "; extruder_colour = \"\";\"#00FF00\"\n; filament_colour = #FF8000;#0000FF\n";
        let archive = zip(&[
            ("3D/3dmodel.model", root),
            ("Metadata/Slic3r_PE_model.config", config),
            ("Metadata/Slic3r_PE.config", settings),
        ]);
        let scene = load(&archive, 100).unwrap();
        assert_eq!(scene.facets.len(), 1);
        assert_eq!(scene.facets[0].color, Some([0, 255, 0]));
        let extents = bounds(&archive).unwrap();
        assert_eq!((extents.width, extents.height, extents.depth), (10.0, 10.0, 0.0));
    }

    #[test]
    fn simplifies_large_scenes_within_budget() {
        let n = 60;
        let mut xml = String::from(r#"<model><object id="1"><mesh><vertices>"#);
        for y in 0..=n {
            for x in 0..=n {
                xml.push_str(&format!(r#"<vertex x="{x}" y="{y}" z="0"/>"#));
            }
        }
        xml.push_str("</vertices><triangles>");
        for y in 0..n {
            for x in 0..n {
                let a = y * (n + 1) + x;
                let (b, c, d) = (a + 1, a + n + 1, a + n + 2);
                xml.push_str(&format!(r#"<triangle v1="{a}" v2="{b}" v3="{d}"/><triangle v1="{a}" v2="{d}" v3="{c}"/>"#));
            }
        }
        xml.push_str("</triangles></mesh></object></model>");
        let scene = load(xml.as_bytes(), 1000).unwrap();
        assert!(scene.info.sampled);
        assert_eq!(scene.info.triangles, 2 * n * n);
        assert!(!scene.facets.is_empty() && scene.facets.len() <= 1500);
        let covered: f64 = scene
            .facets
            .iter()
            .map(|f| area(&f.points.map(|p| p.map(f64::from))))
            .sum();
        assert!(covered > 0.8 * (n * n) as f64, "covered {covered}");
        assert_eq!(scene.info.extent, Some([n as f64, n as f64, 0.0]));
    }
}
