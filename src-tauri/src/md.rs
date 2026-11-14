//! Minimal Markdown-to-HTML renderer for the page-preview tiles.
//!
//! Covers the CommonMark subset that shows up in typical README files: ATX
//! headings, fenced code, lists, blockquotes, tables, rules, links, images and
//! inline emphasis. Raw HTML is escaped rather than passed through, and link
//! targets are filtered, so a hostile document cannot inject markup into the
//! sandboxed preview iframe.

const STYLE: &str = r#"
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; }
body {
  color: #1f2733;
  font: 15px/1.62 "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.md { padding: 44px 56px 60px; max-width: 1024px; }
.md > :first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.28; margin: 1.5em 0 0.55em; font-weight: 650; color: #0f1720; }
h1 { font-size: 2em; border-bottom: 1px solid #e5e9f0; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #eef1f6; padding-bottom: 0.25em; }
h3 { font-size: 1.22em; }
h4 { font-size: 1.05em; }
h5 { font-size: 0.95em; }
h6 { font-size: 0.88em; color: #5c6a7d; }
p { margin: 0.75em 0; }
a { color: #2f6feb; text-decoration: none; }
strong { font-weight: 650; }
code {
  font: 13px/1.5 ui-monospace, "Cascadia Code", Consolas, "Liberation Mono", monospace;
  background: #f1f4f9; border-radius: 4px; padding: 0.15em 0.35em;
}
pre {
  margin: 1em 0; padding: 14px 16px; background: #f6f8fb;
  border: 1px solid #e6eaf1; border-radius: 8px; overflow: hidden;
}
pre code { background: none; padding: 0; font-size: 12.5px; white-space: pre-wrap; }
blockquote { margin: 1em 0; padding: 0.2em 0 0.2em 16px; border-left: 3px solid #d7deea; color: #5c6a7d; }
blockquote p { margin: 0.4em 0; }
ul, ol { margin: 0.7em 0; padding-left: 1.7em; }
li { margin: 0.25em 0; }
li > ul, li > ol { margin: 0.25em 0; }
li input[type="checkbox"] { margin: 0 0.45em 0 0; vertical-align: -1px; }
hr { height: 1px; border: 0; background: #e6eaf1; margin: 1.6em 0; }
img { max-width: 100%; height: auto; border-radius: 6px; }
table { border-collapse: collapse; margin: 1em 0; font-size: 0.94em; }
th, td { border: 1px solid #e3e8f0; padding: 6px 12px; text-align: left; }
th { background: #f5f7fb; font-weight: 650; }
del { color: #7d8899; }
"#;

pub fn page(source: &str) -> String {
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><style>{STYLE}</style></head><body><article class=\"md\">{}</article></body></html>",
        render(source)
    )
}

pub fn render(source: &str) -> String {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.lines().collect();
    let mut out = String::with_capacity(normalized.len() + 256);
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        if let Some(fence) = fence_open(trimmed) {
            i += 1;
            let mut code = String::new();
            while i < lines.len() {
                if lines[i].trim_start().starts_with(fence) {
                    i += 1;
                    break;
                }
                code.push_str(lines[i]);
                code.push('\n');
                i += 1;
            }
            out.push_str("<pre><code>");
            out.push_str(&escape(&code));
            out.push_str("</code></pre>\n");
            continue;
        }

        if let Some((level, text)) = heading(trimmed) {
            out.push_str(&format!("<h{level}>"));
            out.push_str(&inline(text));
            out.push_str(&format!("</h{level}>\n"));
            i += 1;
            continue;
        }

        if is_rule(trimmed) {
            out.push_str("<hr>\n");
            i += 1;
            continue;
        }

        if trimmed.starts_with('>') {
            let mut body = String::new();
            while i < lines.len() {
                let quote = lines[i].trim_start();
                if !quote.starts_with('>') {
                    break;
                }
                let rest = quote[1..].strip_prefix(' ').unwrap_or(&quote[1..]);
                body.push_str(rest);
                body.push('\n');
                i += 1;
            }
            out.push_str("<blockquote>\n");
            out.push_str(&render(&body));
            out.push_str("</blockquote>\n");
            continue;
        }

        if is_table_start(&lines, i) {
            out.push_str(&table(&lines, &mut i));
            continue;
        }

        if list_marker(trimmed).is_some() {
            let items = gather_list(&lines, &mut i);
            out.push_str(&list(&items));
            continue;
        }

        let mut parts: Vec<&str> = Vec::new();
        while i < lines.len() {
            let candidate = lines[i];
            let t = candidate.trim_start();
            if t.trim().is_empty()
                || fence_open(t).is_some()
                || heading(t).is_some()
                || is_rule(t)
                || t.starts_with('>')
                || list_marker(t).is_some()
                || is_table_start(&lines, i)
            {
                break;
            }
            parts.push(candidate.trim_end());
            i += 1;
        }
        if parts.is_empty() {
            i += 1;
            continue;
        }
        out.push_str("<p>");
        out.push_str(&paragraph(&parts));
        out.push_str("</p>\n");
    }
    out
}

fn fence_open(trimmed: &str) -> Option<&str> {
    for marker in ["```", "~~~"] {
        if trimmed.starts_with(marker) {
            return Some(marker);
        }
    }
    None
}

fn heading(trimmed: &str) -> Option<(usize, &str)> {
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }
    let mut text = rest.trim();
    if text.ends_with('#') {
        let without = text.trim_end_matches('#');
        if without.is_empty() || without.ends_with(' ') {
            text = without.trim_end();
        }
    }
    Some((hashes, text))
}

fn is_rule(trimmed: &str) -> bool {
    let compact: Vec<char> = trimmed.chars().filter(|c| *c != ' ' && *c != '\t').collect();
    let Some(first) = compact.first() else {
        return false;
    };
    if !matches!(first, '-' | '*' | '_') {
        return false;
    }
    compact.len() >= 3 && compact.iter().all(|c| c == first)
}

fn list_marker(trimmed: &str) -> Option<(bool, &str)> {
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = trimmed.strip_prefix(marker) {
            return Some((false, rest));
        }
    }
    let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits > 9 {
        return None;
    }
    let rest = &trimmed[digits..];
    if rest.starts_with(". ") || rest.starts_with(") ") {
        return Some((true, &rest[2..]));
    }
    None
}

fn is_table_sep(line: &str) -> bool {
    let trimmed = line.trim().trim_matches('|');
    if trimmed.is_empty() {
        return false;
    }
    trimmed.split('|').all(|cell| {
        let cell = cell.trim();
        !cell.is_empty() && cell.chars().all(|c| c == '-' || c == ':') && cell.contains('-')
    })
}

fn is_table_start(lines: &[&str], i: usize) -> bool {
    lines[i].contains('|') && i + 1 < lines.len() && is_table_sep(lines[i + 1])
}

fn cells(line: &str) -> Vec<&str> {
    let trimmed = line.trim().trim_matches('|');
    trimmed.split('|').map(str::trim).collect()
}

fn table(lines: &[&str], i: &mut usize) -> String {
    let header = cells(lines[*i]);
    let aligns: Vec<&str> = cells(lines[*i + 1])
        .iter()
        .map(|cell| {
            let left = cell.starts_with(':');
            let right = cell.ends_with(':');
            match (left, right) {
                (true, true) => "center",
                (true, false) => "left",
                (false, true) => "right",
                (false, false) => "",
            }
        })
        .collect();
    let attr = |index: usize| -> String {
        match aligns.get(index).copied().unwrap_or("") {
            "" => String::new(),
            align => format!(" style=\"text-align:{align}\""),
        }
    };

    let mut out = String::from("<table>\n<thead><tr>");
    for (index, cell) in header.iter().enumerate() {
        out.push_str(&format!("<th{}>{}</th>", attr(index), inline(cell)));
    }
    out.push_str("</tr></thead>\n<tbody>\n");
    *i += 2;
    while *i < lines.len() {
        let line = lines[*i];
        if line.trim().is_empty() || !line.contains('|') {
            break;
        }
        out.push_str("<tr>");
        for (index, cell) in cells(line).iter().enumerate() {
            out.push_str(&format!("<td{}>{}</td>", attr(index), inline(cell)));
        }
        out.push_str("</tr>\n");
        *i += 1;
    }
    out.push_str("</tbody>\n</table>\n");
    out
}

struct Item {
    indent: usize,
    ordered: bool,
    text: String,
}

fn leading_spaces(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').count()
}

fn gather_list(lines: &[&str], i: &mut usize) -> Vec<Item> {
    let mut items: Vec<Item> = Vec::new();
    let base = leading_spaces(lines[*i]);
    loop {
        if *i >= lines.len() {
            break;
        }
        let line = lines[*i];
        if line.trim().is_empty() {
            let mut next = *i + 1;
            while next < lines.len() && lines[next].trim().is_empty() {
                next += 1;
            }
            let continues = next < lines.len()
                && leading_spaces(lines[next]) >= base
                && list_marker(lines[next].trim_start()).is_some();
            if continues {
                *i = next;
                continue;
            }
            break;
        }
        let indent = leading_spaces(line);
        let trimmed = line.trim_start();
        if indent < base {
            break;
        }
        if let Some((ordered, text)) = list_marker(trimmed) {
            items.push(Item {
                indent,
                ordered,
                text: text.to_string(),
            });
            *i += 1;
            continue;
        }
        if indent > base && !items.is_empty() {
            let last = items.last_mut().expect("list item");
            if !last.text.is_empty() {
                last.text.push(' ');
            }
            last.text.push_str(trimmed.trim_end());
            *i += 1;
            continue;
        }
        break;
    }
    items
}

fn list(items: &[Item]) -> String {
    let mut out = String::new();
    let mut pos = 0;
    while pos < items.len() {
        let indent = items[pos].indent;
        render_list(items, &mut pos, indent, &mut out);
    }
    out
}

fn render_list(items: &[Item], pos: &mut usize, indent: usize, out: &mut String) {
    let ordered = items[*pos].ordered;
    let tag = if ordered { "ol" } else { "ul" };
    out.push('<');
    out.push_str(tag);
    out.push_str(">\n");
    let mut open = false;
    while *pos < items.len() {
        let item = &items[*pos];
        if item.indent > indent {
            render_list(items, pos, item.indent, out);
            continue;
        }
        if item.indent < indent || item.ordered != ordered {
            break;
        }
        if open {
            out.push_str("</li>\n");
        }
        out.push_str("<li>");
        out.push_str(&item_html(&item.text));
        open = true;
        *pos += 1;
    }
    if open {
        out.push_str("</li>\n");
    }
    out.push_str("</");
    out.push_str(tag);
    out.push_str(">\n");
}

fn item_html(text: &str) -> String {
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix("[ ] ") {
        return format!("<input type=\"checkbox\" disabled>{}", inline(rest));
    }
    if let Some(rest) = trimmed
        .strip_prefix("[x] ")
        .or_else(|| trimmed.strip_prefix("[X] "))
    {
        return format!("<input type=\"checkbox\" disabled checked>{}", inline(rest));
    }
    inline(text)
}

fn paragraph(lines: &[&str]) -> String {
    let mut text = String::new();
    for (index, line) in lines.iter().enumerate() {
        let hard_break = line.ends_with("  ");
        text.push_str(line.trim_end());
        if index + 1 < lines.len() {
            text.push(if hard_break { '\u{0}' } else { ' ' });
        }
    }
    inline(&text)
}

fn inline(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('`') {
        out.push_str(&inline_span(&rest[..start]));
        let after = &rest[start + 1..];
        match after.find('`') {
            Some(end) if end > 0 => {
                out.push_str("<code>");
                out.push_str(&escape(&after[..end]));
                out.push_str("</code>");
                rest = &after[end + 1..];
            }
            _ => {
                out.push('`');
                rest = after;
            }
        }
    }
    out.push_str(&inline_span(rest));
    out
}

fn inline_span(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        let c = rest.chars().next().expect("char");
        match c {
            '\\' => {
                let mut chars = rest.chars();
                chars.next();
                if let Some(next) = chars.next() {
                    push_char(&mut out, next);
                    i += 1 + next.len_utf8();
                } else {
                    out.push('\\');
                    i += 1;
                }
            }
            '\u{0}' => {
                out.push_str("<br>");
                i += 1;
            }
            '!' if rest.starts_with("![") => match image(rest) {
                Some((html, used)) => {
                    out.push_str(&html);
                    i += used;
                }
                None => {
                    out.push('!');
                    i += 1;
                }
            },
            '[' => match link(rest) {
                Some((html, used)) => {
                    out.push_str(&html);
                    i += used;
                }
                None => {
                    out.push('[');
                    i += 1;
                }
            },
            '<' => match autolink(rest) {
                Some((html, used)) => {
                    out.push_str(&html);
                    i += used;
                }
                None => {
                    out.push_str("&lt;");
                    i += 1;
                }
            },
            '*' | '_' => match emphasis(rest, c, text[..i].chars().next_back()) {
                Some((html, used)) => {
                    out.push_str(&html);
                    i += used;
                }
                None => {
                    push_char(&mut out, c);
                    i += 1;
                }
            },
            '~' if rest.starts_with("~~") => match delimited(rest, "~~", "del", true) {
                Some((html, used)) => {
                    out.push_str(&html);
                    i += used;
                }
                None => {
                    out.push('~');
                    i += 1;
                }
            },
            _ => {
                push_char(&mut out, c);
                i += c.len_utf8();
            }
        }
    }
    out
}

fn emphasis(text: &str, marker: char, prev: Option<char>) -> Option<(String, usize)> {
    let run = text.chars().take_while(|c| *c == marker).count();
    let (delim, tag) = if run >= 2 {
        (if marker == '*' { "**" } else { "__" }, "strong")
    } else {
        (if marker == '*' { "*" } else { "_" }, "em")
    };
    if marker == '_' && prev.is_some_and(|c| c.is_alphanumeric()) {
        // Snake_case words are not emphasis: `_` must start a word.
        return None;
    }
    delimited(text, delim, tag, marker == '_')
}

fn delimited(text: &str, delim: &str, tag: &str, word_boundary: bool) -> Option<(String, usize)> {
    let start = delim.len();
    let end = text[start..].find(delim)? + start;
    if end == start {
        return None;
    }
    if word_boundary {
        let after = text[end + delim.len()..].chars().next();
        if after.is_some_and(|c| c.is_alphanumeric()) {
            return None;
        }
    }
    let inner = &text[start..end];
    if inner.trim().is_empty() {
        return None;
    }
    Some((
        format!("<{tag}>{}</{tag}>", inline(inner)),
        end + delim.len(),
    ))
}

fn link(text: &str) -> Option<(String, usize)> {
    let close = text.find(']')?;
    if !text[close + 1..].starts_with('(') {
        return None;
    }
    let paren = text[close + 1..].find(')')? + close + 1;
    let label = &text[1..close];
    let target = text[close + 2..paren].trim();
    let url = target.split_whitespace().next().unwrap_or("");
    let html = match safe_url(url, false) {
        Some(safe) => format!("<a href=\"{}\">{}</a>", escape(&safe), inline(label)),
        None => inline(label),
    };
    Some((html, paren + 1))
}

fn image(text: &str) -> Option<(String, usize)> {
    let close = text.find(']')?;
    if !text[close + 1..].starts_with('(') {
        return None;
    }
    let paren = text[close + 1..].find(')')? + close + 1;
    let alt = &text[2..close];
    let target = text[close + 2..paren].trim();
    let url = target.split_whitespace().next().unwrap_or("");
    let html = match safe_url(url, true) {
        Some(safe) => format!("<img src=\"{}\" alt=\"{}\">", escape(&safe), escape(alt)),
        None => escape(alt),
    };
    Some((html, paren + 1))
}

fn autolink(text: &str) -> Option<(String, usize)> {
    let end = text.find('>')?;
    let target = &text[1..end];
    if target.is_empty() || target.chars().any(char::is_whitespace) {
        return None;
    }
    let lower = target.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:"))
    {
        return None;
    }
    let safe = safe_url(target, false)?;
    Some((format!("<a href=\"{}\">{}</a>", escape(&safe), escape(target)), end + 1))
}

fn safe_url(raw: &str, image: bool) -> Option<String> {
    let url = raw.trim().trim_matches(|c| c == '<' || c == '>');
    if url.is_empty() {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("javascript:") || lower.starts_with("vbscript:") {
        return None;
    }
    if lower.starts_with("data:") && !(image && lower.starts_with("data:image/")) {
        return None;
    }
    Some(url.to_string())
}

fn push_char(out: &mut String, c: char) {
    match c {
        '&' => out.push_str("&amp;"),
        '<' => out.push_str("&lt;"),
        '>' => out.push_str("&gt;"),
        '"' => out.push_str("&quot;"),
        '\'' => out.push_str("&#39;"),
        _ => out.push(c),
    }
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        push_char(&mut out, c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_paragraphs_and_rules() {
        let html = render("# Title\n\nHello **world**.\n\n---\n");
        assert!(html.contains("<h1>Title</h1>"));
        assert!(html.contains("<p>Hello <strong>world</strong>.</p>"));
        assert!(html.contains("<hr>"));
    }

    #[test]
    fn escapes_raw_html() {
        let html = render("<script>alert(1)</script>");
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn blocks_code_and_lists() {
        let html = render("- one\n- two\n  - nested\n\n```\nx < y\n```\n");
        assert!(html.contains("<ul>"));
        assert!(html.contains("<ul>\n<li>nested</li>\n</ul>"));
        assert!(html.contains("<pre><code>x &lt; y"));
    }

    #[test]
    fn tables_links_and_images() {
        let html = render(
            "| a | b |\n| :- | -: |\n| 1 | 2 |\n\n[docs](./docs/x.md) ![logo](img/logo.png)\n",
        );
        assert!(html.contains("<th style=\"text-align:left\">a</th>"));
        assert!(html.contains("<td style=\"text-align:right\">2</td>"));
        assert!(html.contains("<a href=\"./docs/x.md\">docs</a>"));
        assert!(html.contains("<img src=\"img/logo.png\" alt=\"logo\">"));
    }

    #[test]
    fn rejects_script_urls() {
        let html = render("[x](javascript:alert(1))");
        assert!(!html.contains("javascript:"));
    }
}
