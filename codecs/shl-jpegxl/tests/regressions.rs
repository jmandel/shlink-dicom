//! Inputs found by fuzzing: each must be refused with an error, not a panic.

#[test]
fn fuzz_findings_are_errors_not_panics() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data");
    let mut n = 0;
    for e in std::fs::read_dir(&dir).unwrap() {
        let p = e.unwrap().path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if !name.starts_with("fuzz-") {
            continue;
        }
        let data = std::fs::read(&p).unwrap();
        let opts = shl_jpegxl::Options { max_pixels: 1 << 20 };
        let r = std::panic::catch_unwind(|| shl_jpegxl::decode(&data, &opts).map(|_| ()));
        assert!(r.is_ok(), "{name} panicked");
        n += 1;
    }
    assert!(n > 0);
}
