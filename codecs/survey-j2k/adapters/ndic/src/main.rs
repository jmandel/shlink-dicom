fn main() {
    let (data, out) = survey_common::args();
    let cs = ndic_codestream::Codestream::parse(&data).unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    let d = cs.decode().unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    survey_common::write_planes(&out, d.width as u32, d.height as u32, &d.comps, false);
}
