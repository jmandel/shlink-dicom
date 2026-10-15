use openjph_core::codestream::Codestream;
use openjph_core::file::MemInfile;
fn main() {
    let (data, out) = survey_common::args();
    let siz = survey_common::parse_siz(&data).unwrap_or_else(|| survey_common::fail("no SIZ"));
    let mut inf = MemInfile::new(&data);
    let mut cs = Codestream::new();
    cs.read_headers(&mut inf).unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    let nc = cs.access_siz().get_num_components();
    let signed = cs.access_siz().is_signed(0);
    cs.create(&mut inf).unwrap_or_else(|e| survey_common::fail(format!("{e:?}")));
    let mut planes = vec![Vec::new(); nc as usize];
    for _ in 0..siz.height {
        for c in 0..nc as u32 {
            let line = cs.pull(c).unwrap_or_else(|| survey_common::fail("pull failed"));
            planes[c as usize].extend_from_slice(&line[..]);
        }
    }
    survey_common::write_planes(&out, siz.width, siz.height, &planes, signed);
}
