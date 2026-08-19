import { useEffect, useRef, useState } from 'react';
import { MkvStreamPlayer } from '../../utils/mkvStream';
import { IS_IOS, isMkvLike, safePlay } from './constants';

// iOS-only Matroska streaming engine (Safari has no MKV demux, but supports
// MediaSource since iOS 17.1). Owns the engine lifecycle, its overlay state
// and the retry flow so Room.jsx stays free of the details.
//
// NOTE: `IS_IOS` is a module-level constant (computed once) — the old inline
// `useMemo` version was never imported into Room.jsx, which crashed on iOS
// detection; hoisting it here fixes that latent ReferenceError.
export function useMkvEngine({ videoUrl, videoRef, setDuration, setIsPlaying, setVideoError }) {
  const useMkvEngine = isMkvLike(videoUrl) && IS_IOS && typeof MediaSource !== 'undefined';
  const mkvEngineRef = useRef(null);
  const [enginePhase, setEnginePhase] = useState(null);
  const [engineRetry, setEngineRetry] = useState(0);
  const [codecError, setCodecError] = useState(false);
  const [engineErrorMsg, setEngineErrorMsg] = useState(null);

  useEffect(() => {
    if (!useMkvEngine) return;
    const v = videoRef.current;
    if (!v) return;
    let disposed = false;
    const engine = new MkvStreamPlayer({
      url: videoUrl,
      video: v,
      onReady: ({ duration }) => {
        if (disposed) return;
        if (duration > 0) setDuration(duration);
        setCodecError(false);
      },
      onError: (code, msg) => {
        if (disposed) return;
        setCodecError(true);
        setIsPlaying(false);
        setEngineErrorMsg(msg || null);
      },
      onStatus: (phase) => { if (!disposed) setEnginePhase(phase); },
    });
    mkvEngineRef.current = engine;
    engine.start();
    return () => {
      disposed = true;
      engine.destroy();
      mkvEngineRef.current = null;
    };
  }, [useMkvEngine, videoUrl, engineRetry]);

  const retryVideo = () => {
    setVideoError('');
    if (mkvEngineRef.current) {
      mkvEngineRef.current.destroy();
      mkvEngineRef.current = null;
      setCodecError(false);
      setEngineErrorMsg(null);
      setEngineRetry((r) => r + 1);
      return;
    }
    const v = videoRef.current;
    if (v) {
      v.load();
      safePlay(v).catch(() => {});
    }
  };

  return {
    useMkvEngine,
    mkvEngineRef,
    enginePhase,
    setEnginePhase,
    codecError,
    setCodecError,
    engineErrorMsg,
    setEngineErrorMsg,
    retryVideo,
  };
}