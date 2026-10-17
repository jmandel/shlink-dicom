"""check.py's outcomes: the exit-code matrix of CONTRACT.md, and tolerances that a constant output
would pass. Run: uv run --group dev pytest tests"""
import os
import stat
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import check  # noqa: E402


@pytest.fixture
def sample(tmp_path, monkeypatch):
    src = tmp_path / "in.dcm"
    src.write_bytes(b"x")
    oracle = tmp_path / "oracle.npy"
    np.save(oracle, np.array([10, 200], dtype=np.uint8))
    monkeypatch.setattr(check, "sample_path", lambda f, c: src)
    monkeypatch.setattr(check, "oracle_paths", lambda f, c: (oracle, tmp_path / "oracle.json"))
    return tmp_path


def script(d: Path, name: str, body: str) -> str:
    p = d / name
    p.write_text("#!/bin/sh\n" + body + "\n")
    p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return str(p)


@pytest.mark.parametrize(
    "body,expect,outcome",
    [
        ("exit 2", "error", "pass"),
        ("exit 3", "error", "unsupported"),
        ("exit 1", "error", "crash"),
        ("exit 101", "error", "crash"),
        ("exit 127", "error", "crash"),
        ("kill -SEGV $$", "error", "crash"),
        ("sh -c 'kill -SEGV $$'; exit $?", "error", "crash"),  # a wrapper reporting 139
        ("sh -c 'kill -ABRT $$'; exit $?", "error", "crash"),  # a wrapper reporting 134
        ("exit 0", "error", "fail"),
        ("exit 2", "decode", "fail"),
        ("exit 1", "decode", "crash"),
        ("printf '\\012\\310' > \"$2\"", "decode", "pass"),
    ],
)
def test_exit_codes(sample, body, expect, outcome):
    cmd = script(sample, "cand.sh", body) + " {in} {out}"
    r = check.run_case("jpeg-dct", {"id": "x", "expect": expect, "max_abs": 0}, cmd, 10)
    assert r["outcome"] == outcome, r


def test_a_candidate_that_cannot_run_crashes(sample):
    r = check.run_case("jpeg-dct", {"id": "x", "expect": "error", "max_abs": 0}, "/nonexistent/decoder {in} {out}", 10)
    assert r["outcome"] == "crash", r


def test_paths_are_not_split_or_expanded(sample, tmp_path):
    odd = tmp_path / "a dir; $(true)"
    odd.mkdir()
    cmd = script(odd, "cand.sh", "[ $# -eq 2 ] && printf '\\012\\310' > \"$2\"") + " {in} {out}"
    r = check.run_case("jpeg-dct", {"id": "x", "expect": "decode", "max_abs": 0}, f"'{cmd.split(' {in}')[0]}' {{in}} {{out}}", 10)
    assert r["outcome"] == "pass", r


def test_a_tolerance_a_constant_passes_is_a_failure(sample):
    # Oracle 10 and 200: max_abs 190 lets a constant 128 output (and 0 at 200) pass.
    cmd = script(sample, "cand.sh", "printf '\\012\\310' > \"$2\"") + " {in} {out}"
    r = check.run_case("jpeg-dct", {"id": "x", "expect": "decode", "max_abs": 190}, cmd, 10)
    assert r["outcome"] == "fail" and "constant" in r["reason"], r
    assert check.constant_passes(np.array([10, 200], np.uint8), 117) is None
    assert check.constant_passes(np.array([10, 200], np.uint8), 118) == 128
    # A one-value image can only be matched by that value: not a loose tolerance.
    assert check.constant_passes(np.zeros(4, np.uint8), 0) is None
