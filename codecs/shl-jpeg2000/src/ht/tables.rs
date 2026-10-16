//! Lookup tables built at compile time from the T.814 code definitions: the CxtVLC codes of
//! Annex C (transcribed into `annex_c.rs` by `gen_annex_c.py`) and the U-VLC prefix code of
//! clause 7.3.6, Table 3.

use super::annex_c::{CXT_VLC_TABLE_0, CXT_VLC_TABLE_1};

/// A decoded CxtVLC codeword, as one `u16`: `rho` in bits 0–3, `u_off` in bit 4, the codeword
/// length in bits 5–7, the EMB pattern `eps_k` in bits 8–11 and `eps_1` in bits 12–15. Bit `j`
/// of each 4-bit pattern is sample `j` of the quad (0 top-left, 1 bottom-left, 2 top-right,
/// 3 bottom-right).
pub(super) type CxtEntry = u16;

/// Lookup tables indexed by `c_q << 7 | the next 7 VLC bits` (first bit in the LSB): for the
/// quads of the initial line-pair (`CxtVLC_table_0`) and of the others (`CxtVLC_table_1`).
/// The codes are complete, so every index holds a codeword (`gen_annex_c.py` checks this).
pub(super) static CXT_LOOKUP_0: [CxtEntry; 1024] = build_lookup(&CXT_VLC_TABLE_0);
pub(super) static CXT_LOOKUP_1: [CxtEntry; 1024] = build_lookup(&CXT_VLC_TABLE_1);

const fn build_lookup(table: &[[u8; 7]]) -> [CxtEntry; 1024] {
    let mut out = [0u16; 1024];
    let mut i = 0;
    while i < table.len() {
        let [c_q, rho, u_off, eps_k, eps_1, w, len] = table[i];
        let entry = rho as u16 | (u_off as u16) << 4 | (len as u16) << 5 | (eps_k as u16) << 8 | (eps_1 as u16) << 12;
        // Every 7-bit lookahead that starts with this codeword.
        let mut rest = 0usize;
        while rest < 1 << (7 - len) {
            out[(c_q as usize) << 7 | rest << len | w as usize] = entry;
            rest += 1;
        }
        i += 1;
    }
    out
}

/// U-VLC decoding of a quad pair (clause 7.3.6) by lookup: indexed by `mode << 6 | the next 6
/// VLC bits`, where `mode` holds the two quads' `u_off` flags in bits 0 and 1 and, in the
/// initial line-pair with both flags set, 4 when the pair's MEL symbol is 1. Each entry holds
/// the length of the prefixes in bits 0–2, the suffix lengths of the two quads in bits 3–5 and
/// 6–8, and the residuals before their suffixes are added (`u_pfx`, plus 2 under formula 4) in
/// bits 9–11 and 12–14. The suffix bits follow the prefixes, the first quad's first.
pub(super) type UvlcEntry = u16;

/// U-VLC lookup for quad pairs of non-initial line-pairs (modes 0–3).
pub(super) static UVLC_LOOKUP_1: [UvlcEntry; 256] = build_uvlc(false);
/// U-VLC lookup for quad pairs of the initial line-pair (modes 0–7; 5 and 6 unused). With both
/// flags set and a MEL symbol 0 (mode 3), a first-quad prefix of 3 bits (`u_q1 > 2`) makes the
/// second quad's code a single bit `u_bit`, `u_q2 = u_bit + 1`.
pub(super) static UVLC_LOOKUP_0: [UvlcEntry; 512] = build_uvlc(true);

/// `decodeUPrefix` on `bits` (first bit in the LSB): `(u_pfx, prefix length, suffix length)`.
const fn u_prefix(bits: usize) -> (u16, u16, u16) {
    if bits & 1 != 0 {
        (1, 1, 0)
    } else if bits & 2 != 0 {
        (2, 2, 0)
    } else if bits & 4 != 0 {
        (3, 3, 1)
    } else {
        (5, 3, 5)
    }
}

const fn build_uvlc<const N: usize>(initial: bool) -> [UvlcEntry; N] {
    let mut out = [0u16; N];
    let mut i = 0;
    while i < N {
        let (mode, bits) = (i >> 6, i & 63);
        let (mut pfx0, mut len0, mut sfx0) = (0, 0, 0);
        let (mut pfx1, mut len1, mut sfx1) = (0, 0, 0);
        if mode & 1 != 0 {
            (pfx0, len0, sfx0) = u_prefix(bits);
        }
        if mode & 2 != 0 {
            (pfx1, len1, sfx1) = if initial && mode == 3 && pfx0 > 2 {
                (((bits >> len0) & 1) as u16 + 1, 1, 0)
            } else {
                u_prefix(bits >> len0)
            };
        }
        if mode & 4 != 0 {
            pfx0 += 2;
            pfx1 += 2;
        }
        out[i] = (len0 + len1) | sfx0 << 3 | sfx1 << 6 | pfx0 << 9 | pfx1 << 12;
        i += 1;
    }
    out
}

/// MEL exponents `MEL_E[k]` for the MEL coder state `k` (clause 7.3.3).
pub(super) const MEL_E: [u32; 13] = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 5];
