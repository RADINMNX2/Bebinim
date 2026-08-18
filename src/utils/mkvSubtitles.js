// Minimal Matroska in-band subtitle extractor (no WASM / no external player).
// Extracts embedded subtitle tracks (S_TEXT/UTF8, S_TEXT/ASS, S_TEXT/SSA) so
// they can be rendered with our custom subtitle overlay.
//
// NOTE: ebml@3 dropped the `tools.readAll` tree API, so we ship a tiny
// self-contained EBML element walker (~50 lines) instead of a dependency.

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
const ID_NAME = Object.fromEntries(Object.entries(ID).map(([name, id]) => [id, name]));
const MASTER_IDS = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Cluster, ID.BlockGroup]);

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

const parseChildren = (buf, start, end, depth) => {
  const children = [];
  if (depth > 64) return children; // malformed-file guard
  let pos = start;
  while (pos < end - 1) {
    const idLen = idLength(buf[pos]);
    if (idLen <= 0 || pos + idLen >= end) break;
    const id = readId(buf, pos, idLen);
    pos += idLen;
    const size = readVint(buf, pos);
    if (!size || pos + size.length > end) break;
    pos += size.length;
    if (pos + size.value > end) break; // truncated element
    const dataStart = pos;
    const dataEnd = pos + size.value;
    pos = dataEnd;
    const name = ID_NAME[id];
    if (MASTER_IDS.has(id)) {
      children.push({ name: name || `unknown_${id.toString(16)}`, children: parseChildren(buf, dataStart, dataEnd, depth + 1) });
    } else {
      children.push({
        name: name || `unknown_${id.toString(16)}`,
        data: size.value > 0 ? buf.subarray(dataStart, dataEnd) : new Uint8Array(0)
      });
    }
  }
  return children;
};

const findChild = (children, name) =>
  children && children.find((c) => c.name === name);
const findChildren = (children, name) =>
  (children || []).filter((c) => c.name === name);

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

// Extract every Dialogue line of an ASS/SSA block (blocks may contain several).
const parseAssBlock = (raw) => {
  const out = [];
  const lineRe = /Dialogue:\s*([^\n]*)/gi;
  let m;
  while ((m = lineRe.exec(raw)) !== null) {
    const fields = m[1].split(',');
    if (fields.length < 10) continue;
    const start = assToSec(fields[1]);
    const end = assToSec(fields[2]);
    const text = stripAssOverrides(fields.slice(9).join(','));
    if (start == null || end == null || !text) continue;
    out.push({ start, end, text });
  }
  return out;
};

const decodeBlockText = (data, codecId) => {
  const text = new TextDecoder('utf-8').decode(data);
  if (codecId === 'S_TEXT/UTF8') {
    // Strip SRT timing lines (with optional trailing WebVTT cue settings) and
    // any leading cue index line.
    return text
      .split(/\r?\n/)
      .filter((line) => {
        const l = line.trim();
        return !(l === '' && false) && !/^\d+$/.test(l) && !/^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*.+$/.test(l);
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
  const s = Math.max(0, Math.floor(sec));
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
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
  const tree = parseChildren(buf, 0, buf.length, 0);
  const segment = tree.find((e) => e.name === 'Segment');
  if (!segment || !segment.children) throw new Error('Segment یافت نشد');

  let timecodeScale = 1e6;
  const info = findChild(segment.children, 'Info');
  const tc = info && findChild(info.children, 'TimecodeScale');
  const tcVal = readUint(tc);
  if (tcVal != null && tcVal > 0) timecodeScale = tcVal;

  const subTracks = [];
  const tracks = findChild(segment.children, 'Tracks');
  if (tracks) {
    for (const te of findChildren(tracks.children, 'TrackEntry')) {
      const type = readUint(findChild(te.children, 'TrackType'));
      const num = readUint(findChild(te.children, 'TrackNumber'));
      const codec = readStr(findChild(te.children, 'CodecID'));
      const lang = readStr(findChild(te.children, 'Language'));
      const name = readStr(findChild(te.children, 'Name'));
      if (type === 17 && /S_TEXT\/(UTF8|ASS|SSA)$/.test(codec)) {
        subTracks.push({
          number: num != null ? num : subTracks.length + 1,
          codecId: codec,
          lang,
          name
        });
      }
    }
  }
  if (subTracks.length === 0) throw new Error('ترک زیرنویس یافت نشد');

  const trackNumbers = new Set(subTracks.map((t) => t.number));
  const scaleToMs = timecodeScale / 1e6;
  const blocks = [];

  const pushBlock = (el, isSimpleBlock) => {
    const data = el.data;
    if (!data || data.length < 3) return;
    const trackVint = readVint(data, 0);
    if (!trackVint) return;
    const trackNum = trackVint.value;
    let off = trackVint.length;
    if (off + 2 > data.length) return;
    const hi = data[off];
    const lo = data[off + 1];
    let rel = hi * 256 + lo;
    if (rel > 32767) rel -= 65536; // signed int16
    off += 2;
    // SimpleBlock: 1 flags byte after the timecode; Block (BlockGroup): none.
    if (isSimpleBlock) {
      if (off >= data.length) return;
      const flags = data[off];
      if (flags & 0x06) return; // laced block: not supported -> skip
      off += 1;
    }
    if (!trackNumbers.has(trackNum)) return;
    blocks.push({
      trackNumber: trackNum,
      timeMs: base + rel,
      data: data.subarray(off),
      durationMs: null
    });
  };

  for (const child of segment.children) {
    if (child.name !== 'Cluster') continue;
    const clusterTc = readUint(findChild(child.children, 'Timecode'));
    const base = clusterTc != null ? clusterTc * scaleToMs : 0;

    for (const sub of child.children) {
      if (sub.name === 'SimpleBlock') pushBlock(sub, true);
      else if (sub.name === 'BlockGroup') {
        const block = findChild(sub.children, 'Block');
        if (block) pushBlock(block, false);
        // If a duration was declared, apply it to the block we just pushed
        // (the last one belongs to this group).
        const durEl = findChild(sub.children, 'BlockDuration');
        const durVal = readUint(durEl);
        const last = blocks[blocks.length - 1];
        if (last && durVal != null) {
          last.durationMs = durVal * scaleToMs;
        }
      }
    }
  }

  if (blocks.length === 0) throw new Error('فریم زیرنویس یافت نشد');

  const results = [];
  for (const t of subTracks) {
    const trackBlocks = blocks
      .filter((b) => b.trackNumber === t.number)
      .sort((a, b) => a.timeMs - b.timeMs);
    if (trackBlocks.length === 0) continue;

    const cues = [];
    for (const b of trackBlocks) {
      if (!Number.isFinite(b.timeMs)) continue;
      let start = b.timeMs / 1000;
      let end = b.durationMs != null ? start + b.durationMs / 1000 : start + 2;
      let texts = null;
      if (t.codecId === 'S_TEXT/ASS' || t.codecId === 'S_TEXT/SSA') {
        const parsed = parseAssBlock(new TextDecoder('utf-8').decode(b.data));
        texts = parsed.map((p) => p.text);
        const first = parsed[0];
        if (first) {
          start = first.start;
          end = first.end;
        }
      }
      if (!texts) texts = [decodeBlockText(b.data, t.codecId)];
      for (const text of texts) {
        if (!text) continue;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        cues.push({ start, end, text });
      }
    }
    if (cues.length === 0) continue;

    cues.sort((a, b) => a.start - b.start);
    // Never let a cue overlap the next one (and never end before it starts).
    for (let i = 0; i < cues.length - 1; i += 1) {
      if (!Number.isFinite(cues[i].end) || cues[i].end > cues[i + 1].start) {
        cues[i].end = cues[i + 1].start;
      }
      if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.05;
    }
    results.push({
      trackNumber: t.number,
      type: t.codecId,
      language: t.lang,
      name: t.name,
      cues,
      srt: cuesToSrt(cues)
    });
  }

  if (results.length === 0) throw new Error('فریم زیرنویس یافت نشد');
  return results;
};
