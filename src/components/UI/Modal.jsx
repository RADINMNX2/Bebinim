import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export const Modal = ({ isOpen, onClose, title, children }) => {
  const closeBtnRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    closeBtnRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/85 animate-fade-in" onClick={onClose}></div>

      {/* Modal Card */}
      <div
        className="relative w-full max-w-lg bg-zinc-950 border border-red-500/20 rounded-3xl shadow-2xl shadow-red-900/40 animate-slide-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Ambient Glow */}
        <div className="absolute -top-20 -left-20 w-60 h-60 bg-red-600/10 rounded-full blur-[80px] pointer-events-none"></div>
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-red-600 via-orange-600 to-red-600"></div>

        <div className="relative z-10 p-6">
          <div className="flex items-center justify-between pb-4 mb-4 border-b border-white/5">
            <h3 className="text-xl font-bold text-white tracking-wide font-persian">{title}</h3>
            <button
              ref={closeBtnRef}
              onClick={onClose}
              aria-label="بستن"
              className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-red-500/10 hover:border-red-500/40 border border-transparent transition-all active:scale-90"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto chat-scroll -mx-1 px-1">{children}</div>
        </div>
      </div>
    </div>
  );
};