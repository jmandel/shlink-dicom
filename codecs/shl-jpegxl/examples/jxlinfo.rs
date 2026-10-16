//! Prints the image header of a JPEG XL file.
fn main() {
    let data = std::fs::read(std::env::args().nth(1).unwrap()).unwrap();
    match shl_jpegxl::info(&data) {
        Ok(i) => println!("{i:#?}"),
        Err(e) => println!("error: {e}"),
    }
}
