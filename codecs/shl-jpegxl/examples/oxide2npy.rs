//! Test helper: renders the first frame with jxl-oxide to a float32 .npy (h, w, c).
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let data = std::fs::read(&args[1]).unwrap();
    let mut img = jxl_oxide::JxlImage::builder().pool(jxl_oxide::JxlThreadPool::none()).read(&data[..]).unwrap();
    if args.len() > 3 && args[3] == "linear" {
        if let jxl_oxide::color::ColourEncoding::Enum(e) = &img.image_header().metadata.colour_encoding {
            let e = jxl_oxide::color::EnumColourEncoding { tf: jxl_oxide::color::TransferFunction::Linear, ..e.clone() };
            img.request_color_encoding(e);
        }
    }
    let r = img.render_frame(0).unwrap();
    let mut s = r.stream();
    let (w, h, c) = (s.width() as usize, s.height() as usize, s.channels() as usize);
    let mut buf = vec![0f32; w * h * c];
    s.write_to_buffer(&mut buf);
    let mut header = format!("{{'descr': '<f4', 'fortran_order': False, 'shape': (1, {h}, {w}, {c}), }}");
    while (header.len() + 11) % 64 != 0 {
        header.push(' ');
    }
    header.push('\n');
    let mut out = b"\x93NUMPY\x01\x00".to_vec();
    out.extend_from_slice(&(header.len() as u16).to_le_bytes());
    out.extend_from_slice(header.as_bytes());
    for v in buf {
        out.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(&args[2], out).unwrap();
}
