// MKV → fMP4 streaming engine for iOS (Safari has no Matroska demux in
// <video>, but supports MediaSource since iOS 17.1).
//
// Pipeline: HTTP Range requests fetch clusters one by one (or File.slice
// for uploaded files) → the Matroska container is demuxed (no re-encoding)
// → raw H.264/AAC samples are remuxed into fragmented MP4 → appended to a
// SourceBuffer. Playback starts within the first cluster, memory stays
// bounded (sliding buffer), seeking uses the Cues index when present and a
// live cluster-header index otherwise.
//
// Supported: V_MPEG4/ISO/AVC + A_AAC. HEVC/others → CODEC error (fall back
// to the system player). The file is never fully downloaded.

import {
  readId, idLength, readVint, walkElements,
} from './mkvSubtitles.js';
import { Fmp4Muxer } from './fmp4.js';

const ID = {
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  SeekEntry: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  CodecDelay: 0x56aa,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
};

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const decodeUtf8 = (buf) => {
  try { return new TextDecoder('utf-8').decode(buf).replace(/\u0000+$/g, '').trim(); }
  catch { return ''; }
};
const readUintVal = (buf, s, e) => {
  let v = 0;
  for (let i = s; i < e && i < buf.length; i += 1) v = (v * 256) + buf[i];
  return v;
};
const readFloatVal = (buf, s, e) => {
  const len = e - s;
  if (len === 4) return buf.buffer ? new DataView(buf.buffer, buf.byteOffset + s, 4).getFloat32(0, false) : null;
  if (len === 8) return buf.buffer ? new DataView(buf.buffer, buf.byteOffset + s, 8).getFloat64(0, false) : null;
  return null;
};
const allOnes = (vintLen) => Math.pow(2, vintLen * 7) - 1;

// ---- level-0 scan: locate the Segment data range ----
export const findSegment = (buf) => {
  let pos = 0;
  while (pos < buf.length - 1) {
    const idLen = idLength(buf[pos]);
    if (idLen <= 0 || pos + idLen >= buf.length) return null;
    const id = readId(buf, pos, idLen);
    pos += idLen;
    const size = readVint(buf, pos);
    if (!size || pos + size.length > buf.length) return null;
    pos += size.length;
    const unknown = size.value === allOnes(size.length);
    if (id === ID.Segment) return { start: pos, end: unknown ? buf.length : pos + size.value };
    pos += unknown ? buf.length - pos : size.value;
  }
  return null;
};

// ---- head chunk: Info/Tracks/SeekHead/Cues ----
export const parseMkvHeader = (buf, segment) => {
  const out = {
    timecodeScale: 1e6,
    durationSec: null,
    tracks: [],
    seekHead: [],
    cuesPos: null,
    tracksEnd: segment.start,
  };
  walkElements(buf, segment.start, Math.min(segment.end, buf.length), 0, (id, s, e) => {
    if (id === ID.SeekHead) {
      walkElements(buf, s, e, 1, (sid, ss, se) => {
        if (sid !== ID.SeekEntry) return;
        let seekId = null;
        let seekPos = null;
        walkElements(buf, ss, se, 2, (eid, es, ee) => {
          if (eid === ID.SeekID) seekId = readId(buf, es, ee - es);
          else if (eid === ID.SeekPosition) seekPos = readUintVal(buf, es, ee);
        });
        if (seekId != null && seekPos != null) out.seekHead.push({ id: seekId, pos: seekPos });
      });
    } else if (id === ID.Info) {
      walkElements(buf, s, e, 1, (iid, is, ie) => {
        if (iid === ID.TimecodeScale) { const v = readUintVal(buf, is, ie); if (v != null && v > 0) out.timecodeScale = v; }
        else if (iid === ID.Duration) { const v = readFloatVal(buf, is, ie); if (v != null) out.durationSec = v; }
      });
    } else if (id === ID.Tracks) {
      out.tracksEnd = e;
      walkElements(buf, s, e, 1, (tid, ts, te) => {
        if (tid !== ID.TrackEntry) return;
        const t = {
          number: null, type: null, codecId: null, codecPrivate: null,
          codecDelay: null, defaultDuration: null,
          width: null, height: null, sampleRate: null, channels: null,
        };
        walkElements(buf, ts, te, 2, (eid, es, ee) => {
          const data = buf.subarray(es, ee);
          if (eid === ID.TrackNumber) t.number = readUintVal(buf, es, ee);
          else if (eid === ID.TrackType) t.type = readUintVal(buf, es, ee);
          else if (eid === ID.CodecID) t.codecId = decodeUtf8(data);
          else if (eid === ID.CodecPrivate) t.codecPrivate = new Uint8Array(data);
          else if (eid === ID.CodecDelay) t.codecDelay = readUintVal(buf, es, ee);
          else if (eid === ID.DefaultDuration) t.defaultDuration = readUintVal(buf, es, ee);
          else if (eid === ID.Video) {
            walkElements(buf, es, ee, 3, (vid, vs, ve) => {
              if (vid === ID.PixelWidth) t.width = readUintVal(buf, vs, ve);
              else if (vid === ID.PixelHeight) t.height = readUintVal(buf, vs, ve);
            });
          } else if (eid === ID.Audio) {
            walkElements(buf, es, ee, 3, (aid, as_, ae) => {
              if (aid === ID.SamplingFrequency) t.sampleRate = readFloatVal(buf, as_, ae);
              else if (aid === ID.Channels) t.channels = readUintVal(buf, as_, ae);
            });
          }
        });
        if (t.number != null) out.tracks.push(t);
      });
    } else if (id === ID.Cues) {
      out.cuesPos = s;
    }
  });
  return out;
};

// ---- Cues: instant seek index ----
// buf may start at the Cues element itself OR at its first child (both are
// produced by callers) — walk level 0 and handle either shape.
export const parseCues = (buf, dataStart, segmentStart, timecodeScale) => {
  const entries = [];
  const readCuePoint = (s, e) => {
    let time = null;
    let clusterPos = null;
    walkElements(buf, s, e, 2, (cid, cs, ce) => {
      if (cid === ID.CueTime) time = readUintVal(buf, cs, ce);
      else if (cid === ID.CueTrackPositions) {
        walkElements(buf, cs, ce, 3, (tid, ts, te) => {
          if (tid === ID.CueClusterPosition) clusterPos = readUintVal(buf, ts, te);
        });
      }
    });
    if (time != null && clusterPos != null) {
      entries.push({ timeSec: (time * timecodeScale) / 1e9, pos: segmentStart + clusterPos });
    }
  };
  walkElements(buf, dataStart, buf.length, 0, (id, s, e) => {
    if (id === ID.Cues) walkElements(buf, s, e, 1, (cid, cs, ce) => {
      if (cid === ID.CuePoint) readCuePoint(cs, ce);
    });
    else if (id === ID.CuePoint) readCuePoint(s, e);
  });
  entries.sort((a, b) => a.timeSec - b.timeSec);
  return entries;
};

// ---- Exp-Golomb bit reader (H.264 SPS) ----
class BitReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i += 1) {
      const byte = this.buf[this.pos >> 3];
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos += 1;
    }
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.bits(1) === 0) zeros += 1;
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.bits(zeros);
  }
  se() {
    const v = this.ue();
    return (v & 1) ? (v + 1) >> 1 : -(v >> 1);
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

// B-frame presentation offset: max_dec_frame_buffering × num_units_in_tick / time_scale.
// Used when the track has no CodecDelay element.
export const parseSpsCodecDelay = (sps) => {
  try {
    if (!sps || sps.length < 4) return 0;
    const br = new BitReader(sps.subarray(1)); // skip NAL header byte (0x67)
    br.bits(8); br.bits(8); br.bits(8);        // profile / constraint / level
    br.ue();                                   // seq_parameter_set_id
    const profile = sps[1];
    if (HIGH_PROFILES.has(profile)) {
      const chroma = br.ue();
      if (chroma === 3) br.bits(1);
      br.ue(); br.ue(); br.bits(1);            // bit depths + qpprime
      if (br.bits(1)) {                        // seq_scaling_matrix_present
        for (let i = 0; i < 8 + (chroma !== 3 ? 12 : 0); i += 1) {
          if (br.bits(1)) {
            const size = i < 6 ? 16 : 64;
            let last = 8; let next = 8;
            for (let j = 0; j < size; j += 1) {
              if (next !== 0) {
                const delta = br.se();
                next = (last + delta + 256) % 256;
              }
              if (next !== 0) last = next;
            }
          }
        }
      }
    }
    br.ue();                                   // log2_max_frame_num_minus4
    const poc = br.ue();                       // pic_order_cnt_type
    if (poc === 0) br.ue();
    else if (poc === 1) {
      br.bits(1); br.se(); br.se();
      const n = br.ue();
      for (let i = 0; i < n; i += 1) br.se();
    }
    const maxDecFrameBuffering = br.ue();      // max_num_ref_frames
    br.bits(1);                                // gaps_in_frame_num_value_allowed
    br.ue(); br.ue();                          // pic size in mbs
    if (br.bits(1) === 0) br.bits(1);          // frame_mbs_only + mb_adaptive
    br.bits(1);                                // direct_8x8_inference
    if (br.bits(1)) { br.ue(); br.ue(); br.ue(); br.ue(); } // cropping
    if (br.bits(1) === 0) return 0;            // no VUI timing
    if (br.bits(1)) br.bits(8);                // aspect ratio
    if (br.bits(1)) br.bits(1);                // overscan
    if (br.bits(1)) {
      br.bits(3); br.bits(1); br.bits(1); br.bits(1);
      if (br.bits(1)) br.bits(24);             // colour_description
    }
    if (br.bits(1)) { br.ue(); br.ue(); }      // chroma loc
    if (br.bits(1) === 0) return 0;            // timing_info_present
    const numUnitsInTick = br.bits(32);
    const timeScale = br.bits(32);
    return timeScale > 0 ? (maxDecFrameBuffering * numUnitsInTick) / timeScale : 0;
  } catch {
    return 0;
  }
};

const extractSps = (avcC) => {
  if (!avcC || avcC.length < 8) return null;
  const numSps = avcC[5] & 0x1f;
  if (numSps === 0) return null;
  const spsLen = avcC[6] * 256 + avcC[7];
  if (spsLen < 3 || 8 + spsLen > avcC.length) return null;
  return avcC.subarray(8, 8 + spsLen);
};

// ---- Block lace sizes (SimpleBlock/Block payload after the flags byte) ----
// Returns { sizes, dataStart }: dataStart points AFTER the lacing size bytes —
// the first frame starts there, not at the count byte.
const getLaceSizes = (buf, off, end, laceType) => {
  if (laceType === 0) return { sizes: [end - off], dataStart: off };
  if (off >= end) return null;
  const count = buf[off] + 1;
  off += 1;
  if (laceType === 2) { // fixed
    const size = Math.floor((end - off) / count);
    return { sizes: Array(count).fill(size), dataStart: off };
  }
  const sizes = [];
  let consumed = 0;
  if (laceType === 1) { // xiph
    for (let i = 0; i < count - 1 && off < end; i += 1) {
      let size = 0;
      let b = 0;
      do {
        b = buf[off++];
        size += b;
      } while (b === 0xff && off < end);
      sizes.push(size);
      consumed += size;
    }
  } else if (laceType === 3) { // ebml
    for (let i = 0; i < count - 1 && off < end; i += 1) {
      const v = readVint(buf, off);
      if (!v) return null;
      off += v.length;
      sizes.push(v.value);
      consumed += v.value;
    }
  } else {
    return null;
  }
  sizes.push(Math.max(0, end - off - consumed));
  return { sizes, dataStart: off };
};

// ---- Cluster → samples (exported for tests) ----
export const parseClusterBlocks = (buf, dataStart, opts) => {
  let clusterTc = 0;
  walkElements(buf, dataStart, buf.length, 1, (id, s, e) => {
    if (id === ID.Timecode) {
      const v = readUintVal(buf, s, e);
      if (v != null) clusterTc = v;
    }
  });
  const baseSec = (clusterTc * opts.timecodeScale) / 1e9;
  const samples = [];
  const scaleSec = opts.timecodeScale / 1e9;

  const parseBlock = (bs, be, isSimple, hasRef) => {
    const tv = readVint(buf, bs);
    if (!tv) return;
    const trackNum = tv.value;
    const isVideo = opts.videoTrack != null && trackNum === opts.videoTrack;
    const isAudio = opts.audioTrack != null && trackNum === opts.audioTrack;
    if (!isVideo && !isAudio) return;
    let off = bs + tv.length;
    if (off + 2 > be) return;
    let rel = buf[off] * 256 + buf[off + 1];
    if (rel > 32767) rel -= 65536;
    off += 2;
    let flags = 0;
    let laceType = 0;
    if (isSimple) {
      if (off >= be) return;
      flags = buf[off];
      laceType = (flags >> 1) & 3;
      off += 1;
    }
    const dts = baseSec + rel * scaleSec;
    const lace = getLaceSizes(buf, off, be, laceType);
    if (!lace) return;
    let foff = lace.dataStart;
    for (const size of lace.sizes) {
      const frame = buf.subarray(foff, Math.min(foff + size, be));
      foff += size;
      if (frame.length === 0) continue;
      if (isVideo) {
        samples.push({
          track: 'video', data: frame, dtsSec: dts,
          isSync: isSimple ? !!(flags & 0x80) : !hasRef,
          ctoSec: opts.videoCodecDelaySec || 0,
        });
      } else if (isAudio) {
        let body = frame;
        if (frame.length >= 2) {
          const len = frame[0] * 256 + frame[1];
          body = len > 0 && len <= frame.length - 2 ? frame.subarray(2, 2 + len) : frame.subarray(2);
        }
        if (body.length > 0) {
          samples.push({ track: 'audio', data: body, dtsSec: dts, isSync: true, ctoSec: 0 });
        }
      }
    }
  };

  walkElements(buf, dataStart, buf.length, 1, (id, s, e) => {
    if (id === ID.SimpleBlock) parseBlock(s, e, true, null);
    else if (id === ID.BlockGroup) {
      let blockStart = null;
      let blockEnd = null;
      let hasRef = false;
      walkElements(buf, s, e, 2, (bid, bs, be) => {
        if (bid === ID.Block) { blockStart = bs; blockEnd = be; }
        else if (bid === ID.ReferenceBlock) hasRef = true;
      });
      if (blockStart != null) parseBlock(blockStart, blockEnd, false, hasRef);
    }
  });
  return { timecodeSec: baseSec, samples };
};

const hex2 = (v) => v.toString(16).padStart(2, '0');

const ENGINE_MSGS = {
  NO_MSE: 'مرورگر این دستگاه MediaSource را پشتیبانی نمی‌کند (iOS 17.1+ لازم است) — از پلیر سیستم استفاده کنید.',
  RANGE: 'سرور این فایل از پخش تکه‌تکه (HTTP Range) پشتیبانی نمی‌کند — فایل را دانلود کنید.',
  CODEC: 'کدک داخل این MKV (H.265/HEVC یا غیر از H.264+AAC) با پخش درون‌برنامه‌ای iOS سازگار نیست — با پلیر سیستم پخش کنید.',
  PARSE: 'فایل MKV ناقص یا نامعتبر است.',
  HTTP: 'خطا در دریافت فایل ویدیو — اتصال را بررسی کنید.',
  MSE: 'پخش‌کننده داخلی با خطا مواجه شد.',
};

const asAborted = (e) => {
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
    return new EngineError('ABORTED', '');
  }
  return e;
};

export class MkvStreamPlayer {
  constructor({ url, file, video, onReady, onError, onStatus }) {
    this.url = url;
    this.file = file;
    this.video = video;
    this.onReady = onReady;
    this.onError = onError;
    this.onStatus = onStatus;
    this.abort = new AbortController();
    this.destroyed = false;
    this.size = 0;
    this.segmentStart = 0;
    this.segmentEnd = 0;
    this.timecodeScale = 1e6;
    this.duration = 0;
    this.mediaSource = null;
    this.sb = null;
    this.objectUrl = null;
    this.muxer = null;
    this.index = [];      // merged seek index (cues + stream-built)
    this.indexFromCues = false;
    this.streamPos = 0;
    this.gen = 1;         // loop generation — seek bumps it to kill stale loops
    this.pendingSeek = null;
    this.appendQueue = [];
    this.appending = false;
    this.eosSent = false;
    this.onSeeking = () => { this.handleSeek(this.video.currentTime); };
  }

  emitError(e) {
    if (this.destroyed) return;
    const code = e instanceof EngineError ? e.code : (e instanceof TypeError ? 'HTTP' : 'PARSE');
    if (code === 'ABORTED') return;
    const msg = e instanceof EngineError ? e.message : (ENGINE_MSGS[code] || ENGINE_MSGS.HTTP);
    this.onError?.(code, msg);
  }

  async probeSize() {
    if (this.file) return this.file.size;
    try {
      const res = await fetch(this.url, { method: 'HEAD', signal: this.abort.signal });
      const cl = res.headers.get('content-length');
      if (res.ok && cl != null) return +cl;
    } catch (e) { if (asAborted(e).code === 'ABORTED') throw asAborted(e); }
    let r;
    try {
      r = await fetch(this.url, { headers: { Range: 'bytes=0-0' }, signal: this.abort.signal });
    } catch (e) { throw asAborted(e); }
    if (r.status !== 206) throw new EngineError('RANGE', ENGINE_MSGS.RANGE);
    const cr = r.headers.get('content-range');
    const m = cr && /^\s*bytes\s+\d+-\d+\/(\d+)/.exec(cr);
    if (!m) throw new EngineError('RANGE', ENGINE_MSGS.RANGE);
    return +m[1];
  }

  async fetchRange(start, endExclusive) {
    if (this.destroyed) throw new EngineError('ABORTED');
    const end = Math.min(endExclusive, this.size);
    if (start >= end) return new Uint8Array(0);
    if (this.file) {
      try {
        const ab = await this.file.slice(start, end).arrayBuffer();
        return new Uint8Array(ab);
      } catch (e) { throw asAborted(e); }
    }
    let res;
    try {
      res = await fetch(this.url, {
        headers: { Range: `bytes=${start}-${end - 1}` },
        signal: this.abort.signal,
      });
    } catch (e) { throw asAborted(e); }
    if (res.status !== 206) throw new EngineError('RANGE', ENGINE_MSGS.RANGE);
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }

  async findFirstCluster(from) {
    let pos = from;
    while (pos < this.segmentEnd && !this.destroyed) {
      const probe = await this.fetchRange(pos, pos + 16);
      if (probe.length < 2) return null;
      const idLen = idLength(probe[0]);
      if (idLen > 0 && readId(probe, 0, idLen) === ID.Cluster) return pos;
      pos += 16;
    }
    return null;
  }

  async buildIndexTo(targetSec) {
    // Forward cluster-header scan (used only when Cues are absent).
    const entries = [];
    let pos = this.index.length ? this.index[this.index.length - 1].pos : (this.streamPos || this.segmentStart);
    while (pos < this.segmentEnd && !this.destroyed) {
      const hdr = await this.fetchRange(pos, pos + 64);
      if (hdr.length < 4) break;
      const idLen = idLength(hdr[0]);
      if (idLen <= 0 || readId(hdr, 0, idLen) !== ID.Cluster) break;
      const sz = readVint(hdr, idLen);
      if (!sz) break;
      let tc = null;
      walkElements(hdr, idLen + sz.length, hdr.length, 1, (id, s, e) => {
        if (id === ID.Timecode) tc = readUintVal(hdr, s, e);
      });
      const entry = { timeSec: ((tc || 0) * this.timecodeScale) / 1e9, pos };
      entries.push(entry);
      pos += idLen + sz.length + sz.value;
      if (tc != null && entry.timeSec >= targetSec) break;
    }
    for (const e of entries) this.index.push(e);
    return entries;
  }

  findSeekTarget(t) {
    let lo = 0; let hi = this.index.length - 1; let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.index[mid].timeSec <= t) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best >= 0 ? this.index[best] : null;
  }

  // ---- SourceBuffer helpers (all serialized through appendQueue pump) ----
  waitSbIdle() {
    if (!this.sb || !this.sb.updating) return Promise.resolve();
    return new Promise((r) => this.sb.addEventListener('updateend', r, { once: true }));
  }

  appendChunk(chunk) {
    return new Promise((resolve, reject) => {
      this.appendQueue.push({ chunk, gen: this.gen, resolve, reject });
      this.pumpAppends();
    });
  }

  pumpAppends() {
    if (this.appending) return;
    this.appending = true;
    const next = async () => {
      while (this.appendQueue.length && !this.destroyed) {
        const item = this.appendQueue.shift();
        if (item.gen !== this.gen) { item.resolve(); continue; } // stale (seek happened)
        try {
          await this.waitSbIdle();
          if (this.destroyed) return;
          if (item.gen !== this.gen) { item.resolve(); continue; }
          await this.tryAppend(item.chunk);
          item.resolve();
        } catch (e) {
          item.reject(e);
          this.emitError(e);
          return;
        }
      }
      this.appending = false;
      if (this.appendQueue.length && !this.destroyed) this.pumpAppends();
    };
    next();
  }

  async tryAppend(chunk) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.sb.appendBuffer(chunk);
        await new Promise((r) => this.sb.addEventListener('updateend', r, { once: true }));
        this.pruneBuffer();
        return;
      } catch (e) {
        if (e && e.name === 'QuotaExceededError' && attempt < 2) {
          await this.removeOldest(45);
          continue;
        }
        throw e;
      }
    }
  }

  async removeOldest(seconds) {
    const b = this.sb.buffered;
    if (b.length === 0) return;
    const keepFrom = b.end(b.length - 1) - seconds;
    const ranges = [];
    for (let i = 0; i < b.length; i += 1) {
      if (b.start(i) < keepFrom) ranges.push([b.start(i), Math.min(b.end(i), keepFrom)]);
    }
    for (const [s, e] of ranges) {
      if (e > s) {
        this.sb.remove(s, e);
        await new Promise((r) => this.sb.addEventListener('updateend', r, { once: true }));
      }
    }
  }

  pruneBuffer() {
    if (!this.sb) return;
    const b = this.sb.buffered;
    if (b.length < 2) return;
    const keepFrom = b.end(b.length - 1) - 60;
    for (let i = 0; i < b.length; i += 1) {
      if (b.start(i) < keepFrom) {
        this.sb.remove(b.start(i), Math.min(b.end(i), keepFrom));
        break;
      }
    }
  }

  // ---- streaming ----
  async runStream(fromPos, gen) {
    this.streamPos = fromPos;
    const lastDts = { 1: null, 2: null };
    const defDur = {
      1: this.videoDefaultDurSec || 0.04,
      2: this.audioDefaultDurSec || 1024 / (this.audioSampleRate || 48000),
    };
    while (!this.destroyed && this.gen === gen && this.streamPos < this.segmentEnd) {
      const pos = this.streamPos;
      const hdr = await this.fetchRange(pos, pos + 16);
      if (this.gen !== gen) return;
      if (hdr.length < 2) break;
      const idLen = idLength(hdr[0]);
      if (idLen <= 0) break;
      const id = readId(hdr, 0, idLen);
      if (id !== ID.Cluster) break;
      const sz = readVint(hdr, idLen);
      if (!sz) break;
      const unknown = sz.value === allOnes(sz.length);
      if (unknown) break; // live-muxed clusters are not streamable here
      const total = idLen + sz.length + sz.value;
      const data = await this.fetchRange(pos, pos + total);
      if (this.gen !== gen) return;
      if (data.length < total) break;

      const res = parseClusterBlocks(data, idLen + sz.length, {
        timecodeScale: this.timecodeScale,
        videoTrack: this.videoTrack,
        audioTrack: this.audioTrack,
        videoCodecDelaySec: this.videoCodecDelaySec,
      });
      for (const s of res.samples) {
        const trackId = s.track === 'video' ? 1 : 2;
        let durSec = defDur[trackId];
        if (lastDts[trackId] != null && s.dtsSec > lastDts[trackId]) {
          durSec = s.dtsSec - lastDts[trackId];
        }
        lastDts[trackId] = s.dtsSec;
        this.muxer.addSample(
          trackId,
          s.data,
          { dtsSec: s.dtsSec, durSec, ctoSec: s.ctoSec, isSync: s.isSync }
        );
      }
      const chunk = this.muxer.flush();
      if (chunk) await this.appendChunk(chunk);
      if (this.gen !== gen) return;

      if (!this.indexFromCues) this.index.push({ timeSec: res.timecodeSec, pos });
      this.streamPos += total;

      await this.backpressure();
    }
    if (!this.destroyed && this.gen === gen && !this.eosSent && this.streamPos >= this.segmentEnd) {
      this.eosSent = true;
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        this.mediaSource.endOfStream();
      }
      this.onStatus?.('eos');
    }
  }

  async backpressure() {
    while (!this.destroyed && this.pendingSeek == null) {
      const v = this.video;
      const ahead = this.streamPos - (v.currentTime || 0) * 8e6; // crude: ~8 MB/s
      if (ahead < 240e6) return; // within ~30s of 8Mbps video
      await this.sleep(250);
    }
  }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ---- seeking ----
  handleSeek(t) {
    if (this.destroyed || this.pendingSeek === t || !this.sb) return;
    // Already buffered? Let MSE seek natively — avoids clearing the buffer
    // for tiny jumps (e.g. P2P drift corrections).
    const b = this.sb.buffered;
    for (let i = 0; i < b.length; i += 1) {
      if (b.start(i) <= t && t <= b.end(i)) return;
    }
    this.pendingSeek = t;
    this.onStatus?.('seeking');
    const drain = async () => {
      await this.waitSbIdle();
      if (this.destroyed) return;
      // MediaSource cannot be re-opened after endOfStream — recreate the
      // SourceBuffer (and re-append the init segment) for post-EOS seeks.
      if (this.eosSent) {
        this.eosSent = false;
        const old = this.sb;
        try { this.mediaSource.removeSourceBuffer(old); } catch { /* noop */ }
        this.sb = this.mediaSource.addSourceBuffer(this.codecsStr);
        const init = this.muxer.initBytes();
        this.sb.appendBuffer(init);
        await new Promise((r) => this.sb.addEventListener('updateend', r, { once: true }));
        if (this.destroyed) return;
      }
      await this.clearBuffer();
      if (this.destroyed) return;
      this.gen += 1;
      const target = this.findSeekTarget(t);
      if (target) {
        this.runStream(target.pos, this.gen);
      } else {
        await this.buildIndexTo(t);
        const t2 = this.findSeekTarget(t);
        if (!t2) { this.pendingSeek = null; return; }
        this.runStream(t2.pos, this.gen);
      }
      await this.waitUntilBuffered(t);
      if (this.destroyed) return;
      const b = this.sb.buffered;
      const end = b.length ? b.end(b.length - 1) : 0;
      this.video.currentTime = Math.min(t, Math.max(0, end - 0.05));
      this.pendingSeek = null;
      this.onStatus?.('streaming');
    };
    drain().catch((e) => { this.pendingSeek = null; this.emitError(e); });
  }

  async clearBuffer() {
    while (this.appendQueue.length) this.appendQueue.shift().resolve();
    const b = this.sb.buffered;
    for (let i = 0; i < b.length; i += 1) {
      const s = b.start(i); const e = b.end(i);
      if (e > s) {
        this.sb.remove(s, e);
        await new Promise((r) => this.sb.addEventListener('updateend', r, { once: true }));
      }
    }
  }

  async waitUntilBuffered(t) {
    const deadline = Date.now() + 15000;
    while (!this.destroyed && Date.now() < deadline) {
      const b = this.sb.buffered;
      for (let i = 0; i < b.length; i += 1) {
        if (b.start(i) <= t && t < b.end(i)) return;
      }
      await this.sleep(120);
    }
  }

  // ---- lifecycle ----
  async start() {
    try {
      if (typeof MediaSource === 'undefined') throw new EngineError('NO_MSE', ENGINE_MSGS.NO_MSE);
      this.onStatus?.('headers');
      this.size = await this.probeSize();
      if (this.destroyed) return;
      const head = await this.fetchRange(0, Math.min(this.size, 2_000_000));
      const segment = findSegment(head);
      if (!segment) throw new EngineError('PARSE', ENGINE_MSGS.PARSE);
      this.segmentStart = segment.start;
      this.segmentEnd = Math.min(segment.end, this.size);
      const hdr = parseMkvHeader(head, segment);
      this.timecodeScale = hdr.timecodeScale;
      this.duration = hdr.durationSec || 0;

      const videoTr = hdr.tracks.find((t) => t.type === 1 && t.codecId === 'V_MPEG4/ISO/AVC');
      const audioTr = hdr.tracks.find((t) => t.type === 2 && t.codecId === 'A_AAC');
      if (!videoTr) throw new EngineError('CODEC', ENGINE_MSGS.CODEC);
      if (!videoTr.codecPrivate || videoTr.codecPrivate.length < 4) {
        throw new EngineError('CODEC', ENGINE_MSGS.CODEC);
      }
      this.videoTrack = videoTr.number;
      this.audioTrack = audioTr ? audioTr.number : null;

      const avcCodec = `avc1.${hex2(videoTr.codecPrivate[1])}${hex2(videoTr.codecPrivate[2])}${hex2(videoTr.codecPrivate[3])}`;
      const tracks = [{
        id: 1, type: 'video',
        width: videoTr.width || 640,
        height: videoTr.height || 360,
        codecPrivate: videoTr.codecPrivate,
      }];
      const codecs = [avcCodec];
      if (audioTr) {
        if (!audioTr.codecPrivate || audioTr.codecPrivate.length < 2) {
          throw new EngineError('CODEC', ENGINE_MSGS.CODEC);
        }
        const objType = audioTr.codecPrivate[0] >> 3;
        const aacCodec = objType === 5 ? 'mp4a.40.5' : 'mp4a.40.2';
        tracks.push({
          id: 2, type: 'audio',
          sampleRate: audioTr.sampleRate || 48000,
          channels: audioTr.channels || 2,
          codecPrivate: audioTr.codecPrivate,
        });
        codecs.push(aacCodec);
      }
      this.videoCodecDelaySec = videoTr.codecDelay != null
        ? videoTr.codecDelay / 1e9
        : parseSpsCodecDelay(extractSps(videoTr.codecPrivate));
      this.videoDefaultDurSec = (videoTr.defaultDuration != null ? videoTr.defaultDuration / 1e9 : null);
      this.audioDefaultDurSec = (audioTr && audioTr.defaultDuration != null ? audioTr.defaultDuration / 1e9 : null);
      this.audioSampleRate = audioTr ? (audioTr.sampleRate || 48000) : null;

      // Seek index: Cues (best) else live build during streaming
      let cuesStart = hdr.cuesPos != null ? hdr.cuesPos : null;
      if (cuesStart == null) {
        const ce = hdr.seekHead.find((x) => x.id === ID.Cues);
        if (ce) cuesStart = this.segmentStart + ce.pos;
      }
      if (cuesStart != null && cuesStart < this.size) {
        const want = Math.min(1_500_000, this.size - cuesStart);
        const cuesBuf = (cuesStart + want <= head.length)
          ? head.subarray(cuesStart, cuesStart + want)
          : await this.fetchRange(cuesStart, cuesStart + want);
        this.index = parseCues(cuesBuf, 0, this.segmentStart, this.timecodeScale);
        this.indexFromCues = this.index.length > 0;
      }

      // Starting cluster
      let startPos = this.index[0]?.pos;
      if (!startPos) {
        const ce = hdr.seekHead.find((x) => x.id === ID.Cluster);
        if (ce) startPos = this.segmentStart + ce.pos;
      }
      if (!startPos) startPos = await this.findFirstCluster(hdr.tracksEnd || this.segmentStart);
      if (startPos == null) throw new EngineError('PARSE', ENGINE_MSGS.PARSE);

      this.muxer = new Fmp4Muxer(tracks);
      const ms = this.mediaSource = new MediaSource();
      this.objectUrl = URL.createObjectURL(ms);
      this.video.src = this.objectUrl;
      await new Promise((res, rej) => {
        ms.addEventListener('sourceopen', res, { once: true });
        ms.addEventListener('error', () => rej(new EngineError('MSE', ENGINE_MSGS.MSE)), { once: true });
      });
      if (this.destroyed) return;
      this.sb = ms.addSourceBuffer(`video/mp4; codecs="${codecs.join(',')}"`);
      this.codecsStr = `video/mp4; codecs="${codecs.join(',')}"`;
      this.video.addEventListener('seeking', this.onSeeking);

      this.onReady?.({ duration: this.duration });
      this.onStatus?.('streaming');
      this.runStream(startPos, this.gen);
    } catch (e) {
      this.emitError(e);
    }
  }

  destroy() {
    this.destroyed = true;
    this.abort.abort();
    this.gen += 1;
    if (this.video) this.video.removeEventListener('seeking', this.onSeeking);
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try { this.mediaSource.endOfStream(); } catch { /* closed */ }
    }
    try { if (this.sb) this.mediaSource.removeSourceBuffer(this.sb); } catch { /* noop */ }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.mediaSource = null;
    this.sb = null;
  }
}