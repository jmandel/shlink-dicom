use oxigdal_jpeg2000::Jpeg2000Reader;
fn main() {
    let (data, out) = survey_common::args();
    let mut r = Jpeg2000Reader::new(std::io::Cursor::new(data)).unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    r.parse_headers().unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    let (w, h, nc) = (r.width().unwrap(), r.height().unwrap(), r.num_components().unwrap());
    let rgb = r.decode_rgb().unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    let v: Vec<i32> = if nc >= 3 { rgb.iter().map(|&b| b as i32).collect() } else { rgb.chunks_exact(3).map(|c| c[0] as i32).collect() };
    survey_common::write_interleaved(&out, w, h, if nc >= 3 { 3 } else { 1 }, &v, false);
}
