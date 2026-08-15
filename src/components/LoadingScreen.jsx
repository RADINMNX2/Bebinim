import React, { useEffect, useState } from 'react';
import { Film } from 'lucide-react';

export const LoadingScreen = ({ onComplete }) => {
  const [progress, setProgress] = useState(0);
  const [isFading, setIsFading] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setTimeout(() => {
            setIsFading(true);
            setTimeout(onComplete, 800);
          }, 800);
          return 100;
        }
        return prev + 1;
      });
    }, 30);

    return () => clearInterval(interval);
  }, [onComplete]);

  return (
    <div
      className={`fixed inset-0 z-[9999] bg-black flex items-center justify-center transition-all duration-1000 ${
        isFading ? 'opacity-0 scale-110 pointer-events-none' : 'opacity-100 scale-100'
      }`}
    >
      {/* Background Ambience */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-red-900/10 via-black to-black opacity-80"></div>

      <div className="relative z-10 flex flex-col items-center gap-12">
        {/* --- LIQUID LOADER --- */}
        <div className="relative w-48 h-48 rounded-full border-4 border-red-500/30 shadow-[0_0_40px_rgba(239,68,68,0.4)] bg-black overflow-hidden group">
          {/* The Liquid Container */}
          <div
            className="absolute left-0 w-full bg-red-600 shadow-[0_0_50px_#ef4444] transition-all duration-100 ease-linear"
            style={{
              bottom: 0,
              height: `${progress}%`,
            }}
          >
            {/* The Wave Surface Animation */}
            <div
              className="absolute -top-3 left-[-50%] w-[200%] h-6 bg-red-600 rounded-[40%] animate-wave opacity-80"
              style={{ transformOrigin: '50% 50%' }}
            ></div>
            <div
              className="absolute -top-3 left-[-50%] w-[200%] h-6 bg-red-300/30 rounded-[35%] animate-wave opacity-60"
              style={{ animationDuration: '7s', transformOrigin: '50% 50%' }}
            ></div>
          </div>

          {/* Inner Content (Percentage) */}
          <div className="absolute inset-0 flex flex-col items-center justify-center z-20 mix-blend-difference">
            <span className="text-5xl font-black text-white font-mono tracking-tighter">
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
      </div>
    </div>
  );
};

export default LoadingScreen;
