// Waveforms (PS3.3 C.10.9): each multiplex group's channels as calibrated samples, for plotting
// (ECG, haemodynamic, respiratory…) and for playing audio.
import { codeOf, T, type DataSet } from "./dicom";

export interface WaveformChannel {
  label: string;
  /** Source, e.g. "Lead II". */
  source: string;
  /** Units of the calibrated values, e.g. "uV", "mm[Hg]". */
  units: string;
  /** Calibrated values (sample × sensitivity × correction + baseline). */
  values: Float32Array;
}

export interface WaveformGroup {
  label: string;
  /** Hz. */
  samplingFrequency: number;
  samples: number;
  originality: string;
  /** SB, UB, SS, US, MB (mu-law), AB (A-law). */
  interpretation: string;
  channels: WaveformChannel[];
  /** The raw interleaved samples, for audio (8-bit mu/A-law or PCM). */
  raw: Int16Array | Int8Array | Uint8Array | Uint16Array;
}

function decodeMuLaw(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 7, mantissa = u & 0x0f;
  let s = ((mantissa << 3) + 0x84) << exponent;
  s -= 0x84;
  return sign ? -s : s;
}

function decodeALaw(a: number): number {
  a ^= 0x55;
  const sign = a & 0x80, exponent = (a >> 4) & 7, mantissa = a & 0x0f;
  let s = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
  return sign ? s : -s;
}

export function readWaveforms(ds: DataSet): WaveformGroup[] {
  const groups: WaveformGroup[] = [];
  for (const g of ds.seq(T.WaveformSequence)) {
    const nCh = g.num(T.NumberOfWaveformChannels) ?? 0;
    const nS = g.num(T.NumberOfWaveformSamples) ?? 0;
    const bits = g.num(T.WaveformBitsAllocated) ?? 16;
    const interp = g.str(T.WaveformSampleInterpretation) ?? "SS";
    const data = g.raw(T.WaveformData);
    if (!data || !nCh || !nS) continue;
    const buf = data.slice().buffer;
    const total = nCh * nS;
    let raw: WaveformGroup["raw"];
    if (bits === 8) raw = interp === "SB" ? new Int8Array(buf, 0, Math.min(total, data.length)) : new Uint8Array(buf, 0, Math.min(total, data.length));
    else raw = interp === "US" ? new Uint16Array(buf, 0, Math.min(total, data.length >> 1)) : new Int16Array(buf, 0, Math.min(total, data.length >> 1));
    if (!g.le) {
      // Big endian: swap the 16-bit samples.
      if (raw instanceof Int16Array || raw instanceof Uint16Array) for (let i = 0; i < raw.length; i++) raw[i] = ((raw[i] & 0xff) << 8) | ((raw[i] >> 8) & 0xff);
    }
    const sample = interp === "MB" ? (v: number) => decodeMuLaw(v) : interp === "AB" ? (v: number) => decodeALaw(v) : (v: number) => v;
    const defs = g.seq(T.ChannelDefinitionSequence);
    const channels: WaveformChannel[] = [];
    for (let c = 0; c < nCh; c++) {
      const d = defs[c];
      const src = d?.seq(T.ChannelSourceSequence)[0];
      const units = d?.seq(T.ChannelSensitivityUnitsSequence)[0];
      const sens = d?.num(T.ChannelSensitivity) ?? 1;
      const corr = d?.num(T.ChannelSensitivityCorrectionFactor) ?? 1;
      const base = d?.num(T.ChannelBaseline) ?? 0;
      const values = new Float32Array(nS);
      for (let i = 0; i < nS; i++) values[i] = sample(raw[i * nCh + c] ?? 0) * (d?.has(T.ChannelSensitivity) ? sens * corr : 1) + base;
      const source = src ? codeOf(src).meaning : "";
      channels.push({
        label: d?.str(T.ChannelLabel) ?? (source || `Channel ${c + 1}`),
        source,
        units: units ? codeOf(units).value || codeOf(units).meaning : "",
        values,
      });
    }
    groups.push({
      label: g.str(T.MultiplexGroupLabel) ?? "",
      samplingFrequency: g.num(T.SamplingFrequency) ?? 0,
      samples: nS,
      originality: g.str(T.WaveformOriginality) ?? "",
      interpretation: interp,
      channels,
      raw,
    });
  }
  return groups;
}

/** A 16-bit PCM WAV of one channel (or the interleaved channels), for an <audio> element. */
export function toWav(group: WaveformGroup): Blob {
  const nCh = group.channels.length;
  const n = group.samples;
  const pcm = new Int16Array(n * nCh);
  const mu = group.interpretation === "MB", a = group.interpretation === "AB";
  for (let i = 0; i < n * nCh; i++) {
    const v = group.raw[i] ?? 0;
    if (mu) pcm[i] = decodeMuLaw(v);
    else if (a) pcm[i] = decodeALaw(v);
    else if (group.raw instanceof Uint8Array) pcm[i] = (v - 128) << 8;
    else if (group.raw instanceof Int8Array) pcm[i] = v << 8;
    else if (group.raw instanceof Uint16Array) pcm[i] = v - 32768;
    else pcm[i] = v;
  }
  const rate = Math.round(group.samplingFrequency) || 8000;
  const head = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => head.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  head.setUint32(4, 36 + pcm.byteLength, true);
  w(8, "WAVE");
  w(12, "fmt ");
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true);
  head.setUint16(22, nCh, true);
  head.setUint32(24, rate, true);
  head.setUint32(28, rate * nCh * 2, true);
  head.setUint16(32, nCh * 2, true);
  head.setUint16(34, 16, true);
  w(36, "data");
  head.setUint32(40, pcm.byteLength, true);
  return new Blob([head.buffer, pcm.buffer], { type: "audio/wav" });
}
