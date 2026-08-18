import React, { useEffect, useRef, useState } from 'react';
import { Film } from 'lucide-react';

const LOADER_MS = 2600;
const FADE_MS = 500;

export const LoadingScreen = ({ onComplete }) => {
  const [progress, setProgress] = useState(0);
  const [isFading, setIsFading] = useState(false);
  const doneRef = useRef(false);
  // Stable ref so a re-created `onComplete` identity can never restart the
  // loader animation mid-flight.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      const t = setTimeout(() => onCompleteRef.current(), 60);
      return () => clearTimeout(t);
    }

    let raf;
    const fadeTimer = { current: null };
    const doneTimer = { current: null };
    const start = performance.now();

    const tick = (now) => {
      const t = Math.min(1, (now - start) / LOADER_MS);
      const eased = 1 - Math.pow(1 - t, 2.5);
      setProgress(Math.round(eased * 100));
      if (t < 1) {
        raf = requestAnimationFrame(tick);
        return;
      }
      setProgress(100);
      fadeTimer.current = setTimeout(() => setIsFading(true), 200);
      doneTimer.current = setTimeout(() => {
        if (!doneRef.current) {
          doneRef.current = true;
          onCompleteRef.current();
        }
      }, 200 + FADE_MS);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fadeTimer.current);
      clearTimeout(doneTimer.current);
    };
  }, []);

  const skip = () => {
    if (!doneRef.current) {
      doneRef.current = true;
      onCompleteRef.current();
    }
  };

  return (
    <div
      className={`fixed inset-0 z-[9999] bg-black flex items-center justify-center transition-all duration-500 ${
        isFading ? 'opacity-0 scale-110 pointer-events-none' : 'opacity-100 scale-100'
      }`}
    >
      {/* Background Ambience */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-red-900/10 via-black to-black opacity-80"></div>
      <div className="absolute top-1/4 -right-24 w-96 h-96 bg-red-600/10 rounded-full blur-3xl pointer-events-none animate-pulse-slow"></div>
      <div className="absolute bottom-1/4 -left-24 w-96 h-96 bg-rose-600/10 rounded-full blur-3xl pointer-events-none animate-pulse-slow"></div>

      <div className="relative z-10 flex flex-col items-center gap-10">
        {/* --- LIQUID LOADER --- */}
        <div className="relative w-44 h-44 md:w-48 md:h-48 rounded-full border-4 border-red-500/30 shadow-[0_0_40px_rgba(239,68,68,0.4)] bg-black overflow-hidden">
          {/* The Liquid Container */}
          <div
            className="absolute left-0 w-full bg-red-600 shadow-[0_0_50px_#ef4444]"
            style={{
              bottom: 0,
              height: `${progress}%`,
              transition: 'height 120ms linear',
            }}
          >
            {/* The Wave Surface Animation */}
            <div className="absolute -top-3 left-[-50%] w-[200%] h-6 bg-red-600 rounded-[40%] animate-wave opacity-80 gpu-layer"></div>
            <div
              className="absolute -top-3 left-[-50%] w-[200%] h-6 bg-red-300/30 rounded-[35%] animate-wave opacity-60 gpu-layer"
              style={{ animationDuration: '7s' }}
            ></div>
          </div>

          {/* Inner Content (Percentage) */}
          <div className="absolute inset-0 flex flex-col items-center justify-center z-20 mix-blend-difference">
            <span className="text-5xl font-black text-white font-mono tracking-tighter tabular-nums">
              {progress}%
            </span>
          </div>

          {/* Glass Reflection */}
          <div className="absolute inset-0 rounded-full border border-white/10 pointer-events-none">
            <div className="absolute top-4 left-1/2 -translate-x-1/2 w-20 h-4 bg-white/10 rounded-full blur-sm"></div>
          </div>
        </div>

        {/* Text Branding */}
        <div className="text-center space-y-3">
          <div className="flex items-center justify-center gap-3">
            <Film size={28} className="text-red-500 neon-text" />
            <h1 className="text-2xl font-bold text-white tracking-[0.2em]">
              ببینیم<span className="text-red-500 animate-pulse">...</span>
            </h1>
          </div>
          <p className="text-[10px] font-mono text-red-500/70 tracking-[0.5em] uppercase">
            Initializing P2P Engine
          </p>
        </div>

        <button
          onClick={skip}
          className="text-xs text-gray-500 hover:text-red-400 transition-colors font-persian underline underline-offset-4"
        >
          ورود به ببینیم
        </button>
      </div>
    </div>
  );
};

export default LoadingScreen;