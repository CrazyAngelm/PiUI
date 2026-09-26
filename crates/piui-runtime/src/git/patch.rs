//! Structure of one path's `git diff --binary --full-index` output and the
//! exact patches PiUI applies back with `git apply`.
//!
//! The review shows this output; staging, unstaging or reverting replays the
//! same bytes (the whole output, or one hunk of it with its file header), so
//! git never receives anything the person did not see. The SHA-256 of the
//! output is the fingerprint a later action must still match.

use sha2::{Digest, Sha256};
use std::ops::Range;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatchError {
    /// The output does not follow git's diff grammar.
    Malformed,
    /// The requested hunk does not exist.
    NoSuchHunk,
    /// Hunks of this change cannot be applied one at a time (a new, deleted
    /// or binary file, or more than one file section).
    WholeFileOnly,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    range: Range<usize>,
    pub old_start: u64,
    pub old_lines: u64,
    pub new_start: u64,
    pub new_lines: u64,
    pub added: u64,
    pub removed: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Section {
    range: Range<usize>,
    diff_line: Range<usize>,
    old_path_line: Option<Range<usize>>,
    new_path_line: Option<Range<usize>>,
    pub new_file: bool,
    pub deleted_file: bool,
    pub mode_change: bool,
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

/// One path's diff output, parsed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FilePatch {
    raw: Vec<u8>,
    sections: Vec<Section>,
}

/// Line ranges including their `\n`.
fn line_ranges(raw: &[u8]) -> Vec<Range<usize>> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, byte) in raw.iter().enumerate() {
        if *byte == b'\n' {
            lines.push(start..index + 1);
            start = index + 1;
        }
    }
    if start < raw.len() {
        lines.push(start..raw.len());
    }
    lines
}

/// `@@ -a[,b] +c[,d] @@…` → (a, b, c, d); a missing count is 1.
fn hunk_header(line: &[u8]) -> Option<(u64, u64, u64, u64)> {
    let text = std::str::from_utf8(line).ok()?;
    let rest = text.strip_prefix("@@ -")?;
    let (ranges, _) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let parse = |range: &str| -> Option<(u64, u64)> {
        match range.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((range.parse().ok()?, 1)),
        }
    };
    let (old_start, old_lines) = parse(old)?;
    let (new_start, new_lines) = parse(new)?;
    Some((old_start, old_lines, new_start, new_lines))
}

impl FilePatch {
    /// Parses the diff output of one path. Empty output is an empty patch.
    ///
    /// # Errors
    ///
    /// [`PatchError::Malformed`] when the output is not a git diff.
    pub fn parse(raw: Vec<u8>) -> Result<Self, PatchError> {
        let lines = line_ranges(&raw);
        let starts = |index: usize, prefix: &[u8]| {
            lines
                .get(index)
                .is_some_and(|range| raw[range.clone()].starts_with(prefix))
        };
        let mut sections = Vec::new();
        let mut index = 0;
        while index < lines.len() {
            if !starts(index, b"diff --git ") {
                return Err(PatchError::Malformed);
            }
            let mut section = Section {
                diff_line: lines[index].clone(),
                ..Section::default()
            };
            let section_start = lines[index].start;
            index += 1;
            // Extended header lines up to the first hunk or the next section.
            while index < lines.len() && !starts(index, b"diff --git ") && !starts(index, b"@@ ") {
                let line = &raw[lines[index].clone()];
                if line.starts_with(b"GIT binary patch") {
                    section.binary = true;
                    index += 1;
                    while index < lines.len() && !starts(index, b"diff --git ") {
                        index += 1;
                    }
                    break;
                }
                if line.starts_with(b"Binary files ") {
                    section.binary = true;
                } else if line.starts_with(b"new file mode ") {
                    section.new_file = true;
                } else if line.starts_with(b"deleted file mode ") {
                    section.deleted_file = true;
                } else if line.starts_with(b"old mode ") || line.starts_with(b"new mode ") {
                    section.mode_change = true;
                } else if line.starts_with(b"--- ") {
                    section.old_path_line = Some(lines[index].clone());
                } else if line.starts_with(b"+++ ") {
                    section.new_path_line = Some(lines[index].clone());
                }
                index += 1;
            }
            while starts(index, b"@@ ") {
                let (old_start, old_lines, new_start, new_lines) =
                    hunk_header(&raw[lines[index].clone()]).ok_or(PatchError::Malformed)?;
                let hunk_start = lines[index].start;
                index += 1;
                let (mut old_left, mut new_left) = (old_lines, new_lines);
                let (mut added, mut removed) = (0_u64, 0_u64);
                while (old_left > 0 || new_left > 0) && index < lines.len() {
                    let line = &raw[lines[index].clone()];
                    match line.first() {
                        // An empty line is blank context (`diff.suppressBlankEmpty`).
                        Some(b' ' | b'\n') => {
                            old_left = old_left.checked_sub(1).ok_or(PatchError::Malformed)?;
                            new_left = new_left.checked_sub(1).ok_or(PatchError::Malformed)?;
                        }
                        Some(b'-') => {
                            old_left = old_left.checked_sub(1).ok_or(PatchError::Malformed)?;
                            removed += 1;
                        }
                        Some(b'+') => {
                            new_left = new_left.checked_sub(1).ok_or(PatchError::Malformed)?;
                            added += 1;
                        }
                        Some(b'\\') => {}
                        _ => return Err(PatchError::Malformed),
                    }
                    index += 1;
                }
                // "\ No newline at end of file" after the last line.
                while starts(index, b"\\") {
                    index += 1;
                }
                if old_left != 0 || new_left != 0 {
                    return Err(PatchError::Malformed);
                }
                let hunk_end = lines[index - 1].end;
                section.hunks.push(Hunk {
                    range: hunk_start..hunk_end,
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    added,
                    removed,
                });
            }
            let section_end = lines.get(index).map_or(raw.len(), |line| line.start);
            section.range = section_start..section_end;
            sections.push(section);
        }
        Ok(Self { raw, sections })
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.sections.is_empty()
    }

    #[must_use]
    pub fn sections(&self) -> &[Section] {
        &self.sections
    }

    /// The exact bytes git printed; applying them replays the whole change.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.raw
    }

    /// Lowercase hex SHA-256 of the exact output.
    #[must_use]
    pub fn fingerprint(&self) -> String {
        sha256_hex(&self.raw)
    }

    #[must_use]
    pub fn binary(&self) -> bool {
        self.sections.iter().any(|section| section.binary)
    }

    /// Added and removed lines over every text hunk.
    #[must_use]
    pub fn line_counts(&self) -> (u64, u64) {
        self.sections
            .iter()
            .flat_map(|section| section.hunks.iter())
            .fold((0, 0), |(added, removed), hunk| {
                (added + hunk.added, removed + hunk.removed)
            })
    }

    /// Whether single hunks can be applied: one text section of a file that
    /// exists on both sides.
    #[must_use]
    pub fn hunks_selectable(&self) -> bool {
        matches!(self.sections.as_slice(), [section]
            if !section.binary
                && !section.new_file
                && !section.deleted_file
                && section.old_path_line.is_some()
                && section.new_path_line.is_some()
                && !section.hunks.is_empty())
    }

    #[must_use]
    pub fn hunk_count(&self) -> usize {
        self.sections
            .iter()
            .map(|section| section.hunks.len())
            .sum()
    }

    /// The patch of hunk `index` alone: its file's `diff --git`, `---` and
    /// `+++` lines followed by the hunk, byte for byte.
    ///
    /// # Errors
    ///
    /// [`PatchError::WholeFileOnly`] when hunks are not selectable and
    /// [`PatchError::NoSuchHunk`] for an index out of range.
    pub fn hunk_patch(&self, index: usize) -> Result<Vec<u8>, PatchError> {
        if !self.hunks_selectable() {
            return Err(PatchError::WholeFileOnly);
        }
        let [section] = self.sections.as_slice() else {
            return Err(PatchError::WholeFileOnly);
        };
        let hunk = section.hunks.get(index).ok_or(PatchError::NoSuchHunk)?;
        let (Some(old), Some(new)) = (&section.old_path_line, &section.new_path_line) else {
            return Err(PatchError::WholeFileOnly);
        };
        let mut patch = Vec::with_capacity(hunk.range.len() + 256);
        for range in [&section.diff_line, old, new] {
            patch.extend_from_slice(&self.raw[range.clone()]);
            if !patch.ends_with(b"\n") {
                patch.push(b'\n');
            }
        }
        patch.extend_from_slice(&self.raw[hunk.range.clone()]);
        if !patch.ends_with(b"\n") {
            patch.push(b'\n');
        }
        Ok(patch)
    }

    /// Display text without `index` lines (full object ids help nobody) and
    /// without binary patch data. `None` when longer than `limit` bytes.
    #[must_use]
    pub fn display_text(&self, limit: usize) -> Option<String> {
        let mut text = Vec::new();
        for section in &self.sections {
            let body = &self.raw[section.range.clone()];
            for line in line_ranges(body) {
                let line = &body[line];
                if line.starts_with(b"index ") {
                    continue;
                }
                if line.starts_with(b"GIT binary patch") {
                    break;
                }
                text.extend_from_slice(line);
                if text.len() > limit {
                    return None;
                }
            }
        }
        Some(String::from_utf8_lossy(&text).into_owned())
    }
}

#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Whether bytes look binary the way git decides it (a NUL in the first
/// 8000 bytes).
#[must_use]
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|byte| *byte == 0)
}

/// A new-file unified diff of `content` for display (untracked files).
#[must_use]
pub fn new_file_display(path: &str, content: &[u8]) -> String {
    let text = String::from_utf8_lossy(content);
    let mut lines: Vec<&str> = text.split_inclusive('\n').collect();
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let mut output = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n"
    );
    if lines.is_empty() {
        return output;
    }
    output.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
    for line in &lines {
        output.push('+');
        output.push_str(line);
    }
    if !output.ends_with('\n') {
        output.push_str("\n\\ No newline at end of file\n");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{FilePatch, PatchError, new_file_display};

    const TWO_HUNKS: &[u8] = b"diff --git a/f.txt b/f.txt
index 988f966cfe39e3bb7abbb8b5be995f757de47fa1..9ecff16d0d07dbc3ca2ab2d89248c55483b2927e 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,4 @@
-a
+A
 b
 c
 d
@@ -10,4 +10,4 @@ i
 j
 k
 l
-m
+M
";

    #[test]
    fn parses_hunks_and_builds_single_hunk_patches_byte_for_byte() {
        let patch = FilePatch::parse(TWO_HUNKS.to_vec()).expect("parses diff");
        assert!(patch.hunks_selectable());
        assert_eq!(patch.hunk_count(), 2);
        assert_eq!(patch.line_counts(), (2, 2));
        let second = patch.hunk_patch(1).expect("second hunk");
        assert_eq!(
            String::from_utf8(second).expect("utf8"),
            "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -10,4 +10,4 @@ i\n j\n k\n l\n-m\n+M\n"
        );
        assert_eq!(patch.hunk_patch(2), Err(PatchError::NoSuchHunk));
        let display = patch.display_text(1 << 20).expect("display");
        assert!(!display.contains("index "));
        assert!(display.starts_with("diff --git a/f.txt b/f.txt\n--- a/f.txt"));
        assert_eq!(patch.display_text(10), None);
        assert_eq!(patch.fingerprint().len(), 64);
    }

    #[test]
    fn no_newline_markers_and_blank_context_stay_inside_their_hunk() {
        let raw = b"diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
        let patch = FilePatch::parse(raw.to_vec()).expect("parses");
        let hunk = patch.hunk_patch(0).expect("hunk");
        assert!(hunk.ends_with(b"+new\n\\ No newline at end of file\n"));
    }

    #[test]
    fn new_deleted_binary_and_multi_section_changes_are_whole_file_only() {
        let new_file = b"diff --git a/n b/n\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n";
        let patch = FilePatch::parse(new_file.to_vec()).expect("parses");
        assert!(patch.sections()[0].new_file);
        assert_eq!(patch.hunk_patch(0), Err(PatchError::WholeFileOnly));

        let binary = b"diff --git a/b.bin b/b.bin\nindex 87ae..22f6 100644\nGIT binary patch\nliteral 8\nPcmYew%wtF_sx$%s42c4`\n\nliteral 7\nOcmYew%wtF_sssQD(E^45\n\n";
        let patch = FilePatch::parse(binary.to_vec()).expect("parses binary");
        assert!(patch.binary());
        assert!(!patch.hunks_selectable());
        assert_eq!(
            patch.display_text(1 << 20).as_deref(),
            Some("diff --git a/b.bin b/b.bin\n")
        );

        let type_change = b"diff --git a/l b/l\ndeleted file mode 100644\n--- a/l\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\ndiff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n";
        let patch = FilePatch::parse(type_change.to_vec()).expect("parses two sections");
        assert_eq!(patch.sections().len(), 2);
        assert!(!patch.hunks_selectable());
    }

    #[test]
    fn rejects_truncated_or_foreign_output() {
        assert_eq!(
            FilePatch::parse(b"not a diff\n".to_vec()),
            Err(PatchError::Malformed)
        );
        let truncated = b"diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n";
        assert_eq!(
            FilePatch::parse(truncated.to_vec()),
            Err(PatchError::Malformed)
        );
        assert!(FilePatch::parse(Vec::new()).expect("empty").is_empty());
    }

    #[test]
    fn new_file_display_marks_a_missing_final_newline() {
        assert_eq!(
            new_file_display("a.txt", b"one\ntwo"),
            "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n"
        );
        assert_eq!(
            new_file_display("e.txt", b""),
            "diff --git a/e.txt b/e.txt\nnew file mode 100644\n--- /dev/null\n+++ b/e.txt\n"
        );
    }
}
