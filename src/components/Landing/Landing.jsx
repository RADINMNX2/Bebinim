import React, { useState } from 'react';
import { Film, Users, Plus, ArrowRight, Sparkles, Tv, ShieldCheck, Zap, Link as LinkIcon, LogIn } from 'lucide-react';
import { useToast } from '../../context/ToastContext';

export const Landing = ({ onJoinRoom, inviteRoomId }) => {
  const [name, setName] = useState('');
  const [roomIdInput, setRoomIdInput] = useState('');
  const [mode, setMode] = useState(inviteRoomId ? 'invite' : 'menu'); // 'menu' | 'create' | 'join' | 'invite'
  const { addToast } = useToast();

  const handleCreate = (e) => {
    e.preventDefault();
    if (!name.trim()) {
      addToast('لطفاً نام خود را وارد کنید', 'warning');
      return;
    }
    const generatedId = Math.random().toString(36).substring(2, 8);
    onJoinRoom(generatedId, name.trim(), true);
    addToast('روم با موفقیت ساخته شد!', 'success');
  };

  const handleJoin = (e) => {
    e.preventDefault();
    if (!name.trim()) {
      addToast('لطفاً نام خود را وارد کنید', 'warning');
      return;
    }
    if (!roomIdInput.trim()) {
      addToast('لطفاً کد روم را وارد کنید', 'warning');
      return;
    }
    onJoinRoom(roomIdInput.trim(), name.trim(), false);
    addToast('در حال اتصال به روم...', 'info');
  };

  const handleInviteJoin = (e) => {
    e.preventDefault();
    if (!name.trim()) {
      addToast('لطفاً نام خود را وارد کنید', 'warning');
      return;
    }
    onJoinRoom(inviteRoomId, name.trim(), false);
    addToast('در حال اتصال به روم دعوت...', 'info');
  };

  return (
    <div className="h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden bg-black">
      {/* Decorative background glow elements */}
      <div className="absolute top-1/4 -right-20 w-96 h-96 bg-red-600/15 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute bottom-1/4 -left-20 w-96 h-96 bg-rose-600/20 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none"></div>

      <div className="max-w-xl w-full mx-auto relative z-10 animate-fade-in">
        {/* Logo & Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-zinc-950 border border-red-500/30 shadow-[0_0_35px_rgba(239,68,68,0.35)] mb-4 animate-float">
            <Film className="w-10 h-10 text-red-500" />
          </div>
          <h1 className="text-4xl md:text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-red-500 via-rose-500 to-red-400 tracking-tight mb-3 neon-text">
            ببینیم (Bebinim)
          </h1>
          <p className="text-gray-400 text-sm md:text-base max-w-md mx-auto font-persian">
            تماشای آنلاین و همگام‌سازی شده فیلم با دوستان به صورت P2P و کاملاً رایگان، بدون نیاز به سرور مرکزی!
          </p>
        </div>

        {/* Card Container */}
        <div className="bg-zinc-950/90 border border-white/10 rounded-3xl p-6 md:p-8 shadow-2xl shadow-black/80 backdrop-blur-xl relative overflow-hidden">
          {/* Ambient glow */}
          <div className="absolute -top-20 -right-20 w-60 h-60 bg-red-600/10 rounded-full blur-[80px] pointer-events-none"></div>

          <div className="relative z-10">
          {mode === 'invite' && (
            <form onSubmit={handleInviteJoin} className="space-y-6 animate-fade-in">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-white flex items-center gap-2 font-persian">
                  <LogIn className="w-5 h-5 text-red-500" />
                  ورود به روم دعوت
                </h3>
                <button
                  type="button"
                  onClick={() => setMode('menu')}
                  className="text-sm text-gray-400 hover:text-red-400 transition-colors font-persian"
                >
                  بازگشت
                </button>
              </div>

              <div className="p-4 rounded-2xl bg-red-950/30 border border-red-500/20 text-sm text-red-200 font-persian flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <LinkIcon className="w-4 h-4 text-red-400 flex-shrink-0" />
                  <span>شما از طریق لینک دعوت وارد شدید. فقط نام خود را بنویسید و مستقیم وارد اتاق شوید.</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">کد روم:</span>
                  <span className="font-mono font-bold text-red-300 tracking-widest" dir="ltr">{inviteRoomId}</span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2 font-persian">نام شما در روم</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="مثال: سارا..."
                  className="input-field"
                  maxLength={25}
                />
              </div>

              <button type="submit" className="btn-primary w-full py-3.5 justify-center">
                <span>ورود مستقیم به اتاق</span>
                <ArrowRight className="w-5 h-5 rotate-180" />
              </button>
            </form>
          )}

          {mode === 'menu' && (
            <div className="space-y-6 animate-fade-in">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2 font-persian">نام شما در روم</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="مثال: کوروش..."
                  className="input-field"
                  maxLength={25}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                <button
                  onClick={() => {
                    if (!name.trim()) {
                      addToast('لطفاً ابتدا نام خود را وارد کنید', 'warning');
                      return;
                    }
                    setMode('create');
                  }}
                  className="btn-primary py-4 flex flex-col items-center gap-2 text-center"
                >
                  <Plus className="w-6 h-6" />
                  <span className="font-bold text-base">ساخت روم جدید</span>
                  <span className="text-xs font-normal text-red-100 opacity-90">ایجاد اتاق و دعوت دوستان</span>
                </button>

                <button
                  onClick={() => {
                    if (!name.trim()) {
                      addToast('لطفاً ابتدا نام خود را وارد کنید', 'warning');
                      return;
                    }
                    setMode('join');
                  }}
                  className="btn-secondary py-4 flex flex-col items-center gap-2 text-center"
                >
                  <Users className="w-6 h-6 text-red-400" />
                  <span className="font-bold text-base">پیوستن به روم</span>
                  <span className="text-xs font-normal text-gray-400">ورود با کد دعوت دوستان</span>
                </button>
              </div>

              {/* Features pills */}
              <div className="grid grid-cols-3 gap-3 pt-4 border-t border-white/10 text-center">
                <div className="p-3 rounded-2xl glass-card flex flex-col items-center gap-1">
                  <Tv className="w-5 h-5 text-red-500" />
                  <span className="text-xs text-gray-300 font-medium">سینک لحظه‌ای</span>
                </div>
                <div className="p-3 rounded-2xl glass-card flex flex-col items-center gap-1">
                  <ShieldCheck className="w-5 h-5 text-red-500" />
                  <span className="text-xs text-gray-300 font-medium">امن و P2P</span>
                </div>
                <div className="p-3 rounded-2xl glass-card flex flex-col items-center gap-1">
                  <Zap className="w-5 h-5 text-red-500" />
                  <span className="text-xs text-gray-300 font-medium">چت و ایموجی</span>
                </div>
              </div>
            </div>
          )}

          {mode === 'create' && (
            <form onSubmit={handleCreate} className="space-y-6 animate-fade-in">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-white flex items-center gap-2 font-persian">
                  <Sparkles className="w-5 h-5 text-red-500" />
                  ساخت اتاق جدید
                </h3>
                <button
                  type="button"
                  onClick={() => setMode('menu')}
                  className="text-sm text-gray-400 hover:text-red-400 transition-colors font-persian"
                >
                  بازگشت
                </button>
              </div>

              <div className="p-4 rounded-2xl bg-red-950/30 border border-red-500/20 text-sm text-red-200 font-persian">
                سلام <span className="font-bold text-white">{name}</span> عزیز! با ساخت اتاق، شما میزبان (Host) خواهید بود و می‌توانید لینک ویدیو را با دوستانتان به اشتراک بگذارید.
              </div>

              <button type="submit" className="btn-primary w-full py-3.5 justify-center">
                <span>ساخت و ورود به اتاق</span>
                <ArrowRight className="w-5 h-5 rotate-180" />
              </button>
            </form>
          )}

          {mode === 'join' && (
            <form onSubmit={handleJoin} className="space-y-6 animate-fade-in">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-white flex items-center gap-2 font-persian">
                  <Users className="w-5 h-5 text-red-400" />
                  پیوستن به اتاق دوستان
                </h3>
                <button
                  type="button"
                  onClick={() => setMode('menu')}
                  className="text-sm text-gray-400 hover:text-red-400 transition-colors font-persian"
                >
                  بازگشت
                </button>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2 font-persian">کد روم (Room ID)</label>
                <input
                  type="text"
                  value={roomIdInput}
                  onChange={(e) => setRoomIdInput(e.target.value)}
                  placeholder="کد ۶ رقمی دریافتی از دوستتان..."
                  className="input-field uppercase tracking-widest font-mono"
                  maxLength={12}
                />
              </div>

              <button type="submit" className="btn-primary w-full py-3.5 justify-center">
                <span>ورود به اتاق</span>
                <ArrowRight className="w-5 h-5 rotate-180" />
              </button>
            </form>
          )}
          </div>
        </div>

        {/* Footer info */}
        <div className="text-center mt-6 text-xs text-gray-500 font-persian">
          طراحی شده با عشق • پشتیبانی از قابلیت‌های مدرن WebRTC P2P
          <br />
          ساخته شده توسط <span className="text-red-500 font-bold">RADINMNX</span>
        </div>
      </div>
    </div>
  );
};
