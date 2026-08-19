import { useEffect, useRef } from 'react';
import {
  Film, Loader2, Subtitles, Type, Minus, Plus, Palette, SlidersHorizontal,
  Check, Send, Link as LinkIcon, Shield, ShieldOff, UserX
} from 'lucide-react';
import { Modal } from '../UI/Modal';
import { AnimatedInput } from '../UI/AnimatedInput';
import { Select } from '../UI/Select';
import { BUFFER_SECONDS, SUBTITLE_FONTS, ACTIVE_SIGNALING, ACTIVE_TURN } from './constants';

// ---------------------------------------------------------------------------
// All in-wrapper / in-page modals of the Room. Each is a pure presentational
// component: all state lives in Room.jsx and flows in through props.
// ---------------------------------------------------------------------------

// Change Video Modal (URL + Subtitles)
export function ChangeVideoModal({
  isOpen, onClose,
  customUrlInput, onCustomUrlChange, onCustomUrlSubmit,
  subUrlInput, onSubUrlChange, onLoadSubtitleUrl,
  subtitleFileRef, onSubtitleFile, subtitleName,
  mkvTracks, mkvLoading, mkvError,
  onExtractFromUrl, onExtractFromFile, onLoadMkvTrack,
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="تغییر ویدیو و زیرنویس">
      <div className="space-y-4">
        <p className="text-sm text-gray-300 font-persian">لینک مستقیم ویدیو را وارد کنید (MP4/WebM/MKV):</p>

        <form onSubmit={onCustomUrlSubmit} className="space-y-3">
          <label className="block text-xs text-gray-400">لینک مستقیم (URL):</label>
          <div className="flex gap-2">
            <AnimatedInput
              type="url"
              value={customUrlInput}
              onChange={(e) => onCustomUrlChange(e.target.value)}
              placeholder="https://.../movie.mp4"
              dir="ltr"
              autoFocus
              fieldClassName="py-2 px-5 text-xs"
              wrapperClassName="flex-1"
            />
            <button type="submit" className="btn-primary py-2 px-4 text-xs whitespace-nowrap shrink-0">
              پخش
            </button>
          </div>
          <p className="text-[10px] text-gray-500">
            پس از تایید، برای هماهنگی همهٔ کاربران {BUFFER_SECONDS} ثانیه صبر می‌شود و سپس پخش شروع می‌شود.
          </p>
        </form>

        <div className="pt-3 border-t border-white/10 space-y-3">
          <label className="block text-xs text-gray-400">زیرنویس (SRT / WebVTT):</label>
          <div className="flex gap-2">
            <AnimatedInput
              type="url"
              value={subUrlInput}
              onChange={(e) => onSubUrlChange(e.target.value)}
              placeholder="https://.../movie.srt"
              dir="ltr"
              fieldClassName="py-2 px-5 text-xs"
              wrapperClassName="flex-1"
            />
            <button
              onClick={() => {
                if (!subUrlInput.trim()) return;
                onLoadSubtitleUrl(subUrlInput.trim());
                onSubUrlChange('');
              }}
              className="btn-secondary py-2 px-4 text-xs whitespace-nowrap shrink-0"
            >
              بارگذاری
            </button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="btn-secondary flex-1 py-2 text-xs gap-1.5 cursor-pointer">
              <Subtitles className="w-3.5 h-3.5 text-red-400" />
              آپلود فایل زیرنویس
              <input
                ref={subtitleFileRef}
                type="file"
                accept=".srt,.vtt,.ass,.ssa,.txt"
                className="hidden"
                onChange={(e) => {
                  onSubtitleFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
            {subtitleName && (
              <span className="text-[9px] text-emerald-400 truncate font-mono" dir="ltr">
                ✓ {subtitleName}
              </span>
            )}
          </div>

          <div className="pt-1 space-y-2">
            <button
              onClick={onExtractFromUrl}
              disabled={mkvLoading}
              className="btn-secondary w-full text-xs gap-1.5 disabled:opacity-50"
            >
              {mkvLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Film className="w-3.5 h-3.5 text-red-400" />}
              استخراج زیرنویس داخلی (MKV)
            </button>
            {mkvError && <p className="text-[10px] text-red-400">{mkvError}</p>}
            {mkvTracks.length > 0 && (
              <div className="space-y-1.5">
                {mkvTracks.map((t) => (
                  <div key={t.trackNumber} className="flex items-center justify-between gap-2 glass-card p-2 rounded-lg">
                    <span className="text-[10px] text-gray-300 truncate" dir="ltr">
                      #{t.trackNumber} · {t.type}{t.language ? ` · ${t.language}` : ''}{t.name ? ` · ${t.name}` : ''}
                    </span>
                    <button
                      onClick={() => onLoadMkvTrack(t.cues, `${t.language || 'sub'} (MKV #${t.trackNumber})`)}
                      className="btn-primary py-1 px-2 text-[10px] shrink-0"
                    >
                      بارگذاری
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="pt-1">
            <label className="btn-secondary w-full text-xs gap-1.5 cursor-pointer">
              <Subtitles className="w-3.5 h-3.5 text-red-400" />
              استخراج از فایل MKV (آپلود — بدون محدودیت CORS)
              <input
                type="file"
                accept=".mkv,.mks"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) onExtractFromFile(file);
                }}
              />
            </label>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Subtitle Settings Modal
export function SubtitleSettingsModal({
  isOpen, onClose, settings, onChange, subtitleEnabled, onToggleSubtitle, onReset,
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="تنظیمات زیرنویس"
    >
      <div className="space-y-5">
        {/* Enable/Disable toggle */}
        <div className="flex items-center justify-between p-3 glass-card rounded-xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-600/20 border border-red-500/30 flex items-center justify-center">
              <Subtitles className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h4 className="font-bold text-white">زیرنویس</h4>
              <p className="text-[10px] text-gray-400">فعال/غیرفعال کردن نمایش زیرنویس</p>
            </div>
          </div>
          <button
            onClick={onToggleSubtitle}
            aria-label="فعال/غیرفعال کردن زیرنویس"
            className={`relative w-12 h-7 rounded-full transition-all ${subtitleEnabled ? 'bg-red-500' : 'bg-gray-600'}`}
            role="switch"
            aria-checked={subtitleEnabled}
          >
            <span
              className={`absolute top-0.5 bottom-0.5 w-6 rounded-full bg-white transition-transform shadow-lg ${subtitleEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}
            />
          </button>
        </div>

        <div className="border-t border-white/5 pt-2 space-y-4">
          {/* Font Size */}
          <div className="glass-card p-4 rounded-xl">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Type className="w-5 h-5 text-red-400" />
                <span className="font-medium text-white">اندازه فونت</span>
              </div>
              <span className="text-sm font-mono text-red-400 bg-red-500/10 px-2 py-0.5 rounded">
                {settings.fontSize}px
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => onChange((s) => ({ ...s, fontSize: Math.max(12, s.fontSize - 2) }))}
                aria-label="کاهش اندازه فونت"
                className="p-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
              >
                <Minus className="w-5 h-5" />
              </button>
              <input
                type="range"
                min="12"
                max="48"
                step="2"
                value={settings.fontSize}
                onChange={(e) => onChange((s) => ({ ...s, fontSize: Number(e.target.value) }))}
                aria-label="اندازه فونت زیرنویس"
                dir="ltr"
                className="flex-1 neon-range"
              />
              <button
                onClick={() => onChange((s) => ({ ...s, fontSize: Math.min(48, s.fontSize + 2) }))}
                aria-label="افزایش اندازه فونت"
                className="p-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
              >
                <Plus className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Subtitle Font */}
          <div className="glass-card p-4 rounded-xl">
            <div className="flex items-center gap-2 mb-3">
              <Type className="w-5 h-5 text-purple-400" />
              <span className="font-medium text-white">فونت زیرنویس</span>
            </div>
            <Select
              value={settings.fontFamily}
              onChange={(v) => onChange((s) => ({ ...s, fontFamily: v }))}
              options={SUBTITLE_FONTS}
              label="فونت"
            />
          </div>

          {/* Font Color */}
          <div className="glass-card p-4 rounded-xl">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Palette className="w-5 h-5 text-red-400" />
                <span className="font-medium text-white">رنگ فونت</span>
              </div>
              <input
                type="color"
                value={settings.fontColor}
                onChange={(e) => onChange((s) => ({ ...s, fontColor: e.target.value }))}
                aria-label="رنگ فونت زیرنویس"
                className="w-10 h-10 rounded-lg border border-white/10 cursor-pointer"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {['#ffffff', '#ffeb3b', '#00e676', '#ff1744', '#2979ff', '#ff9100'].map((color) => (
                <button
                  key={color}
                  onClick={() => onChange((s) => ({ ...s, fontColor: color }))}
                  aria-label={`رنگ ${color}`}
                  className={`w-8 h-8 rounded-lg border-2 transition-all ${settings.fontColor === color ? 'border-red-400 scale-110' : 'border-white/10 hover:border-red-500/50'}`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>

          {/* Background Color */}
          <div className="glass-card p-4 rounded-xl">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded bg-gradient-to-r from-red-500 to-orange-500" />
                <span className="font-medium text-white">پس‌زمینه</span>
              </div>
              <input
                type="color"
                value={settings.backgroundColor === 'transparent' ? '#000000' : settings.backgroundColor}
                onChange={(e) => onChange((s) => ({ ...s, backgroundColor: e.target.value }))}
                aria-label="رنگ پس‌زمینه زیرنویس"
                className="w-10 h-10 rounded-lg border border-white/10 cursor-pointer"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {['#000000', '#1c1c24', '#8b0000', 'transparent'].map((bg) => (
                <button
                  key={bg}
                  onClick={() => onChange((s) => ({ ...s, backgroundColor: bg }))}
                  aria-label={`پس‌زمینه ${bg === 'transparent' ? 'شفاف' : bg}`}
                  className={`w-20 h-10 rounded-lg border-2 flex items-center justify-center text-[10px] font-mono transition-all ${settings.backgroundColor === bg ? 'border-red-400 scale-110' : 'border-white/10 hover:border-red-500/50'}`}
                  style={{ backgroundColor: bg }}
                >
                  {bg === 'transparent' ? 'بدون' : ''}
                </button>
              ))}
            </div>
          </div>

          {/* Background Blur */}
          <div className="glass-card p-4 rounded-xl">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-5 h-5 text-red-400" />
                <span className="font-medium text-white">بلور پس‌زمینه</span>
              </div>
              <span className="text-sm font-mono text-red-400 bg-red-500/10 px-2 py-0.5 rounded">
                {settings.backgroundBlur}px
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="20"
              step="1"
              value={settings.backgroundBlur}
              onChange={(e) => onChange((s) => ({ ...s, backgroundBlur: Number(e.target.value) }))}
              aria-label="میزان بلور پس‌زمینه"
              dir="ltr"
              className="neon-range"
            />
          </div>

          {/* Vertical Position */}
          <div className="glass-card p-4 rounded-xl">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded border-2 border-red-400 relative">
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-red-400 rounded-full" />
                </div>
                <span className="font-medium text-white">موقعیت عمودی</span>
              </div>
              <span className="text-sm font-mono text-red-400 bg-red-500/10 px-2 py-0.5 rounded">
                {settings.verticalOffset}px از پایین
              </span>
            </div>
            <input
              type="range"
              min="8"
              max="200"
              step="4"
              value={settings.verticalOffset}
              onChange={(e) => onChange((s) => ({ ...s, verticalOffset: Number(e.target.value) }))}
              aria-label="موقعیت عمودی زیرنویس"
              dir="ltr"
              className="neon-range"
            />
            <div className="flex justify-between text-[10px] text-gray-500 mt-1">
              <span>بالا (8px)</span>
              <span>پایین (200px)</span>
            </div>
          </div>

          {/* Text Shadow Toggle */}
          <div className="flex items-center justify-between p-3 glass-card rounded-xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center">
                <Type className="w-5 h-5 text-purple-400" />
              </div>
              <div>
                <h4 className="font-bold text-white">سایه متن</h4>
                <p className="text-[10px] text-gray-400">افزودن سایه برای خوانایی بهتر</p>
              </div>
            </div>
            <button
              onClick={() => onChange((s) => ({ ...s, textShadow: !s.textShadow }))}
              aria-label="فعال/غیرفعال کردن سایه متن"
              className={`relative w-12 h-7 rounded-full transition-all ${settings.textShadow ? 'bg-purple-500' : 'bg-gray-600'}`}
              role="switch"
              aria-checked={settings.textShadow}
            >
              <span
                className={`absolute top-0.5 bottom-0.5 w-6 rounded-full bg-white transition-transform shadow-lg ${settings.textShadow ? 'translate-x-5' : 'translate-x-0.5'}`}
              />
            </button>
          </div>

          {/* Reset Button */}
          <button
            onClick={onReset}
            className="w-full btn-secondary text-sm gap-2"
          >
            <SlidersHorizontal className="w-4 h-4" />
            بازنشانی به پیش‌فرض
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Chat Modal (fullscreen) — owns its scroll ref + auto-scroll effect
export function ChatModal({ isOpen, onClose, messages, chatInput, onChatInputChange, onSendMessage }) {
  const chatModalScrollRef = useRef(null);

  // Keep the chat modal scrolled to the latest message
  useEffect(() => {
    if (isOpen && chatModalScrollRef.current) {
      chatModalScrollRef.current.scrollTop = chatModalScrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="چت اتاق"
    >
      <div className="space-y-4">
        <div
          ref={chatModalScrollRef}
          className="flex-1 min-h-0 max-h-[60vh] overflow-y-auto space-y-2 p-1 chat-scroll"
        >
          {messages.length === 0 ? (
            <p className="text-center text-[10px] text-gray-500 py-8">هنوز پیامی ارسال نشده است</p>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className="glass-card p-3 rounded-xl border-l-2 border-l-red-500/40 animate-fade-in">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-red-400 text-xs">{msg.sender}</span>
                  <span className="text-[9px] text-gray-500">{msg.time}</span>
                </div>
                <p className="text-gray-200 text-sm break-words">{msg.text}</p>
              </div>
            ))
          )}
        </div>
        <form onSubmit={onSendMessage} className="flex items-center gap-2 shrink-0">
          <AnimatedInput
            value={chatInput}
            onChange={(e) => onChatInputChange(e.target.value)}
            placeholder="پیام خود را بنویسید..."
            autoFocus
            fieldClassName="py-2 px-5 text-sm"
            wrapperClassName="flex-1"
          />
          <button type="submit" aria-label="ارسال پیام" className="btn-primary p-2.5 rounded-xl shrink-0">
            <Send className="w-5 h-5" />
          </button>
        </form>
      </div>
    </Modal>
  );
}

// Share Room Modal
export function ShareModal({ isOpen, onClose, roomId, isCopied, onCopy, xirsysTurnActive, netStats }) {
  const signalingHost = ACTIVE_SIGNALING.includes('://')
    ? new URL(ACTIVE_SIGNALING).host
    : ACTIVE_SIGNALING;

  const iceTypeLabel = netStats?.iceType === 'relay'
    ? 'رله (TURN)'
    : netStats?.iceType === 'srflx'
      ? 'مستقیم (P2P)'
      : netStats?.iceType === 'host'
        ? 'مستقیم (LAN)'
        : '—';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="دعوت دوستان به اتاق">
      <div className="space-y-4">
        <p className="text-sm text-gray-300 font-persian">
          برای تماشای همزمان فیلم با دوستانتان، لینک زیر یا کد اتاق را برای آن‌ها ارسال کنید:
        </p>

        <div className="p-3.5 rounded-2xl bg-black/60 border border-red-500/20 flex items-center justify-between gap-2">
          <span className="font-mono text-xs md:text-sm text-red-300 truncate max-w-[300px]" dir="ltr">{window.location.href}</span>
          <button
            onClick={onCopy}
            className="btn-primary py-1.5 px-3 text-xs gap-1.5 shrink-0"
          >
            {isCopied ? <Check className="w-4 h-4" /> : <LinkIcon className="w-4 h-4" />}
            <span>{isCopied ? 'کپی شد!' : 'کپی لینک'}</span>
          </button>
        </div>

        <div className="text-center pt-2">
          <span className="text-xs text-gray-500 font-mono">کد یکتای اتاق: <strong className="text-red-400">{roomId}</strong></span>
        </div>

        <div className="rounded-xl bg-black/40 border border-white/5 p-3 space-y-1.5 text-[11px] font-mono text-gray-400" dir="ltr">
          <div className="flex items-center justify-between">
            <span>signaling</span>
            <span className="text-emerald-400">{signalingHost}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>turn relay</span>
            <span className={ACTIVE_TURN || xirsysTurnActive ? 'text-emerald-400' : 'text-gray-500'}>
              {ACTIVE_TURN
                ? ACTIVE_TURN.split(':')[1] + ':' + ACTIVE_TURN.split(':')[2]
                : xirsysTurnActive
                  ? 'xirsys (خودکار)'
                  : 'خاموش (فقط P2P)'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>rtt (تاخیر)</span>
            <span className={netStats?.rtt != null ? 'text-emerald-400' : 'text-gray-500'}>
              {netStats?.rtt != null ? `${netStats.rtt}ms` : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>clock offset (اختلاف ساعت)</span>
            <span className={netStats?.offsetMs != null ? 'text-emerald-400' : 'text-gray-500'}>
              {netStats?.offsetMs != null ? `${netStats.offsetMs}ms` : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>مسیر اتصال</span>
            <span className={netStats?.iceType ? 'text-emerald-400' : 'text-gray-500'}>
              {iceTypeLabel}
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Manage User Modal
export function ManageUserModal({ isOpen, onClose, user, isHost, canManage, onToggleAdmin, onKick }) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={user ? `مدیریت کاربر: ${user.name}` : 'مدیریت کاربر'}
    >
      {user && (
        <div className="space-y-4">
          <div className="glass-card p-4 rounded-2xl flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-red-600/20 border border-red-500/30 flex items-center justify-center font-bold text-red-300">
              {user.name.charAt(0)}
            </div>
            <div>
              <h4 className="font-bold text-sm text-white">{user.name}</h4>
              <p className="text-[10px] text-gray-400">
                {user.isHost ? 'میزبان اتاق' : user.isAdmin ? 'ادمین' : 'عضو اتاق'}
              </p>
            </div>
          </div>

          {isHost && !user.isHost && (
            <button
              onClick={() => onToggleAdmin(user.id, !user.isAdmin)}
              className={`btn-secondary w-full text-sm gap-2 ${user.isAdmin ? 'hover:border-red-500/70 hover:text-red-400' : ''}`}
            >
              {user.isAdmin
                ? <><ShieldOff className="w-4 h-4 text-red-400" /> گرفتن دسترسی ادمین</>
                : <><Shield className="w-4 h-4 text-red-400" /> ارتقا به ادمین</>}
            </button>
          )}

          {(isHost || (canManage && !user.isAdmin && !user.isHost)) && (
            <button
              onClick={() => onKick(user.id)}
              className="btn-secondary w-full text-sm gap-2 hover:border-red-500/70 hover:text-red-400 hover:bg-red-500/10"
            >
              <UserX className="w-4 h-4 text-red-400" />
              حذف از اتاق (Kick)
            </button>
          )}

          {!canManage && (
            <p className="text-xs text-gray-500 text-center">فقط میزبان/ادمین می‌تواند دسترسی‌ها را تغییر دهد</p>
          )}
        </div>
      )}
    </Modal>
  );
}