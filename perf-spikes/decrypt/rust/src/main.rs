//! Native reference throughput for the same two code paths.
//! Usage: bench-native [MB...]   (default 1 50 400)
use aes_gcm::{aead::{AeadInPlace, KeyInit}, Aes256Gcm, Nonce};
use decrypt_spike::*;
use std::time::Instant;

fn main() {
    let sizes: Vec<usize> = {
        let a: Vec<usize> = std::env::args().skip(1).filter_map(|s| s.parse().ok()).collect();
        if a.is_empty() { vec![1, 50, 400] } else { a }
    };
    let key: [u8; 32] = std::array::from_fn(|i| 0x20 + i as u8);
    let cipher = Aes256Gcm::new((&key).into());
    for mb in sizes {
        let n = (mb * 1_000_000).div_ceil(RECORD_CIPHERTEXT);
        let mut ct = vec![0u8; n * RECORD_CIPHERTEXT];
        for (k, b) in ct.iter_mut().enumerate() { *b = (k % 251) as u8; }
        for i in 0..n {
            let r = &mut ct[i * RECORD_CIPHERTEXT..(i + 1) * RECORD_CIPHERTEXT];
            let (body, tag) = r.split_at_mut(RECORD_PLAINTEXT);
            let t = cipher.encrypt_in_place_detached(Nonce::from_slice(&record_nonce(i as u64)), &[], body).unwrap();
            tag.copy_from_slice(&t);
        }
        let bytes = ct.len() as f64;
        let reps = if mb <= 1 { 200 } else if mb <= 50 { 5 } else { 2 };
        let mut out = vec![0u8; ct.len()];
        let mut work = ct.clone();
        let mut best_asis = f64::MAX;
        let mut best_tuned = f64::MAX;
        let mut times_asis = vec![];
        let mut times_tuned = vec![];
        for _ in 0..reps + 1 {
            let t = Instant::now();
            assert_eq!(records_asis(&ct, 0, &key, &mut out), -1);
            let s = t.elapsed().as_secs_f64();
            times_asis.push(s); best_asis = best_asis.min(s);
            work.copy_from_slice(&ct);
            let t = Instant::now();
            assert_eq!(records_tuned(&cipher, &mut work, 0), -1);
            let s = t.elapsed().as_secs_f64();
            times_tuned.push(s); best_tuned = best_tuned.min(s);
        }
        let med = |v: &mut Vec<f64>| { v.remove(0); v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v[v.len() / 2] };
        let ma = med(&mut times_asis);
        let mt = med(&mut times_tuned);
        println!("{{\"mb\":{mb},\"bytes\":{bytes},\"records\":{n},\"asis_MBps\":{:.1},\"tuned_MBps\":{:.1}}}",
                 bytes / ma / 1e6, bytes / mt / 1e6);
        let _ = (best_asis, best_tuned);
    }
}
