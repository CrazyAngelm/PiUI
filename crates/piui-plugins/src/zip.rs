//! A deliberately small, bounded `.zip` reader for plugin packages.
//!
//! It reads the central directory, accepts stored and deflated regular
//! files, checks every CRC, and refuses what a package never needs:
//! encryption, ZIP64, multi-disk archives, symbolic links, other compression
//! methods, and anything whose sizes exceed the package limits. Nothing is
//! written to disk here; names are checked by [`crate::package`].

use std::io::Read;

use flate2::read::DeflateDecoder;

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
const EOCD_SIZE: usize = 22;
const MAX_COMMENT: usize = 0xFFFF;
const FLAG_ENCRYPTED: u16 = 0x0001;
const FLAG_STRONG_ENCRYPTION: u16 = 0x0040;
const METHOD_STORED: u16 = 0;
const METHOD_DEFLATED: u16 = 8;
const UNIX_FILE_TYPE_MASK: u32 = 0o170_000;
const UNIX_SYMLINK: u32 = 0o120_000;
const UNIX_REGULAR: u32 = 0o100_000;
const UNIX_DIRECTORY: u32 = 0o040_000;

/// Limits for one archive, normally the package limits.
#[derive(Clone, Copy, Debug)]
pub struct ZipLimits {
    pub entries: usize,
    pub file_bytes: u64,
    pub total_bytes: u64,
}

/// Why an archive is refused. Messages are English locale keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZipError {
    Unreadable,
    Unsupported,
    Encrypted,
    Link,
    TooLarge,
    TooManyFiles,
    Corrupt,
}

impl ZipError {
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::Unreadable => "The file is not a readable .zip archive.",
            Self::Unsupported => {
                "The archive uses a .zip feature PiUI does not accept (ZIP64, split archives or a compression method other than deflate)."
            }
            Self::Encrypted => "The archive is encrypted.",
            Self::Link => "The archive contains a symbolic link.",
            Self::TooLarge => "The package is larger than 20 MiB or a file is larger than 8 MiB.",
            Self::TooManyFiles => "The package has more than 2000 files.",
            Self::Corrupt => "A file in the archive is damaged (its checksum does not match).",
        }
    }
}

/// One regular file of an archive, with its raw (unchecked) name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZipFile {
    pub name: String,
    pub bytes: Vec<u8>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn at(bytes: &'a [u8], at: usize) -> Self {
        Self { bytes, at }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ZipError> {
        let end = self.at.checked_add(length).ok_or(ZipError::Unreadable)?;
        let slice = self.bytes.get(self.at..end).ok_or(ZipError::Unreadable)?;
        self.at = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, ZipError> {
        let slice = self.take(2)?;
        Ok(u16::from_le_bytes([slice[0], slice[1]]))
    }

    fn u32(&mut self) -> Result<u32, ZipError> {
        let slice = self.take(4)?;
        Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
    }
}

fn find_end(bytes: &[u8]) -> Result<usize, ZipError> {
    if bytes.len() < EOCD_SIZE {
        return Err(ZipError::Unreadable);
    }
    let earliest = bytes.len().saturating_sub(EOCD_SIZE + MAX_COMMENT);
    let signature = EOCD_SIGNATURE.to_le_bytes();
    (earliest..=bytes.len() - EOCD_SIZE)
        .rev()
        .find(|&offset| bytes[offset..offset + 4] == signature)
        .ok_or(ZipError::Unreadable)
}

struct Central {
    name: String,
    flags: u16,
    method: u16,
    crc: u32,
    compressed: u64,
    size: u64,
    external: u32,
    made_by_unix: bool,
    local_offset: usize,
}

/// Reads every regular file of `bytes`. Directory entries are skipped.
pub fn read_zip(bytes: &[u8], limits: ZipLimits) -> Result<Vec<ZipFile>, ZipError> {
    let end = find_end(bytes)?;
    let mut eocd = Reader::at(bytes, end + 4);
    let disk = eocd.u16()?;
    let directory_disk = eocd.u16()?;
    let on_disk = eocd.u16()?;
    let total = eocd.u16()?;
    let directory_size = eocd.u32()?;
    let directory_offset = eocd.u32()?;
    if disk != 0 || directory_disk != 0 || on_disk != total {
        return Err(ZipError::Unsupported);
    }
    if total == 0xFFFF || directory_size == 0xFFFF_FFFF || directory_offset == 0xFFFF_FFFF {
        return Err(ZipError::Unsupported);
    }
    let total = usize::from(total);
    if total > limits.entries.saturating_mul(2) {
        return Err(ZipError::TooManyFiles);
    }
    let offset = usize::try_from(directory_offset).map_err(|_| ZipError::Unreadable)?;
    let mut reader = Reader::at(bytes, offset);
    let mut entries = Vec::with_capacity(total);
    for _ in 0..total {
        if reader.u32()? != CENTRAL_SIGNATURE {
            return Err(ZipError::Unreadable);
        }
        let made_by = reader.u16()?;
        let _needed = reader.u16()?;
        let flags = reader.u16()?;
        let method = reader.u16()?;
        let _time = reader.u16()?;
        let _date = reader.u16()?;
        let crc = reader.u32()?;
        let compressed = reader.u32()?;
        let size = reader.u32()?;
        let name_length = usize::from(reader.u16()?);
        let extra_length = usize::from(reader.u16()?);
        let comment_length = usize::from(reader.u16()?);
        let _disk_start = reader.u16()?;
        let _internal = reader.u16()?;
        let external = reader.u32()?;
        let local_offset = reader.u32()?;
        let name = reader.take(name_length)?;
        reader.take(extra_length)?;
        reader.take(comment_length)?;
        if compressed == 0xFFFF_FFFF || size == 0xFFFF_FFFF || local_offset == 0xFFFF_FFFF {
            return Err(ZipError::Unsupported);
        }
        let name = std::str::from_utf8(name).map_err(|_| ZipError::Unreadable)?;
        entries.push(Central {
            name: name.to_owned(),
            flags,
            method,
            crc,
            compressed: u64::from(compressed),
            size: u64::from(size),
            external,
            made_by_unix: made_by >> 8 == 3,
            local_offset: usize::try_from(local_offset).map_err(|_| ZipError::Unreadable)?,
        });
    }
    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    for entry in entries {
        if entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION) != 0 {
            return Err(ZipError::Encrypted);
        }
        let file_type = entry.external >> 16 & UNIX_FILE_TYPE_MASK;
        if entry.made_by_unix && file_type == UNIX_SYMLINK {
            return Err(ZipError::Link);
        }
        let directory =
            entry.name.ends_with('/') || (entry.made_by_unix && file_type == UNIX_DIRECTORY);
        if directory {
            if entry.size != 0 {
                return Err(ZipError::Unreadable);
            }
            continue;
        }
        if entry.made_by_unix && file_type != 0 && file_type != UNIX_REGULAR {
            return Err(ZipError::Link);
        }
        if files.len() >= limits.entries {
            return Err(ZipError::TooManyFiles);
        }
        if entry.size > limits.file_bytes {
            return Err(ZipError::TooLarge);
        }
        total_bytes = total_bytes.saturating_add(entry.size);
        if total_bytes > limits.total_bytes {
            return Err(ZipError::TooLarge);
        }
        let data = entry_data(bytes, &entry)?;
        let contents = match entry.method {
            METHOD_STORED => {
                if entry.compressed != entry.size {
                    return Err(ZipError::Corrupt);
                }
                data.to_vec()
            }
            METHOD_DEFLATED => inflate(data, entry.size)?,
            _ => return Err(ZipError::Unsupported),
        };
        if crc32fast::hash(&contents) != entry.crc {
            return Err(ZipError::Corrupt);
        }
        files.push(ZipFile {
            name: entry.name,
            bytes: contents,
        });
    }
    Ok(files)
}

fn entry_data<'a>(bytes: &'a [u8], entry: &Central) -> Result<&'a [u8], ZipError> {
    let mut local = Reader::at(bytes, entry.local_offset);
    if local.u32()? != LOCAL_SIGNATURE {
        return Err(ZipError::Unreadable);
    }
    let _version = local.u16()?;
    let _flags = local.u16()?;
    let method = local.u16()?;
    local.take(16)?;
    let name_length = usize::from(local.u16()?);
    let extra_length = usize::from(local.u16()?);
    local.take(name_length)?;
    local.take(extra_length)?;
    if method != entry.method {
        return Err(ZipError::Corrupt);
    }
    let length = usize::try_from(entry.compressed).map_err(|_| ZipError::TooLarge)?;
    local.take(length)
}

/// Inflates at most `expected` bytes; more (or less) output is a damaged
/// archive, so a small archive can never expand beyond its declared size.
fn inflate(data: &[u8], expected: u64) -> Result<Vec<u8>, ZipError> {
    let capacity = usize::try_from(expected).map_err(|_| ZipError::TooLarge)?;
    let mut output = Vec::with_capacity(capacity);
    let mut decoder = DeflateDecoder::new(data).take(expected.saturating_add(1));
    decoder
        .read_to_end(&mut output)
        .map_err(|_| ZipError::Corrupt)?;
    if output.len() != capacity {
        return Err(ZipError::Corrupt);
    }
    Ok(output)
}

/// Test helper: writes a small archive with stored or deflated entries.
#[cfg(test)]
pub(crate) mod writer {
    use std::io::Write as _;

    pub struct Entry<'a> {
        pub name: &'a str,
        pub bytes: &'a [u8],
        pub deflate: bool,
        /// Unix file mode in the external attributes (`0o100644` for a file).
        pub unix_mode: Option<u32>,
    }

    pub fn write(entries: &[Entry<'_>]) -> Vec<u8> {
        let mut archive = Vec::new();
        let mut central = Vec::new();
        for entry in entries {
            let data = if entry.deflate {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(entry.bytes).expect("deflate");
                encoder.finish().expect("deflate")
            } else {
                entry.bytes.to_vec()
            };
            let method: u16 = if entry.deflate { 8 } else { 0 };
            let crc = crc32fast::hash(entry.bytes);
            let offset = u32::try_from(archive.len()).expect("offset");
            let name = entry.name.as_bytes();
            let name_length = u16::try_from(name.len()).expect("name");
            let compressed = u32::try_from(data.len()).expect("size");
            let size = u32::try_from(entry.bytes.len()).expect("size");
            archive.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
            archive.extend_from_slice(&20_u16.to_le_bytes());
            archive.extend_from_slice(&0x0800_u16.to_le_bytes());
            archive.extend_from_slice(&method.to_le_bytes());
            archive.extend_from_slice(&[0; 4]);
            archive.extend_from_slice(&crc.to_le_bytes());
            archive.extend_from_slice(&compressed.to_le_bytes());
            archive.extend_from_slice(&size.to_le_bytes());
            archive.extend_from_slice(&name_length.to_le_bytes());
            archive.extend_from_slice(&0_u16.to_le_bytes());
            archive.extend_from_slice(name);
            archive.extend_from_slice(&data);
            let made_by: u16 = if entry.unix_mode.is_some() {
                0x0314
            } else {
                0x0014
            };
            central.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
            central.extend_from_slice(&made_by.to_le_bytes());
            central.extend_from_slice(&20_u16.to_le_bytes());
            central.extend_from_slice(&0x0800_u16.to_le_bytes());
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&[0; 4]);
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&compressed.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&name_length.to_le_bytes());
            central.extend_from_slice(&[0; 8]);
            central.extend_from_slice(&(entry.unix_mode.unwrap_or(0) << 16).to_le_bytes());
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name);
        }
        let directory_offset = u32::try_from(archive.len()).expect("offset");
        let directory_size = u32::try_from(central.len()).expect("size");
        let count = u16::try_from(entries.len()).expect("count");
        archive.extend_from_slice(&central);
        archive.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
        archive.extend_from_slice(&[0; 4]);
        archive.extend_from_slice(&count.to_le_bytes());
        archive.extend_from_slice(&count.to_le_bytes());
        archive.extend_from_slice(&directory_size.to_le_bytes());
        archive.extend_from_slice(&directory_offset.to_le_bytes());
        archive.extend_from_slice(&0_u16.to_le_bytes());
        archive
    }
}

#[cfg(test)]
mod tests {
    use super::writer::{Entry, write};
    use super::*;

    const LIMITS: ZipLimits = ZipLimits {
        entries: 10,
        file_bytes: 1024,
        total_bytes: 2048,
    };

    fn file<'a>(name: &'a str, bytes: &'a [u8], deflate: bool) -> Entry<'a> {
        Entry {
            name,
            bytes,
            deflate,
            unix_mode: None,
        }
    }

    #[test]
    fn reads_stored_and_deflated_files_and_skips_directories() {
        let archive = write(&[
            file("plugin/", b"", false),
            file("plugin/piui-plugin.json", b"{\"schemaVersion\":1}", true),
            file("plugin/ui/index.html", b"<!doctype html>", false),
        ]);
        let files = read_zip(&archive, LIMITS).expect("archive");
        assert_eq!(
            files,
            vec![
                ZipFile {
                    name: "plugin/piui-plugin.json".into(),
                    bytes: b"{\"schemaVersion\":1}".to_vec()
                },
                ZipFile {
                    name: "plugin/ui/index.html".into(),
                    bytes: b"<!doctype html>".to_vec()
                },
            ]
        );
    }

    #[test]
    fn refuses_links_bombs_damage_and_garbage() {
        let link = write(&[Entry {
            name: "link",
            bytes: b"/etc/passwd",
            deflate: false,
            unix_mode: Some(0o120_777),
        }]);
        assert_eq!(read_zip(&link, LIMITS), Err(ZipError::Link));
        let big = vec![b'a'; 1500];
        let bomb = write(&[file("big.txt", &big, true)]);
        assert_eq!(read_zip(&bomb, LIMITS), Err(ZipError::TooLarge));
        let many = (0..11)
            .map(|index| format!("f{index}.txt"))
            .collect::<Vec<_>>();
        let entries = many
            .iter()
            .map(|name| file(name, b"x", false))
            .collect::<Vec<_>>();
        assert_eq!(
            read_zip(&write(&entries), LIMITS),
            Err(ZipError::TooManyFiles)
        );
        let mut damaged = write(&[file("a.txt", b"hello world", false)]);
        let position = damaged
            .windows(11)
            .position(|window| window == b"hello world")
            .expect("data");
        damaged[position] = b'j';
        assert_eq!(read_zip(&damaged, LIMITS), Err(ZipError::Corrupt));
        assert_eq!(
            read_zip(b"not a zip at all, clearly", LIMITS),
            Err(ZipError::Unreadable)
        );
        assert_eq!(read_zip(&[], LIMITS), Err(ZipError::Unreadable));
    }
}
