//! Host tests for chat files v1 (ADR-074).

use super::super::native_host_tests::{install_test_spawner, test_root};
use super::*;
use piui_runtime::workspace_runtime::{NativeRuntime, NativeRuntimeConfig};

const PNG: &[u8] =
    b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";

/// A session that only reports a snapshot: no turn is ever run.
const ADAPTER: &str = r#"
    let status = 'idle';
    const native = {supported:true,enforcement:'native'};
    const unsupported = {supported:false,enforcement:'unsupported'};
    return {
      snapshot() {
        return {nativeId:'native-files',materialized:false,title:config.title ?? 'Files',status,blocks:[],approvals:[],
          capabilities:{prompt:native,resume:native,models:native,approvals:native,instructions:unsupported,toolPolicy:native,nativeSubagents:unsupported},models:[]};
      },
      interrupt() { return null; },
      dispose() { return null; },
    };
"#;

fn wav_bytes() -> Vec<u8> {
    let mut bytes = b"RIFF\x24\0\0\0WAVEfmt ".to_vec();
    bytes.extend_from_slice(&[0; 32]);
    bytes
}

fn pe_bytes() -> Vec<u8> {
    let mut bytes = b"MZ".to_vec();
    bytes.resize(0x80, 0);
    bytes
}

fn write(directory: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    fs::create_dir_all(directory).expect("creates directory");
    let path = directory.join(name);
    fs::write(&path, bytes).expect("writes file");
    path
}

#[derive(Default)]
struct Recorder {
    revealed: Mutex<Vec<PathBuf>>,
    opened: Mutex<Vec<PathBuf>>,
}

impl SystemActions for Recorder {
    fn reveal(&self, path: &Path) -> Result<(), ChatFilesError> {
        self.revealed.lock().expect("lock").push(path.to_path_buf());
        Ok(())
    }

    fn open(&self, path: &Path) -> Result<(), ChatFilesError> {
        self.opened.lock().expect("lock").push(path.to_path_buf());
        Ok(())
    }
}

struct Setup {
    host: Arc<HostState>,
    session: String,
    /// The trusted workspace folder of the session.
    workspace: PathBuf,
    /// A folder outside the workspace.
    outside: PathBuf,
}

async fn setup(purpose: &str) -> Setup {
    let root = test_root(purpose);
    let host = Arc::new(HostState::open(&root, false).expect("host state"));
    install_test_spawner(&host.workspace, |config: NativeRuntimeConfig| {
        NativeRuntime::spawn_test_adapter(config, ADAPTER)
    });
    let result = dispatch_workspace_command(
        &host,
        WorkspaceCommand::CreateSession {
            workspace_id: host.personal_workspace.project_id.clone(),
            harness: HarnessKind::Pi,
            title: Some("Chat files".into()),
            model: None,
            permission_mode: PermissionMode::Native,
        },
        Arc::new(|_| {}),
    )
    .await;
    let session = match result {
        Ok(WorkspaceResult::Session { snapshot }) => snapshot.session.id,
        other => panic!("expected a session, got {other:?}"),
    };
    let record = host.workspace.record(&session).expect("record");
    let workspace = verified_project_directory(&host, &record.workspace_id, true)
        .expect("verified workspace")
        .canonical_path()
        .to_path_buf();
    let outside = root.join("outside");
    fs::create_dir_all(&outside).expect("creates outside folder");
    Setup {
        host,
        session,
        workspace,
        outside,
    }
}

fn registry(setup: &Setup) -> Arc<ChatFileRegistry> {
    Arc::clone(&setup.host.workspace.inner.chat_files)
}

fn report(setup: &Setup, block: &str, path: &Path) -> bool {
    registry(setup).register_path(&setup.session, block, path, ChatFileOrigin::Written, None)
}

async fn run_with(
    setup: &Setup,
    command: ChatFilesCommand,
    dialog: SaveDialog,
    actions: Arc<dyn SystemActions>,
) -> Result<ChatFilesResult, WorkspaceError> {
    run_chat_files(&setup.host, command, dialog, actions).await
}

fn no_dialog() -> SaveDialog {
    Box::new(|_| panic!("the save dialog is not opened by this command"))
}

async fn run(setup: &Setup, command: ChatFilesCommand) -> Result<ChatFilesResult, WorkspaceError> {
    run_with(setup, command, no_dialog(), Arc::new(Recorder::default())).await
}

fn list_command(setup: &Setup) -> ChatFilesCommand {
    ChatFilesCommand::List {
        session_id: setup.session.clone(),
    }
}

fn preview_command(setup: &Setup, file_id: &str) -> ChatFilesCommand {
    ChatFilesCommand::Preview {
        session_id: setup.session.clone(),
        file_id: file_id.into(),
    }
}

fn resolve_command(setup: &Setup, name: &str) -> ChatFilesCommand {
    ChatFilesCommand::Resolve {
        session_id: setup.session.clone(),
        name: name.into(),
    }
}

async fn listed(setup: &Setup) -> Vec<ChatFile> {
    match run(setup, list_command(setup)).await {
        Ok(ChatFilesResult::Files { files, .. }) => files,
        other => panic!("expected files, got {other:?}"),
    }
}

async fn resolved(setup: &Setup, name: &str) -> Option<ChatFile> {
    match run(setup, resolve_command(setup, name)).await {
        Ok(ChatFilesResult::Resolved { file, .. }) => file,
        other => panic!("expected a resolution, got {other:?}"),
    }
}

fn code<T: std::fmt::Debug>(result: Result<T, WorkspaceError>) -> &'static str {
    result.expect_err("the command is refused").code
}

/// Creates a link, or returns false where the platform or account may not.
fn try_symlink(target: &Path, link: &Path, directory: bool) -> bool {
    #[cfg(unix)]
    {
        let _ = directory;
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        if directory {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
        } else {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link, directory);
        false
    }
}

#[test]
fn the_golden_fixture_matches_the_rust_contract() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../contracts/fixtures/chat-files-v1.json"
    ))
    .expect("fixture");
    for command in fixture["commands"].as_array().expect("commands") {
        assert!(
            serde_json::from_value::<ChatFilesCommand>(command.clone()).is_ok(),
            "{command}"
        );
    }
    for command in fixture["invalidCommands"].as_array().expect("invalid") {
        assert!(
            serde_json::from_value::<ChatFilesCommand>(command.clone()).is_err(),
            "{command}"
        );
    }
    let session = "8d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    let image_id = "0f8e5a4c-1b2d-4e6f-8a9b-7c6d5e4f3a2b";
    let image = ChatFile {
        id: image_id.into(),
        block_id: "block-4".into(),
        name: "render.png".into(),
        kind: ChatFileKind::Image,
        media_type: Some("image/png".into()),
        size: Some(1024),
        origin: ChatFileOrigin::Generated,
        openable: true,
        previewable: true,
        revealable: true,
        unavailable: false,
    };
    let audio = ChatFile {
        id: "6a1b2c3d-4e5f-4a6b-8c7d-0123456789ab".into(),
        name: "narration.wav".into(),
        kind: ChatFileKind::Audio,
        media_type: Some("audio/wav".into()),
        size: Some(88_200),
        ..image.clone()
    };
    let program = ChatFile {
        id: "7b2c3d4e-5f60-4b7c-9d8e-123456789abc".into(),
        block_id: "block-6".into(),
        name: "setup.exe".into(),
        kind: ChatFileKind::File,
        media_type: Some("application/octet-stream".into()),
        size: Some(4096),
        origin: ChatFileOrigin::Written,
        openable: false,
        previewable: false,
        ..image.clone()
    };
    let gone = ChatFile {
        id: "8c3d4e5f-6071-4c8d-8e9f-23456789abcd".into(),
        block_id: "block-6".into(),
        name: "old-notes.txt".into(),
        kind: ChatFileKind::File,
        media_type: None,
        size: None,
        origin: ChatFileOrigin::Read,
        openable: false,
        previewable: false,
        revealable: false,
        unavailable: true,
    };
    let results = &fixture["results"];
    let json = |result: ChatFilesResult| serde_json::to_value(result).expect("json");
    assert_eq!(
        json(ChatFilesResult::Files {
            protocol: 1,
            session_id: session.into(),
            files: vec![image.clone(), audio, program, gone],
        }),
        results["files"]
    );
    assert_eq!(
        json(ChatFilesResult::Preview {
            protocol: 1,
            session_id: session.into(),
            file_id: image_id.into(),
            media_type: "image/png".into(),
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ".into(),
        }),
        results["preview"]
    );
    assert_eq!(
        json(ChatFilesResult::Saved {
            protocol: 1,
            session_id: session.into(),
            file_id: image_id.into(),
            saved: true,
        }),
        results["saved"]
    );
    assert_eq!(
        json(ChatFilesResult::Revealed {
            protocol: 1,
            session_id: session.into(),
            file_id: image_id.into(),
        }),
        results["revealed"]
    );
    assert_eq!(
        json(ChatFilesResult::Opened {
            protocol: 1,
            session_id: session.into(),
            file_id: image_id.into(),
        }),
        results["opened"]
    );
    assert_eq!(
        json(ChatFilesResult::Resolved {
            protocol: 1,
            session_id: session.into(),
            file: Some(ChatFile {
                block_id: String::new(),
                origin: ChatFileOrigin::Returned,
                ..image
            }),
        }),
        results["resolved"]
    );
    assert_eq!(
        json(ChatFilesResult::Resolved {
            protocol: 1,
            session_id: session.into(),
            file: None,
        }),
        results["resolvedNone"]
    );
    let errors = fixture["errors"].as_array().expect("errors");
    for (error, expected) in [
        ChatFilesError::Unavailable,
        ChatFilesError::NotPreviewable,
        ChatFilesError::OpenRefused,
        ChatFilesError::Failed,
    ]
    .into_iter()
    .zip(errors)
    {
        let error = WorkspaceError::from(error);
        assert_eq!(error.code, expected["code"]);
        assert_eq!(error.message, expected["message"]);
        assert_eq!(error.recoverable, expected["recoverable"]);
    }
}

#[test]
fn bytes_decide_what_a_file_is() {
    let mp3_frame = [0xff, 0xfb, 0x90, 0x00];
    let adts = [0xff, 0xf1, 0x50, 0x80];
    let mut mp4 = vec![0, 0, 0, 0x20];
    mp4.extend_from_slice(b"ftypisom");
    let mut m4a = vec![0, 0, 0, 0x20];
    m4a.extend_from_slice(b"ftypM4A ");
    let mut avif = vec![0, 0, 0, 0x20];
    avif.extend_from_slice(b"ftypavif");
    let mut webm = vec![0x1a, 0x45, 0xdf, 0xa3];
    webm.extend_from_slice(b"\x42\x82\x84webm");
    let mut matroska = vec![0x1a, 0x45, 0xdf, 0xa3];
    matroska.extend_from_slice(b"\x42\x82\x88matroska");
    let wav = wav_bytes();
    let emoji = "plain \u{1f600}";
    // Each case: name, first bytes, extension, kind, media type.
    type Case<'a> = (&'a str, &'a [u8], Option<&'a str>, ChatFileKind, &'a str);
    fn case<'a>(
        name: &'a str,
        head: &'a [u8],
        extension: Option<&'a str>,
        kind: ChatFileKind,
        mime: &'a str,
    ) -> Case<'a> {
        (name, head, extension, kind, mime)
    }
    let cases: Vec<Case<'_>> = vec![
        // The name never decides: a PNG called .txt is an image.
        case(
            "png named txt",
            PNG,
            Some("txt"),
            ChatFileKind::Image,
            "image/png",
        ),
        case(
            "jpeg",
            &[0xff, 0xd8, 0xff, 0xe0],
            None,
            ChatFileKind::Image,
            "image/jpeg",
        ),
        case("gif", b"GIF89a....", None, ChatFileKind::Image, "image/gif"),
        case(
            "webp",
            b"RIFF\0\0\0\0WEBPVP8 ",
            None,
            ChatFileKind::Image,
            "image/webp",
        ),
        case("wav", &wav, Some("png"), ChatFileKind::Audio, "audio/wav"),
        case(
            "mp3 tag",
            b"ID3\x04\0\0",
            None,
            ChatFileKind::Audio,
            "audio/mpeg",
        ),
        case(
            "mp3 frame",
            &mp3_frame,
            None,
            ChatFileKind::Audio,
            "audio/mpeg",
        ),
        case("ogg", b"OggS\0\x02", None, ChatFileKind::Audio, "audio/ogg"),
        case("flac", b"fLaC\0\0", None, ChatFileKind::Audio, "audio/flac"),
        case("m4a", &m4a, None, ChatFileKind::Audio, "audio/mp4"),
        case("mp4", &mp4, None, ChatFileKind::Video, "video/mp4"),
        case("webm", &webm, None, ChatFileKind::Video, "video/webm"),
        // Not played inline: a card.
        case(
            "matroska",
            &matroska,
            None,
            ChatFileKind::File,
            "video/x-matroska",
        ),
        case("avif", &avif, None, ChatFileKind::File, "image/avif"),
        case(
            "pdf",
            b"%PDF-1.7\n",
            None,
            ChatFileKind::Pdf,
            "application/pdf",
        ),
        // An SVG can carry script: a card, never an image.
        case(
            "svg",
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
            None,
            ChatFileKind::File,
            "image/svg+xml",
        ),
        case(
            "svg by name",
            b"<?xml version='1.0'?><g/>",
            Some("svg"),
            ChatFileKind::File,
            "image/svg+xml",
        ),
        case(
            "markdown",
            b"# Title\n",
            Some("md"),
            ChatFileKind::Text,
            "text/markdown",
        ),
        case(
            "text",
            emoji.as_bytes(),
            None,
            ChatFileKind::Text,
            "text/plain",
        ),
        case(
            "adts is not mp3",
            &adts,
            None,
            ChatFileKind::File,
            "application/octet-stream",
        ),
        case(
            "binary",
            &[0, 1, 2, 3, 0xfe],
            None,
            ChatFileKind::File,
            "application/octet-stream",
        ),
        case(
            "empty",
            b"",
            None,
            ChatFileKind::File,
            "application/octet-stream",
        ),
    ];
    for (name, head, extension, kind, mime) in cases {
        let sniffed = sniff_media(head, extension);
        assert_eq!((sniffed.kind, sniffed.mime), (kind, mime), "{name}");
        assert!(!sniffed.executable, "{name}");
    }
    let executables: Vec<(&str, Vec<u8>)> = vec![
        ("pe", pe_bytes()),
        ("elf", b"\x7fELF\x02\x01\x01".to_vec()),
        ("script", b"#!/bin/sh\necho hi\n".to_vec()),
        ("mach-o", vec![0xcf, 0xfa, 0xed, 0xfe, 0, 0]),
    ];
    for (name, head) in &executables {
        let sniffed = sniff_media(head, Some("txt"));
        assert!(sniffed.executable, "{name}");
        assert_eq!(sniffed.kind, ChatFileKind::File, "{name}");
    }
    // A text cut in the middle of a character is still text.
    let cut = &"é".as_bytes()[..1];
    assert_eq!(sniff_media(cut, None).kind, ChatFileKind::Text);
}

#[test]
fn only_a_bounded_image_audio_or_video_is_previewed() {
    let image = MAX_IMAGE_PREVIEW_BYTES;
    let media = MAX_MEDIA_PREVIEW_BYTES;
    assert!(is_previewable(ChatFileKind::Image, image));
    assert!(!is_previewable(ChatFileKind::Image, image + 1));
    assert!(!is_previewable(ChatFileKind::Image, 0));
    assert!(is_previewable(ChatFileKind::Audio, media));
    assert!(!is_previewable(ChatFileKind::Audio, media + 1));
    assert!(is_previewable(ChatFileKind::Video, media));
    assert!(!is_previewable(ChatFileKind::Video, media + 1));
    for kind in [ChatFileKind::Pdf, ChatFileKind::Text, ChatFileKind::File] {
        assert!(!is_previewable(kind, 10), "{kind:?}");
    }
}

#[test]
fn programs_and_scripts_are_never_opened() {
    for extension in [
        "exe", "bat", "cmd", "ps1", "lnk", "msi", "scr", "com", "vbs", "js", "jar", "hta", "reg",
        "dll", "url",
    ] {
        assert!(extension_never_opened(Some(extension)), "{extension}");
    }
    for extension in ["png", "txt", "pdf", "mp4", "wav", "md", "docx", "json"] {
        assert!(!extension_never_opened(Some(extension)), "{extension}");
    }
    assert!(!extension_never_opened(None));
    // Windows ignores trailing dots and spaces, so the host does too.
    assert_eq!(extension_of("Setup.EXE ").as_deref(), Some("exe"));
    assert_eq!(extension_of("run.bat.").as_deref(), Some("bat"));
    assert_eq!(extension_of("archive.tar.gz").as_deref(), Some("gz"));
    assert_eq!(extension_of(".gitignore"), None);
    assert_eq!(extension_of("README"), None);
}

#[test]
fn explorer_gets_one_quoted_argument_whatever_the_path_holds() {
    let plan = reveal_plan(Platform::Windows, Path::new(r"C:\Users\A B\x,y & z.png"))
        .expect("windows plan");
    assert_eq!(plan.program, "explorer.exe");
    assert!(plan.args.is_empty());
    assert_eq!(
        plan.raw_tail.as_deref(),
        Some(r#"/select,"C:\Users\A B\x,y & z.png""#)
    );
    // The verbatim prefix is not something Explorer understands.
    let verbatim = reveal_plan(Platform::Windows, Path::new(r"\\?\C:\a b\c.png")).expect("plan");
    assert_eq!(
        verbatim.raw_tail.as_deref(),
        Some(r#"/select,"C:\a b\c.png""#)
    );
    // A quote would end the argument early: refused.
    assert_eq!(
        reveal_plan(Platform::Windows, Path::new("C:\\a\"b.png")),
        Err(ChatFilesError::Failed)
    );
    assert_eq!(
        reveal_plan(Platform::Windows, Path::new("")),
        Err(ChatFilesError::Failed)
    );

    let mac = reveal_plan(Platform::MacOs, Path::new("/Users/a b/c,d & e.png")).expect("mac");
    assert_eq!(mac.program, "open");
    assert_eq!(
        mac.args,
        vec![
            OsString::from("-R"),
            OsString::from("/Users/a b/c,d & e.png")
        ]
    );
    assert_eq!(mac.raw_tail, None);

    let linux = reveal_plan(Platform::Linux, Path::new("/home/a b/c,d & e.png")).expect("linux");
    assert_eq!(linux.program, "xdg-open");
    assert_eq!(linux.args, vec![OsString::from("/home/a b")]);
    assert_eq!(
        reveal_plan(Platform::Linux, Path::new("/")),
        Err(ChatFilesError::Failed)
    );

    assert_eq!(open_plan(Platform::Windows, Path::new(r"C:\a.png")), None);
    let open = open_plan(Platform::MacOs, Path::new("/a b/c.png")).expect("mac open");
    assert_eq!(
        (open.program, open.args),
        ("open", vec![OsString::from("/a b/c.png")])
    );
    let open = open_plan(Platform::Linux, Path::new("/a b/c.png")).expect("linux open");
    assert_eq!(
        (open.program, open.args),
        ("xdg-open", vec![OsString::from("/a b/c.png")])
    );
}

#[test]
fn a_mention_is_a_plain_relative_name() {
    for (name, expected) in [
        ("render.png", vec!["render.png"]),
        ("docs\\render.png", vec!["docs", "render.png"]),
        ("./docs//render.png", vec!["docs", "render.png"]),
        ("  docs/a b.png  ", vec!["docs", "a b.png"]),
    ] {
        assert_eq!(
            mention_components(name),
            Ok(expected.iter().map(|part| (*part).to_owned()).collect()),
            "{name}"
        );
    }
    for name in [
        "",
        "   ",
        ".",
        "..",
        "../render.png",
        "docs/../../render.png",
        "docs\\..\\render.png",
        "/etc/passwd",
        "\\Windows\\win.ini",
        "C:\\Windows\\win.ini",
        "C:/Windows/win.ini",
        "C:render.png",
        "\\\\server\\share\\render.png",
        "//server/share/render.png",
        "render.png:stream",
        "a\0b.png",
        "line\nbreak.png",
    ] {
        assert_eq!(
            mention_components(name),
            Err(ChatFilesError::Invalid),
            "{name:?}"
        );
    }
    assert_eq!(
        mention_components(&"a".repeat(MAX_NAME_BYTES + 1)),
        Err(ChatFilesError::Invalid)
    );
}

#[test]
fn the_registry_takes_absolute_local_paths_of_plain_names() {
    let directory = test_root("chat-files-registry");
    let registry = ChatFileRegistry::open(&directory).expect("opens registry");
    let session = Uuid::new_v4().to_string();
    let base = directory.join("project");
    let png = write(&base, "a.png", PNG);

    // One entry per file: a second block and a second origin join it.
    assert!(registry.register_path(&session, "b1", &png, ChatFileOrigin::Written, None));
    assert!(registry.register_path(&session, "b2", &png, ChatFileOrigin::Read, None));
    assert!(registry.register_path(&session, "b2", &png, ChatFileOrigin::Generated, None));
    let entries = registry.entries(&session);
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].blocks,
        vec![
            ("b1".to_owned(), ChatFileOrigin::Written),
            ("b2".to_owned(), ChatFileOrigin::Generated)
        ]
    );
    assert_eq!(entries[0].name, "a.png");
    // `.` and `..` are resolved before the path is compared.
    let spelled = base.join("sub").join("..").join(".").join("a.png");
    assert!(registry.register_path(&session, "b3", &spelled, ChatFileOrigin::Read, None));
    assert_eq!(registry.entries(&session).len(), 1);

    // A relative path needs a base; it cannot climb out of the file system.
    assert!(!registry.register_path(
        &session,
        "b4",
        Path::new("a.png"),
        ChatFileOrigin::Read,
        None
    ));
    assert!(registry.register_path(
        &session,
        "b4",
        Path::new("a.png"),
        ChatFileOrigin::Read,
        Some(&base)
    ));
    let mut climbing = PathBuf::new();
    for _ in 0..64 {
        climbing.push("..");
    }
    climbing.push("x.png");
    assert!(!registry.register_path(&session, "b5", &climbing, ChatFileOrigin::Read, Some(&base)));
    // Unusable block ids and names are not kept.
    assert!(!registry.register_path(&session, "", &png, ChatFileOrigin::Read, None));
    assert!(!registry.register_path(&session, "bad\nid", &png, ChatFileOrigin::Read, None));
    assert!(!registry.register_path(
        &session,
        "b6",
        &base.join("x\0y.png"),
        ChatFileOrigin::Read,
        None
    ));
    assert!(!registry.register_path(&session, "b6", Path::new(""), ChatFileOrigin::Read, None));
    // A block list stays bounded.
    for index in 0..(MAX_BLOCKS_PER_FILE + 10) {
        registry.register_path(
            &session,
            &format!("many-{index}"),
            &png,
            ChatFileOrigin::Read,
            None,
        );
    }
    assert_eq!(
        registry.entries(&session)[0].blocks.len(),
        MAX_BLOCKS_PER_FILE
    );

    // Another session never sees the file or its id.
    let other = Uuid::new_v4().to_string();
    let id = registry.entries(&session)[0].id.clone();
    assert!(registry.find(&session, &id).is_some());
    assert!(registry.find(&other, &id).is_none());
    assert!(registry.entries(&other).is_empty());
}

#[cfg(windows)]
#[test]
fn network_and_device_paths_are_not_kept() {
    let directory = test_root("chat-files-network");
    let registry = ChatFileRegistry::open(&directory).expect("opens registry");
    let session = Uuid::new_v4().to_string();
    for path in [
        r"\\server\share\a.png",
        r"\\?\UNC\server\share\a.png",
        r"\\.\pipe\a.png",
        r"\a.png",
        r"C:a.png",
        r"C:\x\a.txt:evil.exe",
    ] {
        assert!(
            !registry.register_path(&session, "b1", Path::new(path), ChatFileOrigin::Read, None),
            "{path}"
        );
    }
    assert!(registry.register_path(
        &session,
        "b1",
        Path::new(r"C:\x\a.png"),
        ChatFileOrigin::Read,
        None
    ));
    assert!(registry.register_path(
        &session,
        "b1",
        Path::new(r"\\?\C:\x\b.png"),
        ChatFileOrigin::Read,
        None
    ));
}

#[test]
fn a_session_registry_holds_at_most_two_hundred_files() {
    let directory = test_root("chat-files-cap");
    let registry = ChatFileRegistry::open(&directory).expect("opens registry");
    let session = Uuid::new_v4().to_string();
    let base = directory.join("project");
    for index in 0..(MAX_FILES_PER_SESSION + 5) {
        let path = base.join(format!("file-{index}.txt"));
        assert!(registry.register_path(&session, "b1", &path, ChatFileOrigin::Written, None));
    }
    let entries = registry.entries(&session);
    assert_eq!(entries.len(), MAX_FILES_PER_SESSION);
    assert_eq!(entries[0].name, "file-5.txt");
    assert_eq!(
        entries[MAX_FILES_PER_SESSION - 1].name,
        format!("file-{}.txt", MAX_FILES_PER_SESSION + 4)
    );
}

#[test]
fn inline_bytes_are_stored_by_the_host_sniffed_and_capped() {
    let directory = test_root("chat-files-inline");
    let registry = ChatFileRegistry::open(&directory).expect("opens registry");
    let session = Uuid::new_v4().to_string();
    assert!(registry.register_inline(&session, "b1", "image/jpeg", PNG, ChatFileOrigin::Read));
    let entries = registry.entries(&session);
    assert_eq!(entries.len(), 1);
    // The bytes are a PNG whatever the declared type says.
    assert_eq!(entries[0].name, "image.png");
    assert!(entries[0].owned);
    assert!(
        entries[0]
            .path
            .starts_with(directory.join(CHAT_FILES_DIRECTORY).join(&session))
    );
    assert_eq!(fs::read(&entries[0].path).expect("stored bytes"), PNG);
    let (files, _) = list_files(&entries);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].kind, ChatFileKind::Image);
    assert!(files[0].previewable);
    // There is no folder to show for a file the host stored.
    assert!(!files[0].revealable);

    // Programs, empty bytes and ids that are not sessions are refused.
    assert!(!registry.register_inline(
        &session,
        "b2",
        "image/png",
        &pe_bytes(),
        ChatFileOrigin::Read
    ));
    assert!(!registry.register_inline(&session, "b2", "image/png", b"", ChatFileOrigin::Read));
    assert!(!registry.register_inline("../escape", "b2", "image/png", PNG, ChatFileOrigin::Read));

    // The oldest inline files make room for new ones, and their bytes go.
    for index in 0..(MAX_INLINE_FILES_PER_SESSION + 6) {
        assert!(registry.register_inline(
            &session,
            &format!("n{index}"),
            "image/png",
            PNG,
            ChatFileOrigin::Returned
        ));
    }
    let kept = registry.entries(&session);
    assert_eq!(kept.len(), MAX_INLINE_FILES_PER_SESSION);
    let stored = fs::read_dir(directory.join(CHAT_FILES_DIRECTORY).join(&session))
        .expect("session folder")
        .count();
    assert_eq!(stored, MAX_INLINE_FILES_PER_SESSION);

    // Inline files last as long as the run that produced them.
    let reopened = ChatFileRegistry::open(&directory).expect("reopens registry");
    assert!(reopened.entries(&session).is_empty());
    assert!(!directory.join(CHAT_FILES_DIRECTORY).join(&session).exists());
}

#[test]
fn a_replaced_path_is_not_the_file_that_was_seen() {
    let directory = test_root("chat-files-pinned");
    let first = write(&directory, "first.png", PNG);
    let second = write(&directory, "second.png", PNG);
    let mut entry = Entry {
        id: Uuid::new_v4().to_string(),
        path: first.clone(),
        pinned: None,
        owned: false,
        name: "first.png".into(),
        blocks: vec![("b1".into(), ChatFileOrigin::Written)],
        inline_bytes: 0,
        digest: None,
    };
    let opened = open_entry(&entry).expect("opens the file");
    assert_eq!(opened.len, PNG.len() as u64);
    entry.pinned = Some(fs::canonicalize(&second).expect("canonical"));
    assert_eq!(open_entry(&entry).err(), Some(ChatFilesError::Unavailable));
    entry.pinned = Some(opened.canonical.clone());
    assert!(open_entry(&entry).is_ok());
    // A folder is not a file.
    entry.path = directory.clone();
    entry.pinned = None;
    assert_eq!(open_entry(&entry).err(), Some(ChatFilesError::Unavailable));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_png_named_txt_is_listed_as_an_image_and_previewed() {
    let setup = setup("chat-files-png").await;
    let path = write(&setup.outside, "photo.txt", PNG);
    assert!(report(&setup, "block-1", &path));
    let files = listed(&setup).await;
    assert_eq!(files.len(), 1);
    let file = &files[0];
    assert_eq!(file.block_id, "block-1");
    assert_eq!(file.name, "photo.txt");
    assert_eq!(file.kind, ChatFileKind::Image);
    assert_eq!(file.media_type.as_deref(), Some("image/png"));
    assert_eq!(file.size, Some(PNG.len() as u64));
    assert!(file.previewable && file.openable && file.revealable && !file.unavailable);
    match run(&setup, preview_command(&setup, &file.id)).await {
        Ok(ChatFilesResult::Preview {
            media_type,
            data,
            file_id,
            ..
        }) => {
            assert_eq!(file_id, file.id);
            assert_eq!(media_type, "image/png");
            assert_eq!(
                base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .expect("base64"),
                PNG
            );
        }
        other => panic!("expected a preview, got {other:?}"),
    }
    // A session that reported nothing lists nothing.
    let other = ChatFilesCommand::List {
        session_id: Uuid::new_v4().to_string(),
    };
    assert_eq!(code(run(&setup, other).await), "NOT_FOUND");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_audio_file_is_a_previewable_card_and_a_document_is_not() {
    let setup = setup("chat-files-audio").await;
    let wav = write(&setup.outside, "voice.wav", &wav_bytes());
    let pdf = write(&setup.outside, "report.pdf", b"%PDF-1.7\n%%EOF");
    assert!(report(&setup, "block-1", &wav));
    assert!(report(&setup, "block-1", &pdf));
    let files = listed(&setup).await;
    assert_eq!(files.len(), 2);
    assert_eq!(
        (files[0].kind, files[0].previewable),
        (ChatFileKind::Audio, true)
    );
    assert_eq!(
        (files[1].kind, files[1].previewable),
        (ChatFileKind::Pdf, false)
    );
    assert_eq!(
        code(run(&setup, preview_command(&setup, &files[1].id)).await),
        "CHAT_FILE_NOT_PREVIEWABLE"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forged_and_foreign_ids_are_refused() {
    let setup = setup("chat-files-forged").await;
    let path = write(&setup.outside, "a.png", PNG);
    assert!(report(&setup, "block-1", &path));
    // A well-formed id nobody handed out.
    let forged = Uuid::new_v4().to_string();
    for command in [
        preview_command(&setup, &forged),
        ChatFilesCommand::Save {
            session_id: setup.session.clone(),
            file_id: forged.clone(),
        },
        ChatFilesCommand::Reveal {
            session_id: setup.session.clone(),
            file_id: forged.clone(),
        },
        ChatFilesCommand::Open {
            session_id: setup.session.clone(),
            file_id: forged.clone(),
        },
    ] {
        assert_eq!(code(run(&setup, command).await), "CHAT_FILE_UNAVAILABLE");
    }
    // A path, a name or anything else that is not an id the host made.
    for bad in [
        path.to_string_lossy().into_owned(),
        "a.png".into(),
        String::new(),
        "../x".into(),
    ] {
        assert_eq!(
            code(run(&setup, preview_command(&setup, &bad)).await),
            "INVALID_ARGUMENT",
            "{bad}"
        );
    }
    // An id of another session's registry does not work in this one.
    let other = Uuid::new_v4().to_string();
    let foreign = write(&setup.outside, "foreign.png", PNG);
    assert!(registry(&setup).register_path(
        &other,
        "block-9",
        &foreign,
        ChatFileOrigin::Written,
        None
    ));
    let foreign_id = registry(&setup).entries(&other)[0].id.clone();
    assert_eq!(
        code(run(&setup, preview_command(&setup, &foreign_id)).await),
        "CHAT_FILE_UNAVAILABLE"
    );
    // A session that does not exist.
    let missing = ChatFilesCommand::Preview {
        session_id: Uuid::new_v4().to_string(),
        file_id: forged,
    };
    assert_eq!(code(run(&setup, missing).await), "NOT_FOUND");
    let invalid = ChatFilesCommand::List {
        session_id: "not-a-session".into(),
    };
    assert_eq!(code(run(&setup, invalid).await), "INVALID_ARGUMENT");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_file_becomes_unavailable() {
    let setup = setup("chat-files-deleted").await;
    let path = write(&setup.outside, "gone.png", PNG);
    assert!(report(&setup, "block-1", &path));
    let before = listed(&setup).await;
    assert!(!before[0].unavailable);
    fs::remove_file(&path).expect("deletes file");
    let after = listed(&setup).await;
    assert_eq!(after.len(), 1);
    let file = &after[0];
    assert!(file.unavailable);
    assert!(!file.previewable && !file.openable && !file.revealable);
    assert_eq!(file.name, "gone.png");
    assert_eq!(
        code(run(&setup, preview_command(&setup, &file.id)).await),
        "CHAT_FILE_UNAVAILABLE"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_link_is_refused_even_when_it_points_at_an_image() {
    let setup = setup("chat-files-link").await;
    let target = write(&setup.outside, "target.png", PNG);
    let link = setup.outside.join("link.png");
    if !try_symlink(&target, &link, false) {
        eprintln!("skipped: this account cannot create symbolic links");
        return;
    }
    assert!(report(&setup, "block-1", &link));
    let files = listed(&setup).await;
    assert_eq!(files.len(), 1);
    assert!(files[0].unavailable);
    assert_eq!(
        code(run(&setup, preview_command(&setup, &files[0].id)).await),
        "CHAT_FILE_UNAVAILABLE"
    );
    let save = ChatFilesCommand::Save {
        session_id: setup.session.clone(),
        file_id: files[0].id.clone(),
    };
    assert_eq!(code(run(&setup, save).await), "CHAT_FILE_UNAVAILABLE");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_program_is_never_opened_but_can_be_shown_and_saved() {
    let setup = setup("chat-files-exe").await;
    let named = write(&setup.outside, "setup.exe", b"not really a program");
    let disguised = write(&setup.outside, "notes.txt", &pe_bytes());
    let script = write(&setup.outside, "run.ps1", b"Write-Host hi");
    for path in [&named, &disguised, &script] {
        assert!(report(&setup, "block-1", path));
    }
    let files = listed(&setup).await;
    assert_eq!(files.len(), 3);
    for file in &files {
        assert!(!file.openable, "{}", file.name);
        assert!(file.revealable, "{}", file.name);
    }
    let recorder = Arc::new(Recorder::default());
    for file in &files {
        let open = ChatFilesCommand::Open {
            session_id: setup.session.clone(),
            file_id: file.id.clone(),
        };
        let result = run_with(&setup, open, no_dialog(), recorder.clone()).await;
        assert_eq!(code(result), "CHAT_FILE_OPEN_REFUSED", "{}", file.name);
    }
    assert!(recorder.opened.lock().expect("lock").is_empty());

    // Reveal and Save stay allowed for the same file.
    let first = &files[0];
    let reveal = ChatFilesCommand::Reveal {
        session_id: setup.session.clone(),
        file_id: first.id.clone(),
    };
    assert!(matches!(
        run_with(&setup, reveal, no_dialog(), recorder.clone()).await,
        Ok(ChatFilesResult::Revealed { .. })
    ));
    assert_eq!(
        recorder.revealed.lock().expect("lock").as_slice(),
        [fs::canonicalize(&named).expect("canonical")]
    );
    let destination = setup.outside.join("copy.exe");
    let target = destination.clone();
    let save = ChatFilesCommand::Save {
        session_id: setup.session.clone(),
        file_id: first.id.clone(),
    };
    let saved = run_with(
        &setup,
        save,
        Box::new(move |_| Some(target)),
        recorder.clone(),
    )
    .await;
    assert!(matches!(
        saved,
        Ok(ChatFilesResult::Saved { saved: true, .. })
    ));
    assert_eq!(
        fs::read(&destination).expect("copy"),
        b"not really a program"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_and_reveal_hand_the_canonical_path_to_the_system() {
    let setup = setup("chat-files-open").await;
    let path = write(&setup.outside, "pic.png", PNG);
    assert!(report(&setup, "block-1", &path));
    let id = listed(&setup).await[0].id.clone();
    let recorder = Arc::new(Recorder::default());
    let open = ChatFilesCommand::Open {
        session_id: setup.session.clone(),
        file_id: id.clone(),
    };
    assert!(matches!(
        run_with(&setup, open, no_dialog(), recorder.clone()).await,
        Ok(ChatFilesResult::Opened { .. })
    ));
    let reveal = ChatFilesCommand::Reveal {
        session_id: setup.session.clone(),
        file_id: id,
    };
    assert!(matches!(
        run_with(&setup, reveal, no_dialog(), recorder.clone()).await,
        Ok(ChatFilesResult::Revealed { .. })
    ));
    let canonical = fs::canonicalize(&path).expect("canonical");
    assert_eq!(
        recorder.opened.lock().expect("lock").as_slice(),
        std::slice::from_ref(&canonical)
    );
    assert_eq!(
        recorder.revealed.lock().expect("lock").as_slice(),
        [canonical]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_save_writes_nothing_and_a_save_copies_the_bytes() {
    let setup = setup("chat-files-save").await;
    let path = write(&setup.outside, "pic.png", PNG);
    assert!(report(&setup, "block-1", &path));
    let id = listed(&setup).await[0].id.clone();
    let command = |id: &str| ChatFilesCommand::Save {
        session_id: setup.session.clone(),
        file_id: id.into(),
    };
    let destination = setup.outside.join("saved").join("copy.png");
    fs::create_dir_all(destination.parent().expect("parent")).expect("creates folder");

    // The dialog suggests the file's own name; cancelling saves nothing.
    let suggested = Arc::new(Mutex::new(String::new()));
    let seen = Arc::clone(&suggested);
    let cancelled = run_with(
        &setup,
        command(&id),
        Box::new(move |name| {
            *seen.lock().expect("lock") = name;
            None
        }),
        Arc::new(Recorder::default()),
    )
    .await;
    assert!(matches!(
        cancelled,
        Ok(ChatFilesResult::Saved { saved: false, .. })
    ));
    assert_eq!(*suggested.lock().expect("lock"), "pic.png");
    assert_eq!(
        fs::read_dir(destination.parent().expect("parent"))
            .expect("folder")
            .count(),
        0
    );

    let target = destination.clone();
    let saved = run_with(
        &setup,
        command(&id),
        Box::new(move |_| Some(target)),
        Arc::new(Recorder::default()),
    )
    .await;
    assert!(matches!(
        saved,
        Ok(ChatFilesResult::Saved { saved: true, .. })
    ));
    assert_eq!(fs::read(&destination).expect("copy"), PNG);
    // No temporary file is left beside the copy.
    assert_eq!(
        fs::read_dir(destination.parent().expect("parent"))
            .expect("folder")
            .count(),
        1
    );

    // Saving over the file itself never empties it.
    let source = path.clone();
    let same = run_with(
        &setup,
        command(&id),
        Box::new(move |_| Some(source)),
        Arc::new(Recorder::default()),
    )
    .await;
    assert!(matches!(
        same,
        Ok(ChatFilesResult::Saved { saved: true, .. })
    ));
    assert_eq!(fs::read(&path).expect("source"), PNG);

    // A file that disappeared while the dialog was open is not "saved".
    let doomed = path.clone();
    let late = run_with(
        &setup,
        command(&id),
        Box::new(move |_| {
            fs::remove_file(&doomed).expect("deletes file");
            Some(doomed.with_file_name("late.png"))
        }),
        Arc::new(Recorder::default()),
    )
    .await;
    assert_eq!(code(late), "CHAT_FILE_UNAVAILABLE");
    // A missing file is refused before any dialog opens.
    assert_eq!(
        code(run(&setup, command(&id)).await),
        "CHAT_FILE_UNAVAILABLE"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_image_over_the_preview_cap_is_a_card_only() {
    let setup = setup("chat-files-large").await;
    let path = write(&setup.outside, "huge.png", PNG);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("opens file")
        .set_len(MAX_IMAGE_PREVIEW_BYTES + 1)
        .expect("grows file");
    assert!(report(&setup, "block-1", &path));
    let files = listed(&setup).await;
    assert_eq!(files[0].kind, ChatFileKind::Image);
    assert!(!files[0].previewable);
    assert_eq!(files[0].size, Some(MAX_IMAGE_PREVIEW_BYTES + 1));
    assert_eq!(
        code(run(&setup, preview_command(&setup, &files[0].id)).await),
        "CHAT_FILE_NOT_PREVIEWABLE"
    );
    // Save and Reveal stay available for a card.
    assert!(files[0].openable && files[0].revealable);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn safe_mode_refuses_every_command() {
    let root = test_root("chat-files-safe");
    let host = HostState::open(&root, true).expect("host state");
    let session = Uuid::new_v4().to_string();
    let id = Uuid::new_v4().to_string();
    let commands = vec![
        ChatFilesCommand::List {
            session_id: session.clone(),
        },
        ChatFilesCommand::Preview {
            session_id: session.clone(),
            file_id: id.clone(),
        },
        ChatFilesCommand::Save {
            session_id: session.clone(),
            file_id: id.clone(),
        },
        ChatFilesCommand::Reveal {
            session_id: session.clone(),
            file_id: id.clone(),
        },
        ChatFilesCommand::Open {
            session_id: session.clone(),
            file_id: id,
        },
        ChatFilesCommand::Resolve {
            session_id: session,
            name: "a.png".into(),
        },
    ];
    for command in commands {
        let result =
            run_chat_files(&host, command, no_dialog(), Arc::new(Recorder::default())).await;
        assert_eq!(code(result), "SAFE_MODE");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mention_finds_the_latest_reported_file_by_name() {
    let setup = setup("chat-files-resolve-name").await;
    let older = write(&setup.outside.join("a"), "render.png", PNG);
    let newer = write(&setup.outside.join("b"), "render.png", PNG);
    assert!(report(&setup, "block-1", &older));
    assert!(report(&setup, "block-2", &newer));
    let ids = registry(&setup)
        .entries(&setup.session)
        .into_iter()
        .map(|entry| entry.id)
        .collect::<Vec<_>>();

    // The latest file of that name wins; a mention belongs to no block.
    let latest = resolved(&setup, "render.png").await.expect("found");
    assert_eq!(latest.id, ids[1]);
    assert_eq!(latest.block_id, "");
    assert_eq!(latest.kind, ChatFileKind::Image);
    assert!(latest.previewable);
    // A folder in the mention picks the file that lives there.
    assert_eq!(
        resolved(&setup, "a/render.png").await.expect("found").id,
        ids[0]
    );
    assert_eq!(
        resolved(&setup, "a\\RENDER.png").await.is_some(),
        cfg!(windows)
    );
    // The id works with Preview.
    assert!(matches!(
        run(&setup, preview_command(&setup, &latest.id)).await,
        Ok(ChatFilesResult::Preview { .. })
    ));
    // A deleted file is skipped for the next one of that name.
    fs::remove_file(&newer).expect("deletes file");
    assert_eq!(
        resolved(&setup, "render.png").await.expect("found").id,
        ids[0]
    );
    assert!(resolved(&setup, "unknown.png").await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mention_finds_a_workspace_file_and_registers_it_without_a_block() {
    let setup = setup("chat-files-resolve-path").await;
    write(&setup.workspace.join("docs"), "shot.png", PNG);
    fs::create_dir_all(setup.workspace.join("docs").join("folder")).expect("creates folder");
    let file = resolved(&setup, "docs/shot.png").await.expect("found");
    assert_eq!(file.name, "shot.png");
    assert_eq!(file.block_id, "");
    assert_eq!(file.origin, ChatFileOrigin::Returned);
    assert!(file.previewable && file.openable && file.revealable && !file.unavailable);
    // Registered: the same mention gives the same id, and Preview works.
    assert_eq!(
        resolved(&setup, "./docs\\shot.png")
            .await
            .expect("found")
            .id,
        file.id
    );
    assert_eq!(registry(&setup).entries(&setup.session).len(), 1);
    assert!(matches!(
        run(&setup, preview_command(&setup, &file.id)).await,
        Ok(ChatFilesResult::Preview { .. })
    ));
    // It belongs to no message: the list does not show it.
    assert!(listed(&setup).await.is_empty());
    // A folder, a missing file and a file outside the workspace are nothing.
    assert!(resolved(&setup, "docs/folder").await.is_none());
    assert!(resolved(&setup, "docs/missing.png").await.is_none());
    write(&setup.outside, "secret.png", PNG);
    assert!(resolved(&setup, "secret.png").await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mention_cannot_leave_the_workspace() {
    let setup = setup("chat-files-resolve-escape").await;
    let secret = write(&setup.outside, "secret.png", PNG);
    for name in [
        "../outside/secret.png",
        "docs/../../outside/secret.png",
        "/etc/passwd",
        "C:\\Windows\\win.ini",
        "C:/Windows/win.ini",
        "\\\\server\\share\\a.png",
        "//server/share/a.png",
        "",
    ] {
        assert_eq!(
            code(run(&setup, resolve_command(&setup, name)).await),
            "INVALID_ARGUMENT",
            "{name:?}"
        );
    }
    // A link inside the workspace that points outside it leads nowhere.
    let folder_link = setup.workspace.join("out");
    if try_symlink(&setup.outside, &folder_link, true) {
        assert!(resolved(&setup, "out/secret.png").await.is_none());
    } else {
        eprintln!("skipped: this account cannot create symbolic links");
    }
    let file_link = setup.workspace.join("secret-link.png");
    if try_symlink(&secret, &file_link, false) {
        assert!(resolved(&setup, "secret-link.png").await.is_none());
    }
    assert!(registry(&setup).entries(&setup.session).is_empty());
}

#[test]
fn history_reports_register_once_and_the_same_inline_bytes_of_a_block_are_one_file() {
    let directory = test_root("chat-files-history");
    let registry = ChatFileRegistry::open(&directory).expect("opens registry");
    let session = Uuid::new_v4().to_string();
    let chart = write(&directory, "chart.png", PNG);
    let reports = || {
        vec![
            HistoryChatFile {
                block_id: "b1".into(),
                path: Some(chart.clone()),
                inline: None,
                origin: HistoryChatFileOrigin::Generated,
            },
            HistoryChatFile {
                block_id: "b2".into(),
                path: None,
                inline: Some(("image/png".into(), PNG.to_vec())),
                origin: HistoryChatFileOrigin::Read,
            },
            HistoryChatFile {
                block_id: "b3".into(),
                path: None,
                inline: None,
                origin: HistoryChatFileOrigin::Read,
            },
        ]
    };
    record_history(&registry, &session, &directory, &reports());
    let first: Vec<String> = registry
        .entries(&session)
        .iter()
        .map(|entry| entry.id.clone())
        .collect();
    assert_eq!(first.len(), 2);

    // Opening the chat again reports the same files: nothing new, same ids.
    record_history(&registry, &session, &directory, &reports());
    record_history(&registry, &session, &directory, &reports());
    let again: Vec<String> = registry
        .entries(&session)
        .iter()
        .map(|entry| entry.id.clone())
        .collect();
    assert_eq!(again.len(), first.len());
    for id in &first {
        assert!(again.contains(id));
    }
    let stored = fs::read_dir(directory.join(CHAT_FILES_DIRECTORY).join(&session))
        .expect("session folder")
        .count();
    assert_eq!(stored, 1);

    // The same bytes under another block are another file.
    assert!(registry.register_inline(&session, "b4", "image/png", PNG, ChatFileOrigin::Read));
    assert_eq!(registry.entries(&session).len(), 3);
}
