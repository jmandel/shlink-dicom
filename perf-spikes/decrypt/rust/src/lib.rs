//! Series-file record decryption (spec/README.md §9) with the same `aes-gcm` crate the viewer uses,
//! exposed as raw wasm exports (no wasm-bindgen) so JS can time it directly.
//!
//! Two code paths:
//! * `decrypt_asis`  — what crates/shl-dicom-core `decrypt_record` does today: a fresh `Aes256Gcm`
//!   (AES key schedule + GHASH key) per record and a newly allocated `Vec` per record.
//! * `decrypt_tuned` — the key schedule done once (`set_key`), decryption in place, plaintext
//!   compacted to be contiguous. No allocation.
//!
//! Both return -1 on success, or the index of the first record whose tag failed.

use aes_gcm::{
    aead::{Aead, AeadInPlace, KeyInit},
    Aes256Gcm, Nonce, Tag,
};

pub const RECORD_PLAINTEXT: usize = 65_520;
pub const TAG_LEN: usize = 16;
pub const RECORD_CIPHERTEXT: usize = RECORD_PLAINTEXT + TAG_LEN;

pub fn record_nonce(i: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..12].copy_from_slice(&i.to_be_bytes());
    n
}

/// Copy of shl_dicom_core::crypto::decrypt_record.
pub fn decrypt_record(record_ct: &[u8], record_index: u64, series_key: &[u8; 32]) -> Option<Vec<u8>> {
    if record_ct.len() < TAG_LEN || record_ct.len() > RECORD_CIPHERTEXT {
        return None;
    }
    let cipher = Aes256Gcm::new(series_key.into());
    cipher.decrypt(Nonce::from_slice(&record_nonce(record_index)), record_ct).ok()
}

/// As-is path over a run of records; plaintext written contiguously to `out`.
pub fn records_asis(ct: &[u8], first: u64, key: &[u8; 32], out: &mut [u8]) -> i64 {
    let mut off = 0;
    let mut o = 0;
    let mut i = first;
    while off < ct.len() {
        let end = (off + RECORD_CIPHERTEXT).min(ct.len());
        match decrypt_record(&ct[off..end], i, key) {
            Some(pt) => {
                out[o..o + pt.len()].copy_from_slice(&pt);
                o += pt.len();
            }
            None => return i as i64,
        }
        off = end;
        i += 1;
    }
    -1
}

/// Tuned path: decrypt in place, then move each record's plaintext down so the result is
/// contiguous at the start of `buf`.
pub fn records_tuned(cipher: &Aes256Gcm, buf: &mut [u8], first: u64) -> i64 {
    let len = buf.len();
    let mut off = 0;
    let mut o = 0;
    let mut i = first;
    while off < len {
        let end = (off + RECORD_CIPHERTEXT).min(len);
        if end - off < TAG_LEN {
            return i as i64;
        }
        let (body, tag) = buf[off..end].split_at_mut(end - off - TAG_LEN);
        let tag = Tag::clone_from_slice(tag);
        if cipher
            .decrypt_in_place_detached(Nonce::from_slice(&record_nonce(i)), &[], body, &tag)
            .is_err()
        {
            return i as i64;
        }
        let n = end - off - TAG_LEN;
        if o != off {
            buf.copy_within(off..off + n, o);
        }
        o += n;
        off = end;
        i += 1;
    }
    -1
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use std::alloc::{alloc as a, dealloc as d, Layout};

    static mut CIPHER: Option<Aes256Gcm> = None;

    #[no_mangle]
    pub extern "C" fn alloc(n: usize) -> *mut u8 {
        unsafe { a(Layout::from_size_align(n.max(1), 16).unwrap()) }
    }
    #[no_mangle]
    pub extern "C" fn dealloc(p: *mut u8, n: usize) {
        unsafe { d(p, Layout::from_size_align(n.max(1), 16).unwrap()) }
    }
    #[no_mangle]
    pub extern "C" fn set_key(k: *const u8) {
        let key: &[u8; 32] = unsafe { &*(k as *const [u8; 32]) };
        unsafe { CIPHER = Some(Aes256Gcm::new(key.into())) };
    }
    /// `first` as f64 so JS can pass any record index up to 2^53.
    #[no_mangle]
    pub extern "C" fn decrypt_tuned(p: *mut u8, len: usize, first: f64) -> f64 {
        let buf = unsafe { std::slice::from_raw_parts_mut(p, len) };
        #[allow(static_mut_refs)]
        let c = unsafe { CIPHER.as_ref().unwrap() };
        records_tuned(c, buf, first as u64) as f64
    }
    #[no_mangle]
    pub extern "C" fn decrypt_asis(ct: *const u8, len: usize, first: f64, key: *const u8, out: *mut u8) -> f64 {
        let ct = unsafe { std::slice::from_raw_parts(ct, len) };
        let key: &[u8; 32] = unsafe { &*(key as *const [u8; 32]) };
        let out = unsafe { std::slice::from_raw_parts_mut(out, len) };
        records_asis(ct, first as u64, key, out) as f64
    }
}
