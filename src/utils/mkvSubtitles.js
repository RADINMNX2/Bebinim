// Minimal Matroska in-band subtitle extractor (no WASM / no external player).
// Extracts embedded subtitle tracks (S_TEXT/UTF8, S_TEXT/ASS, S_TEXT/SSA) so
// they can be rendered with our custom subtitle overlay.
import { tools } from 'ebml';

const findChild = (children, name) =>
  children && children.find((c) => c.name === name);
const findChildren = (children, name) =>
  (children || []).filter((c) => c.name === name);

const readVint = (buf, pos) => {
  const first = buf[pos];
  let mask = 0x80;
  let len = 1;
  while ((first & mask) === 0 && mask > 0) {
    mask >>= 1;
    len += 1;
  }
  let val = first & (mask - 1);
  for (let i = 1; i < len; i += 1) val = (val << 8) | buf[pos + i];
  return { value: val, length: len };
};

const assToSec = (t) => {
  const m = String(t).trim().match(/(\d+):(\d+):(\d+)(?:[.,](\d+))?/);
  if (!m) return null;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + frac;
};

const decodeBlockText = (data, codecId) => {
  const text = new TextDecoder('utf-8').decode(data);
  if (codecId === 'S_TEXT/UTF8') {
    // Strip optional SRT timing line(s): "00:00:01,000 --> 00:00:03,000"
    return text
      .replace(/^\s*\d+:\d\d:\d\d[,.]\d+\s*-->\s*\d+:\d\d:\d\d[,.]\d+\s*\n?/gm, '')
      .replace(/\r/g, '')
      .trim();
  }
  if (codecId === 'S_TEXT/ASS' || codecId === 'S_TEXT/SSA') {
    const m = text.match(
      /Dialogue:\s*[^,]*,([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)/
    );
    return m ? m[9].trim() : text.trim();
  }
  return text.trim();
};

export const extractMkvSubtitles = async (arrayBuffer) => {
  const tree = await tools.readAll(new Uint8Array(arrayBuffer));
  const segment = tree.find((e) => e.name === 'Segment');
  if (!segment || !segment.children) throw new Error('Segment یافت نشد');

  let timecodeScale = 1e6;
  for (const child of segment.children) {
    if (child.name === 'Info') {
      const tc = findChild(child.children, 'TimecodeScale');
      if (tc && tc.value != null) timecodeScale = tc.value;
    }
  }

  const subTracks = [];
  for (const child of segment.children) {
    if (child.name === 'Tracks') {
      for (const te of findChildren(child.children, 'TrackEntry')) {
        const type = findChild(te.children, 'TrackType');
        const num = findChild(te.children, 'TrackNumber');
        const codec = findChild(te.children, 'CodecID');
        const lang = findChild(te.children, 'Language');
        const name = findChild(te.children, 'Name');
        if (type && type.value === 17 && codec && /S_TEXT/.test(codec.value)) {
          subTracks.push({
            number: num ? num.value : subTracks.length + 1,
            codecId: codec.value,
            lang: lang ? lang.value : '',
            name: name ? name.value : ''
          });
        }
      }
    }
  }
  if (subTracks.length === 0) throw new Error('ترک زیرنویس یافت نشد');

  const trackNumbers = new Set(subTracks.map((t) => t.number));
  const scaleToMs = timecodeScale / 1e6;
  const blocks = [];

  for (const child of segment.children) {
    if (child.name !== 'Cluster') continue;
    const clusterTc = findChild(child.children, 'Timecode');
    const base = clusterTc ? clusterTc.value * scaleToMs : 0;

    const pushBlock = (el) => {
      const data = el.data;
      if (!data) return;
      const { value: trackNum, length } = readVint(data, 0);
      let off = length;
      const hi = data[off];
      const lo = data[off + 1];
      let rel = hi * 256 + lo;
      if (rel > 32767) rel -= 65536; // signed int16
      off += 2;
      // off += 1; // flags byte (not needed)
      if (!trackNumbers.has(trackNum)) return;
      blocks.push({
        trackNumber: trackNum,
        timeMs: base + rel,
        data: data.subarray(off + 1)
      });
    };

    for (const sub of child.children) {
      if (sub.name === 'SimpleBlock') pushBlock(sub);
      else if (sub.name === 'BlockGroup') {
        const block = findChild(sub.children, 'Block');
        if (block) pushBlock(block);
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
      let text = decodeBlockText(b.data, t.codecId);
      if (!text) continue;
      let start = null;
      let end = null;
      if (t.codecId === 'S_TEXT/ASS' || t.codecId === 'S_TEXT/SSA') {
        const raw = new TextDecoder('utf-8').decode(b.data);
        const m = raw.match(/Dialogue:\s*[^,]*,([^,]*),([^,]*),/);
        if (m) {
          start = assToSec(m[1]);
          end = assToSec(m[2]);
        }
      }
      start = start != null ? start : b.timeMs / 1000;
      end = end != null ? end : start + 2;
      cues.push({ start, end, text });
    }
    if (cues.length === 0) continue;

    cues.sort((a, b) => a.start - b.start);
    for (let i = 0; i < cues.length - 1; i += 1) {
      if (cues[i].end <= cues[i].start || cues[i].end > cues[i + 1].start) {
        cues[i].end = cues[i + 1].start;
      }
    }
    results.push({
      trackNumber: t.number,
      type: t.codecId,
      language: t.lang,
      name: t.name,
      cues
    });
  }

  if (results.length === 0) throw new Error('فریم زیرنویس یافت نشد');
  return results;
};