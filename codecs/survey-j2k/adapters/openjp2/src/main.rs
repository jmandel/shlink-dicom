use openjp2::{opj_dparameters_t, Codec, Stream, OPJ_CODEC_J2K};
fn main() {
    let (data, out) = survey_common::args();
    let tmp = std::env::temp_dir().join(format!("a-openjp2-{}.j2c", std::process::id()));
    std::fs::write(&tmp, &data).expect("tmp");
    let mut codec = Codec::new_decoder(OPJ_CODEC_J2K).unwrap_or_else(|| survey_common::fail("codec"));
    let mut params = opj_dparameters_t::default();
    if codec.setup_decoder(&mut params) == 0 { survey_common::fail("setup"); }
    let mut stream = Stream::new_file(&tmp, 1 << 20, true).unwrap_or_else(|e| survey_common::fail(e));
    let mut img = codec.read_header(&mut stream).unwrap_or_else(|| survey_common::fail("read_header"));
    if codec.decode(&mut stream, &mut img) == 0 { survey_common::fail("decode"); }
    let _ = std::fs::remove_file(&tmp);
    let comps = img.comps().unwrap_or_else(|| survey_common::fail("no comps"));
    let signed = comps.iter().any(|c| c.sgnd != 0);
    let (w, h) = (comps[0].w, comps[0].h);
    let planes: Vec<Vec<i32>> = comps.iter().map(|c| c.data().map(|d| d.to_vec()).unwrap_or_default()).collect();
    survey_common::write_planes(&out, w, h, &planes, signed);
}
