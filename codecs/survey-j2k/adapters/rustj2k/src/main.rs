fn main() {
    let (data, out) = survey_common::args();
    let img = rust_j2k::decode(&data).unwrap_or_else(|e| survey_common::fail(format!("{e}")));
    let signed = img.components.iter().any(|c| c.signed);
    let planes: Vec<Vec<i32>> = img.components.iter().map(|c| c.samples.clone()).collect();
    survey_common::write_planes(&out, img.width, img.height, &planes, signed);
}
