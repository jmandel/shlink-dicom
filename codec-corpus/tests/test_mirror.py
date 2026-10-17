"""scripts/mirror.py: sources in order, and nothing written unless the SHA-256 matches."""
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import mirror  # noqa: E402


def test_first_source_with_the_right_bytes_wins(tmp_path):
    good, bad = tmp_path / "good", tmp_path / "bad"
    good.write_bytes(b"right")
    bad.write_bytes(b"wrong")
    sha = hashlib.sha256(b"right").hexdigest()
    dst = tmp_path / "out" / "x.dcm"
    logs = []
    assert mirror.fetch(dst, sha, None, [bad.as_uri(), good.as_uri()], logs.append) == good.as_uri()
    assert dst.read_bytes() == b"right"
    assert any("not" in l for l in logs), "the wrong bytes are reported"
    # Already in place: nothing fetched.
    assert mirror.fetch(dst, sha, None, [], logs.append) == "local"


def test_no_source_has_it_writes_nothing(tmp_path):
    bad = tmp_path / "bad"
    bad.write_bytes(b"wrong")
    dst = tmp_path / "x.dcm"
    gone = (tmp_path / "gone").as_uri()
    assert mirror.fetch(dst, "0" * 64, None, [bad.as_uri(), gone, lambda p: p.write_bytes(b"also wrong")], lambda _: None) is None
    assert not dst.exists() and not dst.with_name("x.dcm.part").exists()


def test_raw_urls():
    assert mirror.raw_url("https://github.com/a/b/blob/main/x.dcm") == "https://raw.githubusercontent.com/a/b/main/x.dcm"
    assert mirror.raw_url("https://sourceforge.net/p/gdcm/gdcmdata/ci/master/tree/a.dcm") == "https://sourceforge.net/p/gdcm/gdcmdata/ci/master/tree/a.dcm?format=raw"
    assert mirror.raw_url("https://github.com/o/r/issues/1") is None
