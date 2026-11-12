fn main() {
    const INPUTS: [&str; 3] = [
        "PIUI_NANO_RUNTIME_ARCHIVE",
        "PIUI_NANO_RUNTIME_MANIFEST",
        "PIUI_NANO_RUNTIME_VERSION",
    ];
    println!("cargo:rustc-check-cfg=cfg(bundled_nano_runtime)");
    let inputs = INPUTS.map(|name| {
        println!("cargo:rerun-if-env-changed={name}");
        std::env::var(name).ok()
    });
    if inputs.iter().all(Option::is_none) {
        return;
    }
    assert_eq!(
        std::env::var("TARGET").as_deref(),
        Ok("x86_64-pc-windows-msvc")
    );
    for (name, value) in INPUTS.into_iter().zip(inputs) {
        let value = value.expect("the bundled Nano runtime requires all three build inputs");
        if name != "PIUI_NANO_RUNTIME_VERSION" {
            let path = std::path::Path::new(&value);
            assert!(path.is_absolute() && path.is_file(), "invalid {name}");
            println!("cargo:rerun-if-changed={value}");
        }
        println!("cargo:rustc-env={name}={value}");
    }
    println!("cargo:rustc-cfg=bundled_nano_runtime");
}
