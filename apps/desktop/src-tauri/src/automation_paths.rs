//! Project-relative path patterns for "files changed" automations (v7.2).
//!
//! A pattern is a small glob over `/`-separated paths relative to the project
//! folder: `*` and `?` stay inside one folder name, `**` is any number of
//! folders, `[a-z]`/`[!a]` are character classes and `{ts,svelte}` lists
//! alternatives. A pattern without a slash matches a file or folder name at
//! any depth (`*.md`); one with a slash is anchored at the project folder
//! (`src/**/*.ts`). A pattern that matches a folder also matches everything
//! inside it. Validation is shared by save and enable; `host-api/triggerPatterns.ts`
//! mirrors it for the editor with the same fixtures.

/// Most include or exclude patterns one automation may store.
pub(crate) const MAX_PATTERNS: usize = 32;
/// Longest pattern in bytes.
pub(crate) const MAX_PATTERN_BYTES: usize = 256;
/// Brace alternatives one pattern may expand to.
const MAX_ALTERNATIVES: usize = 64;

/// Why a pattern was refused. The codes are the IPC-free vocabulary the
/// editor mirrors; the host itself only answers `invalid`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PatternError {
    Empty,
    TooLong,
    Control,
    Backslash,
    Absolute,
    DotSegment,
    EmptySegment,
    DoubleStar,
    Bracket,
    Brace,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Token {
    Literal(char),
    Any,
    One,
    Class {
        negated: bool,
        items: Vec<ClassItem>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ClassItem {
    Char(char),
    Range(char, char),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Segment {
    /// `**`: zero or more folder names.
    Globstar,
    Glob(Vec<Token>),
}

/// One validated pattern, brace-expanded into anchored alternatives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PathPattern {
    alternatives: Vec<Vec<Segment>>,
}

impl PathPattern {
    pub(crate) fn parse(text: &str) -> Result<Self, PatternError> {
        if text.trim().is_empty() {
            return Err(PatternError::Empty);
        }
        if text.len() > MAX_PATTERN_BYTES {
            return Err(PatternError::TooLong);
        }
        if text.chars().any(char::is_control) {
            return Err(PatternError::Control);
        }
        if text.contains('\\') {
            return Err(PatternError::Backslash);
        }
        let bytes = text.as_bytes();
        if text.starts_with('/')
            || text.starts_with('~')
            || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        {
            return Err(PatternError::Absolute);
        }
        let body = text.strip_suffix('/').unwrap_or(text);
        let anchored = body.contains('/');
        let mut alternatives = Vec::new();
        for expanded in expand_braces(body)? {
            let mut segments = Vec::new();
            if !anchored {
                segments.push(Segment::Globstar);
            }
            for part in expanded.split('/') {
                segments.push(parse_segment(part)?);
            }
            alternatives.push(segments);
        }
        Ok(Self { alternatives })
    }

    /// Whether a project-relative `/`-separated path, or one of the folders
    /// that contain it, matches. `fold_case` compares ASCII case-insensitively.
    pub(crate) fn matches(&self, path: &str, fold_case: bool) -> bool {
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        if parts.is_empty() {
            return false;
        }
        self.alternatives.iter().any(|segments| {
            (1..=parts.len()).any(|end| match_segments(segments, &parts[..end], fold_case))
        })
    }
}

/// Parses and checks a whole list, as a trigger stores it.
pub(crate) fn parse_patterns(values: &[String]) -> Result<Vec<PathPattern>, PatternError> {
    values
        .iter()
        .map(|value| PathPattern::parse(value))
        .collect()
}

/// Case folding follows the file system convention of the host platform.
pub(crate) fn platform_folds_case() -> bool {
    cfg!(any(windows, target_os = "macos"))
}

fn expand_braces(text: &str) -> Result<Vec<String>, PatternError> {
    let Some(open) = text.find('{') else {
        if text.contains('}') {
            return Err(PatternError::Brace);
        }
        return Ok(vec![text.to_owned()]);
    };
    let close = text[open..]
        .find('}')
        .map(|offset| open + offset)
        .ok_or(PatternError::Brace)?;
    let inner = &text[open + 1..close];
    if inner.contains('{') || inner.contains('/') {
        return Err(PatternError::Brace);
    }
    let options: Vec<&str> = inner.split(',').collect();
    if options.len() < 2 || options.iter().any(|option| option.is_empty()) {
        return Err(PatternError::Brace);
    }
    let prefix = &text[..open];
    if prefix.contains('}') {
        return Err(PatternError::Brace);
    }
    let mut result = Vec::new();
    for rest in expand_braces(&text[close + 1..])? {
        for option in &options {
            result.push(format!("{prefix}{option}{rest}"));
            if result.len() > MAX_ALTERNATIVES {
                return Err(PatternError::Brace);
            }
        }
    }
    Ok(result)
}

fn parse_segment(part: &str) -> Result<Segment, PatternError> {
    if part.is_empty() {
        return Err(PatternError::EmptySegment);
    }
    if part == "." || part == ".." {
        return Err(PatternError::DotSegment);
    }
    if part == "**" {
        return Ok(Segment::Globstar);
    }
    if part.contains("**") {
        return Err(PatternError::DoubleStar);
    }
    let mut tokens = Vec::new();
    let mut chars = part.chars().peekable();
    while let Some(current) = chars.next() {
        match current {
            '*' => tokens.push(Token::Any),
            '?' => tokens.push(Token::One),
            ']' => return Err(PatternError::Bracket),
            '[' => {
                let negated = matches!(chars.peek(), Some('!' | '^'));
                if negated {
                    chars.next();
                }
                let mut items = Vec::new();
                let mut closed = false;
                while let Some(item) = chars.next() {
                    if item == ']' {
                        closed = true;
                        break;
                    }
                    if item == '[' {
                        return Err(PatternError::Bracket);
                    }
                    if chars.peek() == Some(&'-') {
                        chars.next();
                        match chars.next() {
                            Some(']') | None => return Err(PatternError::Bracket),
                            Some(end) if end < item => return Err(PatternError::Bracket),
                            Some(end) => items.push(ClassItem::Range(item, end)),
                        }
                    } else {
                        items.push(ClassItem::Char(item));
                    }
                }
                if !closed || items.is_empty() {
                    return Err(PatternError::Bracket);
                }
                tokens.push(Token::Class { negated, items });
            }
            other => tokens.push(Token::Literal(other)),
        }
    }
    Ok(Segment::Glob(tokens))
}

fn match_segments(segments: &[Segment], parts: &[&str], fold_case: bool) -> bool {
    match segments.split_first() {
        None => parts.is_empty(),
        Some((Segment::Globstar, rest)) => {
            (0..=parts.len()).any(|skip| match_segments(rest, &parts[skip..], fold_case))
        }
        Some((Segment::Glob(tokens), rest)) => match parts.split_first() {
            Some((part, remaining)) => {
                let name: Vec<char> = part.chars().collect();
                match_tokens(tokens, &name, fold_case) && match_segments(rest, remaining, fold_case)
            }
            None => false,
        },
    }
}

fn same(left: char, right: char, fold_case: bool) -> bool {
    left == right || (fold_case && left.eq_ignore_ascii_case(&right))
}

fn in_class(items: &[ClassItem], value: char, fold_case: bool) -> bool {
    let candidates = if fold_case {
        [value.to_ascii_lowercase(), value.to_ascii_uppercase()]
    } else {
        [value, value]
    };
    items.iter().any(|item| {
        candidates.iter().any(|candidate| match item {
            ClassItem::Char(expected) => same(*expected, *candidate, fold_case),
            ClassItem::Range(start, end) => (*start..=*end).contains(candidate),
        })
    })
}

/// Classic wildcard matching with a single backtrack point for `*`.
fn match_tokens(tokens: &[Token], name: &[char], fold_case: bool) -> bool {
    let (mut token, mut position) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while position < name.len() {
        let matched = match tokens.get(token) {
            Some(Token::Literal(expected)) => same(*expected, name[position], fold_case),
            Some(Token::One) => true,
            Some(Token::Class { negated, items }) => {
                in_class(items, name[position], fold_case) != *negated
            }
            Some(Token::Any) => {
                star = Some((token, position));
                token += 1;
                continue;
            }
            None => false,
        };
        if matched {
            token += 1;
            position += 1;
        } else if let Some((star_token, star_position)) = star {
            token = star_token + 1;
            position = star_position + 1;
            star = Some((star_token, star_position + 1));
        } else {
            return false;
        }
    }
    tokens[token..].iter().all(|item| *item == Token::Any)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(pattern: &str, path: &str) -> bool {
        PathPattern::parse(pattern)
            .expect("valid fixture pattern")
            .matches(path, false)
    }

    #[test]
    fn patterns_without_a_slash_match_names_at_any_depth() {
        assert!(matches("*.md", "README.md"));
        assert!(matches("*.md", "docs/guide/setup.md"));
        assert!(!matches("*.md", "docs/guide/setup.mdx"));
        // A matching folder name covers everything inside it.
        assert!(matches("fixtures", "tests/fixtures/data.json"));
        assert!(!matches("fixtures", "tests/fixture/data.json"));
    }

    #[test]
    fn slashes_anchor_at_the_project_folder() {
        assert!(matches("src/*.ts", "src/main.ts"));
        assert!(!matches("src/*.ts", "lib/src/main.ts"));
        assert!(!matches("src/*.ts", "src/app/main.ts"));
        assert!(matches("src/**/*.ts", "src/main.ts"));
        assert!(matches("src/**/*.ts", "src/app/deep/main.ts"));
        assert!(matches("docs/", "docs/a/b.txt"));
        assert!(matches("docs/**", "docs/a.txt"));
        assert!(!matches("docs/**", "other/docs.txt"));
    }

    #[test]
    fn classes_alternatives_and_single_characters() {
        assert!(matches("src/**/*.{ts,svelte}", "src/app/View.svelte"));
        assert!(matches("src/**/*.{ts,svelte}", "src/app/view.ts"));
        assert!(!matches("src/**/*.{ts,svelte}", "src/app/view.js"));
        assert!(matches("log[0-9].txt", "log7.txt"));
        assert!(!matches("log[!0-9].txt", "log7.txt"));
        assert!(matches("log[!0-9].txt", "logx.txt"));
        assert!(matches("?.rs", "a.rs"));
        assert!(!matches("?.rs", "ab.rs"));
        assert!(matches("a*b*c", "a-long-b-and-c"));
        assert!(!matches("a*b*c", "a-long-b-and-d"));
    }

    /// The editor's `triggerPatterns.ts` reads the same file.
    #[test]
    fn shared_fixtures_agree_with_the_editor() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/fixtures/trigger-patterns-v7.json"
        ))
        .expect("fixture JSON");
        let code = |error: PatternError| match error {
            PatternError::Empty => "empty",
            PatternError::TooLong => "too-long",
            PatternError::Control => "control",
            PatternError::Backslash => "backslash",
            PatternError::Absolute => "absolute",
            PatternError::DotSegment => "dot-segment",
            PatternError::EmptySegment => "empty-segment",
            PatternError::DoubleStar => "double-star",
            PatternError::Bracket => "bracket",
            PatternError::Brace => "brace",
        };
        for valid in fixtures["valid"].as_array().expect("valid list") {
            let pattern = valid.as_str().expect("pattern");
            assert!(PathPattern::parse(pattern).is_ok(), "{pattern:?}");
        }
        for entry in fixtures["invalid"].as_array().expect("invalid list") {
            let pattern = entry[0].as_str().expect("pattern");
            let expected = entry[1].as_str().expect("code");
            assert_eq!(
                PathPattern::parse(pattern).map_err(code),
                Err(expected),
                "{pattern:?}"
            );
        }
        for entry in fixtures["matches"].as_array().expect("match list") {
            let (pattern, path) = (
                entry[0].as_str().expect("pattern"),
                entry[1].as_str().expect("path"),
            );
            assert_eq!(
                matches(pattern, path),
                entry[2].as_bool().expect("expected"),
                "{pattern:?} vs {path:?}"
            );
        }
    }

    #[test]
    fn case_folding_is_explicit() {
        let pattern = PathPattern::parse("*.MD").expect("valid");
        assert!(!pattern.matches("readme.md", false));
        assert!(pattern.matches("readme.md", true));
        let class = PathPattern::parse("[a-c].txt").expect("valid");
        assert!(class.matches("B.txt", true));
        assert!(!class.matches("B.txt", false));
    }

    #[test]
    fn unsafe_or_ambiguous_patterns_are_refused_with_a_reason() {
        for (pattern, error) in [
            ("", PatternError::Empty),
            ("   ", PatternError::Empty),
            ("/etc/passwd", PatternError::Absolute),
            ("C:/Windows/*.dll", PatternError::Absolute),
            ("~/notes.md", PatternError::Absolute),
            ("src\\*.ts", PatternError::Backslash),
            ("../outside/*", PatternError::DotSegment),
            ("./src/*.ts", PatternError::DotSegment),
            ("src/../x", PatternError::DotSegment),
            ("src//a.ts", PatternError::EmptySegment),
            ("src/a**.ts", PatternError::DoubleStar),
            ("log[.txt", PatternError::Bracket),
            ("log].txt", PatternError::Bracket),
            ("log[].txt", PatternError::Bracket),
            ("log[z-a].txt", PatternError::Bracket),
            ("*.{ts", PatternError::Brace),
            ("*.{ts}", PatternError::Brace),
            ("*.{ts,}", PatternError::Brace),
            ("{a,{b,c}}", PatternError::Brace),
            ("{src/a,lib}/x", PatternError::Brace),
            ("a\u{7}b", PatternError::Control),
        ] {
            assert_eq!(PathPattern::parse(pattern), Err(error), "{pattern:?}");
        }
        assert_eq!(
            PathPattern::parse(&"a".repeat(MAX_PATTERN_BYTES + 1)),
            Err(PatternError::TooLong)
        );
        let many = format!("{}.x", "{a,b}".repeat(7));
        assert_eq!(PathPattern::parse(&many), Err(PatternError::Brace));
        assert!(parse_patterns(&["*.md".into(), "src/**".into()]).is_ok());
        assert!(parse_patterns(&["*.md".into(), String::new()]).is_err());
    }
}
