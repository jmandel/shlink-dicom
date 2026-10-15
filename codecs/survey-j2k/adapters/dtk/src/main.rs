use dicom_toolkit_jpeg2000::{DecodeSettings, Image};
fn main() {
    let (data, out) = survey_common::args();
    let img = Image::new(&data, &DecodeSettings::default()).unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    let raw = img.decode_native().unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    let v: Vec<i32> = if raw.bytes_per_sample == 1 {
        raw.data.iter().map(|&b| b as i32).collect()
    } else {
        raw.data.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]]) as i32).collect()
    };
    survey_common::write_interleaved(&out, raw.width, raw.height, raw.num_components as usize, &v, false);
}
