# shl-dicom-reader

The viewer's link reader as a small wasm module of its own: the same Rust code (shl-dicom-core) the
CLI and the server use to read a SMART Health Link, find the Bundle in a manifest, decrypt the
Bundle and index its studies. It assumes no DOM, so it runs in a Worker.

```
cargo build --profile wasm-reader --target wasm32-unknown-unknown -p shl-dicom-reader
wasm-bindgen --target web --remove-name-section --remove-producers-section \
  --out-dir crates/shl-dicom-reader/pkg target/wasm32-unknown-unknown/wasm-reader/shl_dicom_reader.wasm
```

## Functions

All are synchronous once the module is instantiated. On failure each throws an error whose
`message` is JSON `{"code", "message"}`: the code (below) is stable, the message is English detail.

| Function | Returns |
|---|---|
| `parse_link(text, nowSecs)` | JSON `{url, key, exp, flag, label, v, direct, passcode, longLived, expired}` for the link in `text` (a bare `shlink:/…`, a viewer URL with `#shlink:/…`, or text around one). |
| `manifest_location(manifestJson)` | The Bundle's `location`: the first file whose `contentType` is `application/fhir+json` (parameters and case aside) with a location. |
| `decrypt_bundle(jwe, key)` | The Bundle's UTF-8 JSON bytes. |
| `parse_index(bundleBytes)` | JSON: the study index in the viewer's shape (web/core/bundle.ts `StudyIndex` without `bundle`; series name their file by `fileId`; report attachments carry `dataB64`). |
| `open_bundle(jwe, key)` | `{index, bundle}`: `decrypt_bundle` then `parse_index` in one call, for a worker. |
| `has_frame_start_marker(transferSyntax)` | Whether frames of this syntax are found by codestream start markers (JPEG, JPEG-LS, JPEG 2000, HTJ2K, JPEG XL); when false, each fragment is a frame. Never throws. |
| `is_frame_start(transferSyntax, head)` | Whether a fragment whose value starts with `head` (its first 8 bytes) starts a frame: the rule the packer's offset tables and the decoder use. Never throws. |

## Error codes

| Code | From | Meaning |
|---|---|---|
| `not-a-link` | `parse_link` | No `shlink:/` in the text. |
| `damaged` | `parse_link`, `manifest_location` | The payload is not base64url JSON; the manifest is not JSON. |
| `missing-url-or-key` | `parse_link` | No `url` (or a blank one), or no `key`. |
| `bad-key` | `parse_link`, `decrypt_bundle` | The key is not 43 base64url characters for 32 bytes. |
| `bad-flag` | `parse_link` | `flag` holds something other than L, P and U, each at most once. |
| `u-with-p` | `parse_link` | `flag` combines U with P (SMART Health Links: SHALL NOT). |
| `version` | `parse_link` | `v` is present and not 1. |
| `bad-exp` | `parse_link` | `exp` is not a non-negative number. |
| `no-location` | `manifest_location` | No `application/fhir+json` file with a `location`. |
| `bad-location` | `manifest_location` | The location is not an https URL (http only for localhost, 127.0.0.1 and [::1]) without query or fragment, ending in `/` or a file name (spec/README.md §10). |
| `not-jwe` | `decrypt_bundle` | Not a compact JWE with direct encryption, or the IV or tag is the wrong length. |
| `unsupported` | `decrypt_bundle` | alg other than `dir`, enc other than `A256GCM`, `cty` not `application/fhir+json`, or `zip` other than `DEF`. |
| `too-large` | `decrypt_bundle` | Longer than the JWE limit, or inflating past 64 MiB. |
| `decrypt` | `decrypt_bundle` | The key does not open it (or it was altered). |
| `inflate` | `decrypt_bundle` | The DEFLATE data is damaged. |
| `invalid-bundle` | `parse_index` | Not a FHIR Bundle, or it breaks a rule of spec/README.md §8 (instance lengths, files, keys, uids). |

A long `label` is accepted: it is only shown.

## Tests

`fixtures/reader/cases.json` (written by `bun fixtures/reader/make.ts`) holds the golden cases;
`cargo test -p shl-dicom-reader` runs them on the Rust code and `bun test test/reader.test.ts` on
the wasm module, which it also opens in a Worker.
