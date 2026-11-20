use crate::paths;
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

const MAX_VISITED: usize = 250_000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub name: String,
    pub path: String,
    pub parent: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub ext: String,
    pub kind: String,
    pub match_range: Option<[usize; 2]>,
}

#[derive(Serialize)]
pub struct NameMatch {
    index: usize,
    range: Option<[usize; 2]>,
}

struct Match {
    score: i32,
    range: Option<[usize; 2]>,
}

struct NameMatcher {
    fuzzy: Option<String>,
    patterns: Vec<Regex>,
}

impl NameMatcher {
    fn new(query: &str, wildcards: bool, regex: bool) -> Result<Self, String> {
        if !wildcards && !regex {
            return Ok(Self {
                fuzzy: Some(query.to_lowercase()),
                patterns: Vec::new(),
            });
        }
        if query.len() > 4096 {
            return Err("Search patterns are limited to 4096 bytes.".to_string());
        }
        let mut patterns = Vec::new();
        if wildcards {
            let query = if query == "*.*" { "*" } else { query };
            let mut pattern = String::from(r"\A(?:");
            for ch in query.chars() {
                match ch {
                    '*' => pattern.push_str(".*"),
                    '?' => pattern.push('.'),
                    _ => pattern.push_str(&regex::escape(&ch.to_string())),
                }
            }
            pattern.push_str(r")\z");
            patterns.push(
                RegexBuilder::new(&pattern)
                    .case_insensitive(true)
                    .dot_matches_new_line(true)
                    .size_limit(2 * 1024 * 1024)
                    .build()
                    .map_err(|error| format!("Invalid wildcard pattern: {error}"))?,
            );
        }
        if regex {
            match RegexBuilder::new(query)
                .case_insensitive(true)
                .size_limit(2 * 1024 * 1024)
                .build()
            {
                Ok(pattern) => patterns.push(pattern),
                Err(error) if !wildcards => {
                    return Err(format!("Invalid regular expression: {error}"))
                }
                Err(_) => {}
            }
        }
        Ok(Self {
            fuzzy: None,
            patterns,
        })
    }

    fn find(&self, name: &str) -> Option<Match> {
        if let Some(query) = &self.fuzzy {
            return score(name, query).map(|score| Match { score, range: None });
        }
        self.patterns.iter().find_map(|pattern| {
            let found = pattern.find(name)?;
            let start = name[..found.start()].encode_utf16().count();
            let end = start + found.as_str().encode_utf16().count();
            Some(Match {
                score: if found.start() == 0 && found.end() == name.len() {
                    2_000
                } else {
                    1_200 - start as i32
                },
                range: Some([start, end]),
            })
        })
    }
}

fn match_names(
    names: &[String],
    query: &str,
    wildcards: bool,
    regex: bool,
) -> Result<Vec<NameMatch>, String> {
    let matcher = NameMatcher::new(query.trim(), wildcards, regex)?;
    Ok(names
        .iter()
        .enumerate()
        .filter_map(|(index, name)| {
            matcher.find(name).map(|found| NameMatch {
                index,
                range: found.range,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn filter_names(
    names: Vec<String>,
    query: String,
    wildcards: bool,
    regex: bool,
) -> Result<Vec<NameMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || match_names(&names, &query, wildcards, regex))
        .await
        .map_err(|error| format!("Filtering failed: {error}"))?
}

fn score(name: &str, query: &str) -> Option<i32> {
    let lower = name.to_lowercase();
    if lower == query {
        return Some(2_000);
    }
    if lower.starts_with(query) {
        return Some(1_600 - name.len() as i32);
    }
    if let Some(pos) = lower.find(query) {
        return Some(1_200 - pos as i32);
    }
    let mut chars = lower.chars();
    let mut matched = 0i32;
    for q in query.chars() {
        if chars.any(|c| c == q) {
            matched += 1;
        } else {
            return None;
        }
    }
    Some(400 + matched * 8 - name.len() as i32)
}

fn walk(
    root: &PathBuf,
    matcher: &NameMatcher,
    limit: usize,
    include_hidden: bool,
) -> Vec<SearchHit> {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(!include_hidden)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .follow_links(false)
        .same_file_system(true)
        .max_depth(Some(16));

    let mut scored: Vec<(i32, SearchHit)> = Vec::new();
    let mut visited = 0usize;

    for result in builder.build() {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        visited += 1;
        if visited > MAX_VISITED {
            break;
        }
        if entry.depth() == 0 {
            continue;
        }
        let name = match entry.file_name().to_str() {
            Some(n) => n.to_string(),
            None => entry.file_name().to_string_lossy().into_owned(),
        };
        let Some(found) = matcher.find(&name) else {
            continue;
        };
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let ext = if is_dir {
            String::new()
        } else {
            paths::ext_of(&name)
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        scored.push((
            found.score,
            SearchHit {
                name,
                path: paths::text(path),
                parent: path
                    .parent()
                    .map(paths::text)
                    .unwrap_or_else(|| paths::text(root)),
                is_dir,
                size: if is_dir { 0 } else { meta.len() },
                modified,
                kind: paths::classify(&ext, is_dir).to_string(),
                ext,
                match_range: found.range,
            },
        ));
        if scored.len() > limit * 6 {
            scored.sort_by(|a, b| b.0.cmp(&a.0));
            scored.truncate(limit * 2);
        }
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    scored.truncate(limit);
    scored.into_iter().map(|(_, hit)| hit).collect()
}

#[tauri::command]
pub async fn search_files(
    path: String,
    query: String,
    limit: Option<usize>,
    include_hidden: Option<bool>,
    wildcards: bool,
    regex: bool,
) -> Result<Vec<SearchHit>, String> {
    let root = paths::resolve_dir(&path)?;
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(300).clamp(1, 2_000);
    let include_hidden = include_hidden.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let matcher = NameMatcher::new(&query, wildcards, regex)?;
        Ok(walk(&root, &matcher, limit, include_hidden))
    })
    .await
    .map_err(|e| format!("Search failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_fuzzy_search_when_patterns_are_disabled() {
        let matcher = NameMatcher::new("RPT", false, false).unwrap();
        assert!(matcher.find("report.txt").is_some());
        assert!(matcher.find("notes.md").is_none());
        assert!(NameMatcher::new("*.txt", false, false)
            .unwrap()
            .find("report.txt")
            .is_none());
    }

    #[test]
    fn wildcards_match_the_whole_name_case_insensitively() {
        let matcher = NameMatcher::new("report?.txt", true, false).unwrap();
        for name in ["REPORT1.TXT", "reporté.txt", "report\u{1D11E}.txt"] {
            assert!(matcher.find(name).is_some(), "{name}");
        }
        for name in [
            "report.txt",
            "report12.txt",
            "prefix-report1.txt",
            "report1.txt.bak",
        ] {
            assert!(matcher.find(name).is_none(), "{name}");
        }
        let matcher = NameMatcher::new("*.txt", true, false).unwrap();
        assert!(matcher.find("report.txt").is_some());
        assert!(matcher.find("report.txt.bak").is_none());
        assert!(NameMatcher::new("a?b", true, false)
            .unwrap()
            .find("a\nb")
            .is_some());
    }

    #[test]
    fn dos_star_dot_star_includes_extensionless_names() {
        let matcher = NameMatcher::new("*.*", true, false).unwrap();
        for name in ["README", "folder", "report.txt", ".gitignore"] {
            assert!(matcher.find(name).is_some());
        }
    }

    #[test]
    fn wildcard_mode_escapes_regex_punctuation() {
        let matcher = NameMatcher::new("invoice[1].*", true, false).unwrap();
        assert!(matcher.find("invoice[1].txt").is_some());
        assert!(matcher.find("invoice1.txt").is_none());
        assert!(NameMatcher::new("(a)+$.txt", true, false)
            .unwrap()
            .find("(a)+$.txt")
            .is_some());
    }

    #[test]
    fn regex_supports_anchors_classes_and_original_escape_case() {
        let matcher = NameMatcher::new(r"^report[0-9]+\.txt$", false, true).unwrap();
        assert!(matcher.find("REPORT12.TXT").is_some());
        assert!(matcher.find("reportA.txt").is_none());
        assert!(matcher.find("report12.txt.bak").is_none());
        let matcher = NameMatcher::new(r"^\D+$", false, true).unwrap();
        assert!(matcher.find("README").is_some());
        assert!(matcher.find("report1").is_none());
        assert!(NameMatcher::new("port", false, true)
            .unwrap()
            .find("report.txt")
            .is_some());
    }

    #[test]
    fn combined_modes_match_either_interpretation() {
        let matcher = NameMatcher::new("file?.txt", true, true).unwrap();
        assert!(matcher.find("fileA.txt").is_some());
        assert!(matcher.find("fil.txt").is_some());
        assert!(matcher.find("other.md").is_none());
        assert!(NameMatcher::new("*.txt", true, true)
            .unwrap()
            .find("notes.txt")
            .is_some());
        assert!(NameMatcher::new(r"^report\d+\.txt$", true, true)
            .unwrap()
            .find("report42.txt")
            .is_some());
        assert!(NameMatcher::new("[", true, true)
            .unwrap()
            .find("[")
            .is_some());
    }

    #[test]
    fn invalid_or_excessive_regex_patterns_return_errors() {
        for query in ["[", "*", r"(a)\1", "(?=a)", "a{999999999}"] {
            assert!(NameMatcher::new(query, false, true).is_err(), "{query}");
        }
        assert!(NameMatcher::new(&"a".repeat(4097), true, false).is_err());
        let matcher = NameMatcher::new("^(a+)+$", false, true).unwrap();
        assert!(matcher.find(&("a".repeat(10000) + "!")).is_none());
    }

    #[test]
    fn match_ranges_use_utf16_and_allow_zero_width_matches() {
        let matcher = NameMatcher::new("report", false, true).unwrap();
        assert_eq!(matcher.find("\u{1D11E}report.txt").unwrap().range, Some([2, 8]));
        assert_eq!(
            NameMatcher::new("^", false, true)
                .unwrap()
                .find("name")
                .unwrap()
                .range,
            Some([0, 0])
        );
        let matches = match_names(
            &["other.md".into(), "\u{1D11E}report.txt".into()],
            "report",
            false,
            true,
        )
        .unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].index, 1);
        assert_eq!(matches[0].range, Some([2, 8]));
    }

    #[test]
    fn recursive_and_local_matching_agree() {
        let root = std::env::temp_dir().join(format!("altfe-search-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        for name in ["report1.txt", "reportA.txt", "README", "notes.md"] {
            std::fs::write(root.join(name), b"fixture").unwrap();
        }
        std::fs::write(root.join("nested/report2.txt"), b"nested").unwrap();
        let names: Vec<String> = [
            "nested",
            "report1.txt",
            "reportA.txt",
            "README",
            "notes.md",
            "report2.txt",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        for (query, wildcards, regex) in [
            ("rpt", false, false),
            ("*.*", true, false),
            (r"^report\d+\.txt$", false, true),
            ("*.txt", true, true),
        ] {
            let matcher = NameMatcher::new(query, wildcards, regex).unwrap();
            let hits = walk(&root, &matcher, 100, false);
            let local = match_names(&names, query, wildcards, regex).unwrap();
            let mut actual: Vec<_> = hits.iter().map(|hit| hit.name.as_str()).collect();
            let mut expected: Vec<_> = local
                .iter()
                .map(|found| names[found.index].as_str())
                .collect();
            actual.sort();
            expected.sort();
            assert_eq!(actual, expected);
            assert!(walk(&root, &matcher, 1, false).len() <= 1);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
