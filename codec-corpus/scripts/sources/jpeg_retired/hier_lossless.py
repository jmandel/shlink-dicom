"""A small T.81 encoder for lossless JPEG with arithmetic coding and for lossless hierarchical
JPEG (processes 14, 15, 28 and 29), written from the standard for test data.

No available encoder writes lossless hierarchical streams that follow T.81 J.1.1.2: Thomas
Richter's libjpeg encodes the differential frame against an upsampled reference that its own
decoder does not reproduce (formats/jpeg-lossless/FORMAT.md). This one is plain Python:

- prediction H.1.2.1 (predictors 1-7, point transform 0), restart intervals of whole lines;
- Huffman coding with one fixed table, or arithmetic coding with the QM coder (D.1, ported from
  libjpeg-turbo's jcarith.c) and the two-dimensional model of H.1.2.3;
- hierarchical: frame 1 codes every second sample of every second line, frame 2 the
  difference from that frame expanded per J.1.1.2 (truncating mean, horizontal then vertical,
  last line and column repeated), modulo 2^16.
"""

from __future__ import annotations

import numpy as np

# Qe, Next_Index_LPS, Next_Index_MPS, Switch_MPS (T.81 Table D.2)
_D2 = [
    (0x5a1d, 1, 1, 1), (0x2586, 14, 2, 0), (0x1114, 16, 3, 0), (0x080b, 18, 4, 0), (0x03d8, 20, 5, 0),
    (0x01da, 23, 6, 0), (0x00e5, 25, 7, 0), (0x006f, 28, 8, 0), (0x0036, 30, 9, 0), (0x001a, 33, 10, 0),
    (0x000d, 35, 11, 0), (0x0006, 9, 12, 0), (0x0003, 10, 13, 0), (0x0001, 12, 13, 0), (0x5a7f, 15, 15, 1),
    (0x3f25, 36, 16, 0), (0x2cf2, 38, 17, 0), (0x207c, 39, 18, 0), (0x17b9, 40, 19, 0), (0x1182, 42, 20, 0),
    (0x0cef, 43, 21, 0), (0x09a1, 45, 22, 0), (0x072f, 46, 23, 0), (0x055c, 48, 24, 0), (0x0406, 49, 25, 0),
    (0x0303, 51, 26, 0), (0x0240, 52, 27, 0), (0x01b1, 54, 28, 0), (0x0144, 56, 29, 0), (0x00f5, 57, 30, 0),
    (0x00b7, 59, 31, 0), (0x008a, 60, 32, 0), (0x0068, 62, 33, 0), (0x004e, 63, 34, 0), (0x003b, 32, 35, 0),
    (0x002c, 33, 9, 0), (0x5ae1, 37, 37, 1), (0x484c, 64, 38, 0), (0x3a0d, 65, 39, 0), (0x2ef1, 67, 40, 0),
    (0x261f, 68, 41, 0), (0x1f33, 69, 42, 0), (0x19a8, 70, 43, 0), (0x1518, 72, 44, 0), (0x1177, 73, 45, 0),
    (0x0e74, 74, 46, 0), (0x0bfb, 75, 47, 0), (0x09f8, 77, 48, 0), (0x0861, 78, 49, 0), (0x0706, 79, 50, 0),
    (0x05cd, 48, 51, 0), (0x04de, 50, 52, 0), (0x040f, 50, 53, 0), (0x0363, 51, 54, 0), (0x02d4, 52, 55, 0),
    (0x025c, 53, 56, 0), (0x01f8, 54, 57, 0), (0x01a4, 55, 58, 0), (0x0160, 56, 59, 0), (0x0125, 57, 60, 0),
    (0x00f6, 58, 61, 0), (0x00cb, 59, 62, 0), (0x00ab, 61, 63, 0), (0x008f, 61, 32, 0), (0x5b12, 65, 65, 1),
    (0x4d04, 80, 66, 0), (0x412c, 81, 67, 0), (0x37d8, 82, 68, 0), (0x2fe8, 83, 69, 0), (0x293c, 84, 70, 0),
    (0x2379, 86, 71, 0), (0x1edf, 87, 72, 0), (0x1aa9, 87, 73, 0), (0x174e, 72, 74, 0), (0x1424, 72, 75, 0),
    (0x119c, 74, 76, 0), (0x0f6b, 74, 77, 0), (0x0d51, 75, 78, 0), (0x0bb6, 77, 79, 0), (0x0a40, 77, 48, 0),
    (0x5832, 80, 81, 1), (0x4d1c, 88, 82, 0), (0x438e, 89, 83, 0), (0x3bdd, 90, 84, 0), (0x34ee, 91, 85, 0),
    (0x2eae, 92, 86, 0), (0x299a, 93, 87, 0), (0x2516, 86, 71, 0), (0x5570, 88, 89, 1), (0x4ca9, 95, 90, 0),
    (0x44d9, 96, 91, 0), (0x3e22, 97, 92, 0), (0x3824, 99, 93, 0), (0x32b4, 99, 94, 0), (0x2e17, 93, 86, 0),
    (0x56a8, 95, 96, 1), (0x4f46, 101, 97, 0), (0x47e5, 102, 98, 0), (0x41cf, 103, 99, 0), (0x3c3d, 104, 100, 0),
    (0x375e, 99, 93, 0), (0x5231, 105, 102, 0), (0x4c0f, 106, 103, 0), (0x4639, 107, 104, 0), (0x415e, 103, 99, 0),
    (0x5627, 105, 106, 1), (0x50e7, 108, 107, 0), (0x4b85, 109, 103, 0), (0x5597, 110, 109, 0), (0x504f, 111, 107, 0),
    (0x5a10, 110, 111, 1), (0x5522, 112, 109, 0), (0x59eb, 112, 111, 1),
]


class QMEncoder:
    """The QM coder (T.81 D.1), as libjpeg-turbo's jcarith.c implements it. A bin is
    [index, mps]."""

    def __init__(self) -> None:
        self.out = bytearray()
        self.c, self.a, self.ct, self.sc, self.zc, self.buffer = 0, 0x10000, 11, 0, 0, -1

    def _emit(self, b: int) -> None:
        self.out.append(b)

    def _zeros(self) -> None:
        while self.zc:
            self._emit(0)
            self.zc -= 1

    def encode(self, st: list[int], val: int) -> None:
        qe, nlps, nmps, switch = _D2[st[0]]
        self.a -= qe
        if val != st[1]:
            if self.a >= qe:
                self.c += self.a
                self.a = qe
            if switch:
                st[1] ^= 1
            st[0] = nlps
        else:
            if self.a >= 0x8000:
                return
            if self.a < qe:
                self.c += self.a
                self.a = qe
            st[0] = nmps
        while True:
            self.a <<= 1
            self.c <<= 1
            self.ct -= 1
            if self.ct == 0:
                temp = self.c >> 19
                if temp > 0xFF:
                    if self.buffer >= 0:
                        self._zeros()
                        self._emit(self.buffer + 1)
                        if self.buffer + 1 == 0xFF:
                            self._emit(0)
                    self.zc += self.sc
                    self.sc = 0
                    self.buffer = temp & 0xFF
                elif temp == 0xFF:
                    self.sc += 1
                else:
                    if self.buffer == 0:
                        self.zc += 1
                    elif self.buffer >= 0:
                        self._zeros()
                        self._emit(self.buffer)
                    if self.sc:
                        self._zeros()
                        for _ in range(self.sc):
                            self._emit(0xFF)
                            self._emit(0)
                        self.sc = 0
                    self.buffer = temp & 0xFF
                self.c &= 0x7FFFF
                self.ct += 8
            if self.a >= 0x8000:
                break

    def finish(self) -> bytes:
        temp = (self.a - 1 + self.c) & 0xFFFF0000
        self.c = temp + 0x8000 if temp < self.c else temp
        self.c <<= self.ct
        if self.c & 0xF8000000:
            if self.buffer >= 0:
                self._zeros()
                self._emit(self.buffer + 1)
                if self.buffer + 1 == 0xFF:
                    self._emit(0)
            self.zc += self.sc
            self.sc = 0
        else:
            if self.buffer == 0:
                self.zc += 1
            elif self.buffer >= 0:
                self._zeros()
                self._emit(self.buffer)
            if self.sc:
                self._zeros()
                for _ in range(self.sc):
                    self._emit(0xFF)
                    self._emit(0)
                self.sc = 0
        if self.c & 0x7FFF800:
            self._zeros()
            b = (self.c >> 19) & 0xFF
            self._emit(b)
            if b == 0xFF:
                self._emit(0)
            if self.c & 0x7F800:
                b = (self.c >> 11) & 0xFF
                self._emit(b)
                if b == 0xFF:
                    self._emit(0)
        return bytes(self.out)


class BitWriter:
    def __init__(self) -> None:
        self.out = bytearray()
        self.acc, self.n = 0, 0

    def put(self, v: int, n: int) -> None:
        for i in range(n - 1, -1, -1):
            self.acc = (self.acc << 1) | ((v >> i) & 1)
            self.n += 1
            if self.n == 8:
                self.out.append(self.acc)
                if self.acc == 0xFF:
                    self.out.append(0)
                self.acc, self.n = 0, 0

    def finish(self) -> bytes:
        while self.n:
            self.put(1, 1)
        return bytes(self.out)


# One Huffman table for SSSS 0..16: sixteen 5-bit codes and one 6-bit code.
_COUNTS = [0, 0, 0, 0, 16, 1] + [0] * 10
_CODES = {s: (s, 5) for s in range(16)} | {16: (0b100000, 6)}


def _cat(d: int, lo: int, hi: int) -> int:
    a = abs(d)
    c = 0 if a <= (1 << lo) >> 1 else (1 if a <= (1 << hi) else 2)
    return {0: 0, 1: 1 if d > 0 else 2, 2: 3 if d > 0 else 4}[c]


class _LosslessModel:
    """H.1.2.3 statistics for one table: 25 x 4 sign/zero bins, then X1..X15, M2..M15 twice."""

    def __init__(self) -> None:
        self.bins = [[0, 0] for _ in range(158)]


def _encode_arith_diff(qm: QMEncoder, m: _LosslessModel, v: int, da: int, db: int, lo: int = 0, hi: int = 1) -> None:
    s0 = 20 * _cat(da, lo, hi) + 4 * _cat(db, lo, hi)
    b = m.bins
    if v == 0:
        qm.encode(b[s0], 0)
        return
    qm.encode(b[s0], 1)
    qm.encode(b[s0 + 1], 1 if v < 0 else 0)
    sz = abs(v) - 1
    sp = b[s0 + 3] if v < 0 else b[s0 + 2]
    if sz == 0:
        qm.encode(sp, 0)
        return
    qm.encode(sp, 1)
    x1 = 129 if _cat(db, lo, hi) >= 3 else 100
    i, mm = 0, 2
    while sz >= mm:
        qm.encode(b[x1 + i], 1)
        mm <<= 1
        i += 1
    qm.encode(b[x1 + i], 0)
    mm >>= 1
    while True:
        mm >>= 1
        if not mm:
            break
        qm.encode(b[x1 + i + 14], 1 if sz & mm else 0)


def _predict(psv: int, ra: int, rb: int, rc: int) -> int:
    return {1: ra, 2: rb, 3: rc, 4: ra + rb - rc, 5: ra + ((rb - rc) >> 1), 6: rb + ((ra - rc) >> 1),
            7: (ra + rb) >> 1}[psv]


def _segment(marker: int, body: bytes) -> bytes:
    return bytes([0xFF, marker]) + (len(body) + 2).to_bytes(2, "big") + body


def _frame_header(marker: int, p: int, h: int, w: int, n: int) -> bytes:
    body = bytes([p]) + h.to_bytes(2, "big") + w.to_bytes(2, "big") + bytes([n])
    for k in range(n):
        body += bytes([k + 1, 0x11, 0])
    return _segment(marker, body)


def _scan(img: np.ndarray, p: int, psv: int, arith: bool, differential: bool, restart_lines: int) -> bytes:
    """One interleaved scan of all components (none subsampled). `img` (h, w, n) holds the
    samples, or for a differential frame the differences modulo 2^16."""
    h, w, n = img.shape
    out = bytearray()
    sos = bytes([n]) + b"".join(bytes([k + 1, 0x00]) for k in range(n)) + bytes([0 if differential else psv, 0, 0])
    ri = restart_lines * w
    if ri:
        out += _segment(0xDD, ri.to_bytes(2, "big"))
    out += _segment(0xDA, sos)

    def start():
        # Every component uses table 0, so they share one statistics area.
        return (QMEncoder(), [_LosslessModel()] * n) if arith else (BitWriter(), None)

    coder, models = start()
    db = np.zeros((n, w), dtype=np.int64)
    first_row = 0
    rst = 0
    for y in range(h):
        if ri and y > 0 and (y * w) % ri == 0:
            out += coder.finish()
            out += bytes([0xFF, 0xD0 + rst % 8])
            rst += 1
            coder, models = start()
            db[:] = 0
            first_row = y
        da = [0] * n
        for x in range(w):
            for k in range(n):
                cur = int(img[y, x, k])
                if differential:
                    pred = 0
                elif y == first_row and x == 0:
                    pred = 1 << (p - 1)
                elif y == first_row:
                    pred = int(img[y, x - 1, k])
                elif x == 0:
                    pred = int(img[y - 1, 0, k])
                else:
                    pred = _predict(psv, int(img[y, x - 1, k]), int(img[y - 1, x, k]), int(img[y - 1, x - 1, k]))
                d = (cur - pred) % 65536
                if d >= 32768:
                    d -= 65536
                if arith:
                    v = d
                    _encode_arith_diff(coder, models[k], v, da[k], int(db[k, x]))
                    da[k] = v
                    db[k, x] = v
                else:
                    if d == -32768:
                        coder.put(*_CODES[16])
                    else:
                        s = abs(d).bit_length()
                        coder.put(*_CODES[s])
                        if s:
                            coder.put(d if d > 0 else d + (1 << s) - 1, s)
    out += coder.finish()
    return bytes(out)


def _tables(arith: bool) -> bytes:
    if arith:
        return b""   # default conditioning (L = 0, U = 1)
    body = bytes([0x00]) + bytes(_COUNTS) + bytes(range(17))
    return _segment(0xC4, body)


def expand(img: np.ndarray) -> np.ndarray:
    """T.81 J.1.1.2, both directions: horizontal then vertical, truncating means."""
    a = img.astype(np.int64)
    h, w = a.shape[:2]
    right = np.concatenate([a[:, 1:], a[:, -1:]], axis=1)
    hz = np.empty((h, 2 * w) + a.shape[2:], np.int64)
    hz[:, 0::2] = a
    hz[:, 1::2] = (a + right) >> 1
    below = np.concatenate([hz[1:], hz[-1:]], axis=0)
    out = np.empty((2 * h, 2 * w) + a.shape[2:], np.int64)
    out[0::2] = hz
    out[1::2] = (hz + below) >> 1
    return out


def encode(img: np.ndarray, p: int, *, psv: int = 1, arith: bool = False, hierarchical: bool = False,
           restart_lines: int = 0) -> bytes:
    """`img` (h, w) or (h, w, n): unsigned samples of precision `p`."""
    if img.ndim == 2:
        img = img[:, :, None]
    h, w, n = img.shape
    img = img.astype(np.int64)
    out = bytearray(b"\xff\xd8")
    out += _tables(arith)
    if not hierarchical:
        out += _frame_header(0xCB if arith else 0xC3, p, h, w, n)
        out += _scan(img, p, psv, arith, False, restart_lines)
    else:
        out += _frame_header(0xDE, p, h, w, n)                 # DHP
        low = img[::2, ::2]
        out += _frame_header(0xCB if arith else 0xC3, p, low.shape[0], low.shape[1], n)
        out += _scan(low, p, psv, arith, False, restart_lines)
        ref = expand(low)[:h, :w]
        diff = (img - ref) % 65536
        out += _segment(0xDF, bytes([0x11]))                   # EXP: expand both ways
        out += _frame_header(0xCF if arith else 0xC7, p, h, w, n)
        out += _scan(diff, p, psv, arith, True, restart_lines)
    out += b"\xff\xd9"
    return bytes(out)
