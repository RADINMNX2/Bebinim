import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { CheckCircle2, AlertCircle, Info, XCircle, X } from 'lucide-react';

const ToastContext = createContext(null);

const MAX_TOASTS = 4;

const toastAccent = {
  success: {
    border: 'border-r-emerald-500',
    bar: 'from-emerald-500 to-emerald-400',
    text: 'text-emerald-400',
    icon: <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-400" />,
  },
  error: {
    border: 'border-r-red-500',
    bar: 'from-red-600 to-red-400',
    text: 'text-red-400',
    icon: <XCircle className="w-5 h-5 flex-shrink-0 text-red-400" />,
  },
  warning: {
    border: 'border-r-amber-500',
    bar: 'from-amber-500 to-amber-400',
    text: 'text-amber-400',
    icon: <AlertCircle className="w-5 h-5 flex-shrink-0 text-amber-400" />,
  },
  info: {
    border: 'border-r-red-500',
    bar: 'from-red-600 to-rose-400',
    text: 'text-red-400',
    icon: <Info className="w-5 h-5 flex-shrink-0 text-red-400" />,
  },
};

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const addToast = useCallback((message, type = 'info', duration = 4000) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => {
      const next = [...prev, { id, message, type, duration }];
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    });
    const timer = setTimeout(() => removeToast(id), duration);
    timersRef.current.set(id, timer);
  }, [removeToast]);

  // Clear all pending timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div
        aria-live="polite"
        className="fixed bottom-4 left-4 z-[60] flex flex-col gap-3 max-w-sm w-full pointer-events-none"
      >
        {toasts.map((toast) => {
          const accent = toastAccent[toast.type] || toastAccent.info;
          return (
            <div
              key={toast.id}
              className={`pointer-events-auto relative overflow-hidden flex items-center justify-between gap-3 px-4 py-3 rounded-xl shadow-2xl bg-zinc-950 border border-white/10 animate-slide-up border-r-4 ${accent.border}`}
              role="status"
            >
              {/* Top gradient bar */}
              <div className={`absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r ${accent.bar} opacity-60`}></div>
              {/* Countdown bar */}
              <div
                className={`absolute bottom-0 left-0 h-[2px] bg-gradient-to-r ${accent.bar} toast-progress`}
                style={{ animationDuration: `${toast.duration}ms` }}
              ></div>
              <div className="flex items-center gap-3">
                {accent.icon}
                <span className="text-sm font-medium text-gray-200 font-persian">{toast.message}</span>
              </div>
              <button
                onClick={() => removeToast(toast.id)}
                aria-label="بستن اعلان"
                className="text-gray-400 hover:text-white transition-colors p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);