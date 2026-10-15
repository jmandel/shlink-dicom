fn main() {
    let (data, out) = survey_common::args();
    let siz = survey_common::parse_siz(&data).unwrap_or_else(|| survey_common::fail("no SIZ"));
    let (px, w, h) = jpeg2k::decode(&data, siz.width, siz.height).unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    let v: Vec<i32> = px.iter().map(|&x| x as i32).collect();
    survey_common::write_interleaved(&out, w, h, 1, &v, false);
}
