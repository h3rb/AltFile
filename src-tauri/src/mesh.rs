use crate::paths;
use serde::Serialize;
use std::fs;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshBounds {
    pub width: f64,
    pub height: f64,
    pub depth: f64,
}

const MAX_MESH_BYTES: u64 = 96 * 1024 * 1024;
const MAX_VERTICES: usize = 4_000_000;

#[derive(Default)]
struct Bounds {
    min: [f64; 3],
    max: [f64; 3],
    seen: bool,
}

impl Bounds {
    fn add(&mut self, point: [f64; 3]) {
        if !point.iter().all(|v| v.is_finite()) {
            return;
        }
        if !self.seen {
            self.min = point;
            self.max = point;
            self.seen = true;
            return;
        }
        for axis in 0..3 {
            self.min[axis] = self.min[axis].min(point[axis]);
            self.max[axis] = self.max[axis].max(point[axis]);
        }
    }

    fn finish(&self) -> Option<MeshBounds> {
        if !self.seen {
            return None;
        }
        Some(MeshBounds {
            width: self.max[0] - self.min[0],
            height: self.max[1] - self.min[1],
            depth: self.max[2] - self.min[2],
        })
    }
}

fn triplet(values: &[serde_json::Value]) -> Option<[f64; 3]> {
    let read = |i: usize| values.get(i).and_then(serde_json::Value::as_f64);
    Some([read(0)?, read(1)?, read(2)?])
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len())
        .position(|window| window == needle)
}

fn numbers(line: &str) -> Option<[f64; 3]> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 3 {
        return None;
    }
    Some([
        parts[0].parse::<f64>().ok()?,
        parts[1].parse::<f64>().ok()?,
        parts[2].parse::<f64>().ok()?,
    ])
}

fn from_obj(text: &str) -> Option<MeshBounds> {
    let mut bounds = Bounds::default();
    for line in text.lines() {
        let line = line.trim_start();
        let Some(rest) = line.strip_prefix('v') else {
            continue;
        };
        if !rest.starts_with(' ') && !rest.starts_with('\t') {
            continue;
        }
        if let Some(point) = numbers(rest) {
            bounds.add(point);
        }
    }
    bounds.finish()
}

fn from_off(text: &str) -> Option<MeshBounds> {
    let mut tokens = text.split_whitespace().peekable();
    if matches!(tokens.peek(), Some(&"OFF") | Some(&"COFF") | Some(&"NOFF")) {
        tokens.next();
    }
    let count = tokens.next()?.parse::<usize>().ok()?;
    tokens.next()?;
    tokens.next()?;
    let mut bounds = Bounds::default();
    for _ in 0..count.min(MAX_VERTICES) {
        let x = tokens.next()?.parse::<f64>().ok()?;
        let y = tokens.next()?.parse::<f64>().ok()?;
        let z = tokens.next()?.parse::<f64>().ok()?;
        bounds.add([x, y, z]);
    }
    bounds.finish()
}

fn from_stl(text: &str) -> Option<MeshBounds> {
    let mut bounds = Bounds::default();
    for line in text.lines() {
        let line = line.trim_start();
        if !line.starts_with("vertex") {
            continue;
        }
        if let Some(point) = numbers(&line[6..]) {
            bounds.add(point);
        }
    }
    bounds.finish()
}

fn from_stl_binary(bytes: &[u8]) -> Option<MeshBounds> {
    if bytes.len() < 84 {
        return None;
    }
    let triangles = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
    let mut bounds = Bounds::default();
    let mut offset = 84usize;
    for _ in 0..triangles {
        if offset + 50 > bytes.len() {
            break;
        }
        for corner in 0..3 {
            let start = offset + 12 + corner * 12;
            let point = [
                f32::from_le_bytes(bytes[start..start + 4].try_into().unwrap()) as f64,
                f32::from_le_bytes(bytes[start + 4..start + 8].try_into().unwrap()) as f64,
                f32::from_le_bytes(bytes[start + 8..start + 12].try_into().unwrap()) as f64,
            ];
            bounds.add(point);
        }
        offset += 50;
    }
    bounds.finish()
}

fn ply_type_size(ty: &str) -> Option<usize> {
    match ty {
        "char" | "int8" | "uchar" | "uint8" => Some(1),
        "short" | "int16" | "ushort" | "uint16" => Some(2),
        "int" | "int32" | "uint" | "uint32" | "float" | "float32" => Some(4),
        "double" | "float64" => Some(8),
        _ => None,
    }
}

fn read_scalar(bytes: &[u8], offset: usize, ty: &str, big_endian: bool) -> Option<f64> {
    let size = ply_type_size(ty)?;
    let src = bytes.get(offset..offset + size)?;
    let mut buf = [0u8; 8];
    buf[..size].copy_from_slice(src);
    if big_endian {
        buf[..size].reverse();
    }
    let value = match ty {
        "char" | "int8" => i8::from_le_bytes([buf[0]]) as f64,
        "uchar" | "uint8" => buf[0] as f64,
        "short" | "int16" => i16::from_le_bytes(buf[..2].try_into().unwrap()) as f64,
        "ushort" | "uint16" => u16::from_le_bytes(buf[..2].try_into().unwrap()) as f64,
        "int" | "int32" => i32::from_le_bytes(buf[..4].try_into().unwrap()) as f64,
        "uint" | "uint32" => u32::from_le_bytes(buf[..4].try_into().unwrap()) as f64,
        "float" | "float32" => f32::from_le_bytes(buf[..4].try_into().unwrap()) as f64,
        "double" | "float64" => f64::from_le_bytes(buf),
        _ => return None,
    };
    Some(value)
}

#[derive(Clone, Copy, PartialEq)]
enum PlyFormat {
    Ascii,
    Little,
    Big,
}

struct PlyField {
    name: String,
    ty: String,
    list_count: Option<String>,
}

struct PlyElement {
    name: String,
    count: usize,
    fields: Vec<PlyField>,
}

struct PlyHeader {
    format: PlyFormat,
    elements: Vec<PlyElement>,
    body: usize,
}

enum PlyCell {
    Scalar,
    Indices(Vec<u32>),
}

fn ply_header(bytes: &[u8]) -> Option<PlyHeader> {
    if !bytes.starts_with(b"ply") {
        return None;
    }
    let marker = find_subslice(bytes, b"end_header")?;
    let mut body = marker + "end_header".len();
    while body < bytes.len() && bytes[body] != b'\n' {
        body += 1;
    }
    if body >= bytes.len() {
        return None;
    }
    body += 1;
    let text = std::str::from_utf8(&bytes[..body]).ok()?;

    let mut format = None;
    let mut elements: Vec<PlyElement> = Vec::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        match fields.next() {
            Some("format") => {
                format = match fields.next() {
                    Some("ascii") => Some(PlyFormat::Ascii),
                    Some("binary_little_endian") => Some(PlyFormat::Little),
                    Some("binary_big_endian") => Some(PlyFormat::Big),
                    _ => return None,
                };
            }
            Some("element") => {
                let name = fields.next()?.to_owned();
                let count = fields.next()?.parse::<usize>().ok()?;
                elements.push(PlyElement {
                    name,
                    count,
                    fields: Vec::new(),
                });
            }
            Some("property") => {
                let ty = fields.next()?;
                let field = if ty == "list" {
                    let count_ty = fields.next()?;
                    let value_ty = fields.next()?;
                    let name = fields.next()?;
                    PlyField {
                        name: name.to_owned(),
                        ty: value_ty.to_owned(),
                        list_count: Some(count_ty.to_owned()),
                    }
                } else {
                    let name = fields.next()?;
                    PlyField {
                        name: name.to_owned(),
                        ty: ty.to_owned(),
                        list_count: None,
                    }
                };
                elements.last_mut()?.fields.push(field);
            }
            _ => {}
        }
    }

    Some(PlyHeader {
        format: format?,
        elements,
        body,
    })
}

fn ply_record_size(fields: &[PlyField]) -> Option<usize> {
    if fields.iter().any(|field| field.list_count.is_some()) {
        return None;
    }
    fields.iter().map(|field| ply_type_size(&field.ty)).sum()
}

fn ply_word_offsets(fields: &[PlyField]) -> Option<Vec<(usize, String)>> {
    let mut out = Vec::with_capacity(3);
    for axis in ["x", "y", "z"] {
        let index = fields
            .iter()
            .position(|field| field.list_count.is_none() && field.name == axis)?;
        let offset = ply_record_size(&fields[..index])?;
        out.push((offset, fields[index].ty.clone()));
    }
    Some(out)
}

fn ply_row_binary(
    bytes: &[u8],
    start: usize,
    fields: &[PlyField],
    big_endian: bool,
) -> Option<(Vec<PlyCell>, usize)> {
    let mut cursor = start;
    let mut row = Vec::with_capacity(fields.len());
    for field in fields {
        match &field.list_count {
            Some(count_ty) => {
                let count = read_scalar(bytes, cursor, count_ty, big_endian)? as usize;
                cursor += ply_type_size(count_ty)?;
                let value_size = ply_type_size(&field.ty)?;
                if count > 65_536 {
                    return None;
                }
                let mut indices = Vec::with_capacity(count.min(1024));
                for _ in 0..count {
                    indices.push(read_scalar(bytes, cursor, &field.ty, big_endian)? as u32);
                    cursor += value_size;
                }
                row.push(PlyCell::Indices(indices));
            }
            None => {
                read_scalar(bytes, cursor, &field.ty, big_endian)?;
                cursor += ply_type_size(&field.ty)?;
                row.push(PlyCell::Scalar);
            }
        }
    }
    Some((row, cursor))
}

fn from_ply(bytes: &[u8]) -> Option<MeshBounds> {
    let header = ply_header(bytes)?;
    let index = header
        .elements
        .iter()
        .position(|element| element.name == "vertex")?;
    let element = &header.elements[index];
    let count = element.count;
    let big_endian = header.format == PlyFormat::Big;
    let mut bounds = Bounds::default();

    if header.format == PlyFormat::Ascii {
        let skip = header.elements[..index]
            .iter()
            .map(|element| element.count)
            .sum::<usize>();
        let positions: Vec<usize> = ["x", "y", "z"]
            .iter()
            .map(|axis| {
                element
                    .fields
                    .iter()
                    .position(|field| field.list_count.is_none() && field.name == *axis)
            })
            .collect::<Option<Vec<usize>>>()?;
        let body = String::from_utf8_lossy(&bytes[header.body..]);
        let mut lines = body.lines().skip(skip);
        for _ in 0..count.min(MAX_VERTICES) {
            let line = lines.next()?;
            let fields: Vec<&str> = line.split_whitespace().collect();
            let point = positions
                .iter()
                .map(|&axis| fields.get(axis).and_then(|v| v.parse::<f64>().ok()))
                .collect::<Option<Vec<f64>>>()?;
            bounds.add([point[0], point[1], point[2]]);
        }
        return bounds.finish();
    }

    let record_size = ply_record_size(&element.fields)?;
    let axis_props = ply_word_offsets(&element.fields)?;

    let mut cursor = header.body;
    for prior in &header.elements[..index] {
        cursor += prior.count * ply_record_size(&prior.fields)?;
    }
    let available = (bytes.len().saturating_sub(cursor)) / record_size;
    for row in 0..count.min(MAX_VERTICES).min(available) {
        let base = cursor + row * record_size;
        let mut coords = Vec::with_capacity(3);
        for (byte_offset, ty) in &axis_props {
            let Some(value) = read_scalar(bytes, base + byte_offset, ty, big_endian) else {
                return bounds.finish();
            };
            coords.push(value);
        }
        bounds.add([coords[0], coords[1], coords[2]]);
    }
    bounds.finish()
}

fn from_gltf(json: &serde_json::Value) -> Option<MeshBounds> {
    let accessors = json.get("accessors")?.as_array()?;
    let meshes = json.get("meshes")?.as_array()?;
    let mut bounds = Bounds::default();
    let mut found = false;
    for mesh in meshes {
        let Some(primitives) = mesh.get("primitives").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for primitive in primitives {
            let Some(index) = primitive
                .get("attributes")
                .and_then(|attributes| attributes.get("POSITION"))
                .and_then(serde_json::Value::as_u64)
            else {
                continue;
            };
            let Some(accessor) = accessors.get(index as usize) else {
                continue;
            };
            let low = accessor.get("min").and_then(serde_json::Value::as_array);
            let high = accessor.get("max").and_then(serde_json::Value::as_array);
            if let (Some(low), Some(high)) = (low, high) {
                if let (Some(low), Some(high)) = (triplet(low), triplet(high)) {
                    bounds.add(low);
                    bounds.add(high);
                    found = true;
                }
            }
        }
    }
    if found {
        bounds.finish()
    } else {
        None
    }
}

fn from_glb(bytes: &[u8]) -> Option<MeshBounds> {
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" {
        return None;
    }
    let length = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    if &bytes[16..20] != b"JSON" {
        return None;
    }
    let json = std::str::from_utf8(bytes.get(20..20 + length)?).ok()?;
    from_gltf(&serde_json::from_str(json).ok()?)
}

#[derive(Clone, Copy)]
pub struct Facet {
    pub points: [[f32; 3]; 3],
    pub color: Option<[u8; 3]>,
}

const MAX_FACETS: usize = 250_000;

fn make_facet(points: [[f32; 3]; 3]) -> Option<Facet> {
    points
        .iter()
        .all(|point| point.iter().all(|v| v.is_finite()))
        .then_some(Facet {
            points,
            color: None,
        })
}

fn facet_corners(first: [f32; 3], ids: &[usize], verts: &[[f32; 3]], out: &mut Vec<Facet>) {
    for window in ids.windows(2) {
        let (Some(one), Some(two)) = (verts.get(window[0]), verts.get(window[1])) else {
            return;
        };
        if let Some(facet) = make_facet([first, *one, *two]) {
            out.push(facet);
        }
        if out.len() >= MAX_FACETS {
            return;
        }
    }
}

fn facets_stl(text: &str) -> Vec<Facet> {
    let mut out = Vec::new();
    let mut corners: Vec<[f32; 3]> = Vec::with_capacity(3);
    for line in text.lines() {
        let line = line.trim_start();
        if !line.starts_with("vertex") {
            continue;
        }
        let Some(point) = numbers(&line[6..]) else {
            continue;
        };
        corners.push([point[0] as f32, point[1] as f32, point[2] as f32]);
        if corners.len() == 3 {
            if let Some(facet) = make_facet([corners[0], corners[1], corners[2]]) {
                out.push(facet);
            }
            corners.clear();
            if out.len() >= MAX_FACETS {
                break;
            }
        }
    }
    out
}

fn facets_stl_binary(bytes: &[u8]) -> Vec<Facet> {
    let mut out = Vec::new();
    if bytes.len() < 84 {
        return out;
    }
    let triangles = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
    let mut offset = 84usize;
    for _ in 0..triangles {
        if offset + 50 > bytes.len() || out.len() >= MAX_FACETS {
            break;
        }
        let mut corners = [[0.0f32; 3]; 3];
        for (corner, point) in corners.iter_mut().enumerate() {
            let start = offset + 12 + corner * 12;
            *point = [
                f32::from_le_bytes(bytes[start..start + 4].try_into().unwrap()),
                f32::from_le_bytes(bytes[start + 4..start + 8].try_into().unwrap()),
                f32::from_le_bytes(bytes[start + 8..start + 12].try_into().unwrap()),
            ];
        }
        if let Some(facet) = make_facet(corners) {
            out.push(facet);
        }
        offset += 50;
    }
    out
}

fn obj_corner(token: &str, count: usize) -> Option<usize> {
    let head = token.split('/').next()?;
    let value: i64 = head.parse().ok()?;
    if value > 0 {
        (value as usize).checked_sub(1)
    } else {
        count.checked_sub((-value) as usize)
    }
}

fn facets_obj(text: &str) -> Vec<Facet> {
    let mut verts: Vec<[f32; 3]> = Vec::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_start();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let mut words = line.split_whitespace();
        match words.next() {
            Some("v") => {
                if verts.len() >= MAX_VERTICES {
                    continue;
                }
                let point: Vec<f32> = words
                    .take(3)
                    .filter_map(|word| word.parse::<f32>().ok())
                    .collect();
                if point.len() == 3 {
                    verts.push([point[0], point[1], point[2]]);
                }
            }
            Some("f") => {
                if out.len() >= MAX_FACETS {
                    break;
                }
                let Some(ids) = words
                    .map(|token| obj_corner(token, verts.len()))
                    .collect::<Option<Vec<usize>>>()
                else {
                    continue;
                };
                if ids.len() < 3 || verts.is_empty() {
                    continue;
                }
                let Some(first) = ids.first().and_then(|&id| verts.get(id)) else {
                    continue;
                };
                facet_corners(*first, &ids[1..], &verts, &mut out);
            }
            _ => {}
        }
    }
    out
}

fn facets_ply(bytes: &[u8]) -> Vec<Facet> {
    let empty: Vec<Facet> = Vec::new();
    let header = match ply_header(bytes) {
        Some(header) => header,
        None => return empty,
    };
    let vindex = match header.elements.iter().position(|e| e.name == "vertex") {
        Some(index) => index,
        None => return empty,
    };
    let findex = match header.elements.iter().position(|e| e.name == "face") {
        Some(index) => index,
        None => return empty,
    };
    if findex < vindex {
        return empty;
    }
    let big_endian = header.format == PlyFormat::Big;
    let mut verts: Vec<[f32; 3]> = Vec::new();
    let mut out = Vec::new();

    if header.format == PlyFormat::Ascii {
        let vertex = &header.elements[vindex];
        let positions: Vec<usize> = match ["x", "y", "z"]
            .iter()
            .map(|axis| {
                vertex
                    .fields
                    .iter()
                    .position(|field| field.list_count.is_none() && field.name == *axis)
            })
            .collect::<Option<Vec<usize>>>()
        {
            Some(positions) => positions,
            None => return empty,
        };
        let list_at = header.elements[findex]
            .fields
            .iter()
            .position(|field| field.list_count.is_some());
        let body = String::from_utf8_lossy(&bytes[header.body..]);
        let mut lines = body.lines();
        for (index, element) in header.elements.iter().enumerate() {
            let mode = if index == vindex {
                1
            } else if index == findex {
                2
            } else {
                0
            };
            for _ in 0..element.count {
                let Some(line) = lines.next() else {
                    return out;
                };
                if mode == 0 {
                    continue;
                }
                let fields: Vec<&str> = line.split_whitespace().collect();
                if mode == 1 {
                    let point: Vec<f32> = positions
                        .iter()
                        .filter_map(|&axis| fields.get(axis).and_then(|v| v.parse::<f32>().ok()))
                        .collect();
                    if point.len() == 3 && verts.len() < MAX_VERTICES {
                        verts.push([point[0], point[1], point[2]]);
                    }
                    continue;
                }
                let Some(list_at) = list_at else {
                    continue;
                };
                let Some(count) = fields.get(list_at).and_then(|v| v.parse::<usize>().ok()) else {
                    continue;
                };
                let ids: Vec<usize> = fields[list_at + 1..]
                    .iter()
                    .take(count)
                    .filter_map(|v| v.parse::<usize>().ok())
                    .collect();
                if ids.len() >= 3 && ids.len() == count {
                    if let Some(first) = ids.first().and_then(|&id| verts.get(id)) {
                        facet_corners(*first, &ids[1..], &verts, &mut out);
                    }
                }
                if out.len() >= MAX_FACETS {
                    return out;
                }
            }
        }
        return out;
    }

    let mut cursor = header.body;
    for (index, element) in header.elements.iter().enumerate() {
        let mode = if index == vindex {
            1
        } else if index == findex {
            2
        } else {
            0
        };
        if mode == 0 && index > findex {
            break;
        }
        if let Some(record) = ply_record_size(&element.fields) {
            if mode == 1 {
                let offsets = match ply_word_offsets(&element.fields) {
                    Some(offsets) => offsets,
                    None => return out,
                };
                let available = (bytes.len().saturating_sub(cursor)) / record;
                for row in 0..element.count.min(MAX_VERTICES).min(available) {
                    let base = cursor + row * record;
                    let mut point = [0.0f32; 3];
                    let mut complete = true;
                    for (axis, (offset, ty)) in offsets.iter().enumerate() {
                        match read_scalar(bytes, base + offset, ty, big_endian) {
                            Some(value) => point[axis] = value as f32,
                            None => {
                                complete = false;
                                break;
                            }
                        }
                    }
                    if complete {
                        verts.push(point);
                    }
                }
            }
            cursor += element.count * record;
            continue;
        }
        for _ in 0..element.count {
            let Some((row, next)) = ply_row_binary(bytes, cursor, &element.fields, big_endian)
            else {
                return out;
            };
            cursor = next;
            if mode != 2 {
                continue;
            }
            let ids: Vec<usize> = match row.iter().find_map(|cell| match cell {
                PlyCell::Indices(indices) => Some(indices),
                PlyCell::Scalar => None,
            }) {
                Some(indices) => indices.iter().map(|&id| id as usize).collect(),
                None => continue,
            };
            if ids.len() >= 3 {
                if let Some(first) = ids.first().and_then(|&id| verts.get(id)) {
                    facet_corners(*first, &ids[1..], &verts, &mut out);
                }
            }
            if out.len() >= MAX_FACETS {
                return out;
            }
        }
    }
    out
}

pub fn facets(ext: &str, bytes: &[u8]) -> Vec<Facet> {
    match ext {
        "stl" => {
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
            if head.trim_start().starts_with("solid") && head.contains("facet normal") {
                facets_stl(&String::from_utf8_lossy(bytes))
            } else {
                facets_stl_binary(bytes)
            }
        }
        "obj" => facets_obj(&String::from_utf8_lossy(bytes)),
        "ply" => facets_ply(bytes),
        "3mf" => crate::threemf::load(bytes, MAX_FACETS)
            .map(|scene| scene.facets)
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

pub fn render_image(path: &std::path::Path, ext: &str, size: u32) -> Option<image::RgbImage> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_MESH_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    crate::render::render(&facets(ext, &bytes), size)
}

fn measure(ext: &str, bytes: &[u8]) -> Option<MeshBounds> {
    match ext {
        "stl" => {
            let text = String::from_utf8_lossy(bytes);
            if text.trim_start().starts_with("solid") && text.contains("facet normal") {
                from_stl(&text)
            } else {
                from_stl_binary(bytes)
            }
        }
        "ply" => from_ply(bytes),
        "glb" => from_glb(bytes),
        "3mf" => crate::threemf::bounds(bytes),
        _ => {
            let text = String::from_utf8_lossy(bytes);
            match ext {
                "obj" => from_obj(&text),
                "off" => from_off(&text),
                "gltf" => serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|json| from_gltf(&json)),
                _ => None,
            }
        }
    }
}

#[tauri::command]
pub fn mesh_bounds(path: String) -> Result<Option<MeshBounds>, String> {
    let file = paths::resolve_file(&path)?;
    let ext = paths::ext_of(&file.to_string_lossy());
    let meta = fs::metadata(&file).map_err(|e| paths::io_msg(&e, &file))?;
    if !meta.is_file() || meta.len() > MAX_MESH_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(&file).map_err(|e| paths::io_msg(&e, &file))?;
    Ok(measure(&ext, &bytes))
}

// Stride sampling cannot keep a closed surface watertight, so it must stay a last resort:
// half the triangles of a dense mesh drop out and the dark inner shell shows through the
// sub-pixel gaps. The budget covers full binary STLs well past 40 MB.
const MAX_PREVIEW_FACETS: usize = 1_000_000;

/// Triangle corners as packed little-endian f32 triplets, sampled evenly when the mesh
/// exceeds the preview budget so the whole object stays recognizable.
fn preview_geometry(ext: &str, bytes: &[u8], max_facets: usize) -> Vec<u8> {
    if ext == "3mf" {
        return preview_3mf(bytes, max_facets);
    }
    let facets = facets(ext, bytes);
    if facets.is_empty() || max_facets == 0 {
        return Vec::new();
    }
    let step = facets.len().div_ceil(max_facets).max(1);
    let mut out = Vec::with_capacity(facets.len().div_ceil(step) * 36);
    for facet in facets.iter().step_by(step) {
        for point in facet.points {
            for value in point {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    out
}

// A NaN bit pattern, so it can never be mistaken for the first corner of a plain payload.
const SCENE_MAGIC: u32 = 0x7FC0_334D;

/// Header (magic, version, facet count, info length), packed corners, one RGBA per facet
/// (alpha 0 = default tone), then the scene info as JSON.
fn preview_3mf(bytes: &[u8], max_facets: usize) -> Vec<u8> {
    let Some(scene) = crate::threemf::load(bytes, max_facets) else {
        return Vec::new();
    };
    let info = serde_json::to_vec(&scene.info).unwrap_or_default();
    let count = scene.facets.len();
    let mut out = Vec::with_capacity(16 + count * 40 + info.len());
    for word in [SCENE_MAGIC, 1, count as u32, info.len() as u32] {
        out.extend_from_slice(&word.to_le_bytes());
    }
    for facet in &scene.facets {
        for point in facet.points {
            for value in point {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    for facet in &scene.facets {
        match facet.color {
            Some([r, g, b]) => out.extend_from_slice(&[r, g, b, 255]),
            None => out.extend_from_slice(&[0, 0, 0, 0]),
        }
    }
    out.extend_from_slice(&info);
    out
}

#[tauri::command]
pub fn mesh_geometry(path: String) -> Result<tauri::ipc::Response, String> {
    let file = paths::resolve_file(&path)?;
    let ext = paths::ext_of(&file.to_string_lossy());
    let meta = fs::metadata(&file).map_err(|e| paths::io_msg(&e, &file))?;
    if !meta.is_file() || meta.len() > MAX_MESH_BYTES {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }
    let bytes = fs::read(&file).map_err(|e| paths::io_msg(&e, &file))?;
    Ok(tauri::ipc::Response::new(preview_geometry(
        &ext,
        &bytes,
        MAX_PREVIEW_FACETS,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_obj_boxes() {
        let text = "# cube\nv 0 0 0\nv 2 3 4\nvn 0 0 1\nf 1 2 3";
        let bounds = from_obj(text).unwrap();
        assert_eq!((bounds.width, bounds.height, bounds.depth), (2.0, 3.0, 4.0));
    }

    #[test]
    fn measures_binary_stl() {
        let mut bytes = vec![0u8; 84 + 50];
        bytes[80..84].copy_from_slice(&1u32.to_le_bytes());
        let floats = [0.0f32, 0.0, 0.0, 1.0, 2.0, 3.0, 2.0, 2.0, 2.0];
        for (index, value) in floats.iter().enumerate() {
            let offset = 84 + 12 + index * 4;
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        let bounds = from_stl_binary(&bytes).unwrap();
        assert_eq!((bounds.width, bounds.height, bounds.depth), (2.0, 2.0, 3.0));
    }

    fn binary_stl_facets(count: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; 84 + 50 * count];
        bytes[80..84].copy_from_slice(&(count as u32).to_le_bytes());
        for index in 0..count {
            let x = index as f32;
            let floats = [x, 0.0, 0.0, x + 1.0, 1.0, 0.0, x, 1.0, 0.0];
            for (slot, value) in floats.iter().enumerate() {
                let offset = 84 + index * 50 + 12 + slot * 4;
                bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            }
        }
        bytes
    }

    #[test]
    fn samples_preview_geometry_evenly() {
        let bytes = binary_stl_facets(4);
        let out = preview_geometry("stl", &bytes, 2);
        assert_eq!(out.len(), 2 * 36);
        let first = f32::from_le_bytes(out[0..4].try_into().unwrap());
        let second = f32::from_le_bytes(out[36..40].try_into().unwrap());
        assert_eq!(first, 0.0);
        assert_eq!(second, 2.0);
    }

    #[test]
    fn rejects_unsupported_preview_formats() {
        assert!(preview_geometry("glb", b"not a mesh", 10).is_empty());
    }

    #[test]
    fn measures_glb() {
        let json = r#"{"accessors":[{"count":3,"type":"VEC3","min":[0,0,0],"max":[10,20,30]}],"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}]}"#;
        let mut payload = json.as_bytes().to_vec();
        while payload.len() % 4 != 0 {
            payload.push(b' ');
        }
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"glTF");
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&(20 + payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"JSON");
        bytes.extend_from_slice(&payload);
        let bounds = from_glb(&bytes).unwrap();
        assert_eq!(
            (bounds.width, bounds.height, bounds.depth),
            (10.0, 20.0, 30.0)
        );
    }

    #[test]
    fn measures_ascii_ply() {
        let text = "ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n-1 -2 -3\n4 5 6\n3 0 1 2\n";
        let bounds = from_ply(text.as_bytes()).unwrap();
        assert_eq!((bounds.width, bounds.height, bounds.depth), (5.0, 7.0, 9.0));
    }

    #[test]
    fn measures_binary_ply() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(
            b"ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty uchar red\nproperty float y\nproperty float z\nend_header\n",
        );
        for point in [[-1.0f32, -2.0, -3.0], [4.0, 5.0, 6.0]] {
            bytes.extend_from_slice(&point[0].to_le_bytes());
            bytes.push(255);
            bytes.extend_from_slice(&point[1].to_le_bytes());
            bytes.extend_from_slice(&point[2].to_le_bytes());
        }
        let bounds = from_ply(&bytes).unwrap();
        assert_eq!((bounds.width, bounds.height, bounds.depth), (5.0, 7.0, 9.0));
    }

    #[test]
    fn triangulates_obj_fans() {
        let text = "# two quads\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\nf -4 -3 -2 -1\n";
        let facets = facets_obj(text);
        assert_eq!(facets.len(), 4);
        assert_eq!(
            facets[0].points,
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]]
        );
        assert_eq!(
            facets[3].points,
            [[0.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]]
        );
    }

    #[test]
    fn reads_obj_texture_indices() {
        let text = "v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1/1/1 2/2/2 3/3/3\n";
        let facets = facets_obj(text);
        assert_eq!(facets.len(), 1);
        assert_eq!(facets[0].points[2], [1.0, 1.0, 0.0]);
    }

    #[test]
    fn reads_binary_stl_facets() {
        let mut bytes = vec![0u8; 84 + 50];
        bytes[80..84].copy_from_slice(&1u32.to_le_bytes());
        let floats = [0.0f32, 0.0, 0.0, 1.0, 2.0, 3.0, 2.0, 2.0, 2.0];
        for (index, value) in floats.iter().enumerate() {
            let offset = 84 + 12 + index * 4;
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        let facets = facets_stl_binary(&bytes);
        assert_eq!(facets.len(), 1);
        assert_eq!(facets[0].points[1], [1.0, 2.0, 3.0]);
    }

    #[test]
    fn reads_ascii_stl_facets() {
        let text = "solid box\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 1 1 0\nendloop\nendfacet\nendsolid box\n";
        let facets = facets_stl(text);
        assert_eq!(facets.len(), 1);
        assert_eq!(facets[0].points[2], [1.0, 1.0, 0.0]);
    }

    #[test]
    fn reads_ascii_ply_faces() {
        let text = "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n1 1 0\n3 0 1 2\n";
        let facets = facets_ply(text.as_bytes());
        assert_eq!(facets.len(), 1);
        assert_eq!(facets[0].points[2], [1.0, 1.0, 0.0]);
    }

    #[test]
    fn reads_binary_ply_faces() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(
            b"ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty uchar red\nproperty float y\nproperty float z\nelement face 2\nproperty list uchar int vertex_indices\nend_header\n",
        );
        for point in [[0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]] {
            bytes.extend_from_slice(&point[0].to_le_bytes());
            bytes.push(200);
            bytes.extend_from_slice(&point[1].to_le_bytes());
            bytes.extend_from_slice(&point[2].to_le_bytes());
        }
        for face in [[0u32, 1, 2], [2, 1, 0]] {
            bytes.push(3);
            for index in face {
                bytes.extend_from_slice(&index.to_le_bytes());
            }
        }
        let facets = facets_ply(&bytes);
        assert_eq!(facets.len(), 2);
        assert_eq!(facets[0].points[2], [1.0, 1.0, 0.0]);
        assert_eq!(facets[1].points[0], [1.0, 1.0, 0.0]);
    }
}
