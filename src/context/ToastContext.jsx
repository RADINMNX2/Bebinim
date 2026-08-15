import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertCircle, Info, XCircle, X } from 'lucide-react';

const ToastContext = createContext(null);

const toastAccent = {
  success: {
    border: 'border-r-emerald-500',
    text: 'text-emerald-400',
    icon: <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-400" />,
  },
  error: {
    border: 'border-r-red-500',
    text: 'text-red-400',
    icon: <XCircle className="w-5 h-5 flex-shrink-0 text-red-400" />,
  },
  warning: {
    border: 'border-r-amber-500',
    text: 'text-amber-400',
    icon: <AlertCircle className="w-5 h-5 flex-shrink-0 text-amber-400" />,
  },
  info: {
    border: 'border-r-red-500',
    text: 'text-red-400',
    icon: <Info className="w-5 h-5 flex-shrink-0 text-red-400" />,
  },
};

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info', duration = 4000) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed bottom-6 left-6 z-50 flex flex-col gap-3 max-w-sm w-full pointer-events-none">
        {toasts.map((toast) => {
          const accent = toastAccent[toast.type] || toastAccent.info;
          return (
            <div
              key={toast.id}
              className={`pointer-events-auto relative overflow-hidden flex items-center justify-between gap-3 px-4 py-3 rounded-xl shadow-2xl bg-zinc-950 border border-white/10 animate-slide-up border-r-4 ${accent.border}`}
            >
              {/* Top gradient bar */}
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-red-600/60 via-transparent to-red-600/60"></div>
              <div className="flex items-center gap-3">
                {accent.icon}
                <span className="text-sm font-medium text-gray-200 font-persian">{toast.message}</span>
              </div>
              <button
                onClick={() => removeToast(toast.id)}
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
