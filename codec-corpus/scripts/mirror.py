"""Sample files from the mirror (github.com/jmandel/shlink-dicom-samples) first, then from their
original source, always checked against their SHA-256.

The mirror holds only files whose source clearly allows redistribution, as release assets named
<sha256>.dcm (releases codec-corpus-1, objects-1, slides-1; the repository's NOTICE.md lists each
file's source, licence and attribution). Any other file comes from its source only. A file whose
bytes match neither is not written: callers treat it as missing and skip it.
"""
from __future__ import annotations

import hashlib
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Iterable, Union

MIRROR = "https://github.com/jmandel/shlink-dicom-samples/releases/download"

Origin = Union[str, Callable[[Path], None]]


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def _download(url: str, dst: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "shlink-dicom-samples"})
    with urllib.request.urlopen(req, timeout=300) as r, open(dst, "wb") as f:
        shutil.copyfileobj(r, f)


def fetch(dst: Path, sha256: str, release: str | None, origins: Iterable[Origin] = (), log: Callable[[str], None] = print) -> str | None:
    """Puts the file with this SHA-256 at `dst`. Tries a copy already there, the mirror's
    `release`, then each origin (a URL, or a function that writes the file to the path it is
    given). Returns where it came from, or None (and writes nothing) when no source has it."""
    if dst.exists() and sha256_of(dst) == sha256:
        return "local"
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    candidates: list[Origin] = ([f"{MIRROR}/{release}/{sha256}.dcm"] if release else []) + list(origins)
    for o in candidates:
        try:
            if isinstance(o, str):
                _download(o, tmp)
            else:
                o(tmp)
        except (urllib.error.URLError, OSError, ValueError) as e:
            if not (isinstance(o, str) and o.startswith(MIRROR)):
                log(f"  {dst.name}: {o if isinstance(o, str) else 'source'}: {e}")
            continue
        got = sha256_of(tmp)
        if got == sha256:
            tmp.replace(dst)
            return o if isinstance(o, str) else "source"
        log(f"  {dst.name}: {o if isinstance(o, str) else 'source'} gave SHA-256 {got}, not {sha256}")
    tmp.unlink(missing_ok=True)
    return None


def raw_url(url: str | None) -> str | None:
    """A direct download URL for a source page URL, when there is one."""
    if not url:
        return None
    if url.startswith("https://github.com/") and "/blob/" in url:
        return url.replace("https://github.com/", "https://raw.githubusercontent.com/", 1).replace("/blob/", "/", 1)
    if "sourceforge.net/p/gdcm/gdcmdata/ci/master/tree/" in url:
        return url.split("?")[0] + "?format=raw"
    if "orthanc.uclouvain.be/hg/orthanc-tests/file/tip/" in url:
        return url.replace("/file/tip/", "/raw-file/tip/")
    if url.startswith("https://idc-open-data.s3.amazonaws.com/") or url.startswith("https://raw.githubusercontent.com/"):
        return url
    return None
