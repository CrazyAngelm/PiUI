//! Parser for `git status --porcelain=v2 -z --branch` and
//! `git diff --numstat -z`. Paths stay repository-relative with `/`
//! separators exactly as git printed them; a path that is not valid UTF-8,
//! or that contains a control character, is counted but not returned.

use std::collections::HashMap;

/// One status letter of porcelain v2 (`X` for the index, `Y` for the work
/// tree).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusCode {
    Unmodified,
    Modified,
    TypeChanged,
    Added,
    Deleted,
    Renamed,
    Copied,
    Unmerged,
}

impl StatusCode {
    fn from_byte(byte: u8) -> Option<Self> {
        Some(match byte {
            b'.' => Self::Unmodified,
            b'M' => Self::Modified,
            b'T' => Self::TypeChanged,
            b'A' => Self::Added,
            b'D' => Self::Deleted,
            b'R' => Self::Renamed,
            b'C' => Self::Copied,
            b'U' => Self::Unmerged,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StatusEntry {
    /// A tracked path changed in the index (`index`) and/or the work tree
    /// (`worktree`). `intent_to_add` marks `git add -N` entries.
    Changed {
        path: String,
        index: StatusCode,
        worktree: StatusCode,
        submodule: bool,
        intent_to_add: bool,
    },
    /// An unmerged path (a conflict).
    Unmerged {
        path: String,
    },
    Untracked {
        path: String,
    },
}

impl StatusEntry {
    #[must_use]
    pub fn path(&self) -> &str {
        match self {
            Self::Changed { path, .. } | Self::Unmerged { path } | Self::Untracked { path } => path,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StatusReport {
    /// The checked-out branch; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// The commit HEAD names; `None` before the first commit.
    pub head: Option<String>,
    pub entries: Vec<StatusEntry>,
    /// Paths PiUI cannot show (not UTF-8 or containing control characters).
    pub unrepresentable: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusParseError {
    Malformed,
}

/// A path PiUI can show and pass back safely.
#[must_use]
pub fn representable_path(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    if text.is_empty() || text.chars().any(char::is_control) {
        return None;
    }
    Some(text.to_owned())
}

/// Parses `git status --porcelain=v2 -z --branch` output.
///
/// # Errors
///
/// [`StatusParseError::Malformed`] when a record does not follow porcelain v2.
pub fn parse_status(output: &[u8]) -> Result<StatusReport, StatusParseError> {
    let mut report = StatusReport::default();
    let mut records = output.split(|byte| *byte == 0).peekable();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        match record[0] {
            b'#' => {
                let text = std::str::from_utf8(record).map_err(|_| StatusParseError::Malformed)?;
                if let Some(head) = text.strip_prefix("# branch.head ") {
                    report.branch = (head != "(detached)").then(|| head.to_owned());
                } else if let Some(oid) = text.strip_prefix("# branch.oid ") {
                    report.head = (oid != "(initial)").then(|| oid.to_owned());
                }
            }
            b'1' => {
                let fields: Vec<&[u8]> = record.splitn(9, |byte| *byte == b' ').collect();
                let [
                    _,
                    xy,
                    sub,
                    _mode_head,
                    _mode_index,
                    _mode_worktree,
                    _hash_head,
                    _hash_index,
                    path,
                ] = fields.as_slice()
                else {
                    return Err(StatusParseError::Malformed);
                };
                push_changed(&mut report, xy, sub, path)?;
            }
            b'2' => {
                // Renames only appear without `--no-renames`; keep the target.
                let fields: Vec<&[u8]> = record.splitn(10, |byte| *byte == b' ').collect();
                let [_, xy, sub, _, _, _, _, _, _score, path] = fields.as_slice() else {
                    return Err(StatusParseError::Malformed);
                };
                push_changed(&mut report, xy, sub, path)?;
                // The original path is the next NUL-separated field.
                records.next().ok_or(StatusParseError::Malformed)?;
            }
            b'u' => {
                let fields: Vec<&[u8]> = record.splitn(11, |byte| *byte == b' ').collect();
                let Some(path) = fields.get(10).filter(|_| fields.len() == 11) else {
                    return Err(StatusParseError::Malformed);
                };
                match representable_path(path) {
                    Some(path) => report.entries.push(StatusEntry::Unmerged { path }),
                    None => report.unrepresentable += 1,
                }
            }
            b'?' => {
                let path = record
                    .strip_prefix(b"? ")
                    .ok_or(StatusParseError::Malformed)?;
                match representable_path(path) {
                    Some(path) => report.entries.push(StatusEntry::Untracked { path }),
                    None => report.unrepresentable += 1,
                }
            }
            b'!' => {}
            _ => return Err(StatusParseError::Malformed),
        }
    }
    Ok(report)
}

fn push_changed(
    report: &mut StatusReport,
    xy: &[u8],
    sub: &[u8],
    path: &[u8],
) -> Result<(), StatusParseError> {
    let [x, y] = xy else {
        return Err(StatusParseError::Malformed);
    };
    let index = StatusCode::from_byte(*x).ok_or(StatusParseError::Malformed)?;
    let worktree = StatusCode::from_byte(*y).ok_or(StatusParseError::Malformed)?;
    let submodule = sub.first() == Some(&b'S');
    // Only a `git add -N` entry is "added" in the work tree relative to the
    // index.
    let intent_to_add = worktree == StatusCode::Added;
    match representable_path(path) {
        Some(path) => report.entries.push(StatusEntry::Changed {
            path,
            index,
            worktree,
            submodule,
            intent_to_add,
        }),
        None => report.unrepresentable += 1,
    }
    Ok(())
}

/// Added and removed line counts of one path; `None` counts mean binary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineCounts {
    pub added: Option<u64>,
    pub removed: Option<u64>,
}

/// Parses `git diff --numstat -z --no-renames` output.
///
/// # Errors
///
/// [`StatusParseError::Malformed`] for a record without two counts and a path.
pub fn parse_numstat(output: &[u8]) -> Result<HashMap<String, LineCounts>, StatusParseError> {
    let mut counts = HashMap::new();
    for record in output.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&[u8]> = record.splitn(3, |byte| *byte == b'\t').collect();
        let [added, removed, path] = fields.as_slice() else {
            return Err(StatusParseError::Malformed);
        };
        let number = |value: &[u8]| -> Result<Option<u64>, StatusParseError> {
            if value == b"-" {
                return Ok(None);
            }
            std::str::from_utf8(value)
                .ok()
                .and_then(|text| text.parse().ok())
                .map(Some)
                .ok_or(StatusParseError::Malformed)
        };
        let counts_for_path = LineCounts {
            added: number(added)?,
            removed: number(removed)?,
        };
        if let Some(path) = representable_path(path) {
            counts.insert(path, counts_for_path);
        }
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::{LineCounts, StatusCode, StatusEntry, parse_numstat, parse_status};

    #[test]
    fn parses_branch_changes_conflicts_and_untracked_paths() {
        let output = b"# branch.oid 0123456789abcdef0123456789abcdef01234567\0# branch.head main\0\
1 .M N... 100644 100644 100644 aaaa aaaa src/a b.ts\0\
1 M. N... 100644 100644 100644 aaaa bbbb src/staged.ts\0\
1 .A N... 000000 000000 100644 0000 0000 new-intent.txt\0\
1 .M SC.. 160000 160000 160000 aaaa aaaa vendor/lib\0\
u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt\0\
? notes/todo.md\0? \xff\xfe.bin\0";
        let report = parse_status(output).expect("parses porcelain v2");
        assert_eq!(report.branch.as_deref(), Some("main"));
        assert_eq!(
            report.head.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(report.unrepresentable, 1);
        assert_eq!(
            report.entries,
            vec![
                StatusEntry::Changed {
                    path: "src/a b.ts".into(),
                    index: StatusCode::Unmodified,
                    worktree: StatusCode::Modified,
                    submodule: false,
                    intent_to_add: false,
                },
                StatusEntry::Changed {
                    path: "src/staged.ts".into(),
                    index: StatusCode::Modified,
                    worktree: StatusCode::Unmodified,
                    submodule: false,
                    intent_to_add: false,
                },
                StatusEntry::Changed {
                    path: "new-intent.txt".into(),
                    index: StatusCode::Unmodified,
                    worktree: StatusCode::Added,
                    submodule: false,
                    intent_to_add: true,
                },
                StatusEntry::Changed {
                    path: "vendor/lib".into(),
                    index: StatusCode::Unmodified,
                    worktree: StatusCode::Modified,
                    submodule: true,
                    intent_to_add: false,
                },
                StatusEntry::Unmerged {
                    path: "conflict.txt".into()
                },
                StatusEntry::Untracked {
                    path: "notes/todo.md".into()
                },
            ]
        );
    }

    #[test]
    fn detached_and_unborn_heads_are_explicit() {
        let report = parse_status(b"# branch.oid (initial)\0# branch.head (detached)\0")
            .expect("parses headers");
        assert_eq!(report.branch, None);
        assert_eq!(report.head, None);
        assert!(report.entries.is_empty());
    }

    #[test]
    fn rejects_malformed_records_and_skips_control_characters() {
        assert!(parse_status(b"1 .M N... too few\0").is_err());
        assert!(parse_status(b"x unknown\0").is_err());
        let report = parse_status(b"? line\nbreak.txt\0").expect("parses");
        assert!(report.entries.is_empty());
        assert_eq!(report.unrepresentable, 1);
    }

    #[test]
    fn numstat_reports_text_and_binary_counts() {
        let counts = parse_numstat(b"3\t1\tsrc/a b.ts\0-\t-\timage.png\0").expect("parses numstat");
        assert_eq!(
            counts.get("src/a b.ts"),
            Some(&LineCounts {
                added: Some(3),
                removed: Some(1)
            })
        );
        assert_eq!(
            counts.get("image.png"),
            Some(&LineCounts {
                added: None,
                removed: None
            })
        );
        assert!(parse_numstat(b"x\t1\tfile\0").is_err());
    }
}
