# Codec corpus

Test files, reference ("oracle") decodes and scripts for checking pure-Rust DICOM pixel decoders.

- `CONTRACT.md` — the command and pixel format every decoder is checked on.
- `AGENTS.md` — how work on decoders is divided and run, including by parallel agents.
- `formats/<fmt>/` — one directory per codec family: `FORMAT.md` (scope, references, rulings, status), `cases.json` (committed manifest), and `samples/` and `oracle/` (generated, not committed).
- `scripts/` — `discover.py`, `generate.py`, `oracle.py`, `check.py`, `ref_decode.py`, `common.py`.
- `prevalence/` — how often each format occurs in real-world data, and the coverage estimate built from it.

## Get the samples

```sh
cd codec-corpus
uv run python scripts/restore.py          # fetched cases: the sample mirror first, then each file's source
uv run python scripts/generate.py         # generated cases
uv run python scripts/oracle.py
```

`restore.py` takes each file from the sample mirror ([jmandel/shlink-dicom-samples](https://github.com/jmandel/shlink-dicom-samples), release `codec-corpus-1`) when it is there, else from its source, and keeps it only when its SHA-256 matches `cases.json`. The mirror holds only files whose source clearly allows redistribution; its `NOTICE.md` lists each one's source, licence and attribution. A case that no source still has stays missing, and `check.py` skips it.

## Rebuild everything

```sh
cd codec-corpus
uv sync                                   # Python 3.12 venv with pydicom and reference decoders
uv run python scripts/discover.py         # pydicom test data + local demo studies -> formats/*/samples
uv run python scripts/generate.py         # seed images encoded by pydicom, DCMTK and OpenJPH
uv run python scripts/oracle.py           # reference decodes -> formats/*/oracle, expectations -> cases.json
uv run python scripts/check.py --name selftest \
  --candidate "uv run --quiet python scripts/ref_decode.py --ref pydicom:gdcm {in} {out}" --quiet
```

External tools used when present: DCMTK (`dcmcjpeg`, `dcmdjpeg`, `dcmcjpls`, `dcmdjpls`, `dcmcrle`, `dcmdrle`), OpenJPEG (`opj_decompress`) and OpenJPH (`ojph_compress`, `ojph_expand`).
