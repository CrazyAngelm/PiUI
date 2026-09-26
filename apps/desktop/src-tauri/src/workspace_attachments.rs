//! Composer image attachments (composer inputs v1).
//!
//! Image bytes live in PiUI's own app data (`composer-attachments-v1`) from
//! the moment the user attaches them until their message is delivered or
//! removed. Nothing is ever written into a project. A picked or dropped file
//! that is not an image is never read beyond its first bytes: it becomes a
//! path reference the user confirms before it is inserted into the message.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub(crate) const ATTACHMENT_DIRECTORY: &str = "composer-attachments-v1";
/// Largest image sent natively (the strictest harness limit).
pub(crate) const MAX_IMAGE_BYTES: u64 = 5_000_000;
/// Images attached to one message.
pub(crate) const MAX_ATTACHMENTS_PER_MESSAGE: usize = 6;
/// Files handled from one pick or drop.
pub(crate) const MAX_FILES_PER_BATCH: usize = 10;
/// Pending (not yet sent) images across every composer.
const MAX_PENDING_IMAGES: usize = 64;
const MAX_PENDING_BYTES: u64 = 256 * 1024 * 1024;
/// A pending image nobody sent is forgotten after a day.
const PENDING_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_NAME_CHARS: usize = 128;
const FILE_SUFFIX: &str = "img";

/// Image formats every image-capable harness accepts, identified by magic bytes.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub(crate) enum ImageType {
    #[serde(rename = "image/png")]
    Png,
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/gif")]
    Gif,
    #[serde(rename = "image/webp")]
    Webp,
}

impl ImageType {
    pub(crate) const fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }
}

/// The image type proven by the first bytes, never by a name or extension.
pub(crate) fn sniff_image(bytes: &[u8]) -> Option<ImageType> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageType::Png)
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(ImageType::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageType::Gif)
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(ImageType::Webp)
    } else {
        None
    }
}

/// One stored image. The same shape is the composer v19 `QueuedAttachment`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredImage {
    pub id: String,
    pub name: String,
    pub mime_type: ImageType,
    pub size: u64,
}

/// A picked or dropped file that is not a supported image.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileReference {
    pub name: String,
    pub reference: String,
    pub in_project: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RejectionReason {
    NotAFile,
    TooLarge,
    Unreadable,
    NotAnImage,
    Limit,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Rejection {
    pub name: String,
    pub reason: RejectionReason,
}

/// What one user-chosen path became.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Classified {
    Image(StoredImage),
    File(FileReference),
    Rejected(Rejection),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AttachmentError {
    /// The id is unknown, already sent or removed.
    NotFound,
    TooLarge,
    NotAnImage,
    /// The pending image store is full.
    Limit,
    Io,
}

struct PendingImage {
    image: StoredImage,
    created: Instant,
}

/// Pending images and the byte files of queued messages.
pub(crate) struct AttachmentStore {
    root: PathBuf,
    pending: Mutex<HashMap<String, PendingImage>>,
}

/// A display name without directories or control characters.
pub(crate) fn display_name(value: &str, fallback: &str) -> String {
    let base = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let base = base.trim();
    if base.is_empty() || base == "." || base == ".." {
        return fallback.to_owned();
    }
    let count = base.chars().count();
    if count <= MAX_NAME_CHARS {
        return base.to_owned();
    }
    // Keep the extension visible when a long name is cut.
    let extension = base
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .filter(|extension| extension.chars().count() <= 12)
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    let keep = MAX_NAME_CHARS - 1 - extension.chars().count();
    format!(
        "{}…{extension}",
        base.chars().take(keep).collect::<String>()
    )
}

fn valid_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|uuid| uuid.hyphenated().to_string() == id)
}

impl AttachmentStore {
    pub(crate) fn open(app_data_dir: &Path) -> io::Result<Self> {
        let root = app_data_dir.join(ATTACHMENT_DIRECTORY);
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            pending: Mutex::new(HashMap::new()),
        })
    }

    fn pending(&self) -> Result<MutexGuard<'_, HashMap<String, PendingImage>>, AttachmentError> {
        self.pending.lock().map_err(|_| AttachmentError::Io)
    }

    fn file(&self, id: &str) -> Option<PathBuf> {
        valid_id(id).then(|| self.root.join(format!("{id}.{FILE_SUFFIX}")))
    }

    /// Stores sniffed image bytes as a new pending image.
    pub(crate) fn insert(&self, name: &str, bytes: &[u8]) -> Result<StoredImage, AttachmentError> {
        let size = u64::try_from(bytes.len()).map_err(|_| AttachmentError::TooLarge)?;
        if size > MAX_IMAGE_BYTES {
            return Err(AttachmentError::TooLarge);
        }
        let mime_type = sniff_image(bytes).ok_or(AttachmentError::NotAnImage)?;
        let mut pending = self.pending()?;
        let expired: Vec<String> = pending
            .iter()
            .filter(|(_, item)| item.created.elapsed() > PENDING_LIFETIME)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            pending.remove(&id);
            if let Some(path) = self.file(&id) {
                let _ = fs::remove_file(path);
            }
        }
        let used: u64 = pending.values().map(|item| item.image.size).sum();
        if pending.len() >= MAX_PENDING_IMAGES || used.saturating_add(size) > MAX_PENDING_BYTES {
            return Err(AttachmentError::Limit);
        }
        let id = Uuid::new_v4().to_string();
        let path = self.file(&id).ok_or(AttachmentError::Io)?;
        let partial = self.root.join(format!("{id}.part"));
        let written = fs::write(&partial, bytes).and_then(|()| fs::rename(&partial, &path));
        if written.is_err() {
            let _ = fs::remove_file(&partial);
            return Err(AttachmentError::Io);
        }
        let image = StoredImage {
            id: id.clone(),
            name: display_name(name, "Image"),
            mime_type,
            size,
        };
        pending.insert(
            id,
            PendingImage {
                image: image.clone(),
                created: Instant::now(),
            },
        );
        Ok(image)
    }

    /// The bytes of a pending image (its composer thumbnail).
    pub(crate) fn preview(&self, id: &str) -> Result<(StoredImage, Vec<u8>), AttachmentError> {
        let image = self
            .pending()?
            .get(id)
            .map(|item| item.image.clone())
            .ok_or(AttachmentError::NotFound)?;
        let bytes = self.read(&image)?;
        Ok((image, bytes))
    }

    /// Deletes pending images; ids that are not pending are ignored.
    pub(crate) fn discard(&self, ids: &[String]) -> Result<(), AttachmentError> {
        let mut pending = self.pending()?;
        for id in ids {
            if pending.remove(id).is_some()
                && let Some(path) = self.file(id)
            {
                let _ = fs::remove_file(path);
            }
        }
        Ok(())
    }

    /// Runs `attach` with the distinct pending images named by `ids` while the
    /// store is held, and hands them over (they stop being pending) only when
    /// it succeeds. Their bytes stay until [`AttachmentStore::remove`]. Any id
    /// that is unknown, repeated or already handed over fails with
    /// `unavailable` before `attach` runs.
    pub(crate) fn claim_with<T, E>(
        &self,
        ids: &[String],
        unavailable: E,
        attach: impl FnOnce(Vec<StoredImage>) -> Result<T, E>,
    ) -> Result<T, E> {
        let Ok(mut pending) = self.pending.lock() else {
            return Err(unavailable);
        };
        let mut seen = HashSet::new();
        let mut images = Vec::with_capacity(ids.len());
        for id in ids {
            match pending.get(id) {
                Some(item) if seen.insert(id) => images.push(item.image.clone()),
                _ => return Err(unavailable),
            }
        }
        let attached = attach(images)?;
        for id in ids {
            pending.remove(id);
        }
        Ok(attached)
    }

    /// Reads a stored image again and verifies that it is still the image
    /// that was attached.
    pub(crate) fn read(&self, image: &StoredImage) -> Result<Vec<u8>, AttachmentError> {
        let path = self.file(&image.id).ok_or(AttachmentError::NotFound)?;
        let file = fs::File::open(path).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => AttachmentError::NotFound,
            _ => AttachmentError::Io,
        })?;
        let mut bytes = Vec::new();
        file.take(MAX_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| AttachmentError::Io)?;
        if u64::try_from(bytes.len()).ok() != Some(image.size)
            || sniff_image(&bytes) != Some(image.mime_type)
        {
            return Err(AttachmentError::NotFound);
        }
        Ok(bytes)
    }

    /// Deletes the bytes of delivered or removed images.
    pub(crate) fn remove(&self, images: &[StoredImage]) {
        let ids: Vec<String> = images.iter().map(|image| image.id.clone()).collect();
        if let Ok(mut pending) = self.pending() {
            for id in &ids {
                pending.remove(id);
            }
        }
        for id in ids {
            if let Some(path) = self.file(&id) {
                let _ = fs::remove_file(path);
            }
        }
    }

    /// Startup cleanup: removes every stored file that no queued message
    /// references (pending images do not survive a restart).
    pub(crate) fn retain_only(&self, referenced: &HashSet<String>) -> io::Result<()> {
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let keep = name
                .to_str()
                .and_then(|name| name.strip_suffix(&format!(".{FILE_SUFFIX}")))
                .is_some_and(|id| valid_id(id) && referenced.contains(id));
            if !keep && entry.file_type()?.is_file() {
                fs::remove_file(entry.path())?;
            }
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|id, _| referenced.contains(id));
        }
        Ok(())
    }
}

/// A path without Windows' verbatim prefix, for display in message text.
pub(crate) fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        text.into_owned()
    }
}

/// Text that names `path` in a message: `@relative/path` inside the project,
/// otherwise the absolute path; quoted when it contains whitespace.
pub(crate) fn file_reference(path: &Path, project_root: Option<&Path>) -> (String, bool) {
    let relative = project_root
        .and_then(|root| path.strip_prefix(root).ok())
        .filter(|relative| {
            !relative.as_os_str().is_empty()
                && relative
                    .components()
                    .all(|component| matches!(component, Component::Normal(_)))
        })
        .and_then(Path::to_str)
        .map(|relative| relative.replace('\\', "/"));
    match relative {
        Some(relative) if relative.contains(char::is_whitespace) => {
            (format!("@\"{relative}\""), true)
        }
        Some(relative) => (format!("@{relative}"), true),
        None => {
            let absolute = display_path(path);
            if absolute.contains(char::is_whitespace) {
                (format!("\"{absolute}\""), false)
            } else {
                (absolute, false)
            }
        }
    }
}

/// Classifies one path the user picked in the native dialog or dropped on
/// the window. Images are stored; other regular files become references.
pub(crate) fn classify_user_file(
    store: &AttachmentStore,
    path: &Path,
    project_root: Option<&Path>,
) -> Classified {
    let name = display_name(
        &path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        "File",
    );
    let rejected = |reason| {
        Classified::Rejected(Rejection {
            name: name.clone(),
            reason,
        })
    };
    let Ok(canonical) = fs::canonicalize(path) else {
        return rejected(RejectionReason::Unreadable);
    };
    let Ok(metadata) = fs::metadata(&canonical) else {
        return rejected(RejectionReason::Unreadable);
    };
    if !metadata.is_file() {
        return rejected(RejectionReason::NotAFile);
    }
    let Ok(file) = fs::File::open(&canonical) else {
        return rejected(RejectionReason::Unreadable);
    };
    let mut head = Vec::with_capacity(16);
    if file.take(16).read_to_end(&mut head).is_err() {
        return rejected(RejectionReason::Unreadable);
    }
    if sniff_image(&head).is_none() {
        let (reference, in_project) = file_reference(&canonical, project_root);
        return Classified::File(FileReference {
            name,
            reference,
            in_project,
        });
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return rejected(RejectionReason::TooLarge);
    }
    let mut bytes = Vec::new();
    let read = fs::File::open(&canonical)
        .and_then(|file| file.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut bytes));
    if read.is_err() {
        return rejected(RejectionReason::Unreadable);
    }
    match store.insert(&name, &bytes) {
        Ok(image) => Classified::Image(image),
        Err(AttachmentError::TooLarge) => rejected(RejectionReason::TooLarge),
        Err(AttachmentError::Limit) => rejected(RejectionReason::Limit),
        Err(AttachmentError::NotAnImage) => rejected(RejectionReason::NotAnImage),
        Err(AttachmentError::NotFound | AttachmentError::Io) => {
            rejected(RejectionReason::Unreadable)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const PNG: &[u8] =
        b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";

    fn root(purpose: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("piui-attachments-{purpose}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("creates test root");
        root
    }

    #[test]
    fn sniffing_uses_magic_bytes_only() {
        assert_eq!(sniff_image(PNG), Some(ImageType::Png));
        assert_eq!(
            sniff_image(&[0xff, 0xd8, 0xff, 0xe0]),
            Some(ImageType::Jpeg)
        );
        assert_eq!(sniff_image(b"GIF89a...."), Some(ImageType::Gif));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some(ImageType::Webp));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(
            sniff_image(b"<svg xmlns='http://www.w3.org/2000/svg'/>"),
            None
        );
        assert_eq!(sniff_image(b"BM\0\0"), None);
        assert_eq!(sniff_image(b""), None);
    }

    #[test]
    fn names_never_carry_directories_or_controls() {
        assert_eq!(display_name(r"C:\Users\me\shot.png", "Image"), "shot.png");
        assert_eq!(display_name("../../etc/passwd", "Image"), "passwd");
        assert_eq!(display_name("a\u{0}b\nc.png", "Image"), "abc.png");
        assert_eq!(display_name("", "Image"), "Image");
        assert_eq!(display_name("..", "Image"), "Image");
        let long = display_name(&format!("{}.png", "x".repeat(300)), "Image");
        assert_eq!(long.chars().count(), MAX_NAME_CHARS);
        assert!(long.ends_with("….png"));
    }

    #[test]
    fn pending_images_are_bounded_claimed_once_and_removed() {
        let dir = root("store");
        let store = AttachmentStore::open(&dir).expect("opens store");
        assert_eq!(
            store.insert("notes.txt", b"plain text"),
            Err(AttachmentError::NotAnImage)
        );
        let mut oversized = PNG.to_vec();
        oversized.resize(usize::try_from(MAX_IMAGE_BYTES).expect("fits") + 1, 0);
        assert_eq!(
            store.insert("big.png", &oversized),
            Err(AttachmentError::TooLarge)
        );

        let image = store.insert("../shot.png", PNG).expect("stores image");
        assert_eq!(image.name, "shot.png");
        assert_eq!(image.mime_type, ImageType::Png);
        let (previewed, bytes) = store.preview(&image.id).expect("previews");
        assert_eq!(previewed, image);
        assert_eq!(bytes, PNG);
        let twice = store.claim_with(&[image.id.clone(), image.id.clone()], "unavailable", |_| {
            Ok(())
        });
        assert_eq!(
            twice,
            Err("unavailable"),
            "an image cannot be attached twice to one message"
        );
        let failed = store.claim_with(std::slice::from_ref(&image.id), "unavailable", |_| {
            Err::<(), _>("queue failed")
        });
        assert_eq!(failed, Err("queue failed"));
        let claimed = store.claim_with(std::slice::from_ref(&image.id), "unavailable", |images| {
            Ok::<_, &str>(images)
        });
        assert_eq!(
            claimed,
            Ok(vec![image.clone()]),
            "a failed hand-over keeps the image pending"
        );
        let again = store.claim_with(std::slice::from_ref(&image.id), "unavailable", |_| Ok(()));
        assert_eq!(
            again,
            Err("unavailable"),
            "a claimed image is no longer pending"
        );
        assert_eq!(
            store.preview(&image.id).err(),
            Some(AttachmentError::NotFound)
        );
        // Claimed bytes stay readable for delivery until they are removed.
        assert_eq!(store.read(&image).expect("reads claimed bytes"), PNG);
        store.remove(std::slice::from_ref(&image));
        assert_eq!(store.read(&image), Err(AttachmentError::NotFound));

        for _ in 0..MAX_PENDING_IMAGES {
            store.insert("many.png", PNG).expect("within the limit");
        }
        assert_eq!(
            store.insert("one-more.png", PNG),
            Err(AttachmentError::Limit)
        );
        fs::remove_dir_all(dir).expect("removes test root");
    }

    #[test]
    fn a_modified_file_is_not_sent_as_the_attached_image() {
        let dir = root("tamper");
        let store = AttachmentStore::open(&dir).expect("opens store");
        let image = store.insert("shot.png", PNG).expect("stores image");
        fs::write(
            dir.join(ATTACHMENT_DIRECTORY)
                .join(format!("{}.img", image.id)),
            b"not an image anymore",
        )
        .expect("rewrites");
        assert_eq!(store.read(&image), Err(AttachmentError::NotFound));
        let forged = StoredImage {
            id: "../escape".into(),
            ..image
        };
        assert_eq!(store.read(&forged), Err(AttachmentError::NotFound));
        fs::remove_dir_all(dir).expect("removes test root");
    }

    #[test]
    fn startup_cleanup_keeps_only_queued_images() {
        let dir = root("cleanup");
        let store = AttachmentStore::open(&dir).expect("opens store");
        let queued = store.insert("queued.png", PNG).expect("stores");
        let orphan = store.insert("orphan.png", PNG).expect("stores");
        fs::write(dir.join(ATTACHMENT_DIRECTORY).join("stray.part"), b"x").expect("stray");
        store
            .retain_only(&HashSet::from([queued.id.clone()]))
            .expect("cleans up");
        assert!(store.read(&queued).is_ok());
        assert_eq!(store.read(&orphan), Err(AttachmentError::NotFound));
        assert!(!dir.join(ATTACHMENT_DIRECTORY).join("stray.part").exists());
        fs::remove_dir_all(dir).expect("removes test root");
    }

    #[test]
    fn picked_files_become_images_references_or_rejections() {
        let dir = root("classify");
        let store = AttachmentStore::open(&dir.join("data")).expect("opens store");
        let project = dir.join("project");
        fs::create_dir_all(project.join("docs")).expect("creates project");
        let project = fs::canonicalize(&project).expect("canonical project");
        fs::write(project.join("docs").join("spec sheet.pdf"), b"%PDF-1.7").expect("pdf");
        fs::write(project.join("screen.png"), PNG).expect("png");
        fs::write(project.join("fake.png"), b"text with a png name").expect("fake");
        let outside = dir.join("outside.txt");
        fs::write(&outside, b"outside").expect("outside");
        let mut big = PNG.to_vec();
        big.resize(usize::try_from(MAX_IMAGE_BYTES).expect("fits") + 10, 0);
        fs::write(project.join("huge.png"), &big).expect("huge");

        let Classified::Image(image) =
            classify_user_file(&store, &project.join("screen.png"), Some(&project))
        else {
            panic!("an image is stored");
        };
        assert_eq!(image.name, "screen.png");
        assert_eq!(
            classify_user_file(
                &store,
                &project.join("docs").join("spec sheet.pdf"),
                Some(&project)
            ),
            Classified::File(FileReference {
                name: "spec sheet.pdf".into(),
                reference: "@\"docs/spec sheet.pdf\"".into(),
                in_project: true,
            })
        );
        assert_eq!(
            classify_user_file(&store, &project.join("fake.png"), Some(&project)),
            Classified::File(FileReference {
                name: "fake.png".into(),
                reference: "@fake.png".into(),
                in_project: true,
            }),
            "a name never makes bytes an image"
        );
        let Classified::File(reference) = classify_user_file(&store, &outside, Some(&project))
        else {
            panic!("an outside file is referenced by its absolute path");
        };
        assert!(!reference.in_project);
        assert!(!reference.reference.starts_with('@'));
        assert!(!reference.reference.starts_with(r"\\?\"));
        assert!(reference.reference.ends_with("outside.txt"));
        assert_eq!(
            classify_user_file(&store, &project.join("docs"), Some(&project)),
            Classified::Rejected(Rejection {
                name: "docs".into(),
                reason: RejectionReason::NotAFile
            })
        );
        assert_eq!(
            classify_user_file(&store, &project.join("huge.png"), Some(&project)),
            Classified::Rejected(Rejection {
                name: "huge.png".into(),
                reason: RejectionReason::TooLarge
            })
        );
        assert_eq!(
            classify_user_file(&store, &project.join("missing.png"), Some(&project)),
            Classified::Rejected(Rejection {
                name: "missing.png".into(),
                reason: RejectionReason::Unreadable
            })
        );
        // Nothing was written into the project.
        let mut names: Vec<_> = fs::read_dir(&project)
            .expect("lists project")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        assert_eq!(names, ["docs", "fake.png", "huge.png", "screen.png"]);
        fs::remove_dir_all(dir).expect("removes test root");
    }
}
