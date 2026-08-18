// --- Subtitle codec & parser utilities ---
// Handles the three things that break Persian subtitles in practice:
//   1. Encoding: many .srt files from Windows tools are ANSI (windows-1256)
//      or UTF-16, not UTF-8 — decoding them as UTF-8 produces mojibake.
//   2. Timestamp math: "00:00:01,50" must be 1.050s, not 1.500s.
//   3. Format variety: SRT, WebVTT and (basic) ASS/SSA, with HTML/ASS tags,
//      entities and \N line markers stripped from the displayed text.

// Decode subtitle bytes with BOM detection + encoding fallbacks.
// Priority: BOM → strict UTF-8 → windows-1256 vs windows-1252 (chosen by
// which one yields more Persian/Arabic characters).
export const decodeSubtitleBytes = (bytes) => {
  if (!bytes || !bytes.length) return '';

  // Byte-order marks
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    } catch {
      // Very old browsers: swap byte pairs manually and decode as LE
      const swapped = new Uint8Array(bytes.length - 2);
      for (let i = 2; i < bytes.length; i += 2) {
        swapped[i - 2] = bytes[i + 1];
        swapped[i - 1] = bytes[i];
      }
      return new TextDecoder('utf-16le').decode(swapped);
    }
  }

  // Valid UTF-8? Use it as-is.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* not valid UTF-8 — fall through to ANSI code pages */
  }

  // ANSI fallback: pick the code page that produces more Persian glyphs
  const countFa = (s) => (s.match(/[\u0600-\u06FF]/g) || []).length;
  const cp1256 = new TextDecoder('windows-1256').decode(bytes);
  const cp1252 = new TextDecoder('windows-1252').decode(bytes);
  return countFa(cp1256) >= countFa(cp1252) ? cp1256 : cp1252;
};

// Strip ASS {..} tags, HTML tags and common entities from cue text.
export const stripSubtitleTags = (text) => {
  return String(text)
    .replace(/\{.*?\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
};

// Fractional seconds: "5" → .500, "50" → .050, "500" → .500
const fracSeconds = (v) => Number(v) / 10 ** String(v).length;

// --- SRT / WebVTT parser ---
// Blocks are separated by blank lines; the time line may appear anywhere in
// the block (handles stray index lines and VTT headers/comments).
export const parseSubtitles = (text) => {
  const cues = [];
  const norm = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const timeRe =
    /^(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{1,3})/;

  for (const block of norm.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => timeRe.test(l.trim()));
    if (idx === -1) continue;
    const m = timeRe.exec(lines[idx].trim());
    const start = +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + fracSeconds(m[4]);
    const end = +(m[5] || 0) * 3600 + +m[6] * 60 + +m[7] + fracSeconds(m[8]);

    // Keep the lines BEFORE the time line only if they aren't an SRT index
    // (some files put the index after the time line; most put it before).
    let textLines = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (i === idx) continue;
      const l = stripSubtitleTags(lines[i]);
      if (!l || /^\d+$/.test(l)) continue;
      textLines.push(l);
    }
    const cueText = textLines.join('\n').trim();
    if (cueText && Number.isFinite(start) && Number.isFinite(end) && start < end) {
      cues.push({ start, end, text: cueText });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
};

// --- Basic ASS/SSA parser ---
// Reads [Events] → Format: + Dialogue: lines. Text is the last field (may
// contain commas), so it is sliced from the field array. All styling tags
// ({...}) are stripped; \N / \n become line breaks.
export const parseAss = (text) => {
  const cues = [];
  const norm = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const formatLine = /^Format:\s*(.+)$/im.exec(norm);
  if (!formatLine) return cues;

  const fields = formatLine[1].split(',').map((f) => f.trim().toLowerCase());
  const fStart = fields.indexOf('start');
  const fEnd = fields.indexOf('end');
  const fText = fields.indexOf('text');
  if (fStart < 0 || fEnd < 0 || fText < 0) return cues;

  const toSec = (v) => {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(String(v).trim());
    if (!m) return NaN;
    return +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + fracSeconds(m[4]);
  };

  for (const line of norm.split('\n')) {
    const lm = /^Dialogue:\s*(.*)$/.exec(line.trim());
    if (!lm) continue;
    const parts = lm[1].split(',');
    const start = toSec(parts[fStart]);
    const end = toSec(parts[fEnd]);
    const raw = parts.slice(fText).join(',');
    const cueText = stripSubtitleTags(
      raw.replace(/\\N/gi, '\n').replace(/\\n/g, '\n').replace(/\\h/gi, ' ')
    );
    if (cueText && Number.isFinite(start) && Number.isFinite(end) && start < end) {
      cues.push({ start, end, text: cueText });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
};

// Pick the right parser for a file/URL name (.ass/.ssa → ASS, else SRT/VTT).
// Falls back to ASS detection if the SRT parser found nothing (mislabeled
// files happen more often than you'd think).
export const parseSubtitleContent = (text, name = '') => {
  const ext = (/\.(ass|ssa|srt|vtt|txt)$/i.exec(String(name).split('?')[0]) || [])[1] || '';
  if (ext === 'ass' || ext === 'ssa') return parseAss(text);
  const cues = parseSubtitles(text);
  if (cues.length === 0 && /\[Events\]/.test(text)) return parseAss(text);
  return cues;
};
