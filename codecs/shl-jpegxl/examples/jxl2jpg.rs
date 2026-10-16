//! Rebuilds the JPEG from a recompressed JPEG XL file. Usage: jxl2jpg IN.jxl OUT.jpg
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let data = std::fs::read(&a[1]).unwrap();
    match shl_jpegxl::reconstruct_jpeg(&data, &shl_jpegxl::Options::default()) {
        Ok(j) => std::fs::write(&a[2], j).unwrap(),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    }
}
