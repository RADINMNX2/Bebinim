// Minimal fragmented-MP4 muxer (H.264/AVC + AAC) for MediaSource Extensions.
// Used by the MKV streaming engine: MKV clusters are demuxed into raw samples
// and remuxed here into fMP4 (ftyp + moov + moof/mdat) with zero re-encoding.
//
// Timescale: 1_000_000 µs — exact for AAC frame durations and seek precision.

const TS = 1_000_000;

// ---- tiny byte helpers (plain arrays; converted at the end) ----
const u8 = (v) => [v & 0xff];
const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const u24 = (v) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u64 = (v) => {
  const hi = Math.floor(v / 0x100000000) >>> 0;
  const lo = v >>> 0;
  return [...u32(hi), ...u32(lo)];
};
const str = (s) => Array.from(s, (c) => c.charCodeAt(0));

// Signed int32 (composition time offset)
const i32 = (v) => {
  const x = v < 0 ? v + 0x100000000 : v;
  return u32(x);
};

const pad = (arr, n) => [...arr, ...new Array(n).fill(0)];

const concatBytes = (parts) => {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const box = (type, ...body) => {
  const b = concatBytes(body);
  const head = new Uint8Array(8);
  const v = 8 + b.length;
  head[0] = (v >> 24) & 0xff; head[1] = (v >> 16) & 0xff;
  head[2] = (v >> 8) & 0xff; head[3] = v & 0xff;
  head.set(str(type), 4);
  const out = new Uint8Array(8 + b.length);
  out.set(head, 0);
  out.set(b, 8);
  return out;
};

// ES descriptor length is a variable-length int (max 4 bytes)
const esLen = (n) => {
  if (n < 0x80) return [n];
  if (n < 0x4000) return [0x80 | (n >> 8), n & 0xff];
  if (n < 0x200000) return [0x80 | (n >> 16), 0x80 | ((n >> 8) & 0xff), n & 0xff];
  return [0x80 | (n >> 24), 0x80 | ((n >> 16) & 0xff), 0x80 | ((n >> 8) & 0xff), n & 0xff];
};

const identityMatrix = [
  0x00010000, 0, 0,
  0, 0x00010000, 0,
  0, 0, 0x40000000,
];

// Returns 9 arrays of 4 bytes (identity matrix) — `.map`, NOT `.flatMap`,
// which would flatten the byte arrays into bare numbers.
const matrixBytes = (m) => m.map((x) => u32(x));

const ftyp = () =>
  box('ftyp',
    str('isom'), u32(0x200),
    str('isom'), str('iso2'), str('avc1'), str('mp41'));

const avc1 = (t) => {
  const avcC = box('avcC', t.codecPrivate); // MKV CodecPrivate == avcC payload
  return box('avc1',
    pad([], 6), u16(1),           // reserved, data_reference_index
    u16(0), u16(0),               // pre_defined, reserved
    u32(0), u32(0), u32(0),       // pre_defined ×3
    u16(t.width), u16(t.height),
    u32(0x00480000), u32(0x00480000),
    u32(0), u16(1),               // reserved, frame_count
    pad([], 32),                  // compressorname
    u16(0x18), u16(0xffff),       // depth, pre_defined
    avcC);
};

const mp4a = (t) => {
  // ES_Descriptor length = 2 (ES_ID) + 1 (flags) + (1+1+13) DCD + (1+1+ascLen) DSI + (1+1+1) SL
  const ascLen = t.codecPrivate.length;
  const esds = box('esds',
    u8(0x03), esLen(23 + ascLen),
    u16(1), u8(0),               // ES_ID, flags
    u8(0x04), esLen(15 + ascLen),
    u8(0x40), u8(0x15), u24(0), u32(0), u32(0), // objectType AAC, streamType audio, buffers, bitrates
    u8(0x05), esLen(ascLen), t.codecPrivate,
    u8(0x06), u8(1), u8(0x02)); // SLConfigDescriptor
  return box('mp4a',
    pad([], 6), u16(1),
    u32(0), u32(0),
    u16(t.channels), u16(16),
    u16(0), u16(0),
    u32(Math.round(t.sampleRate * 0x10000)),
    esds);
};

const stsdEntry = (t) => (t.type === 'video' ? avc1(t) : mp4a(t));

// stbl for a fully-fragmented file: description only (tables empty)
const stbl = (t) => {
  const stsd = box('stsd', u32(0), u32(1), stsdEntry(t));
  const stts = box('stts', u32(0), u32(1), u32(0), u32(0));
  const stsc = box('stsc', u32(0), u32(0));
  const stsz = box('stsz', u32(0), u32(0), u32(0));
  const stco = box('stco', u32(0), u32(0));
  return box('stbl', stsd, stts, stsc, stsz, stco);
};

const minf = (t) => {
  const media = t.type === 'video'
    ? box('vmhd', u32(1), u16(0), u16(0), u16(0), u16(0))
    : box('smhd', u32(0), u16(0), u16(0));
  const dinf = box('dinf', box('dref', u32(0), u32(1), box('url ', u32(1))));
  return box('minf', media, dinf, stbl(t));
};

const mdia = (t) => {
  const mdhd = box('mdhd', u32(0), u32(0), u32(TS), u32(0), u16(0x55c4), u16(0));
  const hdlr = box('hdlr', u32(0), u32(0),
    str(t.type === 'video' ? 'vide' : 'soun'),
    u32(0), u32(0), u32(0),
    str(t.type === 'video' ? 'VideoHandler\0' : 'SoundHandler\0'));
  return box('mdia', mdhd, hdlr, minf(t));
};

const trak = (t) => {
  const tkhd = box('tkhd', u32(3), u32(0), u32(0), u32(t.id), u32(0),
    u64(0), u16(0), u16(0), u16(0), u16(0),
    ...matrixBytes(identityMatrix),
    u32(t.type === 'video' ? 0x00010000 : 0),
    u32(t.type === 'video' ? 0x00010000 : 0));
  return box('trak', tkhd, mdia(t));
};

const trex = (t) =>
  box('trex', u32(0), u32(t.id), u32(1), u32(0), u32(0),
    u32(t.type === 'video' ? 0x01010000 : 0x02000000));

const moov = (tracks) => {
  const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(TS), u32(0),
    u32(0x00010000), u16(0x0100), u16(0), u64(0),
    ...matrixBytes(identityMatrix),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(tracks.length + 1));
  const mvex = box('mvex', box('mehd', u32(0), u32(0)), ...tracks.map(trex));
  return box('moov', mvhd, ...tracks.map(trak), mvex);
};

// ---- per-sample flags (24-bit) ----
// sync (I):    depends_on=2, non_sync=0        -> 0x02000000
// non-sync:    depends_on=1, non_sync=1        -> 0x01000001
const FLAG_SYNC = 0x02000000;
const FLAG_NON_SYNC = 0x01000001;

const moof = (seq, trackChunks) => {
  const mfhd = box('mfhd', u32(0), u32(seq));

  // Pass 1: sizes with a placeholder data_offset (fixed width — sizes stable)
  const sizeTraf = (c) =>
    box('traf',
      box('tfhd', u32(0x020000), u32(c.track.id)),
      box('tfdt', u32(1), u64(c.samples[0].dtsTs)),
      box('trun', u32(0x000f01), u32(c.samples.length), u32(0),
        ...c.samples.map((s) => [
          ...u32(s.durTs), ...u32(s.data.length),
          ...u32(s.isSync ? FLAG_SYNC : FLAG_NON_SYNC),
          ...i32(s.ctoTs),
        ])));
  const moofSize = 8 + mfhd.length
    + trackChunks.reduce((a, c) => a + sizeTraf(c).length, 0);

  // Pass 2: real data offsets (relative to moof start; mdat header = 8)
  let offset = moofSize + 8;
  const trafs = trackChunks.map((c) => {
    const trun = box('trun',
      u32(0x000f01),
      u32(c.samples.length),
      u32(offset),
      ...c.samples.map((s) => [
        ...u32(s.durTs), ...u32(s.data.length),
        ...u32(s.isSync ? FLAG_SYNC : FLAG_NON_SYNC),
        ...i32(s.ctoTs),
      ]));
    offset += c.samples.reduce((a, s) => a + s.data.length, 0);
    return box('traf',
      box('tfhd', u32(0x020000), u32(c.track.id)),
      box('tfdt', u32(1), u64(c.samples[0].dtsTs)),
      trun);
  });

  return box('moof', mfhd, ...trafs);
};

/**
 * Fragmented-MP4 muxer for MSE.
 *  - video: { id, type:'video', width, height, codecPrivate }  (avcC payload)
 *  - audio: { id, type:'audio', sampleRate, channels, codecPrivate } (ASC)
 */
export class Fmp4Muxer {
  constructor(tracks) {
    this.tracks = tracks;
    this.seq = 1;
    this.pending = new Map(tracks.map((t) => [t.id, []]));
    this.started = false;
    this.readyBuffer = null; // ftyp+moov, produced on first flush
  }

  /**
   * @param data Uint8Array — raw sample (length-prefixed NALs for video,
   *                            raw AAC frame for audio)
   * @param dtsSec decoding time in seconds
   * @param durSec sample duration in seconds
   * @param ctoSec composition time offset (PTS - DTS), video B-frames
   * @param isSync keyframe?
   */
  addSample(trackId, data, { dtsSec, durSec = 0, ctoSec = 0, isSync = false }) {
    this.pending.get(trackId).push({
      data,
      dtsTs: Math.round(dtsSec * TS),
      durTs: Math.max(0, Math.round(durSec * TS)),
      ctoTs: Math.round(ctoSec * TS),
      isSync,
    });
  }

  /** ftyp+moov (cached) — needed again if the SourceBuffer is recreated */
  initBytes() {
    if (!this._init) this._init = concatBytes([ftyp(), moov(this.tracks)]);
    return this._init;
  }

  /** Returns an fMP4 chunk (Uint8Array). First call prepends ftyp+moov. */
  flush() {
    const parts = [];
    if (!this.started) {
      parts.push(this.initBytes());
      this.started = true;
    }

    const chunks = [];
    let sampleBytes = 0;
    for (const t of this.tracks) {
      const samples = this.pending.get(t.id);
      if (samples.length === 0) continue;
      chunks.push({ track: t, samples });
      sampleBytes += samples.reduce((a, s) => a + s.data.length, 0);
      this.pending.set(t.id, []);
    }
    if (chunks.length === 0) return null;

    parts.push(moof(this.seq, chunks));
    this.seq += 1;

    const mdatHead = new Uint8Array(8);
    const v = 8 + sampleBytes;
    mdatHead[0] = (v >> 24) & 0xff; mdatHead[1] = (v >> 16) & 0xff;
    mdatHead[2] = (v >> 8) & 0xff; mdatHead[3] = v & 0xff;
    mdatHead.set(str('mdat'), 4);
    parts.push(mdatHead);
    for (const c of chunks) {
      for (const s of c.samples) parts.push(s.data);
    }
    return concatBytes(parts);
  }
}