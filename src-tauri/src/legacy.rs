use std::fs::File;
use std::io::Read;
use std::path::Path;

const HEAD_LIMIT: u64 = 13_000;

fn candidate(ext: &str) -> bool {
    matches!(
        ext,
        "atr" | "xex" | "bin" | "cas" | "arc" | "sap" | "sid" | "nsf" | "rmt" | "cmc" | "dmc"
            | "mpt" | "tmc" | "tm2" | "amp" | "ams" | "am2"
            | "di" | "xfd" | "pro" | "atx" | "dcm" | "dc3" | "dsk" | "car" | "lzh" | "lzw"
            | "bas" | "sav" | "abs" | "tb" | "tba" | "tbs" | "tur" | "bxl" | "bxe"
            | "asm" | "lst" | "src" | "act" | "pas" | "hlp" | "4th" | "for" | "fth"
            | "pil" | "plo" | "qik" | "qui" | "lgo" | "c65" | "ccc"
            | "ars" | "aut" | "com" | "sys" | "mac" | "m65"
            | "chr" | "fnt" | "fon" | "nlq"
            | "gr8" | "gr9" | "g15" | "mic" | "p15" | "pi8" | "pi9" | "256" | "ap2" | "apc"
            | "int" | "fwa" | "ilc"
            | "d8" | "d15" | "md8" | "ft" | "pic" | "hip" | "rgb" | "b" | "g" | "r"
    )
}

fn label(ext: &str) -> &'static str {
    match ext {
        "atr" => "Atari disk image",
        "di" => "DI disk image",
        "xfd" => "XFD disk image",
        "pro" => "APE ProSystem image",
        "atx" => "ATX disk image",
        "dcm" | "dc3" | "dsk" => "DCM disk image",
        "car" => "Atari cartridge image",
        "xex" => "Atari executable",
        "com" => "Atari COM executable",
        "sys" => "Atari system file",
        "ars" | "aut" => "Atari autorun file",
        "bin" => "Atari binary",
        "cas" => "Atari cassette image",
        "arc" => "ARC archive",
        "lzh" => "LZH archive",
        "lzw" => "LZW archive",
        "bas" | "sav" | "abs" => "Atari BASIC program",
        "tb" | "tba" | "tbs" | "tur" => "Turbo BASIC program",
        "bxl" => "BASIC XL program",
        "bxe" => "BASIC XE program",
        "mac" | "m65" => "MAC/65 source",
        "asm" | "src" => "Assembler source",
        "lst" => "Atari listing",
        "act" => "Action! source",
        "pas" => "Pascal source",
        "hlp" => "Atari text file",
        "4th" | "for" | "fth" => "Forth source",
        "pil" | "plo" => "Pilot source",
        "qik" | "qui" => "Quick source",
        "lgo" => "Logo source",
        "c65" | "ccc" => "C source",
        "chr" | "fnt" | "fon" => "Atari font",
        "nlq" => "Daisy-Dot NLQ font",
        "gr8" | "pi8" => "Graphics 8 picture",
        "gr9" | "pi9" => "Graphics 9 picture",
        "g15" | "p15" => "Graphics 15 picture",
        "mic" | "pic" => "Atari picture",
        "256" | "ap2" | "apc" => "Paint 256 picture",
        "int" => "INT95a picture",
        "fwa" => "Fun with Art picture",
        "ilc" => "Interlaced picture",
        "hip" => "HIP picture",
        "rgb" | "b" | "g" | "r" => "Atari RGB picture",
        "sap" => "SAP music",
        "sid" => "SID music",
        "nsf" => "NSF music",
        "rmt" => "RMT music",
        "cmc" => "CMC music",
        "dmc" => "DMC music",
        "mpt" => "ProTracker music",
        "d8" | "d15" => "ProTracker module",
        "md8" => "Converted MOD module",
        "ft" => "Future Composer music",
        "tmc" => "TMC music",
        "tm2" => "TM2 music",
        "amp" => "AMP music",
        "ams" | "am2" => "AMS music",
        _ => "Legacy file",
    }
}

/// Returns a display label when the file contents pass the format test.
pub fn identify(path: &Path, ext: &str, size: u64) -> Option<&'static str> {
    if !candidate(ext) || size < 16 {
        return None;
    }
    let mut buf = Vec::new();
    File::open(path)
        .ok()?
        .take(HEAD_LIMIT)
        .read_to_end(&mut buf)
        .ok()?;
    let len = size as usize;
    let ok = match ext {
        "atr" => atr_ok(&buf, len),
        "di" => di_ok(&buf, len),
        "xfd" => xfd_ok(len),
        "pro" => pro_ok(&buf, len),
        "atx" => len >= 48 && buf.starts_with(b"AT8X"),
        "dcm" | "dc3" | "dsk" => dcm_ok(&buf, len),
        "car" => cart_ok(&buf, len),
        "xex" | "bin" | "ars" | "aut" | "com" | "sys" => atari_binary_ok(&buf, len),
        "mac" | "m65" => mac_ok(&buf, len),
        "cas" => buf.starts_with(b"FUJI") && len > 16,
        "arc" => buf.len() >= 2 && buf[0] == 0x1a && buf[1] == 0x08,
        "lzh" => lzh_ok(&buf, len),
        "lzw" => lzw_ok(&buf, len),
        "bas" | "sav" | "abs" | "tb" | "tba" | "tbs" | "tur" | "bxl" | "bxe" => basic_ok(&buf, len),
        "asm" | "lst" | "src" | "act" | "pas" | "hlp" | "4th" | "for" | "fth" | "pil" | "plo"
        | "qik" | "qui" | "lgo" | "c65" | "ccc" => text_ok(&buf, len),
        "chr" | "fnt" | "fon" => font_ok(&buf, len),
        "nlq" => nlq_ok(&buf, len),
        "int" => int95_ok(&buf, len),
        "fwa" => fwa_ok(&buf, len),
        "gr8" | "gr9" | "g15" | "mic" | "p15" | "pi8" | "pi9" | "256" | "ap2" | "apc" | "pic"
        | "ilc" | "hip" | "rgb" | "b" | "g" | "r" => picture_ok(ext, len),
        "d8" | "d15" => mpt_ok(&buf, len),
        "md8" => mod_ok(&buf, len),
        "ft" => fc_ok(&buf, len),
        "sap" => len >= 30 && buf.starts_with(b"SAP\r\n"),
        "sid" => sid_ok(&buf, len),
        "nsf" => nsf_ok(&buf, len),
        "rmt" => rmt_ok(&buf, len),
        "cmc" | "dmc" => cmc_ok(&buf, len),
        "mpt" => mpt_ok(&buf, len),
        "tmc" => tmc_ok(&buf, len),
        "tm2" => tm2_ok(&buf, len),
        "amp" | "am2" => len >= 300 && atari_binary_ok(&buf, len),
        "ams" => len >= 400 && atari_binary_ok(&buf, len),
        _ => false,
    };
    ok.then(|| label(ext))
}

fn word(b: &[u8], i: usize) -> usize {
    b[i] as usize | ((b[i + 1] as usize) << 8)
}

fn be_word(b: &[u8], i: usize) -> usize {
    ((b[i] as usize) << 8) | b[i + 1] as usize
}

/// XL/ST-link DI image: "DI" 0x20 0x02 header, a per-sector checksum table,
/// then only the sectors whose checksum is non-zero. On double-density disks
/// the first three sectors are 128 bytes, the rest 256.
fn di_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 17 || len < 16 + 128 {
        return false;
    }
    if &b[..4] != b"DI\x20\x02" {
        return false;
    }
    let tracks = b[9] as usize;
    let sec_per_track = be_word(b, 10);
    let sec_size = be_word(b, 14);
    if tracks == 0 || tracks > 200 || sec_per_track == 0 || sec_per_track > 128 {
        return false;
    }
    if !matches!(sec_size, 128 | 256) {
        return false;
    }
    let table = tracks * sec_per_track;
    [16usize, 17].iter().any(|&header| {
        if header + table > len {
            return false;
        }
        let body = len - header - table;
        if header + table <= b.len() {
            let expected: usize = b[header..header + table]
                .iter()
                .enumerate()
                .filter(|(_, &c)| c != 0)
                .map(|(i, _)| if sec_size == 256 && i < 3 { 128 } else { sec_size })
                .sum();
            return body == expected;
        }
        body % 128 == 0 && body <= table * sec_size
    })
}

fn xfd_ok(len: usize) -> bool {
    // Headerless raw disk image: only the sector size is testable.
    len % 128 == 0 && (16 * 1024..=4 * 1024 * 1024).contains(&len)
}

/// APE ProSystem: 16-byte header with a big-endian sector count, a 'P', and
/// 12 bytes of timing data per 128-byte sector (atari800 afile.c).
fn pro_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 16 || len < 16 + 140 {
        return false;
    }
    let body = len - 16;
    body % 140 == 0 && b[2] == b'P' && be_word(b, 0) == body / 140
}

fn dcm_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 2 || len < 128 {
        return false;
    }
    matches!(b[0], 0xf9 | 0xfa) && (b[1] & 0x1f) == 1 && ((b[1] >> 5) & 3) <= 2
}

/// AtariMax CART header: "CART", a big-endian type code, then 1K image data.
fn cart_ok(b: &[u8], len: usize) -> bool {
    if len < 16 + 1024 || !b.starts_with(b"CART") {
        return false;
    }
    let cart_type = u32::from_be_bytes([b[4], b[5], b[6], b[7]]);
    (len - 16) % 1024 == 0 && (1..=99).contains(&cart_type)
}

fn lzh_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 24 || len < 24 {
        return false;
    }
    // Level 2 headers start with a two-byte total size and shift the method ID
    // one byte right.
    if b[3] == b'-' && b[4] == b'l' && b[7] == b'-' && (b[5] == b'h' || b[5] == b'z') {
        let header = word(b, 0);
        let csize = u32::from_le_bytes([b[8], b[9], b[10], b[11]]) as usize;
        return header >= 28 && header <= len && csize > 0 && csize <= len;
    }
    if b[0] < 22 || b[2] != b'-' || b[3] != b'l' || b[6] != b'-' || !(b[4] == b'h' || b[4] == b'z')
    {
        return false;
    }
    let csize = u32::from_le_bytes([b[7], b[8], b[9], b[10]]) as usize;
    csize > 0 && csize <= len
}

fn lzw_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 3 || len <= 16 || b[0] != 0x1f || b[1] != 0x9d {
        return false;
    }
    (9..=16).contains(&(b[2] & 0x1f))
}

/// Tokenized Atari BASIC / Turbo-BASIC XL save. The 14-byte header holds
/// LOMEM-relative pointers (LOMEM, VNTP, VNTD, VVTP, STMTAB, STMCUR, STARP),
/// followed by the name table (names end with a high-bit character, then a
/// zero), the 8-byte-per-variable value table, and numbered lines. The last
/// line is the direct-mode line numbered $8000 (often the SAVE command).
fn basic_ok(b: &[u8], len: usize) -> bool {
    const HDR: usize = 14;
    if b.len() < HDR || len < HDR + 3 {
        return false;
    }
    let lomem = word(b, 0);
    let vntp = word(b, 2);
    let vntd = word(b, 4);
    let vvtp = word(b, 6);
    let stmtab = word(b, 8);
    let stmcur = word(b, 10);
    let starp = word(b, 12);

    if lomem != 0 || vntp != 0x100 {
        return false;
    }
    if vntd < vntp || vvtp != vntd + 1 || vvtp > stmtab || stmtab > stmcur || stmcur > starp {
        return false;
    }
    if starp < stmtab + 3 || len != HDR + starp - vntp {
        return false;
    }
    let vvt_len = stmtab - vvtp;
    if vvt_len % 8 != 0 || vvt_len > 8 * 256 {
        return false;
    }
    let truncated = b.len() < len;

    let vnt_end = HDR + vntd - vntp;
    if vnt_end >= b.len() {
        return truncated;
    }
    if b[vnt_end] != 0 {
        return false;
    }
    let mut i = HDR;
    let mut vars = 0usize;
    while i < vnt_end {
        if !(b[i] & 0x7f).is_ascii_uppercase() {
            return false;
        }
        loop {
            if i >= vnt_end {
                return false;
            }
            let c = b[i];
            i += 1;
            // Array names end with '(' and string names with '$', both flagged.
            let base = c & 0x7f;
            if !(base.is_ascii_uppercase()
                || base.is_ascii_digit()
                || matches!(base, b'$' | b'(' | b'%' | b'.' | b'_'))
            {
                return false;
            }
            if c & 0x80 != 0 {
                break;
            }
        }
        vars += 1;
    }
    if vars * 8 != vvt_len {
        return false;
    }

    let mut pos = HDR + stmtab - vntp;
    let end = HDR + starp - vntp;
    let mut prev = None;
    while pos < end {
        if pos + 3 > b.len() {
            return truncated;
        }
        let number = word(b, pos);
        let line_len = b[pos + 2] as usize;
        if line_len < 3 || pos + line_len > end {
            return false;
        }
        if pos + line_len > b.len() {
            return truncated;
        }
        if number == 0x8000 {
            if pos + line_len != end {
                return false;
            }
        } else if number >= 0x8000 || prev.is_some_and(|p| number <= p) {
            return false;
        }
        prev = Some(number);
        pos += line_len;
    }
    prev == Some(0x8000)
}

fn text_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 16 || len < 16 {
        return false;
    }
    let good = b
        .iter()
        .filter(|&&c| matches!(c, 0x09 | 0x0a | 0x0d | 0x1b | 0x9b) || (0x20..=0x7e).contains(&c))
        .count();
    good * 100 >= b.len() * 95
}

fn font_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 2 || len < 512 {
        return false;
    }
    if b[0] == 0 && (1..=3).contains(&b[1]) {
        return false;
    }
    matches!(len, 512 | 768 | 1024 | 2048)
}

fn mod_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 1084 || len < 1084 {
        return false;
    }
    let tag = &b[1080..1084];
    matches!(
        tag,
        b"M.K." | b"M!K!" | b"FLT4" | b"FLT8" | b"4CHN" | b"6CHN" | b"8CHN" | b"OCTA"
            | b"OKTA" | b"CD81" | b"16CN" | b"32CN"
    ) || (tag[0].is_ascii_digit()
        && (&tag[1..] == b"CHN" || (tag[1].is_ascii_digit() && &tag[2..] == b"CH")))
}

fn fc_ok(b: &[u8], len: usize) -> bool {
    len >= 899 && b.len() >= 2 && b[0] == 38 && b[1] == 35
}

fn picture_ok(ext: &str, len: usize) -> bool {
    match ext {
        "gr8" | "gr9" | "pi8" | "pi9" => matches!(len, 7680 | 9600),
        "g15" | "p15" => matches!(len, 15360 | 19200),
        "mic" => matches!(len, 7680 | 9600 | 15360 | 19200),
        "256" | "ap2" | "apc" => matches!(len, 7680 | 8448),
        "pic" => matches!(len, 7680 | 8448 | 9600 | 15360 | 19200),
        // AP3-family interlace dump: headerless, so only the frame sizes
        // RECOIL accepts (recoil DecodeAp3).
        "ilc" => matches!(len, 15360 | 15362 | 15872),
        "hip" => len == 32000,
        "rgb" | "b" | "g" | "r" => matches!(len, 23040 | 23808 | 46080 | 46848),
        _ => false,
    }
}

/// INT95a interlace picture: "INT95a" magic, byte stride and height, two
/// palettes, then two Graphics 9 frames (recoil DecodeInt).
fn int95_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 18 || len < 18 || !b.starts_with(b"INT95a") {
        return false;
    }
    let stride = b[6] as usize;
    let height = b[7] as usize;
    b[8] == 0x0f
        && b[9] == 0x2b
        && (1..=320).contains(&stride)
        && (1..=239).contains(&height)
        && 18 + stride * height * 2 == len
}

/// Fun with Art: a $FE $FE load header, then a display list and DLI table that
/// RECOIL requires at fixed offsets (recoil DecodeFwa).
fn fwa_ok(b: &[u8], len: usize) -> bool {
    const DATA: usize = 0x1f18;
    if b.len() < DATA || len < DATA {
        return false;
    }
    b[0] == 0xfe
        && b[1] == 0xfe
        && b[6] == 0x70
        && b[7] == 0x70
        && b[8] == 0x70
        && b[0x0b] == 0x50
        && b[0x73] == 0x60
        && b[0xcd] == 0x41
        && DATA + word(b, 0x1f16) == len
}

/// Daisy-Dot NLQ font: "DAISY-DOT NLQ FONT" and $9B, then 91 variable-width
/// glyphs, each a width byte, two half-glyph rows, and a trailing $9B
/// (recoil DecodeNlq).
fn nlq_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 19 || len < 19 + 90 * 4 || !b.starts_with(b"DAISY-DOT NLQ FONT") || b[18] != 0x9b {
        return false;
    }
    let mut pos = 19usize;
    for _ in 0..91 {
        if pos >= b.len() {
            return false;
        }
        let width = b[pos] as usize;
        if width == 0 || width > 19 {
            return false;
        }
        let next = pos + (width + 1) * 2;
        if next > b.len() || next > len || b[next - 1] != 0x9b {
            return false;
        }
        pos = next;
    }
    true
}

fn atr_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 16 || len < 16 + 128 {
        return false;
    }
    if b[0] != 0x96 || (b[1] & 0x7f) != 0x02 {
        return false;
    }
    let paragraphs = word(b, 2);
    let sector = word(b, 4);
    if !matches!(sector, 128 | 256 | 512) || paragraphs == 0 {
        return false;
    }
    let body = paragraphs.saturating_mul(16);
    16 + body == len || body == len
}

fn atari_binary_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 6 || len < 6 {
        return false;
    }
    if !((b[0] == 0xff && b[1] == 0xff) || (b[0] == 0 && b[1] == 0)) {
        return false;
    }
    let mut pos = 2usize;
    let mut segments = 0;
    loop {
        if pos + 2 > len {
            return segments > 0 && pos == len;
        }
        if pos + 4 > b.len() {
            // Header read limit reached; the segments seen so far are valid.
            return segments > 0;
        }
        let start = word(b, pos);
        let end = word(b, pos + 2);
        if start == 0xffff || start == 0 {
            return segments > 0 && pos + 4 <= len;
        }
        if end < start {
            return false;
        }
        let next = pos + 4 + (end - start + 1);
        if next > len {
            return false;
        }
        segments += 1;
        pos = next;
        if pos == len {
            return true;
        }
    }
}

/// MAC/65 SAVEd source (ANALOG 5/88): $FE $FE, the byte count of the file
/// (with or without the four header bytes), then lines of line number, byte
/// length and tokenized data.
fn mac_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 8 || len < 8 || b[0] != 0xfe || b[1] != 0xfe {
        return false;
    }
    let size = word(b, 2) as usize;
    if size != len - 4 && size != len {
        return false;
    }
    let mut pos = 4usize;
    let mut prev = None;
    let mut lines = 0usize;
    while pos < len {
        if pos + 3 > b.len() {
            return lines > 0;
        }
        let number = word(b, pos);
        let next = pos + b[pos + 2] as usize;
        if next < pos + 3 || next > len {
            return false;
        }
        if prev.is_some_and(|p| number <= p) {
            return false;
        }
        prev = Some(number);
        lines += 1;
        pos = next;
    }
    lines > 0
}

fn sid_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 0x76 || len < 0x76 {
        return false;
    }
    if !(b.starts_with(b"PSID") || b.starts_with(b"RSID")) {
        return false;
    }
    let version = be_word(b, 4);
    let offset = be_word(b, 6);
    (1..=4).contains(&version) && offset >= 0x76 && offset <= len
}

fn nsf_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 0x80 || len < 0x80 {
        return false;
    }
    if !b.starts_with(b"NESM\x1a") {
        return false;
    }
    let version = b[5];
    (1..=2).contains(&version) && b[6] > 0
}

fn parse_module(b: &[u8], len: usize) -> bool {
    if b.len() < 6 {
        return false;
    }
    if !((b[0] == 0xff && b[1] == 0xff) || (b[0] == 0 && b[1] == 0)) {
        return false;
    }
    let music = word(b, 2);
    let last = word(b, 4);
    if music <= 55295 && last >= 53248 {
        return false;
    }
    if last + 1 < music {
        return false;
    }
    let block = last + 1 - music;
    6 + block == len && 6 + block <= b.len()
}

fn parse_module_rmt(b: &[u8], len: usize) -> bool {
    if b.len() < 6 {
        return false;
    }
    if !((b[0] == 0xff && b[1] == 0xff) || (b[0] == 0 && b[1] == 0)) {
        return false;
    }
    let music = word(b, 2);
    let last = word(b, 4);
    if music <= 55295 && last >= 53248 {
        return false;
    }
    if last + 1 < music {
        return false;
    }
    let block = last + 1 - music;
    if 6 + block == len {
        return 6 + block <= b.len();
    }
    if 11 + block > len || 11 + block > b.len() {
        return false;
    }
    let info = word(b, 6 + block);
    if info != music + block {
        return false;
    }
    let info_end = word(b, 8 + block);
    let info_len = info_end + 1 - info;
    10 + block + info_len == len
}

fn rmt_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 48 || len < 48 {
        return false;
    }
    if &b[6..9] != b"RMT" || b[13] != 1 || (b[9] != b'4' && b[9] != b'8') {
        return false;
    }
    parse_module_rmt(b, len)
}

fn cmc_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 774 || len < 774 {
        return false;
    }
    if !parse_module(b, len) {
        return false;
    }
    let mut last = 84i32;
    while {
        last -= 1;
        last >= 0
    } {
        let i = last as usize;
        if b[518 + i] < 176 || b[603 + i] < 64 || b[688 + i] < 64 {
            break;
        }
    }
    true
}

fn mpt_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 464 || len < 464 {
        return false;
    }
    let track_addr = |ch: usize| b[454 + ch] as usize | ((b[458 + ch] as usize) << 8);
    let first_addr = || {
        for offset in (6..198).step_by(2) {
            let addr = word(b, offset);
            if addr != 0 {
                return addr;
            }
        }
        word(b, 4) + 1
    };
    let track0 = track_addr(0);
    let track0_len = first_addr() as i32 - track0 as i32;
    if track0_len <= 0 {
        return false;
    }
    let mut adjusted = len as i32;
    if 7 + word(b, 4) as i32 - word(b, 2) as i32 != adjusted {
        let extra = 3 * track0_len + track_addr(1) as i32 - first_addr() as i32;
        if extra < 0 {
            return false;
        }
        adjusted -= extra;
    }
    if adjusted < 464 || adjusted as usize > b.len() {
        return false;
    }
    if !parse_module(b, adjusted as usize) {
        return false;
    }
    if track0 != word(b, 2) + 458 {
        return false;
    }
    let song_len = (track0_len >> 1) as usize;
    (1..=254).contains(&song_len)
}

fn tmc_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 464 || len < 464 {
        return false;
    }
    if !parse_module(b, len) {
        return false;
    }
    let mut i = 0usize;
    while b[102 + i] == 0 {
        i += 1;
        if i >= 64 {
            return false;
        }
    }
    let last = ((b[102 + i] as i32) << 8) + b[38 + i] as i32 - word(b, 2) as i32 - 432;
    if last <= 0 {
        return false;
    }
    let mut last = last as usize;
    if 437 + last >= len || 437 + last >= b.len() {
        return false;
    }
    loop {
        if last == 0 {
            return false;
        }
        last -= 16;
        if b[437 + last] < 128 {
            break;
        }
    }
    (1..=4).contains(&b[37])
}

fn tm2_ok(b: &[u8], len: usize) -> bool {
    if b.len() < 932 || len < 932 {
        return false;
    }
    parse_module(b, len) && (1..=4).contains(&b[37])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xex(segments: &[&[u8]], run: bool) -> Vec<u8> {
        let mut b = vec![0xff, 0xff];
        for (i, seg) in segments.iter().enumerate() {
            let start = 0x2000u16 + (i as u16) * 0x100;
            b.extend_from_slice(&(start as u16).to_le_bytes());
            b.extend_from_slice(&((start + seg.len() as u16 - 1) as u16).to_le_bytes());
            b.extend_from_slice(seg);
        }
        if run {
            b.extend_from_slice(&[0xff, 0xff, 0xe0, 0x02, 0xe1, 0x02]);
        }
        b
    }

    #[test]
    fn xex_segments() {
        let b = xex(&[&[6, 7, 8, 9, 10, 11]], true);
        let len = b.len();
        assert!(atari_binary_ok(&b, len));
        assert!(!atari_binary_ok(&b[..10], 10));
        assert!(!atari_binary_ok(&b[6..], b.len() - 6));
        let two = xex(&[&[1, 2, 3], &[4, 5]], true);
        let two_len = two.len();
        assert!(atari_binary_ok(&two, two_len));
    }

    #[test]
    fn nsf_header() {
        let mut nsf = vec![0u8; 0x100];
        nsf[..5].copy_from_slice(b"NESM\x1a");
        nsf[5] = 1;
        nsf[6] = 1;
        assert!(nsf_ok(&nsf, 0x100));
        nsf[5] = 0;
        assert!(!nsf_ok(&nsf, 0x100));
        nsf[5] = 1;
        nsf[6] = 0;
        assert!(!nsf_ok(&nsf, 0x100));
    }

    #[test]
    fn mpt_track_table() {
        let mut b = vec![0u8; 500];
        b[0] = 0xff;
        b[1] = 0xff;
        b[2] = 0x00;
        b[3] = 0x01;
        b[4] = 0xed;
        b[5] = 0x02;
        b[6] = 0xd0;
        b[7] = 0x02;
        b[454] = 0xca;
        b[458] = 0x02;
        b[455] = 0xce;
        b[459] = 0x02;
        assert!(mpt_ok(&b, 500));
        b[458] = 0x00;
        assert!(!mpt_ok(&b, 500));
    }

    #[test]
    fn nsf_magic_required() {
        let mut b = vec![0u8; 0x100];
        b[..4].copy_from_slice(b"NESM");
        b[4] = 1;
        assert!(!nsf_ok(&b, 0x100));
    }

    #[test]
    fn di_header() {
        let mut b = vec![0u8; 16 + 18 + 256];
        b[..4].copy_from_slice(b"DI\x20\x02");
        b[9] = 1;
        b[11] = 18;
        b[15] = 128;
        b[16] = 0x11;
        b[17] = 0x22;
        assert!(di_ok(&b, b.len()));

        let mut long = vec![0u8; 17 + 18 + 256];
        long[..4].copy_from_slice(b"DI\x20\x02");
        long[9] = 1;
        long[11] = 18;
        long[15] = 128;
        long[17] = 0x11;
        long[18] = 0x22;
        assert!(di_ok(&long, long.len()));

        b[15] = 64;
        assert!(!di_ok(&b, b.len()));
        b[15] = 128;
        b[0] = b'X';
        assert!(!di_ok(&b, b.len()));
        b[0] = b'D';
        b[17] = 0;
        assert!(!di_ok(&b, b.len()));
        assert!(!di_ok(&b[..10], 10));
    }

    #[test]
    fn pro_header() {
        let mut b = vec![0u8; 16 + 140];
        b[1] = 1;
        b[2] = b'P';
        assert!(pro_ok(&b, b.len()));
        b[2] = b'X';
        assert!(!pro_ok(&b, b.len()));
        b[2] = b'P';
        b[1] = 2;
        assert!(!pro_ok(&b, b.len()));
        b[1] = 1;
        assert!(!pro_ok(&b[..16 + 139], 16 + 139));
    }

    #[test]
    fn xfd_sizes() {
        assert!(xfd_ok(92160));
        assert!(xfd_ok(16384));
        assert!(!xfd_ok(92161));
        assert!(!xfd_ok(1280));
        assert!(!xfd_ok(8 * 1024 * 1024));
    }

    #[test]
    fn disk_and_cart_magics() {
        let mut atx = vec![0u8; 48];
        atx[..4].copy_from_slice(b"AT8X");
        assert!(atx.len() >= 48 && atx.starts_with(b"AT8X"));
        let mut cart = vec![0u8; 16 + 8 * 1024];
        cart[..4].copy_from_slice(b"CART");
        cart[7] = 1;
        assert!(cart_ok(&cart, cart.len()));
        cart[7] = 0;
        assert!(!cart_ok(&cart, cart.len()));
        cart[7] = 1;
        assert!(!cart_ok(&cart[..16 + 5000], 16 + 5000));

        let mut dcm = vec![0u8; 512];
        dcm[0] = 0xf9;
        dcm[1] = 0x21;
        assert!(dcm_ok(&dcm, 512));
        dcm[1] = 0x22;
        assert!(!dcm_ok(&dcm, 512));
        dcm[1] = 0x61;
        assert!(!dcm_ok(&dcm, 512));
        dcm[1] = 0x21;
        dcm[0] = 0x1f;
        assert!(!dcm_ok(&dcm, 512));
    }

    // 14-byte header, VNT "A" "B$" "C(" + 0, three VVT entries, line 10, and
    // the $8000 direct-mode line at the end.
    fn basic_program() -> Vec<u8> {
        let words: [u16; 7] = [0x0000, 0x0100, 0x0105, 0x0106, 0x011e, 0x012a, 0x0130];
        let mut b = vec![0u8; 14 + (0x130 - 0x100)];
        for (i, w) in words.iter().enumerate() {
            b[i * 2..i * 2 + 2].copy_from_slice(&w.to_le_bytes());
        }
        b[14] = b'A' | 0x80;
        b[15] = b'B';
        b[16] = b'$' | 0x80;
        b[17] = b'C';
        b[18] = b'(' | 0x80;
        for (i, t) in [0x00u8, 0x80, 0x40].iter().enumerate() {
            b[20 + i * 8] = *t;
            b[21 + i * 8] = 0x80 | i as u8;
        }
        b[44..56].copy_from_slice(&[10, 0, 12, 0x80, 0x2d, 0x0e, 0, 0, 0, 0, 0, 0]);
        b[56..62].copy_from_slice(&[0x00, 0x80, 0x06, 0x06, 0x34, 0x16]);
        b
    }

    #[test]
    fn basic_header_and_lines() {
        let b = basic_program();
        assert!(basic_ok(&b, b.len()));
        assert!(basic_ok(&b[..20], b.len()));
        assert!(!basic_ok(&b[..13], b.len()));

        let mut cut = b.clone();
        cut[12] = 0x31;
        assert!(!basic_ok(&cut, cut.len()));

        let mut term = b.clone();
        term[19] = 1;
        assert!(!basic_ok(&term, term.len()));

        let mut count = b.clone();
        count[8] = 0x26;
        count[9] = 0x01;
        assert!(!basic_ok(&count, count.len()));

        let mut len = b.clone();
        len[46] = 2;
        assert!(!basic_ok(&len, len.len()));

        let mut direct = b.clone();
        direct[57] = 0x00;
        assert!(!basic_ok(&direct, direct.len()));

        let mut order = b.clone();
        order[45] = 0x80;
        assert!(!basic_ok(&order, order.len()));

        let mut name = b.clone();
        name[14] = b'a';
        assert!(!basic_ok(&name, name.len()));
    }

    #[test]
    fn text_and_fonts() {
        let text = b"10 PRINT \"HELLO\"\r\n20 GOTO 10\r\n";
        assert!(text_ok(text, text.len()));
        let binary = vec![0u8; 64];
        assert!(!text_ok(&binary, binary.len()));
        let font = vec![0x55u8; 1024];
        assert!(font_ok(&font, font.len()));
        let mut win = font.clone();
        win[0] = 0;
        win[1] = 2;
        assert!(!font_ok(&win, win.len()));
        assert!(!font_ok(&font[..1000], 1000));
    }

    #[test]
    fn module_tags() {
        let mut b = vec![0u8; 1084];
        b[1080..].copy_from_slice(b"M.K.");
        assert!(mod_ok(&b, b.len()));
        b[1080..].copy_from_slice(b"12CH");
        assert!(mod_ok(&b, b.len()));
        b[1080..].copy_from_slice(b"XXXX");
        assert!(!mod_ok(&b, b.len()));
        let mut fc = vec![0u8; 899];
        fc[0] = 38;
        fc[1] = 35;
        assert!(fc_ok(&fc, fc.len()));
        assert!(!fc_ok(&fc[..898], 898));
    }

    #[test]
    fn archives() {
        let mut lzh = vec![0u8; 32];
        lzh[0] = 22;
        lzh[2] = b'-';
        lzh[3] = b'l';
        lzh[4] = b'h';
        lzh[5] = b'5';
        lzh[6] = b'-';
        lzh[7] = 10;
        assert!(lzh_ok(&lzh, lzh.len()));
        lzh[4] = b'x';
        assert!(!lzh_ok(&lzh, lzh.len()));

        let mut lzh2 = vec![0u8; 40];
        lzh2[0] = 40;
        lzh2[3..8].copy_from_slice(b"-lh5-");
        lzh2[8] = 10;
        assert!(lzh_ok(&lzh2, lzh2.len()));
        lzh2[0] = 20;
        assert!(!lzh_ok(&lzh2, lzh2.len()));
        lzh2[0] = 40;
        lzh2[7] = b'x';
        assert!(!lzh_ok(&lzh2, lzh2.len()));
        assert!(lzw_ok(&[0x1f, 0x9d, 0x90], 32));
        assert!(lzw_ok(&[0x1f, 0x9d, 0x09], 32));
        assert!(!lzw_ok(&[0x1f, 0x9d, 0x08], 32));
        assert!(!lzw_ok(&[0x1f, 0x8b, 0x90], 32));
    }

    #[test]
    fn picture_sizes() {
        assert!(picture_ok("gr8", 7680));
        assert!(!picture_ok("gr8", 7681));
        assert!(picture_ok("g15", 19200));
        assert!(picture_ok("256", 8448));
        assert!(picture_ok("hip", 32000));
        assert!(picture_ok("b", 23040));
        assert!(!picture_ok("rgb", 23041));
        assert!(picture_ok("ilc", 15360));
        assert!(picture_ok("ilc", 15362));
        assert!(picture_ok("ilc", 15872));
        assert!(!picture_ok("ilc", 15361));
        assert!(candidate("di") && candidate("ft") && candidate("gr8"));
        assert!(candidate("atx") && candidate("dcm") && candidate("dc3") && candidate("car"));
        assert!(candidate("dsk") && candidate("c65") && candidate("ccc"));
        assert!(candidate("mac") && candidate("m65") && candidate("bxl") && candidate("bxe"));
        assert!(candidate("int") && candidate("fwa") && candidate("ilc") && candidate("nlq"));
        assert!(!candidate("zip"));
    }

    fn mac_program() -> Vec<u8> {
        let mut body = Vec::new();
        for (number, tokens) in [(10u16, &[0x00u8][..]), (20, &[0x51, 0x80][..])] {
            body.extend_from_slice(&number.to_le_bytes());
            body.push(3 + tokens.len() as u8);
            body.extend_from_slice(tokens);
        }
        let mut b = vec![0xfe, 0xfe];
        b.extend_from_slice(&(body.len() as u16).to_le_bytes());
        b.extend_from_slice(&body);
        b
    }

    #[test]
    fn mac_tokenized_source() {
        let b = mac_program();
        assert!(mac_ok(&b, b.len()));
        assert!(mac_ok(&b[..8], b.len()));

        let mut magic = b.clone();
        magic[0] = 0xfd;
        assert!(!mac_ok(&magic, magic.len()));

        let mut size = b.clone();
        size[2] += 1;
        assert!(!mac_ok(&size, size.len()));

        let mut inclusive = b.clone();
        inclusive[2] = inclusive.len() as u8;
        inclusive[3] = (inclusive.len() >> 8) as u8;
        assert!(mac_ok(&inclusive, inclusive.len()));

        let mut order = b.clone();
        order[4] = 30;
        assert!(!mac_ok(&order, order.len()));

        let mut short = b.clone();
        short[6] = 2;
        assert!(!mac_ok(&short, short.len()));

        let mut over = b.clone();
        over[6] = 60;
        assert!(!mac_ok(&over, over.len()));
        assert!(!mac_ok(&b[..4], b.len()));
    }

    #[test]
    fn int95_and_fwa_pictures() {
        let mut int = vec![0u8; 18 + 4 * 2 * 2];
        int[..6].copy_from_slice(b"INT95a");
        int[6] = 4;
        int[7] = 2;
        int[8] = 0x0f;
        int[9] = 0x2b;
        assert!(int95_ok(&int, int.len()));
        int[6] = 0;
        assert!(!int95_ok(&int, int.len()));
        int[6] = 4;
        int[8] = 0x0e;
        assert!(!int95_ok(&int, int.len()));
        int[8] = 0x0f;
        assert!(!int95_ok(&int[..int.len() - 1], int.len() - 1));

        let mut fwa = vec![0u8; 0x1f18 + 10];
        fwa[0] = 0xfe;
        fwa[1] = 0xfe;
        fwa[6] = 0x70;
        fwa[7] = 0x70;
        fwa[8] = 0x70;
        fwa[0x0b] = 0x50;
        fwa[0x73] = 0x60;
        fwa[0xcd] = 0x41;
        fwa[0x1f16] = 10;
        assert!(fwa_ok(&fwa, fwa.len()));
        fwa[0xcd] = 0x42;
        assert!(!fwa_ok(&fwa, fwa.len()));
        fwa[0xcd] = 0x41;
        fwa[0x1f16] = 9;
        assert!(!fwa_ok(&fwa, fwa.len()));
    }

    #[test]
    fn dmc_uses_cmc_layout() {
        let mut b = vec![0u8; 774];
        b[0] = 0xff;
        b[1] = 0xff;
        b[2] = 0x00;
        b[3] = 0x20;
        b[4] = 0xff;
        b[5] = 0x22;
        assert!(cmc_ok(&b, 774));
        assert!(candidate("dmc"));
    }

    #[test]
    fn daisy_dot_nlq_font() {
        let mut nlq = b"DAISY-DOT NLQ FONT".to_vec();
        nlq.push(0x9b);
        for _ in 0..91 {
            nlq.push(1);
            nlq.extend_from_slice(&[0xaa, 0x55]);
            nlq.push(0x9b);
        }
        assert!(nlq_ok(&nlq, nlq.len()));
        assert!(!nlq_ok(&nlq[..19 + 90 * 4 - 1], 19 + 90 * 4 - 1));

        let mut wide = nlq.clone();
        wide[19] = 0;
        assert!(!nlq_ok(&wide, wide.len()));

        let mut tail = nlq.clone();
        tail[22] = 0;
        assert!(!nlq_ok(&tail, tail.len()));
    }
}
