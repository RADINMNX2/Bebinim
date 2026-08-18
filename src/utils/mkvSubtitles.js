// Minimal Matroska in-band subtitle extractor (no WASM / no external player).
// Extracts embedded subtitle tracks (S_TEXT/UTF8, S_TEXT/ASS, S_TEXT/SSA) so
// they can be rendered with our custom subtitle overlay.
//
// The file is walked with a lightweight event-based EBML parser that never
// builds a tree of the whole file, so even multi-GB MKVs parse in bounded
// memory: video/audio clusters are read once and discarded.

// --- Matroska element IDs we care about ---
const ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Language: 0x22b59c,
  Name: 0x536e,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa1,
  BlockGroup: 0xa0,
  Block: 0xa3,
  BlockDuration: 0x9b,
};

// Element IDs are VINTs where the marker bit is KEPT in the value.
const readId = (buf, pos, len) => {
  let v = 0;
  for (let i = 0; i < len; i += 1) v = (v * 256) + buf[pos + i];
  return v;
};
const idLength = (b) => {
  if (b === undefined || b === null) return 0;
  if (b & 0x80) return 1;
  if (b & 0x40) return 2;
  if (b & 0x20) return 3;
  if (b & 0x10) return 4;
  return 0;
};

// Sizes / numbers are VINTs where the marker bit is STRIPPED.
const readVint = (buf, pos) => {
  if (!buf || pos < 0 || pos >= buf.length) return null;
  const first = buf[pos];
  let mask = 0x80;
  let len = 1;
  while ((first & mask) === 0 && mask > 0) {
    mask >>= 1;
    len += 1;
  }
  if (mask === 0 || pos + len > buf.length) return null; // no marker bit / truncated
  let val = first & (mask - 1);
  for (let i = 1; i < len; i += 1) val = (val << 8) | buf[pos + i];
  return { value: val, length: len };
};

// Event-driven EBML walker: visits every element without building a tree.
// The visitor receives (id, dataStart, dataEnd); return false to abort.
// Elements with "unknown size" (all size bits set — used for live-muxed
// Segments/Clusters) are treated as extending to the parent's end.
const walkElements = (buf, start, end, depth, visitor) => {
  if (depth > 64 || start < 0 || end > buf.length) return; // malformed-file guard
  let pos = start;
  while (pos < end - 1) {
    const idLen = idLength(buf[pos]);
    if (idLen <= 0 || pos + idLen >= end) return;
    const id = readId(buf, pos, idLen);
    pos += idLen;
    const size = readVint(buf, pos);
    if (!size || pos + size.length > end) return;
    pos += size.length;
    const unknownSize = size.value === Math.pow(2, size.length * 7) - 1;
    const dataStart = pos;
    const dataEnd = unknownSize ? end : pos + size.value;
    if (!unknownSize && dataEnd > end) return; // truncated element
    if (visitor(id, dataStart, dataEnd) === false) return;
    pos = dataEnd;
  }
};

const readUint = (el) => {
  if (!el || !el.data || el.data.length === 0) return undefined;
  let v = 0;
  for (const b of el.data) v = v * 256 + b;
  return v;
};
const readStr = (el) =>
  el && el.data && el.data.length > 0
    ? new TextDecoder('utf-8').decode(el.data).replace(/\u0000+$/g, '').trim()
    : '';

const assToSec = (t) => {
  const m = String(t).trim().match(/(\d+):(\d+):(\d+)(?:[.,](\d+))?/);
  if (!m) return null;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + frac;
};

const stripAssOverrides = (text) =>
  text.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\([nNh])/g, ' ').trim();

// Standard ASS field order: Layer, Start, End, Style, Name, MarginL/R/V, Effect, Text
const DEFAULT_ASS_FMT = { start: 1, end: 2, text: 9 };

// Read the Format: line from an ASS header block so non-standard field orders
// (custom Format: in [Events]) map correctly.
const parseAssFormat = (header) => {
  const m = /^Format:\s*(.+)$/im.exec(header);
  if (!m) return null;
  const f = m[1].split(',').map((x) => x.trim().toLowerCase());
  const start = f.indexOf('start');
  const end = f.indexOf('end');
  const text = f.indexOf('text');
  if (start < 0 || end < 0 || text < 0) return null;
  return { start, end, text };
};

// Extract every Dialogue line of an ASS/SSA block (blocks may contain several).
// The regex is created per call so `lastIndex` never leaks across blocks.
const parseAssBlock = (raw, fmt) => {
  const out = [];
  const f = fmt || DEFAULT_ASS_FMT;
  const need = Math.max(f.start, f.end, f.text);
  const lineRe = /Dialogue:\s*([^\n]*)/gi;
  let m;
  while ((m = lineRe.exec(raw)) !== null) {
    const fields = m[1].split(',');
    if (fields.length <= need) continue;
    const start = assToSec(fields[f.start]);
    const end = assToSec(fields[f.end]);
    const text = stripAssOverrides(fields.slice(f.text).join(','));
    if (start == null || end == null || !text) continue;
    out.push({ start, end, text });
  }
  return out;
};

const decodeBlockText = (data, codecId) => {
  const text = new TextDecoder('utf-8').decode(data);
  if (codecId === 'S_TEXT/UTF8' || codecId === 'S_TEXT/WEBVTT') {
    // Strip SRT/WebVTT timing lines (with optional trailing cue settings),
    // WebVTT headers (WEBVTT / NOTE / X-TIMESTAMP-MAP) and any cue index line.
    return text
      .split(/\r?\n/)
      .filter((line) => {
        const l = line.trim();
        return (
          !/^\d+$/.test(l) &&
          !/^(WEBVTT|NOTE)\b/i.test(l) &&
          !/^X-TIMESTAMP-MAP=/i.test(l) &&
          !/^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*.+$/.test(l)
        );
      })
      .join('\n')
      .trim();
  }
  if (codecId === 'S_TEXT/ASS' || codecId === 'S_TEXT/SSA') {
    return stripAssOverrides(text);
  }
  return text.trim();
};

const fmtTimestamp = (sec) => {
  // Round the whole value (not seconds/ms separately) so .9995s never
  // produces an invalid "00:00:01,1000" SRT timestamp.
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const s = Math.floor(totalMs / 1000);
  const ms = totalMs % 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

export const cuesToSrt = (cues) =>
  cues
    .map((cue, i) => `${i + 1}\n${fmtTimestamp(cue.start)} --> ${fmtTimestamp(cue.end)}\n${cue.text}`)
    .join('\n\n');

export const extractMkvSubtitles = async (arrayBuffer) => {
  const buf = new Uint8Array(arrayBuffer);

  // Level-0 scan: locate the Segment element (everything else is discarded).
  let segment = null;
  {
    let pos = 0;
    while (pos < buf.length - 1) {
      const idLen = idLength(buf[pos]);
      if (idLen <= 0 || pos + idLen >= buf.length) throw new Error('فایل MKV نامعتبر است');
      const id = readId(buf, pos, idLen);
      pos += idLen;
      const size = readVint(buf, pos);
      if (!size || pos + size.length > buf.length) throw new Error('فایل MKV نامعتبر است');
      pos += size.length;
      const unknownSize = size.value === Math.pow(2, size.length * 7) - 1;
      if (id === ID.Segment) {
        segment = { start: pos, end: unknownSize ? buf.length : pos + size.value };
        if (unknownSize) break; // Segment runs to EOF — nothing left to scan
      }
      if (!unknownSize && pos + size.value > buf.length) throw new Error('فایل MKV ناقص است');
      pos += unknownSize ? buf.length - pos : size.value;
    }
  }
  if (!segment) throw new Error('Segment یافت نشد');

  // Pass 1: read TimecodeScale (Info) + subtitle track list (Tracks).
  // Both live at the start of the file and are small, so this is cheap.
  let timecodeScale = 1e6;
  const subTracks = [];

  walkElements(buf, segment.start, segment.end, 0, (id, s, e) => {
    if (id === ID.Info) {
      walkElements(buf, s, e, 1, (iid, is, ie) => {
        if (iid === ID.TimecodeScale) {
          const v = readUint({ data: buf.subarray(is, ie) });
          if (v != null && v > 0) timecodeScale = v;
        }
      });
    } else if (id === ID.Tracks) {
      walkElements(buf, s, e, 1, (tid, ts, te) => {
        if (tid !== ID.TrackEntry) return;
        const track = { number: null, type: null, codec: null, lang: null, name: null };
        walkElements(buf, ts, te, 2, (eid, es, ee) => {
          const data = buf.subarray(es, ee);
          if (eid === ID.TrackType) track.type = readUint({ data });
          else if (eid === ID.TrackNumber) track.number = readUint({ data });
          else if (eid === ID.CodecID) track.codec = readStr({ data });
          else if (eid === ID.Language) track.lang = readStr({ data });
          else if (eid === ID.Name) track.name = readStr({ data });
        });
        if (track.type === 17 && /S_TEXT\/(UTF8|ASS|SSA|WEBVTT)$/.test(track.codec || '')) {
          subTracks.push({
            number: track.number != null ? track.number : subTracks.length + 1,
            codecId: track.codec,
            lang: track.lang,
            name: track.name
          });
        }
      });
    }
  });

  if (subTracks.length === 0) throw new Error('ترک زیرنویس یافت نشد');

  const trackNumbers = new Set(subTracks.map((t) => t.number));
  const blocksByTrack = new Map(subTracks.map((t) => [t.number, []]));
  const scaleToMs = timecodeScale / 1e6;

  // Only blocks belonging to subtitle tracks are retained — video/audio
  // blocks are visited and immediately discarded (bounded memory).
  const pushBlock = (start, end, isSimpleBlock, clusterBase, blockDurationMs) => {
    const trackVint = readVint(buf, start);
    if (!trackVint) return;
    const trackNum = trackVint.value;
    if (!trackNumbers.has(trackNum)) return;
    let off = start + trackVint.length;
    if (off + 2 > end) return;
    const hi = buf[off];
    const lo = buf[off + 1];
    let rel = hi * 256 + lo;
    if (rel > 32767) rel -= 65536; // signed int16
    off += 2;
    // SimpleBlock: 1 flags byte after the timecode; Block (BlockGroup): none.
    if (isSimpleBlock) {
      if (off >= end) return;
      const flags = buf[off];
      if (flags & 0x06) return; // laced block: not supported -> skip
      off += 1;
    }
    blocksByTrack.get(trackNum).push({
      timeMs: clusterBase + rel,
      data: buf.subarray(off, end),
      durationMs: blockDurationMs
    });
  };

  // Pass 2: walk Clusters, keep only subtitle blocks.
  walkElements(buf, segment.start, segment.end, 0, (id, s, e) => {
    if (id !== ID.Cluster) return;
    let clusterBase = 0;
    // Pass A: read the cluster Timecode. The spec doesn't guarantee it comes
    // before the blocks, so resolve it FIRST — blocks stamped with base 0
    // would all collapse to t=0.
    walkElements(buf, s, e, 1, (cid, cs, ce) => {
      if (cid === ID.Timecode) {
        const v = readUint({ data: buf.subarray(cs, ce) });
        if (v != null) clusterBase = v * scaleToMs;
      }
    });
    // Pass B: collect subtitle blocks with the resolved base.
    walkElements(buf, s, e, 1, (cid, cs, ce) => {
      if (cid === ID.SimpleBlock) {
        pushBlock(cs, ce, true, clusterBase, null);
      } else if (cid === ID.BlockGroup) {
        let blockRange = null;
        let blockDurationMs = null;
        walkElements(buf, cs, ce, 2, (bid, bs, be) => {
          if (bid === ID.Block) blockRange = { start: bs, end: be };
          else if (bid === ID.BlockDuration) {
            const v = readUint({ data: buf.subarray(bs, be) });
            if (v != null) blockDurationMs = v * scaleToMs;
          }
        });
        if (blockRange) pushBlock(blockRange.start, blockRange.end, false, clusterBase, blockDurationMs);
      }
    });
  });

  const results = [];
  for (const t of subTracks) {
    const trackBlocks = blocksByTrack.get(t.number) || [];
    if (trackBlocks.length === 0) continue;
    trackBlocks.sort((a, b) => a.timeMs - b.timeMs);

    const cues = [];
    let assFmt = null;
    for (const b of trackBlocks) {
      if (!Number.isFinite(b.timeMs)) continue;
      const blockStart = b.timeMs / 1000;
      let start = blockStart;
      let end = b.durationMs != null ? start + b.durationMs / 1000 : start + 2;
      if (t.codecId === 'S_TEXT/ASS' || t.codecId === 'S_TEXT/SSA') {
        const raw = new TextDecoder('utf-8').decode(b.data);
        // The first block is usually the ASS header (Script Info / Styles):
        // grab its Format: line so dialogue fields map correctly.
        if (assFmt === null && !/Dialogue:/i.test(raw)) {
          assFmt = parseAssFormat(raw);
        }
        // Every Dialogue line carries its own timestamps — keep them all
        // instead of stamping the whole block with the first one.
        const parsed = parseAssBlock(raw, assFmt);
        for (const p of parsed) {
          if (p.start != null && p.end != null && p.end > p.start && p.text) {
            cues.push({ start: p.start, end: p.end, text: p.text });
          }
        }
      } else {
        const text = decodeBlockText(b.data, t.codecId);
        if (text && end > start) cues.push({ start, end, text });
      }
    }
    if (cues.length === 0) continue;

    cues.sort((a, b) => a.start - b.start);

    // Drop exact duplicates (e.g. the same ASS dialogue in multiple blocks)
    const deduped = [];
    for (const cue of cues) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.start === cue.start && prev.end === cue.end && prev.text === cue.text) continue;
      deduped.push(cue);
    }

    // Never let a cue overlap the next one (and never end before it starts).
    for (let i = 0; i < deduped.length - 1; i += 1) {
      const cue = deduped[i];
      if (!Number.isFinite(cue.end) || cue.end > deduped[i + 1].start) cue.end = deduped[i + 1].start;
      if (cue.end <= cue.start) cue.end = Math.min(deduped[i + 1].start, cue.start + 0.05);
    }

    results.push({
      trackNumber: t.number,
      type: t.codecId,
      language: t.lang,
      name: t.name,
      cues: deduped,
      srt: cuesToSrt(deduped)
    });
  }

  if (results.length === 0) throw new Error('فریم زیرنویس یافت نشد');
  return results;
};