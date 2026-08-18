import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export const Modal = ({ isOpen, onClose, title, children }) => {
  const closeBtnRef = useRef(null);
  const panelRef = useRef(null);
  const overlayRef = useRef(null);
  const backdropRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const lastFocusedRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    // Remember what had focus so we can restore it on close (focus restore)
    lastFocusedRef.current = document.activeElement;

    // Lock body scroll while the modal is open
    const root = document.body;
    const prevOverflow = root.style.overflow;
    root.style.overflow = 'hidden';

    const onKey = (e) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      // Focus trap: keep Tab / Shift+Tab inside the dialog
      const focusables = panel.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);

    // Don't steal focus from an autoFocus input (children mount first)
    const hasAutoFocus = panelRef.current?.querySelector('[autofocus]');
    if (!hasAutoFocus) closeBtnRef.current?.focus();

    return () => {
      window.removeEventListener('keydown', onKey);
      root.style.overflow = prevOverflow;
      lastFocusedRef.current?.focus?.();
    };
  }, [isOpen]);

  // Wheel/touch over the backdrop must not scroll the page behind the modal
  // (the room grid behind us has its own overflow-y-auto).
  useEffect(() => {
    if (!isOpen) return;
    const prevent = (e) => {
      if (e.target === backdropRef.current || e.target === overlayRef.current) {
        e.preventDefault();
      }
    };
    const opts = { passive: false };
    const overlay = overlayRef.current;
    overlay?.addEventListener('wheel', prevent, opts);
    overlay?.addEventListener('touchmove', prevent, opts);
    return () => {
      overlay?.removeEventListener('wheel', prevent);
      overlay?.removeEventListener('touchmove', prevent);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Backdrop */}
      <div ref={backdropRef} className="absolute inset-0 bg-black/85 animate-fade-in" onClick={onClose}></div>

      {/* Modal Card */}
      <div
        ref={panelRef}
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