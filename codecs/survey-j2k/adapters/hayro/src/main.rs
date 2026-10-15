use hayro_jpeg2000::{DecodeSettings, DecoderContext, Image};
fn main() {
    let (data, out) = survey_common::args();
    let img = Image::new(&data, &DecodeSettings::default()).unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    let (w, h) = (img.width(), img.height());
    let mut ctx = DecoderContext::default();
    let dec = img.decode(&mut ctx).unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    let planes: Vec<Vec<i32>> = dec.components().iter().map(|c| c.samples().iter().map(|v| v.round() as i32).collect()).collect();
    survey_common::write_planes(&out, w, h, &planes, false);
}
