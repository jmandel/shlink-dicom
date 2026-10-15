# Prevalence and coverage

Purpose: turn per-profile decode results into an honest statement such as "decodes an estimated N% of real-world studies", with the data source and its biases stated next to the number.

A **pixel profile** is the tuple that decides whether a decoder can handle an instance:
(transfer syntax, photometric interpretation, bits allocated, bits stored, pixel representation, samples per pixel, planar configuration, single- or multi-frame).

Files here:
- `SOURCES.md`: which datasets were measured, how, their size, their known biases, and the top profiles in each.
- `profiles-<source>.csv`: instances, series and studies per (pixel profile, modality). Series and study counts are distinct within a row and cannot be summed across rows.
- `profiles-<source>-sets.csv`: how many series and studies contain each distinct set of profiles. Study-level coverage needs this file.
- `sql/`: the BigQuery queries behind the IDC tables.
- `scripts/pixprofile.py`: the profile key and table formats, shared by the other scripts.
- `scripts/profile_local.py`: profiles DICOM files in archives or directories (used for the local demo studies).
- `scripts/convert_idc_bq.py`: turns the raw BigQuery export (`cache/`, gitignored) into `profiles-idc.csv`.
- `scripts/coverage.py`: combines a profile table with a `check.py` report and prints coverage by instances, series and studies (a series or study counts only if every profile in it passes), the failing profiles, and the profiles with no corpus case.

```
uv run python prevalence/scripts/coverage.py prevalence/profiles-idc.csv reports/<name>.json
```
