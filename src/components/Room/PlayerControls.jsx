import React, { useState, useEffect } from 'react';
import {
  Rewind, FastForward, Pause, Play, Loader2, VolumeX, Volume2,
  Subtitles, Languages, Download, PictureInPicture, Minimize, Maximize
} from 'lucide-react';
import { SKIP_SECONDS, SPEEDS, fmtPlayerTime } from './constants';

// ==================== Player controls bar ====================
// Renders the transport controls + progress bar. `currentTime`/`buffered`
// live here (fed directly by the <video> element) so the huge Room tree is
// NOT re-rendered on every `timeupdate`/`progress` event (4-5 Hz).
const PlayerControls = React.memo(function PlayerControls({
  duration, disabled, isPlaying, isMuted, volume, speed, speedMenuOpen,
  controlsDir, subtitleEnabled, subtitleAvailable, isFullscreen, videoRef,
  videoUrl,
  onSeek, onSeekRelease, onTogglePlay, onSkip, onToggleMute, onVolumeChange,
  onSelectSpeed, onSpeedMenuToggle, onSubtitleSettings, onToggleDir,
  onTogglePip, onToggleFullscreen,
}) {
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered, setBuffered] = useState(0);

  // The <video> element mounts lazily (only once a URL exists) and is
  // swapped on video changes — so re-attach on every videoUrl change,
  // otherwise the listeners attach to nothing and the time stays at 0.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onProgress = () => {
      if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1));
    };
    const onSeeked = () => setCurrentTime(v.currentTime);
    const onMeta = () => { setCurrentTime(0); setBuffered(0); };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('progress', onProgress);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('loadedmetadata', onMeta);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('progress', onProgress);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('loadedmetadata', onMeta);
    };
  }, [videoRef, videoUrl]);

  const handleChange = (e) => {
    const t = parseFloat(e.target.value);
    if (!Number.isFinite(t)) return;
    setCurrentTime(t);
    onSeek(t);
  };

  return (
    <div className="flex flex-col gap-2.5 md:gap-3 pointer-events-auto" dir={controlsDir}>
      {/* Progress bar with buffered indicator */}
      <div className="relative w-full">
        <div
          className="absolute top-1/2 -translate-y-1/2 left-0 h-1 rounded-full bg-white/15 pointer-events-none"
          style={{ width: `${duration ? Math.min(100, (buffered / duration) * 100) : 0}%` }}
        ></div>
        <input
          type="range"
          min={0}
          max={duration || 100}
          value={currentTime}
          onChange={handleChange}
          onPointerUp={onSeekRelease}
          onKeyUp={(e) => { if (e.key.startsWith('Arrow')) onSeekRelease(e); }}
          disabled={disabled}
          aria-label="نوار پیشرفت ویدیو"
          dir="ltr"
          className="neon-range w-full"
          style={{ '--fill': `${duration ? Math.min(100, (currentTime / duration) * 100) : 0}%` }}
        />
      </div>

      <div className="flex items-center justify-between gap-2 text-[10px] md:text-xs text-gray-300 flex-wrap">
        {/* Transport controls: RTL/LTR aware */}
        <div className="flex items-center gap-1.5 md:gap-2">
          {controlsDir === 'rtl' ? (
            <>
              <button onClick={() => onSkip(-SKIP_SECONDS)} title="عقب ۱۰ ثانیه" aria-label="عقب ۱۰ ثانیه" className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10">
                <Rewind className="w-4 h-4 md:w-5 md:h-5" />
              </button>
              <button onClick={onTogglePlay} disabled={disabled} aria-label={isPlaying ? 'توقف' : 'پخش'} className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10">
                {disabled ? <Loader2 className="w-4 h-4 md:w-5 md:h-5 animate-spin" /> : (isPlaying ? <Pause className="w-4 h-4 md:w-5 md:h-5" /> : <Play className="w-4 h-4 md:w-5 md:h-5" />)}
              </button>
              <button onClick={() => onSkip(SKIP_SECONDS)} title="جلو ۱۰ ثانیه" aria-label="جلو ۱۰ ثانیه" className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10">
                <FastForward className="w-4 h-4 md:w-5 md:h-5" />
              </button>
            </>
          ) : (
            <>
              <button onClick={() => onSkip(SKIP_SECONDS)} title="Forward 10s" aria-label="Forward 10s" className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10">
                <FastForward className="w-4 h-4 md:w-5 md:h-5" />
              </button>
              <button onClick={onTogglePlay} disabled={disabled} aria-label={isPlaying ? 'Pause' : 'Play'} className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10">
                {disabled ? <Loader2 className="w-4 h-4 md:w-5 md:h-5 animate-spin" /> : (isPlaying ? <Pause className="w-4 h-4 md:w-5 md:h-5" /> : <Play className="w-4 h-4 md:w-5 md:h-5" />)}
              </button>
              <button onClick={() => onSkip(-SKIP_SECONDS)} title="Back 10s" aria-label="Back 10s" className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10">
                <Rewind className="w-4 h-4 md:w-5 md:h-5" />
              </button>
            </>
          )}

          <div className="flex items-center gap-1.5 md:gap-2">
            <button
              onClick={onToggleMute}
              aria-label={isMuted ? 'فعال کردن صدا' : 'بی‌صدا کردن'}
              className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10"
            >
              {isMuted ? <VolumeX className="w-4 h-4 md:w-5 md:h-5 text-red-400" /> : <Volume2 className="w-4 h-4 md:w-5 md:h-5" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
              aria-label="میزان صدا"
              dir="ltr"
              className="neon-range w-14 md:w-20 hidden md:block"
            />
          </div>

          {/* Speed menu */}
          <div className="relative" data-speed-menu>
            <button
              onClick={onSpeedMenuToggle}
              aria-label="سرعت پخش"
              aria-expanded={speedMenuOpen}
              className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10 font-mono"
              title="سرعت پخش"
            >
              {speed}x
            </button>
            {speedMenuOpen && (
              <div className="absolute bottom-8 right-0 z-40 bg-zinc-950 border border-red-500/30 rounded-xl p-1.5 space-y-0.5 shadow-2xl">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    onClick={() => onSelectSpeed(s)}
                    className={`block w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors ${s === speed ? 'bg-red-500/20 text-red-400' : 'hover:bg-white/5 text-gray-300'}`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Subtitle settings modal */}
          <button
            onClick={onSubtitleSettings}
            disabled={!subtitleAvailable}
            aria-label="تنظیمات زیرنویس"
            title="تنظیمات زیرنویس (C)"
            className={`p-1.5 transition-colors rounded-lg hover:bg-red-500/10 disabled:opacity-30 ${subtitleEnabled && subtitleAvailable ? 'text-red-400' : 'hover:text-red-400'}`}
          >
            <Subtitles className="w-4 h-4 md:w-5 md:h-5" />
          </button>

          {/* RTL / LTR toggle */}
          <button
            onClick={onToggleDir}
            aria-label="تغییر جهت دکمه‌ها"
            title="تغییر جهت دکمه‌ها (RTL/LTR)"
            className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10"
          >
            <Languages className="w-4 h-4 md:w-5 md:h-5" />
          </button>
        </div>

        <div className="flex items-center gap-1.5 md:gap-3">
          <span dir="ltr" className="tabular-nums whitespace-nowrap">
            {fmtPlayerTime(currentTime)} / {fmtPlayerTime(duration)}
          </span>
          {videoUrl && (
            <a
              href={videoUrl}
              download
              target="_blank"
              rel="noopener noreferrer"
              aria-label="دانلود ویدیو"
              title="دانلود ویدیو (MKV در iOS با پلیر سیستم باز میشود)"
              className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10"
            >
              <Download className="w-4 h-4 md:w-5 md:h-5" />
            </a>
          )}
          <button
            onClick={onTogglePip}
            aria-label="تصویر در تصویر"
            title="تصویر در تصویر"
            className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10"
          >
            <PictureInPicture className="w-4 h-4 md:w-5 md:h-5" />
          </button>
          <button
            onClick={onToggleFullscreen}
            aria-label={isFullscreen ? 'خروج از تمام صفحه' : 'تمام صفحه'}
            className="p-1.5 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10 flex items-center gap-1"
          >
            {isFullscreen ? <Minimize className="w-4 h-4 md:w-5 md:h-5" /> : <Maximize className="w-4 h-4 md:w-5 md:h-5" />}
            <span className="hidden md:inline">{isFullscreen ? 'خروج' : 'تمام صفحه'}</span>
          </button>
        </div>
      </div>
    </div>
  );
});

export default PlayerControls;