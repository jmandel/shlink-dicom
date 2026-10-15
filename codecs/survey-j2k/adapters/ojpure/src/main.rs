use openjp2::{Decoder, Format};
fn main() {
    let (data, out) = survey_common::args();
    let fmt = Format::detect(&data).unwrap_or(Format::J2k);
    let img = Decoder::new(fmt).unwrap_or_else(|e| survey_common::fail(format!("{e:?}")))
        .decode(data).unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    let signed = img.components.iter().any(|c| c.signed);
    let planes: Vec<Vec<i32>> = img.components.iter().map(|c| c.data.to_vec()).collect();
    survey_common::write_planes(&out, img.width, img.height, &planes, signed);
}
