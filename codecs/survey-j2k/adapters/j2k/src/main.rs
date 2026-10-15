use j2k::J2kDecoder;
fn main() {
    let (data, out) = survey_common::args();
    let mut d = J2kDecoder::new(&data).unwrap_or_else(|e| survey_common::fail(format!("{e}")));
    if std::env::var_os("SURVEY_J2K_F32").is_some() {
        let comps = d.decode_components().unwrap_or_else(|e| survey_common::fail(format!("{e}")));
        let (w, h) = comps.dimensions();
        let signed = comps.planes().iter().any(|p| p.signed());
        let planes: Vec<Vec<i32>> = comps.planes().iter().map(|p| p.samples().iter().map(|v| v.round() as i32).collect()).collect();
        survey_common::write_planes(&out, w, h, &planes, signed);
        return;
    }
    let comps = d.decode_native_components().unwrap_or_else(|e| survey_common::fail(format!("{e}")));
    let (w, h) = comps.dimensions();
    let mut signed = false;
    let planes: Vec<Vec<i32>> = comps.planes().iter().map(|p| {
        signed |= p.signed();
        let bps = p.bytes_per_sample() as usize;
        p.data().chunks_exact(bps).map(|c| match (bps, p.signed()) {
            (1, false) => c[0] as i32,
            (1, true) => c[0] as i8 as i32,
            (2, false) => u16::from_le_bytes([c[0], c[1]]) as i32,
            (2, true) => i16::from_le_bytes([c[0], c[1]]) as i32,
            (4, _) => i32::from_le_bytes([c[0], c[1], c[2], c[3]]),
            _ => survey_common::fail("odd bytes_per_sample"),
        }).collect()
    }).collect();
    survey_common::write_planes(&out, w, h, &planes, signed);
}
