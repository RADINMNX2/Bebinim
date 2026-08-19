import { useEffect, useRef, useState } from 'react';
import { extractMkvSubtitles, cuesToSrt } from '../../utils/mkvSubtitles';
import { decodeSubtitleBytes, parseSubtitleContent } from '../../utils/subtitleCodec';

// Subtitle domain: state + loading (URL / file / MKV extraction) + the rAF
// cue tracker + export helpers. Room.jsx only wires the pieces it renders.
export function useSubtitles({ videoRef, videoUrlRef, addToast }) {
  const [subtitleText, setSubtitleText] = useState('');
  const [subtitleCues, setSubtitleCues] = useState([]);
  const [subtitleEnabled, setSubtitleEnabled] = useState(false);
  const [subtitleName, setSubtitleName] = useState('');
  const [subUrlInput, setSubUrlInput] = useState('');
  const subtitleFileRef = useRef(null);
  const subtitleSourceRef = useRef('');
  const activeSubtitleRef = useRef('');
  const [mkvTracks, setMkvTracks] = useState([]);
  const [mkvLoading, setMkvLoading] = useState(false);
  const [mkvError, setMkvError] = useState('');

  const resetSubtitles = () => {
    activeSubtitleRef.current = '';
    subtitleSourceRef.current = '';
    setSubtitleCues([]);
    setSubtitleName('');
    setSubtitleText('');
    setSubtitleEnabled(false);
    setMkvTracks([]);
    setMkvError('');
  };

  const loadSubtitleText = (text, name) => {
    const cues = parseSubtitleContent(text, name);
    subtitleSourceRef.current = cuesToSrt(cues);
    activeSubtitleRef.current = '';
    setSubtitleCues(cues);
    setSubtitleName(name);
    setSubtitleEnabled(cues.length > 0);
    setSubtitleText('');
    addToast(
      cues.length > 0 ? `زیرنویس «${name}» با ${cues.length} بخش بارگذاری شد` : 'زیرنویس معتبری یافت نشد',
      cues.length > 0 ? 'success' : 'error'
    );
  };

  // Load raw parsed cues (e.g. extracted from an MKV) directly
  const loadSubtitleCues = (cues, name) => {
    subtitleSourceRef.current = cuesToSrt(cues);
    activeSubtitleRef.current = '';
    setSubtitleCues(cues);
    setSubtitleName(name);
    setSubtitleEnabled(cues.length > 0);
    setSubtitleText('');
    addToast(
      cues.length > 0 ? `زیرنویس «${name}» با ${cues.length} بخش بارگذاری شد` : 'زیرنویس معتبری یافت نشد',
      cues.length > 0 ? 'success' : 'error'
    );
  };

  const loadSubtitleUrl = async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const text = decodeSubtitleBytes(buf);
      loadSubtitleText(text, url.split('/').pop().split('?')[0] || 'زیرنویس');
    } catch {
      addToast('بارگذاری زیرنویس ناموفق بود (CORS یا لینک نامعتبر)', 'error');
    }
  };

  const handleSubtitleFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadSubtitleText(decodeSubtitleBytes(new Uint8Array(reader.result)), file.name);
    reader.readAsArrayBuffer(file);
  };

  // Extract embedded MKV subtitle tracks from the current video URL
  const extractMkvFromUrl = async () => {
    const url = videoUrlRef.current;
    if (!url) {
      setMkvError('ابتدا یک ویدیو انتخاب کنید');
      return;
    }
    setMkvLoading(true);
    setMkvError('');
    setMkvTracks([]);
    try {
      let res;
      try {
        res = await fetch(url, {
          mode: 'cors',
          signal: AbortSignal.timeout(180000)
        });
      } catch (fetchErr) {
        throw fetchErr;
      }
      if (res.type === 'opaque') throw new TypeError('CORS blocked');
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const buf = await res.arrayBuffer();
      const tracks = await extractMkvSubtitles(buf);
      setMkvTracks(tracks);
      if (tracks.length === 0) setMkvError('زیرنویس داخلی در این ویدیو یافت نشد');
      else addToast(`${tracks.length} ترک زیرنویس یافت شد`, 'success');
    } catch (e) {
      const msg = e?.message || String(e);
      const corsBlocked = e instanceof TypeError
        || msg.includes('CORS')
        || msg.includes('cross-origin')
        || msg.includes('Failed to fetch')
        || msg.includes('NetworkError');
      if (corsBlocked) {
        setMkvError('CORS blocked: سرور ویدیو اجازه خواندن مستقیم را نمی‌دهد. فایل را دانلود و آپلود کنید یا از لینک مستقیم SRT استفاده کنید.');
      } else {
        setMkvError('استخراج ناموفق بود: ' + msg);
      }
    } finally {
      setMkvLoading(false);
    }
  };

  // Extract embedded MKV subtitle tracks from an uploaded file (no CORS limits)
  const extractMkvFromFile = async (file) => {
    if (!file) return;
    setMkvLoading(true);
    setMkvError('');
    setMkvTracks([]);
    try {
      const buf = await file.arrayBuffer();
      const tracks = await extractMkvSubtitles(buf);
      setMkvTracks(tracks);
      if (tracks.length === 0) setMkvError('زیرنویس داخلی در این ویدیو یافت نشد');
      else addToast(`${tracks.length} ترک زیرنویس یافت شد`, 'success');
    } catch (err) {
      setMkvError('استخراج ناموفق بود: ' + (err?.message || String(err)));
    } finally {
      setMkvLoading(false);
    }
  };

  // --- Subtitle download (export current subtitle text) ---
  const downloadSubtitle = () => {
    if (subtitleCues.length === 0) return;
    const name = (subtitleName || 'subtitle.srt').replace(/\.(srt|vtt|txt)$/i, '') + '.srt';
    const content = subtitleSourceRef.current || cuesToSrt(subtitleCues);
    const blob = new Blob([content], { type: 'text/plain' });
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
    addToast(`زیرنویس «${name}» دانلود شد`, 'success');
  };

  // Cue tracking loop (rAF + binary search: smooth, no jank, no O(n) scan)
  useEffect(() => {
    if (!subtitleEnabled || subtitleCues.length === 0) return;
    let raf;
    const loop = () => {
      const v = videoRef.current;
      if (v) {
        const t = v.currentTime;
        // Binary search for the last cue whose start <= t (cues are sorted)
        let lo = 0;
        let hi = subtitleCues.length - 1;
        let best = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (subtitleCues[mid].start <= t) {
            best = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        const cue = best >= 0 && t < subtitleCues[best].end ? subtitleCues[best] : null;
        const text = cue ? cue.text : '';
        if (text !== activeSubtitleRef.current) {
          activeSubtitleRef.current = text;
          setSubtitleText(text);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [subtitleEnabled, subtitleCues]);

  return {
    subtitleText,
    subtitleCues,
    subtitleEnabled,
    setSubtitleEnabled,
    subtitleName,
    subUrlInput,
    setSubUrlInput,
    subtitleFileRef,
    mkvTracks,
    mkvLoading,
    mkvError,
    loadSubtitleText,
    loadSubtitleCues,
    loadSubtitleUrl,
    handleSubtitleFile,
    resetSubtitles,
    downloadSubtitle,
    extractMkvFromUrl,
    extractMkvFromFile,
  };
}