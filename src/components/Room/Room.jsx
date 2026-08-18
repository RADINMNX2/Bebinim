import React, { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react';
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize, Share2, Users, MessageSquare,
  Send, Link as LinkIcon, Film, LogOut, Check, Radio, Wifi, RefreshCw,
  Crown, Shield, ShieldOff, UserX, Settings, Loader2, Rewind, FastForward,
  Subtitles, PictureInPicture, Languages, X, SlidersHorizontal, Palette, Type, Minus, Plus, WifiOff
} from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { Modal } from '../UI/Modal';
import { extractMkvSubtitles, cuesToSrt } from '../../utils/mkvSubtitles';

// Default free STUN servers to maximize NAT traversal success inside Iran
const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.services.mozilla.com' },
  { urls: 'stun:stun.1und1.de:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

// --- Xirsys TURN (free tier) ---
const XIRSYS = {
  ident: 'RADINMNX',
  secret: '25a5cd9e-98ec-11f1-8480-cafcf9cf945e',
  channel: 'mnx-bebinim'
};
const XIRSYS_TTL_MS = 30 * 60 * 1000;
let xirsysCache = null;

const fetchXirsysTurn = async () => {
  if (xirsysCache && Date.now() - xirsysCache.fetchedAt < XIRSYS_TTL_MS) {
    return xirsysCache.servers;
  }
  try {
    const auth = btoa(`${XIRSYS.ident}:${XIRSYS.secret}`);
    const res = await fetch(`https://global.xirsys.net/_turn/${XIRSYS.channel}?webrtc=1&expire=21600`, {
      method: 'PUT',
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.s !== 'ok' || !data?.v?.iceServers?.length) return null;
    xirsysCache = { servers: data.v.iceServers, fetchedAt: Date.now() };
    return data.v.iceServers;
  } catch (_) {
    return null;
  }
};

const getUrlParams = () => new URLSearchParams(window.location.search);

// Robust TURN URL parser: accepts `turn:user:pass@host`, `turn:user:pass@host:3478`,
// `turns://user:pass@host:5349`, etc. (the old split(':') logic mangled these).
const parseTurnParam = (raw) => {
  if (!raw) return null;
  const s = raw.includes('://') ? raw.replace('://', ':') : raw;
  const m = /^turns?:([^:@/]+):([^@]+)@([^:/]+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  const [, username, credential, host, port] = m;
  const secure = /^turns:/i.test(s);
  return {
    urls: `${secure ? 'turns:' : 'turn:'}${host}${port ? `:${port}` : ''}`,
    username,
    credential,
  };
};

const buildPeerConfig = () => {
  const iceServers = [...DEFAULT_STUN_SERVERS];

  const turn = parseTurnParam(getUrlParams().get('turn'));
  if (turn) iceServers.push(turn);

  const config = {
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    config: { iceServers },
    debug: 0
  };

  const sigParam = getUrlParams().get('sig');
  if (sigParam) {
    try {
      const u = new URL(sigParam.includes('://') ? sigParam : `ws://${sigParam}`);
      config.host = u.hostname;
      config.port = u.port ? Number(u.port) : (u.protocol === 'wss:' ? 443 : 9000);
      config.secure = u.protocol === 'wss:';
    } catch (_) {
      // malformed sig -> fall back to PeerJS Cloud
    }
  }
  return config;
};

const PEER_CONFIG = buildPeerConfig();
const ACTIVE_SIGNALING = getUrlParams().get('sig') || '0.peerjs.com';
const ACTIVE_TURN = getUrlParams().get('turn') || null;

// ==================== Sync tuning (world-class smooth sync) ====================
// 1. Host is the media reference clock; it broadcasts full state every 2s
//    (tightens to ~900ms while drift is being reported) with a monotonic
//    sequence number so stale packets are dropped.
// 2. Guests measure the host clock offset with NTP-style PING/PONG (EWMA
//    smoothing, bad-RTT samples discarded) and extrapolate the host position
//    at receipt: est = sentTime + (now - sentAt + clockOffset).
// 3. Small drift is smoothed with a moving average and corrected via subtle
//    playbackRate nudges (no seeking, no visual jumps). Only drift >=
//    HARD_DRIFT_THRESHOLD triggers a precise seek. Play/pause always align.
// 4. Video changes force a 10s pre-buffer on EVERY client, gated on a shared
//    absolute deadline (readyAt). Playback waits for canplay (never stalls).
const SYNC_INTERVAL_MS = 2000;
const SYNC_FAST_INTERVAL_MS = 900;
const PING_INTERVAL_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const MAX_RECONNECT_ATTEMPTS = 6;
const RECONNECT_BASE_MS = 1000;
const MAX_HOST_ID_RETRIES = 5;
const HOST_ID_RETRY_DELAY_MS = 3000;
const HARD_DRIFT_THRESHOLD = 1.0;
const RATE_CORRECTION_GAIN = 0.12;
const RATE_CORRECTION_LIMIT = 0.08;
const DRIFT_SMA_WINDOW = 5;
const FAST_AFTER_EVENT_MS = 5000;
const DRIFT_REPORT_MIN_RTT = 120; // hard seeks are only safe once the clock is measured
const BUFFER_SECONDS = 10;
const MAX_CONNECT_RETRIES = 3;
const RETRY_DELAY_MS = 2500;
const CHAT_WINDOW = 60;
const SKIP_SECONDS = 10;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const ACTION_LABELS = {
  toggle: 'پخش / توقف',
  seek: 'پرش به زمان',
  fullscreen: 'تمام صفحه'
};

// --- SRT / WebVTT parser (modern subtitles: SRT + VTT) ---
const parseSubtitles = (text) => {
  const cues = [];
  // Optional hours, optional trailing WebVTT cue settings
  const timeRe = /^(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{1,3})/;
  const frac = (v) => v.padEnd(3, '0');
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const idx = lines.findIndex((l) => timeRe.test(l.trim()));
    if (idx === -1) continue;
    const m = timeRe.exec(lines[idx].trim());
    const start = +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +frac(m[4]) / 1000;
    const end = +(m[5] || 0) * 3600 + +m[6] * 60 + +m[7] + +frac(m[8]) / 1000;
    const textLines = lines
      .filter((_, i) => i !== idx)
      .map((l) => l.replace(/<[^>]+>/g, '').trim());
    while (textLines.length && /^\d+$/.test(textLines[0])) textLines.shift(); // SRT index line
    const cueText = textLines.join('\n').trim();
    if (cueText && start < end) cues.push({ start, end, text: cueText });
  }
  return cues.sort((a, b) => a.start - b.start);
};

const hexToRgba = (hex, alpha) => {
  let h = String(hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

const fmtTime = (sec) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  return `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, '0')}`;
};

// ==================== Player controls bar ====================
// Renders the transport controls + progress bar. `currentTime`/`buffered`
// live here (fed directly by the <video> element) so the ~2500-line Room
// tree is NOT re-rendered on every `timeupdate`/`progress` event (4-5 Hz).
const PlayerControls = React.memo(function PlayerControls({
  duration, disabled, isPlaying, isMuted, volume, speed, speedMenuOpen,
  controlsDir, subtitleEnabled, subtitleAvailable, isFullscreen, videoRef,
  onSeek, onSeekRelease, onTogglePlay, onSkip, onToggleMute, onVolumeChange,
  onSelectSpeed, onSpeedMenuToggle, onSubtitleSettings, onToggleDir,
  onTogglePip, onToggleFullscreen,
}) {
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered, setBuffered] = useState(0);

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
  }, [videoRef]);

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
          <span className="tabular-nums whitespace-nowrap">
            {Math.floor(currentTime / 60)}:{Math.floor(currentTime % 60).toString().padStart(2, '0')} / {Math.floor(duration / 60)}:{Math.floor(duration % 60).toString().padStart(2, '0')}
          </span>
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

export const Room = ({ roomId, userName, isHost, onLeave }) => {
  const [connections, setConnections] = useState([]);
  const [participants, setParticipants] = useState([{ id: 'self', name: userName, isHost, isAdmin: false }]);
  const [messages, setMessages] = useState([]);
  const [chatWindow, setChatWindow] = useState(CHAT_WINDOW);
  const [chatInput, setChatInput] = useState('');
  const [unreadChat, setUnreadChat] = useState(0);

  // Video state
  const [videoUrl, setVideoUrl] = useState('');
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferCountdown, setBufferCountdown] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [codecError, setCodecError] = useState(false);
  const [videoError, setVideoError] = useState('');
  const [speed, setSpeed] = useState(1);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);

  // Subtitles
  const [subtitleText, setSubtitleText] = useState('');
  const [subtitleCues, setSubtitleCues] = useState([]);
  const [subtitleEnabled, setSubtitleEnabled] = useState(false);
  const [subtitleName, setSubtitleName] = useState('');
  const [subUrlInput, setSubUrlInput] = useState('');
  const subtitleFileRef = useRef(null);
  const subtitleSourceRef = useRef('');
  const [mkvTracks, setMkvTracks] = useState([]);
  const [mkvLoading, setMkvLoading] = useState(false);
  const [mkvError, setMkvError] = useState('');

  // Subtitle settings
  const [subtitleSettings, setSubtitleSettings] = useState({
    fontSize: 20,
    fontColor: '#ffffff',
    backgroundColor: '#000000',
    backgroundBlur: 4,
    verticalOffset: 24, // bottom offset in px
    fontFamily: 'inherit',
    textShadow: true,
  });
  const [subtitleModalOpen, setSubtitleModalOpen] = useState(false);
  const [chatModalOpen, setChatModalOpen] = useState(false);

  // Controls direction (RTL / LTR)
  const [controlsDir, setControlsDir] = useState('rtl');

  // Auto-hide controls + in-player chat (fullscreen)
  const [controlsVisible, setControlsVisible] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);

  // Role / management state
  const [selfIsAdmin, setSelfIsAdmin] = useState(false);
  const [manageModalOpen, setManageModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);

  // Control approval system (non-admins request host/admin approval)
  const [pendingRequest, setPendingRequest] = useState(null);
  const [requestModalOpen, setRequestModalOpen] = useState(false);

  // UI states
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' | 'users'
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [reactions, setReactions] = useState([]);
  const [isCopied, setIsCopied] = useState(false);
  const [xirsysTurnActive, setXirsysTurnActive] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [netStats, setNetStats] = useState(null); // { rtt, offsetMs, iceType } live P2P diagnostics

  const videoRef = useRef(null);
  const playerWrapRef = useRef(null);
  const peerRef = useRef(null);
  const connectionsRef = useRef([]);
  const participantsRef = useRef(participants);
  const isSyncingRef = useRef(false);
  const pendingSeekRef = useRef(null);
  const lastCorrectionRef = useRef(0);
  const videoUrlRef = useRef(videoUrl);
  const broadcastRef = useRef(null);
  const chatScrollRef = useRef(null);
  const chatAtBottomRef = useRef(true);
  const pendingChatShiftRef = useRef(null);
  const activeSubtitleRef = useRef('');
  const userSpeedRef = useRef(1);
  const sendingReqRef = useRef(false);
  const lastRequestRef = useRef(null);
  const lastDriftReportRef = useRef(0);
  const hideTimerRef = useRef(null);
  const pendingPlayRef = useRef(null);
  const inPlayerChatScrollRef = useRef(null);
  const chatModalScrollRef = useRef(null);
  const isFullscreenRef = useRef(false);
  isFullscreenRef.current = isFullscreen;
  const chatOpenRef = useRef(false);
  chatOpenRef.current = chatOpen;
  const chatModalOpenRef = useRef(false);
  chatModalOpenRef.current = chatModalOpen;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = requestModalOpen || isUrlModalOpen || isShareModalOpen || manageModalOpen || subtitleModalOpen || chatModalOpen;

  // Sync internals (upgraded engine)
  const clockOffsetRef = useRef(0);
  const offsetInitRef = useRef(false);
  const bestRttRef = useRef(Infinity);
  const seqRef = useRef(0);
  const lastSeqRef = useRef(-1);
  const readyAtRef = useRef(0);
  const pendingAutoPlayRef = useRef(false);
  const desiredPlayingRef = useRef(true);
  const bufferTimerRef = useRef(null);
  const leavingRef = useRef(false);
  const kickedRef = useRef(false);
  const fastUntilRef = useRef(0);
  const driftSmaRef = useRef([]);
  const pendingRequestRef = useRef(null);
  const heartbeatTimersRef = useRef(new Map());
  const lastSeenRef = useRef(new Map());
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const netStatsTimerRef = useRef(null);

  // Fresh refs for role checks inside event handlers
  const selfIsAdminRef = useRef(false);
  const isHostRef = useRef(isHost);
  selfIsAdminRef.current = selfIsAdmin;
  isHostRef.current = isHost;
  participantsRef.current = participants;

  const canControl = isHost || selfIsAdmin;
  const canControlRef = useRef(canControl);
  canControlRef.current = canControl;
  const canManage = canControl;
  const canManageRef = useRef(canManage);
  canManageRef.current = canManage;

  const { addToast } = useToast();

  useEffect(() => { videoUrlRef.current = videoUrl; }, [videoUrl]);

  // --- Auto-hide controls after inactivity (kept visible while paused) ---
  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (!videoRef.current?.paused && !chatModalOpenRef.current) {
        setControlsVisible(false);
      }
    }, 3000);
  }, []);
  useEffect(() => () => clearTimeout(hideTimerRef.current), []);

  // Broadcast to all connected peers (uses ref so closures never go stale)
  const broadcast = (data, excludePeerId = null) => {
    connectionsRef.current.forEach((conn) => {
      if (conn.open && conn.peer !== excludePeerId) {
        try { conn.send(data); } catch (_) {}
      }
    });
  };
  broadcastRef.current = broadcast;

  const hostPeerId = `bebinim-host-${roomId}`;

  // Single source of truth for the host's media state (sync loop, join,
  // REQUEST_STATE, manual re-sync and tab-return all use it).
  const hostStateMessage = () => ({
    type: 'SYNC',
    url: videoUrlRef.current,
    time: videoRef.current ? videoRef.current.currentTime : 0,
    playing: videoRef.current ? !videoRef.current.paused : false,
    sentAt: Date.now(),
    seq: (seqRef.current += 1),
    duration: videoRef.current?.duration || 0
  });

  // --- Heartbeat: kill zombie data channels that silently died ---
  const startHeartbeat = (conn) => {
    stopHeartbeat(conn.peer);
    const timer = setInterval(() => {
      if (conn.open) {
        try { conn.send({ type: 'HEARTBEAT', t: Date.now() }); } catch (_) {}
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimersRef.current.set(conn.peer, timer);
  };
  const stopHeartbeat = (peerId) => {
    const timer = heartbeatTimersRef.current.get(peerId);
    if (timer) {
      clearInterval(timer);
      heartbeatTimersRef.current.delete(peerId);
    }
  };

  // --- Reconnect engine: a dropped host link no longer bounces the guest ---
  const startReconnect = () => {
    if (isHostRef.current || leavingRef.current || peerRef.current?.destroyed) return;
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      addToast('اتصال به میزبان قطع شد و برقرار نشد. شما به صفحه اصلی بازگردانده شدید', 'error');
      leavingRef.current = true;
      setTimeout(onLeave, 700);
      return;
    }
    const attempt = reconnectAttemptsRef.current + 1;
    reconnectAttemptsRef.current = attempt;
    setReconnecting(true);
    addToast(`اتصال قطع شد؛ تلاش برای اتصال مجدد (${attempt}/${MAX_RECONNECT_ATTEMPTS})...`, 'info');
    const delay = Math.min(12000, RECONNECT_BASE_MS * 2 ** (attempt - 1));
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      if (leavingRef.current || !peerRef.current) return;
      try {
        const retry = peerRef.current.connect(hostPeerId, { reliable: true, serialization: 'json' });
        setupConnection(retry, 1);
      } catch (_) {
        startReconnect();
      }
    }, delay);
  };

  // --- Network back: instantly try to reattach if we lost the host ---
  useEffect(() => {
    const onOnline = () => {
      if (leavingRef.current || isHostRef.current) return;
      const alive = connectionsRef.current.some((c) => c.open);
      if (!alive) startReconnect();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Zombie-channel monitor ---
  useEffect(() => {
    const monitor = setInterval(() => {
      const now = Date.now();
      connectionsRef.current.forEach((c) => {
        const lastSeen = lastSeenRef.current.get(c.peer) || now;
        if (c.open && now - lastSeen > HEARTBEAT_TIMEOUT_MS) {
          try { c.close(); } catch (_) {}
        }
      });
    }, HEARTBEAT_TIMEOUT_MS / 3);
    return () => clearInterval(monitor);
  }, []);

  // --- Tab return: re-align immediately (background throttling drifts us) ---
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || leavingRef.current) return;
      if (isHostRef.current) {
        if (videoRef.current && connectionsRef.current.length > 0) {
          broadcastRef.current(hostStateMessage());
        }
      } else {
        connectionsRef.current.forEach((c) => {
          if (c.open) { try { c.send({ type: 'REQUEST_STATE' }); } catch (_) {} }
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Notify the room before the tab actually dies ---
  useEffect(() => {
    const onBeforeUnload = () => {
      broadcastRef.current({ type: 'LEAVE', name: userName });
      try { peerRef.current?.destroy(); } catch (_) {}
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userName]);

  // --- Live P2P diagnostics (RTT + ICE candidate type via getStats) ---
  useEffect(() => {
    const sample = async () => {
      const conn = connectionsRef.current[0];
      const pc = conn?.peerConnection;
      if (!pc?.getStats) return;
      try {
        const stats = await pc.getStats();
        let rtt = null;
        let iceType = null;
        for (const s of stats.values()) {
          if (s.type === 'candidate-pair' && s.state === 'succeeded') {
            if (s.currentRoundTripTime != null) rtt = Math.round(s.currentRoundTripTime * 1000);
            const local = stats.get(s.localCandidateId);
            if (local?.candidateType) iceType = local.candidateType;
            break;
          }
        }
        setNetStats((prev) => ({
          rtt: rtt ?? prev?.rtt ?? null,
          iceType: iceType || prev?.iceType || null,
          offsetMs: prev?.offsetMs ?? null
        }));
      } catch (_) {
        // stats unavailable — badge simply stays hidden
      }
    };
    netStatsTimerRef.current = setInterval(sample, 10000);
    return () => clearInterval(netStatsTimerRef.current);
  }, []);

  // --- Host periodic sync loop (adaptive interval) ---
  useEffect(() => {
    if (!isHost) return;
    let timer = null;
    const tick = () => {
      let fast = false;
      try {
        fast = Date.now() < fastUntilRef.current;
        if (videoRef.current && connectionsRef.current.length > 0) {
          try {
            broadcastRef.current(hostStateMessage());
          } catch (_) {
            // a dying connection must never kill the sync loop
          }
        }
      } finally {
        // Always reschedule — an unexpected error must not desync the room
        timer = setTimeout(tick, fast ? SYNC_FAST_INTERVAL_MS : SYNC_INTERVAL_MS);
      }
    };
    timer = setTimeout(tick, SYNC_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [isHost]);

  // --- Guest clock-offset measurement (NTP-style, EWMA of low-RTT samples) ---
  useEffect(() => {
    if (isHost) return;
    const measure = () => {
      connectionsRef.current.forEach((c) => {
        if (c.open) { try { c.send({ type: 'PING', t0: Date.now() }); } catch (_) {} }
      });
    };
    measure();
    const iv = setInterval(measure, PING_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [isHost]);

  // --- Buffering countdown / auto-play after the 10s pre-buffer ---
  const startBuffering = (deadline) => {
    readyAtRef.current = deadline;
    setIsBuffering(true);
    setBufferCountdown(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    clearInterval(bufferTimerRef.current);
    bufferTimerRef.current = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setBufferCountdown(left);
      if (Date.now() >= deadline) {
        clearInterval(bufferTimerRef.current);
        setIsBuffering(false);
        const v = videoRef.current;
        if (isHostRef.current) {
          // Only auto-play if the host actually wants playback (a paused host
          // stays paused after a video change — the PLAY/PAUSE broadcast
          // keeps everyone in agreement).
          if (v && v.readyState >= 2 && v.paused && desiredPlayingRef.current) {
            safePlay(v).then((ok) => {
              if (!ok) return;
              setIsPlaying(true);
              broadcastRef.current({ type: 'PLAY', currentTime: v.currentTime, sentAt: Date.now() });
            });
          } else {
            pendingAutoPlayRef.current = desiredPlayingRef.current;
          }
        } else if (v && v.readyState >= 2 && pendingPlayRef.current) {
          // Late-join guest: only start playback after we've actually buffered
          safePlay(v).then((ok) => {
            if (!ok) return;
            setIsPlaying(true);
            broadcastRef.current({ type: 'PLAY_ACK', t: Date.now() });
          });
          pendingPlayRef.current = false;
        }
      }
    }, 500);
  };

  // Play only when the element can actually play (never stalls on buffering).
  // Resolves `true` on success so callers don't lie about the play state.
  const safePlay = (video) => {
    if (video.readyState >= 2) {
      return video.play().then(() => true).catch(() => false);
    }
    return new Promise((resolve) => {
      let settled = false;
      const tryPlay = () => {
        video.play().then(() => { if (!settled) { settled = true; resolve(true); } })
          .catch(() => { if (!settled) { settled = true; resolve(false); } });
      };
      video.addEventListener('canplay', tryPlay, { once: true });
      video.play().catch(() => {
        // autoplay blocked / network error: don't wait forever for canplay
        if (!settled) { settled = true; resolve(false); }
      });
    });
  };

  // --- Latency-compensated sync application (upgraded) ---
  const resetSubtitles = () => {
    activeSubtitleRef.current = '';
    subtitleSourceRef.current = '';
    setSubtitleCues([]);
    setSubtitleName('');
    setSubtitleText('');
    setSubtitleEnabled(false);
    setMkvTracks([]);
    setMkvError('');
  };

  const applySync = (data) => {
    const video = videoRef.current;
    if (!video) return;

    const now = Date.now();
    if (data.seq != null) {
      if (data.seq <= lastSeqRef.current) return;
      lastSeqRef.current = data.seq;
    }

    const elapsed = (now - (data.sentAt || now) + clockOffsetRef.current) / 1000;
    let estTime = (data.time || 0) + elapsed;

    if (data.url && data.url !== videoUrlRef.current) {
      pendingSeekRef.current = Math.max(0, estTime);
      pendingPlayRef.current = !!data.playing;
      videoUrlRef.current = data.url;
      setVideoUrl(data.url);
      setDuration(0);
      setCodecError(false);
      resetSubtitles();
      startBuffering(data.readyAt || now + BUFFER_SECONDS * 1000);
      return;
    }

    if (readyAtRef.current && now < readyAtRef.current) return;

    const maxTime = data.duration || video.duration || estTime;
    estTime = Math.min(Math.max(0, estTime), maxTime);
    const drift = estTime - video.currentTime;

    // Smooth the drift with a small moving average (jitter guard)
    const sma = driftSmaRef.current;
    sma.push(drift);
    if (sma.length > DRIFT_SMA_WINDOW) sma.shift();
    const smoothDrift = sma.reduce((a, b) => a + b, 0) / sma.length;

    // Tell the host to tighten its broadcast while we are far off
    if (Math.abs(drift) > 0.5 && now - lastDriftReportRef.current > 5000) {
      lastDriftReportRef.current = now;
      connectionsRef.current.forEach((c) => c.open && c.send({ type: 'DRIFT_REPORT', drift }));
    }

    const nowPlaying = !video.paused;
    // Hard seeks are only safe once the host clock is actually measured
    // (or the RTT is tiny) — otherwise a skewed clock causes seek spam.
    const canHardCorrect = offsetInitRef.current || bestRttRef.current < DRIFT_REPORT_MIN_RTT;

    if (data.playing !== nowPlaying) {
      isSyncingRef.current = true;
      if (data.playing) {
        video.currentTime = estTime;
        safePlay(video).then((ok) => { if (ok) setIsPlaying(true); });
      } else {
        video.pause();
        if (Math.abs(smoothDrift) > 0.5 && canHardCorrect) video.currentTime = estTime;
        setIsPlaying(false);
      }
      video.playbackRate = userSpeedRef.current;
      lastCorrectionRef.current = now;
      setTimeout(() => { isSyncingRef.current = false; }, 300);
    } else if (data.playing) {
      if (Math.abs(smoothDrift) >= HARD_DRIFT_THRESHOLD && canHardCorrect) {
        isSyncingRef.current = true;
        video.currentTime = estTime;
        video.playbackRate = userSpeedRef.current;
        lastCorrectionRef.current = now;
        setTimeout(() => { isSyncingRef.current = false; }, 300);
      } else if (Math.abs(smoothDrift) > 0.05) {
        const adj = Math.max(-RATE_CORRECTION_LIMIT, Math.min(RATE_CORRECTION_LIMIT, smoothDrift * RATE_CORRECTION_GAIN));
        video.playbackRate = Math.max(0.25, Math.min(2, userSpeedRef.current * (1 + adj)));
      } else {
        video.playbackRate = userSpeedRef.current;
      }
    } else {
      if (Math.abs(smoothDrift) > 0.5 && canHardCorrect) {
        isSyncingRef.current = true;
        video.currentTime = estTime;
        lastCorrectionRef.current = now;
        setTimeout(() => { isSyncingRef.current = false; }, 300);
      }
      video.playbackRate = userSpeedRef.current;
    }
  };

  const handleKicked = () => {
    if (leavingRef.current) return; // dedupe: KICK + KICKED both reach us
    kickedRef.current = true; // never auto-reconnect after a kick
    leavingRef.current = true;
    addToast('شما توسط میزبان از اتاق حذف شدید', 'error');
    setTimeout(onLeave, 600);
  };

  // --- Control approval system (host is the arbiter, admins can vote) ---
  const resolveRequest = (req, approved) => {
    pendingRequestRef.current = null;
    setPendingRequest(null);
    setRequestModalOpen(false);
    broadcastRef.current({ type: 'CONTROL_RESULT', reqId: req.reqId, approved, action: req.action });
    if (approved) executeControl(req);
  };

  const executeControl = (req) => {
    const v = videoRef.current;
    if (!v) return;
    if (req.action === 'toggle') {
      togglePlayInternal();
    } else if (req.action === 'seek') {
      const requested = Number(req.value);
      const target = Number.isFinite(requested) ? Math.min(requested, v.duration || requested) : v.currentTime;
      if (!Number.isFinite(target)) return;
      v.currentTime = target;
      broadcastRef.current({ type: 'SEEK', currentTime: target, sentAt: Date.now() });
    }
    // 'fullscreen' is a local UX action -> the requester enters FS on approval
  };

  const approveRequest = () => {
    const req = pendingRequestRef.current;
    if (!req) return;
    if (isHost) {
      resolveRequest(req, true);
    } else {
      broadcastRef.current({ type: 'CONTROL_APPROVE', reqId: req.reqId });
      setPendingRequest(null);
      setRequestModalOpen(false);
      addToast('درخواست تایید شد', 'success');
    }
  };

  const rejectRequest = () => {
    const req = pendingRequestRef.current;
    if (!req) return;
    if (isHost) {
      resolveRequest(req, false);
    } else {
      broadcastRef.current({ type: 'CONTROL_REJECT', reqId: req.reqId });
      setPendingRequest(null);
      setRequestModalOpen(false);
      addToast('درخواست رد شد', 'info');
    }
  };

  const handlePeerData = (data, conn) => {
    // --- Authority checks: only the host / admins may steer the room ---
    const senderIsController = () => {
      if (conn.peer === hostPeerId) return true;
      const sender = participantsRef.current.find((p) => p.id === conn.peer);
      return !!sender && (sender.isHost || sender.isAdmin);
    };
    const senderIsHost = () => conn.peer === hostPeerId;

    switch (data.type) {
      case 'JOIN_ROOM':
        if (participantsRef.current.some((p) => p.id === conn.peer)) break;
        const isHostPeer = conn.peer === hostPeerId;
        setParticipants((prev) =>
          prev.some((p) => p.id === conn.peer)
            ? prev
            : [...prev, { id: conn.peer, name: data.name, isHost: isHostPeer, isAdmin: false }]
        );
        // The host introducing itself to a guest needs no fanfare
        if (isHostPeer) break;
        // Host side: newcomer learns the full roster; everyone hears about them
        addToast(`${data.name} به اتاق پیوست`, 'success');
        try { conn.send({ type: 'ROOM_STATE', participants: participantsRef.current }); } catch (_) {}
        broadcastRef.current({ type: 'PEER_JOINED', id: conn.peer, name: data.name }, conn.peer);
        break;

      case 'ROOM_STATE': {
        // Host's authoritative roster (sent right after joining / reconnect).
        // Drop our own peer entry AND the host's 'self' entry (id collision).
        const mine = peerRef.current?.id;
        const others = (data.participants || []).filter((p) => p.id !== mine && p.id !== 'self');
        setParticipants((prev) => {
          const self = prev[0];
          return self ? [self, ...others] : prev;
        });
        break;
      }

      case 'PEER_JOINED':
        setParticipants((prev) =>
          prev.some((p) => p.id === data.id)
            ? prev
            : [...prev, { id: data.id, name: data.name, isHost: false, isAdmin: false }]
        );
        if (!leavingRef.current) addToast(`${data.name} به اتاق پیوست`, 'success');
        break;

      case 'PEER_LEFT':
        setParticipants((prev) => prev.filter((p) => p.id !== data.id));
        break;

      case 'LEAVE':
        setParticipants((prev) => prev.filter((p) => p.id !== conn.peer));
        if (!leavingRef.current) addToast(`${data.name || 'کاربر'} اتاق را ترک کرد`, 'info');
        break;

      case 'HEARTBEAT':
        try { conn.send({ type: 'HEARTBEAT_ACK' }); } catch (_) {}
        break;

      case 'HEARTBEAT_ACK':
        break;

      case 'REQUEST_STATE':
        if (isHost && videoRef.current) {
          conn.send(hostStateMessage());
        }
        break;

      case 'SYNC':
        if (senderIsHost()) applySync(data);
        break;

      case 'PLAY':
        if (senderIsController()) applySync({ ...data, playing: true, time: data.currentTime });
        break;

      case 'PAUSE':
        if (senderIsController()) applySync({ ...data, playing: false, time: data.currentTime });
        break;

      case 'SEEK':
        if (senderIsController() && videoRef.current && !isSyncingRef.current) {
          const est = (data.currentTime || 0)
            + (Date.now() - (data.sentAt || Date.now()) + clockOffsetRef.current) / 1000;
          videoRef.current.currentTime = Math.min(est, videoRef.current.duration || est);
        }
        break;

      case 'CHANGE_VIDEO': {
        // Only the host / admins may switch the video for everyone.
        const sender = participantsRef.current.find((p) => p.id === conn.peer);
        if (!sender || (!sender.isHost && !sender.isAdmin)) break;
        if (data.url && data.url !== videoUrlRef.current) {
          if (isHostRef.current) desiredPlayingRef.current = data.playing !== false;
          pendingSeekRef.current = 0;
          pendingPlayRef.current = data.playing !== false;
          videoUrlRef.current = data.url;
          setVideoUrl(data.url);
          setDuration(0);
          setCodecError(false);
          resetSubtitles();
          startBuffering(data.readyAt || Date.now() + BUFFER_SECONDS * 1000);
        }
        addToast(`ویدیو در حال بارگذاری: ${data.title || 'ویدیو جدید'}`, 'info');
        break;
      }

      case 'CHAT_MESSAGE':
        setMessages((prev) =>
          [...prev, { id: data.id || `${Date.now()}-${Math.random()}`, sender: data.sender, text: data.text, time: data.time }].slice(-500)
        );
        // Auto-open the chat modal in fullscreen, else bump the unread badge
        if (isFullscreenRef.current) {
          setChatModalOpen(true);
          setUnreadChat(0);
        } else if (!chatOpenRef.current) {
          setUnreadChat((n) => n + 1);
        }
        break;

      case 'REACTION':
        triggerFloatingReaction(data.emoji);
        break;

      case 'PING':
        conn.send({ type: 'PONG', t0: data.t0, hostTime: Date.now() });
        break;

      case 'PONG': {
        const rtt = Date.now() - data.t0;
        if (rtt < bestRttRef.current) bestRttRef.current = rtt;
        if (rtt < 2000) {
          const sample = data.hostTime - (data.t0 + rtt / 2);
          clockOffsetRef.current = offsetInitRef.current
            ? clockOffsetRef.current * 0.75 + sample * 0.25
            : sample;
          offsetInitRef.current = true;
          setNetStats((prev) => ({
            ...prev,
            rtt: Math.round(rtt),
            offsetMs: Math.round(clockOffsetRef.current)
          }));
        }
        break;
      }

      case 'DRIFT_REPORT':
        // Guest is drifting -> tighten the host broadcast for a few seconds
        if (isHost) fastUntilRef.current = Date.now() + 6000;
        break;

      case 'CONTROL_REQUEST':
        if (isHost) {
          if (pendingRequestRef.current) {
            resolveRequest(pendingRequestRef.current, false);
          }
          pendingRequestRef.current = {
            reqId: data.reqId,
            requesterId: data.requesterId,
            requesterName: data.requesterName,
            action: data.action,
            value: data.value
          };
          setPendingRequest(pendingRequestRef.current);
          setRequestModalOpen(true);
          // Admins get to vote too
          connectionsRef.current.forEach((c) => {
            const part = participantsRef.current.find((p) => p.id === c.peer);
            if (part && part.isAdmin && c.open) {
              c.send({ type: 'CONTROL_REQUEST_VIEW', ...pendingRequestRef.current });
            }
          });
        }
        break;

      case 'CONTROL_REQUEST_VIEW':
        if (!isHost && canManageRef.current) {
          pendingRequestRef.current = {
            reqId: data.reqId,
            requesterId: data.requesterId,
            requesterName: data.requesterName,
            action: data.action,
            value: data.value
          };
          setPendingRequest(pendingRequestRef.current);
          setRequestModalOpen(true);
        }
        break;

      case 'CONTROL_APPROVE':
        if (isHost && pendingRequestRef.current && pendingRequestRef.current.reqId === data.reqId) {
          resolveRequest(pendingRequestRef.current, true);
        }
        break;

      case 'CONTROL_REJECT':
        if (isHost && pendingRequestRef.current && pendingRequestRef.current.reqId === data.reqId) {
          resolveRequest(pendingRequestRef.current, false);
        }
        break;

      case 'CONTROL_RESULT':
        // Only the host resolves requests
        if (!senderIsHost()) break;
        // Close any open approval modal matching this request
        if (pendingRequestRef.current && pendingRequestRef.current.reqId === data.reqId) {
          pendingRequestRef.current = null;
          setPendingRequest(null);
          setRequestModalOpen(false);
        }
        if (lastRequestRef.current === data.reqId) {
          lastRequestRef.current = null;
          if (data.approved) {
            if (data.action === 'fullscreen') {
              enterFullscreen();
            }
            addToast('درخواست شما تایید شد', 'success');
          } else {
            addToast('درخواست شما رد شد', 'error');
          }
        }
        break;

      case 'UPDATE_ROLE':
        if (!senderIsHost()) break;
        setParticipants((prev) =>
          prev.map((p) => {
            const isMe = p.id === 'self' && peerRef.current && data.targetId === peerRef.current.id;
            return p.id === data.targetId || isMe ? { ...p, isAdmin: data.isAdmin } : p;
          })
        );
        if (peerRef.current && data.targetId === peerRef.current.id) {
          setSelfIsAdmin(data.isAdmin);
        }
        break;

      case 'KICK':
        if (!senderIsController()) break;
        setParticipants((prev) => prev.filter((p) => p.id !== data.targetId));
        if (peerRef.current && data.targetId === peerRef.current.id) {
          handleKicked();
        } else if (isHostRef.current) {
          // Host enforces the kick: sever the target's data channel so the
          // removal is real even when an admin initiated it.
          const tconn = connectionsRef.current.find((c) => c.peer === data.targetId);
          if (tconn) {
            try { tconn.send({ type: 'KICKED' }); } catch (_) {}
            setTimeout(() => { try { tconn.close(); } catch (_) {} }, 200);
            connectionsRef.current = connectionsRef.current.filter((c) => c.peer !== data.targetId);
          }
        }
        break;

      case 'KICKED':
        handleKicked();
        break;

      default:
        break;
    }
  };

  // --- Initialize PeerJS (loaded on demand so the ~90 KB bundle stays lazy) ---
  useEffect(() => {
    // StrictMode double-mount + HMR leave this flag set from the previous
    // cleanup; reset it so "host left" handling keeps working.
    leavingRef.current = false;
    kickedRef.current = false;
    reconnectAttemptsRef.current = 0;
    setReconnecting(false);

    const peerId = isHost
      ? hostPeerId
      : `bebinim-guest-${roomId}-${Math.random().toString(36).substring(2, 6)}`;

    let cancelled = false;
    let hostIdAttempts = 0;

    const initPeer = async () => {
      const { default: Peer } = await import('peerjs');

      const config = {
        ...PEER_CONFIG,
        config: { ...PEER_CONFIG.config, iceServers: [...PEER_CONFIG.config.iceServers] }
      };

      if (!ACTIVE_TURN) {
        const turnServers = await fetchXirsysTurn();
        if (cancelled) return;
        if (turnServers) {
          config.config.iceServers.push(...turnServers);
          setXirsysTurnActive(true);
        }
      }

      if (cancelled) return;

      // Resume the host ID after a refresh so guests can reattach to the
      // same room (the ID may still be held by the dying socket — retried below).
      let idToClaim = peerId;
      if (isHost) {
        const saved = sessionStorage.getItem(`bebinim-host-id-${roomId}`);
        if (saved) idToClaim = saved;
        sessionStorage.setItem(`bebinim-host-id-${roomId}`, idToClaim);
      }

      const createPeer = () => {
        if (cancelled || leavingRef.current) return null;
        const p = new Peer(idToClaim, config);
        peerRef.current = p;

        p.on('open', (id) => {
          if (cancelled) return;
          if (isHost) {
            addToast(`اتاق ایجاد شد. کد اتاق: ${roomId}`, 'success');
          } else {
            addToast('در حال اتصال به میزبان...', 'info');
            connectToHost(p, hostPeerId, 1);
          }
        });

        p.on('connection', (conn) => {
          setupConnection(conn, 1);
        });

        p.on('disconnected', () => {
          // Signaling socket dropped — recover in place, keep our ID
          if (cancelled || leavingRef.current || peerRef.current !== p) return;
          try { p.reconnect(); } catch (_) {}
        });

        p.on('error', (err) => {
          if (cancelled) return;
          if (isHost && err.type === 'unavailable-id' && hostIdAttempts < MAX_HOST_ID_RETRIES) {
            // A previous socket (e.g. a reloaded tab) may still hold the ID;
            // destroy and re-claim after a short backoff.
            hostIdAttempts += 1;
            if (peerRef.current === p) peerRef.current = null;
            try { p.destroy(); } catch (_) {}
            setTimeout(() => {
              if (cancelled || leavingRef.current) return;
              addToast(`بازیابی شناسه میزبان... (${hostIdAttempts}/${MAX_HOST_ID_RETRIES})`, 'info');
              createPeer();
            }, HOST_ID_RETRY_DELAY_MS);
            return;
          }
          console.error('Peer error:', err);
          if (err.type !== 'peer-unavailable') {
            addToast(`خطای اتصال P2P: ${err.type || err.message}`, 'error');
          }
        });

        return p;
      };

      createPeer();
    };

    initPeer();

    return () => {
      cancelled = true;
      leavingRef.current = true;
      connectionsRef.current = [];
      heartbeatTimersRef.current.forEach((t) => clearInterval(t));
      heartbeatTimersRef.current.clear();
      clearTimeout(reconnectTimerRef.current);
      clearInterval(bufferTimerRef.current);
      clearInterval(netStatsTimerRef.current);
      if (peerRef.current) {
        try { peerRef.current.destroy(); } catch (_) {}
        peerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const connectToHost = (pInstance, hostId, attempt) => {
    const conn = pInstance.connect(hostId, { reliable: true, serialization: 'json' });
    setupConnection(conn, attempt);
  };

  const setupConnection = (conn, attempt = 1) => {
    let settled = false;
    lastSeenRef.current.set(conn.peer, Date.now());

    conn.on('error', (err) => {
      if (settled) {
        // Post-open failure: let the close / zombie-monitor path clean up
        try { conn.close(); } catch (_) {}
        return;
      }
      if (err.type === 'peer-unavailable' && attempt < MAX_CONNECT_RETRIES) {
        settled = true;
        addToast(`میزبان هنوز آنلاین نیست، تلاش مجدد (${attempt}/${MAX_CONNECT_RETRIES - 1})...`, 'info');
        setTimeout(() => {
          // Never touch a destroyed peer (e.g. retry timer firing after unmount)
          if (leavingRef.current || !peerRef.current) return;
          const retry = peerRef.current.connect(hostPeerId, { reliable: true, serialization: 'json' });
          setupConnection(retry, attempt + 1);
        }, RETRY_DELAY_MS);
      } else if (!settled) {
        settled = true;
        addToast(`خطای اتصال: ${err.type || err.message}`, 'error');
        // The host never came online — don't leave guests stranded forever
        if (!isHostRef.current && !kickedRef.current) {
          setTimeout(() => {
            if (!leavingRef.current) onLeave();
          }, 2500);
        }
      }
    });

    conn.on('open', () => {
      settled = true;
      reconnectAttemptsRef.current = 0;
      setReconnecting(false);
      lastSeenRef.current.set(conn.peer, Date.now());
      const exists = connectionsRef.current.some((c) => c.peer === conn.peer);
      if (!exists) {
        connectionsRef.current = [...connectionsRef.current, conn];
        setConnections((prev) => (prev.some((c) => c.peer === conn.peer) ? prev : [...prev, conn]));
      }

      try {
        conn.send({
          type: 'JOIN_ROOM',
          name: userName,
          isHost: isHostRef.current,
          isAdmin: selfIsAdminRef.current
        });
      } catch (_) {}

      if (isHost) {
        if (videoRef.current) {
          try { conn.send(hostStateMessage()); } catch (_) {}
        }
      } else {
        setTimeout(() => {
          if (conn.open) { try { conn.send({ type: 'REQUEST_STATE' }); } catch (_) {} }
        }, 300);
      }

      startHeartbeat(conn);
    });

    conn.on('data', (data) => {
      lastSeenRef.current.set(conn.peer, Date.now());
      handlePeerData(data, conn);
    });

    conn.on('close', () => {
      stopHeartbeat(conn.peer);
      lastSeenRef.current.delete(conn.peer);
      const wasListed = connectionsRef.current.some((c) => c.peer === conn.peer);
      connectionsRef.current = connectionsRef.current.filter((c) => c.peer !== conn.peer);
      setConnections((prev) => prev.filter((c) => c.peer !== conn.peer));
      setParticipants((prev) => prev.filter((p) => p.id !== conn.peer));
      if (isHostRef.current && wasListed && !leavingRef.current) {
        // Guests only ever hear the host: relay removals to the whole room
        broadcastRef.current({ type: 'PEER_LEFT', id: conn.peer });
      }
      if (!leavingRef.current) {
        if (!isHostRef.current && conn.peer === hostPeerId && !kickedRef.current) {
          // Host link dropped — attempt to reattach before giving up
          startReconnect();
        } else if (wasListed && !isHostRef.current) {
          addToast('یکی از کاربران اتاق را ترک کرد', 'info');
        }
      }
    });
  };

  // --- Video control handlers ---
  const requestControl = useCallback((action, value) => {
    if (sendingReqRef.current) return;
    if (action === 'seek' && !Number.isFinite(Number(value))) return;
    sendingReqRef.current = true;
    setTimeout(() => { sendingReqRef.current = false; }, 1200);
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    lastRequestRef.current = reqId;
    broadcastRef.current({
      type: 'CONTROL_REQUEST',
      reqId,
      requesterId: peerRef.current?.id,
      requesterName: userName,
      action,
      value
    });
    addToast(`درخواست «${ACTION_LABELS[action] || action}» برای میزبان ارسال شد`, 'info');
  }, [userName, addToast]);

  const togglePlayInternal = useCallback(() => {
    if (isBuffering) {
      addToast(`ویدیو در حال بارگذاری است (${bufferCountdown}s)...`, 'info');
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      safePlay(v).then((ok) => {
        if (!ok) return;
        setIsPlaying(true);
        broadcastRef.current({
          type: 'PLAY',
          currentTime: v.currentTime,
          sentAt: Date.now()
        });
        if (isHostRef.current) fastUntilRef.current = Date.now() + FAST_AFTER_EVENT_MS;
      });
    } else {
      v.pause();
      setIsPlaying(false);
      broadcastRef.current({
        type: 'PAUSE',
        currentTime: v.currentTime,
        sentAt: Date.now()
      });
      if (isHostRef.current) fastUntilRef.current = Date.now() + FAST_AFTER_EVENT_MS;
    }
  }, [isBuffering, bufferCountdown, addToast]);

  const togglePlay = useCallback(() => {
    if (!canControlRef.current) {
      requestControl('toggle');
      return;
    }
    togglePlayInternal();
  }, [togglePlayInternal, requestControl]);

  const handleSeek = useCallback((newTime) => {
    if (!Number.isFinite(newTime)) return;
    if (!canControlRef.current || isBuffering) return;
    if (videoRef.current) videoRef.current.currentTime = newTime;
  }, [isBuffering]);

  const handleSeekRelease = useCallback((e) => {
    const newTime = parseFloat(e.target.value);
    if (isBuffering || !Number.isFinite(newTime)) return;
    if (canControlRef.current) {
      // Broadcast once per drag (not per onChange event) to avoid flooding
      // the data channel with dozens of SEEK packets per second.
      if (!isSyncingRef.current) {
        broadcastRef.current({ type: 'SEEK', currentTime: newTime, sentAt: Date.now() });
        if (isHostRef.current) fastUntilRef.current = Date.now() + FAST_AFTER_EVENT_MS;
      }
    } else {
      requestControl('seek', newTime);
    }
  }, [isBuffering, requestControl]);

  const skipBy = useCallback((delta) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.currentTime)) return;
    const target = Math.min(v.duration || 0, Math.max(0, v.currentTime + delta));
    if (!Number.isFinite(target)) return;
    if (!canControlRef.current) {
      requestControl('seek', target);
      return;
    }
    v.currentTime = target;
    if (!isSyncingRef.current) {
      broadcastRef.current({ type: 'SEEK', currentTime: target, sentAt: Date.now() });
      if (isHostRef.current) fastUntilRef.current = Date.now() + FAST_AFTER_EVENT_MS;
    }
  }, [requestControl]);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
    if (!v.muted) setVolume(v.volume || 1);
  }, []);

  const handleVolumeChange = useCallback((val) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = val;
    v.muted = val === 0;
    setIsMuted(val === 0);
    setVolume(val);
  }, []);

  const handleVideoSelect = (url, title) => {
    // Only the host / admins may switch the video for the whole room
    if (!canControlRef.current) return;
    const wasPlaying = !videoRef.current?.paused;
    desiredPlayingRef.current = wasPlaying;
    pendingSeekRef.current = 0;
    videoUrlRef.current = url;
    setVideoUrl(url);
    setCodecError(false);
    setDuration(0);
    resetSubtitles();
    setIsUrlModalOpen(false);
    if (/\.(mkv|mks|hevc|h265|265)$/i.test(url)) {
      addToast('MKV/H.265: در صورت پشتیبانی نشدن توسط مرورگر، از دکمه دانلود استفاده کنید', 'info');
    }
    const readyAt = Date.now() + BUFFER_SECONDS * 1000;
    startBuffering(readyAt);
    broadcastRef.current({
      type: 'CHANGE_VIDEO',
      url,
      title,
      readyAt,
      playing: wasPlaying
    });
    addToast(`ویدیو در حال بارگذاری (${BUFFER_SECONDS} ثانیه)...`, 'info');
  };

  const handleCustomUrlSubmit = (e) => {
    e.preventDefault();
    if (!customUrlInput.trim()) return;
    handleVideoSelect(customUrlInput.trim(), 'لینک سفارشی');
    setCustomUrlInput('');
  };

  // --- Fullscreen (custom wrapper so reactions & modals appear in FS) ---
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Activity listeners keep controls visible; reactions (z-20) stay above and don't block
  useEffect(() => {
    const el = playerWrapRef.current;
    if (!el) return;
    const onMove = () => showControls();
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onMove);
    el.addEventListener('touchstart', onMove, { passive: true });
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onMove);
      el.removeEventListener('touchstart', onMove);
    };
  }, [showControls]);

  // Clear the unread badge whenever the chat modal is opened
  useEffect(() => {
    if (chatModalOpen) setUnreadChat(0);
  }, [chatModalOpen]);

  // Keep the chat modal scrolled to the latest message
  useEffect(() => {
    if (chatModalOpen && chatModalScrollRef.current) {
      chatModalScrollRef.current.scrollTop = chatModalScrollRef.current.scrollHeight;
    }
  }, [messages, chatModalOpen]);

  const enterFullscreen = useCallback(() => {
    const el = playerWrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else if (el.requestFullscreen) {
      el.requestFullscreen?.().catch(() => {});
    } else if (el.webkitRequestFullscreen) {
      // iOS Safari
      el.webkitRequestFullscreen?.();
    }
  }, []);

  const togglePip = useCallback(() => {
    if (!videoRef.current) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    } else {
      videoRef.current.requestPictureInPicture?.().catch(() => {});
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!canControlRef.current) {
      requestControl('fullscreen');
      return;
    }
    enterFullscreen();
  }, [requestControl, enterFullscreen]);

  const selectSpeed = useCallback((s) => {
    userSpeedRef.current = s;
    setSpeed(s);
    setSpeedMenuOpen(false);
    if (videoRef.current) videoRef.current.playbackRate = s;
  }, []);

  const toggleSpeedMenu = useCallback(() => setSpeedMenuOpen((s) => !s), []);
  const openSubtitleSettings = useCallback(() => setSubtitleModalOpen(true), []);
  const toggleControlsDir = useCallback(() => setControlsDir((d) => (d === 'rtl' ? 'ltr' : 'rtl')), []);

  const retryVideo = () => {
    setVideoError('');
    const v = videoRef.current;
    if (v) {
      v.load();
      safePlay(v).catch(() => {});
    }
  };

  // --- Subtitles ---
  const loadSubtitleText = (text, name) => {
    const cues = parseSubtitles(text);
    subtitleSourceRef.current = text;
    activeSubtitleRef.current = '';
    setSubtitleCues(cues);
    setSubtitleName(name);
    setSubtitleEnabled(cues.length > 0);
    setSubtitleText('');
    addToast(
      cues.length > 0 ? `زیرنویس «${name}» با ${cues.length} بخش بارگذاری شد` : 'زیرنویس معتبری یافت نشد',
      cues.length > 0 ? 'success' : 'error'
    );
  };

  // Load raw parsed cues (e.g. extracted from an MKV) directly
  const loadSubtitleCues = (cues, name) => {
    subtitleSourceRef.current = cuesToSrt(cues);
    activeSubtitleRef.current = '';
    setSubtitleCues(cues);
    setSubtitleName(name);
    setSubtitleEnabled(cues.length > 0);
    setSubtitleText('');
    addToast(
      cues.length > 0 ? `زیرنویس «${name}» با ${cues.length} بخش بارگذاری شد` : 'زیرنویس معتبری یافت نشد',
      cues.length > 0 ? 'success' : 'error'
    );
  };

  const loadSubtitleUrl = async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      loadSubtitleText(text, url.split('/').pop().split('?')[0] || 'زیرنویس');
    } catch {
      addToast('بارگذاری زیرنویس ناموفق بود (CORS یا لینک نامعتبر)', 'error');
    }
  };

  const handleSubtitleFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadSubtitleText(String(reader.result), file.name);
    reader.readAsText(file);
  };

  // Cue tracking loop (rAF + binary search: smooth, no jank, no O(n) scan)
  useEffect(() => {
    if (!subtitleEnabled || subtitleCues.length === 0) return;
    let raf;
    const loop = () => {
      const v = videoRef.current;
      if (v) {
        const t = v.currentTime;
        // Binary search for the last cue whose start <= t (cues are sorted)
        let lo = 0;
        let hi = subtitleCues.length - 1;
        let best = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (subtitleCues[mid].start <= t) {
            best = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        const cue = best >= 0 && t < subtitleCues[best].end ? subtitleCues[best] : null;
        const text = cue ? cue.text : '';
        if (text !== activeSubtitleRef.current) {
          activeSubtitleRef.current = text;
          setSubtitleText(text);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [subtitleEnabled, subtitleCues]);

  // --- Manual re-sync (no page reload: everyone aligns to the host again) ---
  const syncNow = () => {
    if (isHost) {
      if (videoRef.current && connectionsRef.current.length > 0) {
        broadcastRef.current(hostStateMessage());
      }
    } else {
      connectionsRef.current.forEach((c) => {
        if (c.open) { try { c.send({ type: 'REQUEST_STATE' }); } catch (_) {} }
      });
    }
    addToast('همگام‌سازی مجدد انجام شد', 'success');
  };

  // Close the speed menu when clicking anywhere else
  useEffect(() => {
    if (!speedMenuOpen) return;
    const close = (e) => {
      if (!e.target.closest('[data-speed-menu]')) setSpeedMenuOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [speedMenuOpen]);

  // Escape rejects the pending control request
  useEffect(() => {
    if (!requestModalOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') rejectRequest();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestModalOpen]);

  // --- Chat (lazy loading) ---
  const visibleMessages = messages.slice(-chatWindow);

  const loadOlderMessages = () => {
    const el = chatScrollRef.current;
    if (el) pendingChatShiftRef.current = el.scrollHeight;
    setChatWindow((w) => Math.min(messages.length, w + CHAT_WINDOW));
  };

  const handleChatScroll = () => {
    const el = chatScrollRef.current;
    if (!el) return;
    chatAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    if (pendingChatShiftRef.current != null) {
      el.scrollTop = el.scrollHeight - pendingChatShiftRef.current;
      pendingChatShiftRef.current = null;
    } else if (chatAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, chatWindow]);

  const sendChatMessage = (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const newMsg = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sender: userName,
      text: chatInput.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages((prev) => [...prev, newMsg].slice(-500));
    broadcastRef.current({
      type: 'CHAT_MESSAGE',
      ...newMsg
    });
    setChatInput('');
  };

  // --- Reactions ---
  const triggerFloatingReaction = (emoji) => {
    const id = Date.now() + Math.random();
    const randomLeft = Math.floor(Math.random() * 80) + 10;
    setReactions((prev) => [...prev, { id, emoji, left: randomLeft }]);

    setTimeout(() => {
      setReactions((prev) => prev.filter((r) => r.id !== id));
    }, 3000);
  };

  const sendReaction = (emoji) => {
    triggerFloatingReaction(emoji);
    broadcastRef.current({
      type: 'REACTION',
      emoji
    });
  };

  const copyRoomLink = async () => {
    const link = window.location.href;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Fallback for non-secure contexts / older browsers
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
    }
    setIsCopied(true);
    addToast('لینک اتاق کپی شد!', 'success');
    setTimeout(() => setIsCopied(false), 2000);
  };

  // --- Subtitle download (export current subtitle text) ---
  const downloadSubtitle = () => {
    if (subtitleCues.length === 0) return;
    const name = (subtitleName || 'subtitle.srt').replace(/\.(srt|vtt|txt)$/i, '') + '.srt';
    const content = subtitleSourceRef.current || cuesToSrt(subtitleCues);
    const blob = new Blob([content], { type: 'text/plain' });
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
    addToast(`زیرنویس «${name}» دانلود شد`, 'success');
  };

  // --- Keyboard shortcuts (single listener; latest handler via ref) ---
  const keyHandlerRef = useRef(null);
  keyHandlerRef.current = (e) => {
    if (modalOpenRef.current) return; // never fire behind an open modal
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.target.closest('button')) return; // let focused buttons handle their own activation
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        skipBy(e.shiftKey ? 60 : SKIP_SECONDS);
        break;
      case 'ArrowLeft':
        skipBy(-(e.shiftKey ? 60 : SKIP_SECONDS));
        break;
      case 'f':
      case 'F':
        if (canControlRef.current) enterFullscreen();
        else requestControl('fullscreen');
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'c':
      case 'C':
        if (subtitleCues.length > 0) setSubtitleEnabled((s) => !s);
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    const onKey = (e) => keyHandlerRef.current?.(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- User management ---
  const openManageModal = (user) => {
    setSelectedUser(user);
    setManageModalOpen(true);
  };

  const toggleAdminRole = (targetId, makeAdmin) => {
    if (!isHost) return;
    broadcastRef.current({ type: 'UPDATE_ROLE', targetId, isAdmin: makeAdmin });
    setParticipants((prev) => prev.map((p) => (p.id === targetId ? { ...p, isAdmin: makeAdmin } : p)));
    setManageModalOpen(false);
    addToast(makeAdmin ? 'کاربر ادمین شد' : 'دسترسی ادمین گرفته شد', 'success');
  };

  const kickUser = (targetId) => {
    if (!canManageRef.current) return;
    const target = participantsRef.current.find((p) => p.id === targetId);
    broadcastRef.current({ type: 'KICK', targetId });
    const conn = connectionsRef.current.find((c) => c.peer === targetId);
    if (conn) {
      conn.send({ type: 'KICKED' });
      setTimeout(() => conn.close(), 200);
    }
    setParticipants((prev) => prev.filter((p) => p.id !== targetId));
    setManageModalOpen(false);
    addToast(`کاربر ${target?.name || ''} از اتاق حذف شد`, 'success');
  };

  const syncStatus = reconnecting
    ? 'در حال اتصال مجدد...'
    : connections.length > 0
      ? `همگام‌سازی زنده P2P (${connections.length} اتصال)`
      : isHost
        ? 'در انتظار مهمان‌ها...'
        : 'در حال برقراری اتصال P2P...';

  const iceTypeLabel = netStats?.iceType === 'relay'
    ? 'رله (TURN)'
    : netStats?.iceType === 'srflx'
      ? 'مستقیم (P2P)'
      : netStats?.iceType === 'host'
        ? 'مستقیم (LAN)'
        : '—';

  const signalingHost = ACTIVE_SIGNALING.includes('://')
    ? new URL(ACTIVE_SIGNALING).host
    : ACTIVE_SIGNALING;

  const isCurrentUser = (user) => user.id === 'self' || (peerRef.current && user.id === peerRef.current.id);

  const EMOJIS = ['❤️', '🔥', '😂', '👏', '😮', '🎉', '🍿'];

  return (
    <div className="h-dvh flex flex-col bg-black text-gray-100 relative overflow-hidden">
      {/* Top Navbar */}
      <header className="bg-black/90 backdrop-blur-xl border-b border-white/5 px-3 md:px-6 py-2.5 md:py-3 flex items-center justify-between gap-2 z-30 shadow-2xl shadow-black/50 shrink-0">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <div className="w-8 h-8 md:w-10 md:h-10 rounded-xl bg-zinc-950 flex items-center justify-center border border-red-500/30 shadow-[0_0_20px_rgba(239,68,68,0.25)] shrink-0">
            <Film className="w-4 h-4 md:w-5 md:h-5 text-red-500" />
          </div>
          <div className="min-w-0">
            <h1 className="font-bold text-sm md:text-lg flex items-center gap-2 truncate">
              <span>ببینیم</span>
              <span className="text-[10px] md:text-xs px-2 py-0.5 rounded-full bg-red-900/40 text-red-300 border border-red-500/30 whitespace-nowrap">
                {isHost ? 'میزبان (Host)' : 'تماشاگر'}
              </span>
            </h1>
            <p className="text-[10px] md:text-xs text-gray-500 font-mono truncate">
              کد اتاق: {roomId} <span className="hidden sm:inline text-gray-600">• ساخته شده توسط <span className="text-red-500 font-bold">RADINMNX</span></span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          <button
            onClick={syncNow}
            title="همگام‌سازی مجدد همه"
            className="btn-secondary py-2 px-2.5 md:px-3.5 text-xs md:text-sm gap-1.5"
          >
            <RefreshCw className="w-4 h-4 text-red-400" />
            <span className="hidden lg:inline">همگام‌سازی</span>
          </button>

          <button
            onClick={() => setIsShareModalOpen(true)}
            aria-label="دعوت دوستان"
            className="btn-secondary py-2 px-2.5 md:px-3.5 text-xs md:text-sm gap-1.5"
          >
            <Share2 className="w-4 h-4 text-red-400" />
            <span className="hidden sm:inline">دعوت دوستان</span>
          </button>

          <button
            onClick={onLeave}
            aria-label="خروج از اتاق"
            className="btn-secondary py-2 px-2.5 md:px-3.5 text-xs md:text-sm gap-1.5 hover:border-red-500/70 hover:text-red-400 hover:bg-red-500/10"
          >
            <LogOut className="w-4 h-4 text-red-400" />
            <span className="hidden sm:inline">خروج</span>
          </button>
        </div>
      </header>

      {/* Main Content Grid */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-4 gap-3 md:gap-4 p-3 md:p-6 max-w-[1600px] w-full mx-auto overflow-y-auto">

        {/* Left/Center: Video Player & Controls (3 cols on lg) */}
        <div className="lg:col-span-3 flex flex-col gap-3 md:gap-4 min-h-0">

          {/* Player Wrapper: everything lives here so fullscreen keeps all UI */}
          <div
            ref={playerWrapRef}
            className="relative w-full aspect-video bg-black rounded-2xl md:rounded-3xl overflow-hidden border border-red-500/20 shadow-[0_0_40px_rgba(239,68,68,0.15)] group flex items-center justify-center bg-zinc-950"
          >
            {/* Floating Reactions Overlay */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
              {reactions.map((r) => (
                <div
                  key={r.id}
                  className="absolute bottom-10 text-4xl md:text-6xl animate-float transition-all duration-1000 gpu-layer"
                  style={{ left: `${r.left}%`, animationDuration: '2.5s' }}
                >
                  {r.emoji}
                </div>
              ))}
            </div>

            {!videoUrl ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-gradient-to-b from-black via-zinc-950 to-black z-10 px-4 text-center">
                <Film className="w-12 h-12 md:w-16 md:h-16 text-red-500/70 neon-text" />
                <p className="text-sm md:text-base text-gray-400 font-persian">
                  هنوز ویدیویی انتخاب نشده است
                </p>
                {canControl ? (
                  <button
                    onClick={() => setIsUrlModalOpen(true)}
                    className="btn-primary text-xs md:text-sm"
                  >
                    <Film className="w-4 h-4" />
                    انتخاب یا وارد کردن لینک ویدیو
                  </button>
                ) : (
                  <p className="text-[10px] md:text-xs text-gray-500 font-persian">
                    منتظر باشید — میزبان به‌زودی ویدیو را انتخاب می‌کند
                  </p>
                )}
              </div>
            ) : (
              <video
                ref={videoRef}
                src={videoUrl}
                playsInline
                preload="auto"
                aria-label="ویدیو اتاق"
                tabIndex={0}
                className="w-full h-full object-contain cursor-pointer"
                onLoadStart={() => { setCodecError(false); setVideoError(''); }}
                onLoadedMetadata={() => {
                  if (videoRef.current) {
                    setDuration(videoRef.current.duration);
                  }
                }}
                onError={() => {
                  const code = videoRef.current?.error?.code;
                  if (code === 4) {
                    setCodecError(true);
                    setIsPlaying(false);
                  } else if (code) {
                    const msgs = {
                      1: 'بارگذاری ویدیو متوقف شد',
                      2: 'اتصال به سرور ویدیو برقرار نشد (ممکن است لینک منقضی یا غیرفعال باشد)',
                      3: 'پخش این ویدیو ممکن نیست'
                    };
                    setVideoError(msgs[code] || 'خطایی در بارگذاری ویدیو رخ داد');
                    setIsPlaying(false);
                  }
                }}
                onCanPlay={() => {
                  const v = videoRef.current;
                  if (!v) return;
                  if (pendingSeekRef.current != null) {
                    v.currentTime = Math.min(pendingSeekRef.current, v.duration || pendingSeekRef.current);
                    pendingSeekRef.current = null;
                  }
                  if (isHostRef.current && pendingAutoPlayRef.current && v.paused && Date.now() >= readyAtRef.current) {
                    pendingAutoPlayRef.current = false;
                    safePlay(v).then((ok) => {
                      if (!ok) return;
                      setIsPlaying(true);
                      broadcastRef.current({ type: 'PLAY', currentTime: v.currentTime, sentAt: Date.now() });
                    });
                  } else if (!isHostRef.current && pendingPlayRef.current && v.readyState >= 2 && Date.now() >= readyAtRef.current) {
                    // Late-join guest: wait for the shared 10s pre-buffer
                    // deadline so nobody starts playing early and desyncs.
                    pendingPlayRef.current = false;
                    safePlay(v).then((ok) => {
                      if (!ok) return;
                      setIsPlaying(true);
                      broadcastRef.current({ type: 'PLAY_ACK', t: Date.now() });
                    });
                  }
                }}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onClick={togglePlay}
                onDoubleClick={() => { if (canControlRef.current) enterFullscreen(); }}
              />
            )}

            {/* Codec not supported overlay */}
            {codecError && (
              <div className="absolute inset-0 z-30 bg-black/85 flex flex-col items-center justify-center gap-4 p-6 text-center">
                <Film className="w-12 h-12 md:w-16 md:h-16 text-red-500/70" />
                <p className="text-sm md:text-base text-gray-200 font-persian">
                  این فرمت/کدک توسط مرورگر شما پشتیبانی نمی‌شود
                </p>
                <p className="text-[10px] md:text-xs text-gray-500 font-persian max-w-md">
                  MP4 (H.264) و WebM (VP9/AV1) بهترین سازگاری را دارند؛ MKV در صورت داشتن کدک پشتیبانی‌شده پخش می‌شود.
                </p>
                <button
                  onClick={() => setCodecError(false)}
                  className="btn-primary text-xs md:text-sm"
                >
                  <Film className="w-4 h-4" />
                  بستن
                </button>
              </div>
            )}

            {/* Generic video error overlay (network / decode) */}
            {videoError && !codecError && (
              <div className="absolute inset-0 z-30 bg-black/85 flex flex-col items-center justify-center gap-4 p-6 text-center">
                <WifiOff className="w-12 h-12 md:w-16 md:h-16 text-red-500/70" />
                <p className="text-sm md:text-base text-gray-200 font-persian">{videoError}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <button onClick={retryVideo} className="btn-primary text-xs md:text-sm">
                    <RefreshCw className="w-4 h-4" />
                    تلاش مجدد
                  </button>
                  {canControl && (
                    <button onClick={() => { setVideoError(''); setIsUrlModalOpen(true); }} className="btn-secondary text-xs md:text-sm">
                      <Film className="w-4 h-4" />
                      تغییر ویدیو
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Buffering overlay (10s pre-buffer after a video change) */}
            {isBuffering && videoUrl && !codecError && !videoError && (
              <div className="absolute inset-0 z-30 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-10 h-10 md:w-14 md:h-14 text-red-500 animate-spin" />
                <p className="text-sm md:text-base text-gray-200 font-persian">در حال بارگذاری ویدیو...</p>
                <p className="text-2xl md:text-4xl font-bold text-red-400 neon-text">{bufferCountdown}s</p>
                <p className="text-[10px] md:text-xs text-gray-500 font-persian">
                  برای هماهنگی همهٔ کاربران، پخش بعد از {BUFFER_SECONDS} ثانیه شروع می‌شود
                </p>
              </div>
            )}

            {/* Subtitle overlay (custom-rendered, works in fullscreen too) */}
            {subtitleEnabled && subtitleText && !codecError && (
              <div
                className="absolute left-1/2 -translate-x-1/2 z-[15] pointer-events-none w-[90%] max-w-3xl"
                style={{
                  bottom: `${subtitleSettings.verticalOffset}px`,
                }}
              >
                <p
                  className="text-center leading-relaxed"
                  style={{
                    fontSize: `${subtitleSettings.fontSize}px`,
                    color: subtitleSettings.fontColor,
                    fontFamily: subtitleSettings.fontFamily,
                    textShadow: subtitleSettings.textShadow
                      ? '0 2px 8px rgba(0,0,0,0.8), 0 0 2px rgba(0,0,0,0.9)'
                      : 'none',
                    backgroundColor: subtitleSettings.backgroundColor === 'transparent'
                      ? 'transparent'
                      : hexToRgba(subtitleSettings.backgroundColor, 0.75),
                    backdropFilter: `blur(${subtitleSettings.backgroundBlur}px)`,
                    WebkitBackdropFilter: `blur(${subtitleSettings.backgroundBlur}px)`,
                    padding: '8px 16px',
                    borderRadius: '8px',
                    display: 'inline-block',
                    maxWidth: '100%',
                    wordWrap: 'break-word',
                  }}
                >
                  {subtitleText}
                </p>
              </div>
            )}

            {/* Video Overlay Controls (interactive children re-enable clicks) */}
            <div className={`absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-black/40 ${controlsVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'} transition-opacity duration-300 flex flex-col justify-between p-3 md:p-6 z-10`}>

              {/* Top Video bar */}
              <div className="flex items-center justify-between gap-2 pointer-events-auto">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 md:w-2.5 md:h-2.5 rounded-full ${connections.length > 0 ? 'bg-red-500 shadow-[0_0_10px_red] animate-pulse' : 'bg-amber-500 animate-pulse'}`}></span>
                  <span className="text-[10px] md:text-xs font-medium text-gray-300 flex items-center gap-1.5 truncate">
                    {connections.length > 0 ? <Radio className="w-3 h-3 md:w-3.5 md:h-3.5 text-red-400" /> : <Wifi className="w-3 h-3 md:w-3.5 md:h-3.5 text-amber-400" />}
                    {syncStatus}
                  </span>
                  {netStats?.rtt != null && connections.length > 0 && (
                    <span className="text-[9px] md:text-[10px] px-1.5 py-0.5 rounded-md bg-black/50 border border-white/10 text-emerald-400 font-mono whitespace-nowrap" dir="ltr" title={`تاخیر: ${netStats.rtt}ms${netStats.offsetMs != null ? ` · اختلاف ساعت: ${netStats.offsetMs}ms` : ''}`}>
                      {netStats.rtt}ms
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {isFullscreen && (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-xl bg-black/50 border border-white/10">
                      {EMOJIS.slice(0, 5).map((emoji) => (
                        <button
                          key={emoji}
                          onClick={() => sendReaction(emoji)}
                          aria-label={`ارسال واکنش ${emoji}`}
                          className="text-xl md:text-2xl hover:scale-125 transition-transform"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                  {canControl && (
                    <button
                      onClick={() => setIsUrlModalOpen(true)}
                      aria-label="تغییر ویدیو"
                      className="btn-secondary py-1.5 px-3 text-xs gap-1.5 bg-black/40"
                    >
                      <Film className="w-3.5 h-3.5 text-red-400" />
                      <span className="hidden md:inline">تغییر ویدیو</span>
                    </button>
                  )}
                  <button
                    onClick={() => setChatModalOpen(true)}
                    className={`py-1.5 px-3 text-xs gap-1.5 rounded-xl border transition-colors ${chatModalOpen ? 'bg-red-600/30 border-red-500/50 text-red-300' : 'bg-black/40 border-white/10 text-gray-300'}`}
                    title="چت"
                    aria-label="چت"
                  >
                      <MessageSquare className="w-3.5 h-3.5" />
                      <span className="hidden md:inline">چت</span>
                      {unreadChat > 0 && (
                        <span className="px-1.5 py-0.5 text-[9px] bg-red-600 rounded-full">{unreadChat}</span>
                      )}
                    </button>
                </div>
              </div>

              {/* Center big play/pause */}
              <div className="self-center pointer-events-auto">
                <button
                  onClick={togglePlay}
                  disabled={isBuffering}
                  aria-label={isPlaying ? 'توقف' : 'پخش'}
                  className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-red-600/80 hover:bg-red-600 disabled:opacity-50 text-white flex items-center justify-center backdrop-blur-md shadow-[0_0_30px_rgba(239,68,68,0.5)] transition-all transform hover:scale-110 active:scale-95"
                >
                  {isBuffering ? <Loader2 className="w-7 h-7 animate-spin" /> : (isPlaying ? <Pause className="w-7 h-7 md:w-8 md:h-8" /> : <Play className="w-7 h-7 md:w-8 md:h-8 ml-1" />)}
                </button>
              </div>

              {/* Bottom Video Controls Bar (memoized: progress state stays local) */}
              <PlayerControls
                duration={duration}
                disabled={isBuffering}
                isPlaying={isPlaying}
                isMuted={isMuted}
                volume={volume}
                speed={speed}
                speedMenuOpen={speedMenuOpen}
                controlsDir={controlsDir}
                subtitleEnabled={subtitleEnabled}
                subtitleAvailable={subtitleCues.length > 0}
                isFullscreen={isFullscreen}
                videoRef={videoRef}
                onSeek={handleSeek}
                onSeekRelease={handleSeekRelease}
                onTogglePlay={togglePlay}
                onSkip={skipBy}
                onToggleMute={toggleMute}
                onVolumeChange={handleVolumeChange}
                onSelectSpeed={selectSpeed}
                onSpeedMenuToggle={toggleSpeedMenu}
                onSubtitleSettings={openSubtitleSettings}
                onToggleDir={toggleControlsDir}
                onTogglePip={togglePip}
                onToggleFullscreen={toggleFullscreen}
              />
            </div>

            {/* Control request approval modal (rendered inside wrapper: visible in fullscreen) */}
            {requestModalOpen && pendingRequest && (
              <div
                className="absolute inset-0 z-40 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm max-sm:fixed"
                role="dialog"
                aria-modal="true"
                aria-label="درخواست کنترل"
              >
                <div className="w-full max-w-sm bg-zinc-950 border border-red-500/30 rounded-2xl p-5 shadow-2xl shadow-red-900/40 animate-slide-up max-sm:max-h-[85dvh] max-sm:overflow-y-auto">
                  <div className="absolute -top-16 -left-16 w-40 h-40 bg-red-600/10 rounded-full blur-[80px] pointer-events-none"></div>
                  <div className="relative">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-xl bg-red-600/20 border border-red-500/30 flex items-center justify-center font-bold text-red-300">
                        {pendingRequest.requesterName.charAt(0)}
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-white">درخواست کنترل</h3>
                        <p className="text-[10px] text-gray-400">{pendingRequest.requesterName}</p>
                      </div>
                    </div>
                    <div className="rounded-xl bg-black/40 border border-white/10 p-3 text-xs text-gray-200 mb-4">
                      <div className="flex justify-between mb-1">
                        <span className="text-gray-500">عملیات:</span>
                        <span className="text-red-400 font-bold">{ACTION_LABELS[pendingRequest.action] || pendingRequest.action}</span>
                      </div>
                      {pendingRequest.action === 'seek' && (
                        <div className="flex justify-between">
                          <span className="text-gray-500">زمان:</span>
                          <span className="font-mono">{fmtTime(pendingRequest.value)}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button onClick={approveRequest} className="btn-primary flex-1 py-2.5 text-xs gap-1.5">
                        <Check className="w-4 h-4" />
                        تایید
                      </button>
                      <button onClick={rejectRequest} className="btn-secondary flex-1 py-2.5 text-xs gap-1.5 hover:border-red-500/70 hover:text-red-400">
                        <X className="w-4 h-4" />
                        رد
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Non-controller hint */}
            {!canControl && videoUrl && !requestModalOpen && (
              <div className="absolute top-14 md:top-16 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
                <span className="text-[10px] md:text-xs px-2.5 py-1 rounded-full bg-black/60 border border-white/10 text-gray-400 whitespace-nowrap">
                  دکمه‌ها درخواست تایید می‌فرستند
                </span>
              </div>
            )}

            {/* --- In-wrapper modals: stay visible inside fullscreen --- */}

            {/* Change Video Modal (URL + Subtitles) */}
            <Modal isOpen={isUrlModalOpen} onClose={() => setIsUrlModalOpen(false)} title="تغییر ویدیو و زیرنویس">
              <div className="space-y-4">
                <p className="text-sm text-gray-300 font-persian">لینک مستقیم ویدیو را وارد کنید (MP4/WebM/MKV):</p>

                <form onSubmit={handleCustomUrlSubmit} className="space-y-3">
                  <label className="block text-xs text-gray-400">لینک مستقیم (URL):</label>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={customUrlInput}
                      onChange={(e) => setCustomUrlInput(e.target.value)}
                      placeholder="https://.../movie.mp4"
                      className="input-field text-xs py-2"
                      autoFocus
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
                    <input
                      type="url"
                      value={subUrlInput}
                      onChange={(e) => setSubUrlInput(e.target.value)}
                      placeholder="https://.../movie.srt"
                      className="input-field text-xs py-2"
                    />
                    <button
                      onClick={() => {
                        if (!subUrlInput.trim()) return;
                        loadSubtitleUrl(subUrlInput.trim());
                        setSubUrlInput('');
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
                        accept=".srt,.vtt,.txt"
                        className="hidden"
                        onChange={(e) => {
                          handleSubtitleFile(e.target.files?.[0]);
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
                      onClick={async () => {
                        const url = videoUrlRef.current;
                        if (!url) {
                          setMkvError('ابتدا یک ویدیو انتخاب کنید');
                          return;
                        }
                        setMkvLoading(true);
                        setMkvError('');
                        setMkvTracks([]);
                        try {
                          let res;
                          try {
                            res = await fetch(url, {
                              mode: 'cors',
                              signal: AbortSignal.timeout(60000)
                            });
                          } catch (fetchErr) {
                            throw fetchErr;
                          }
                          if (res.type === 'opaque') throw new TypeError('CORS blocked');
                          if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                          const buf = await res.arrayBuffer();
                          const tracks = await extractMkvSubtitles(buf);
                          setMkvTracks(tracks);
                          if (tracks.length === 0) setMkvError('زیرنویس داخلی در این ویدیو یافت نشد');
                          else addToast(`${tracks.length} ترک زیرنویس یافت شد`, 'success');
                        } catch (e) {
                          const msg = e?.message || String(e);
                          const corsBlocked = e instanceof TypeError
                            || msg.includes('CORS')
                            || msg.includes('cross-origin')
                            || msg.includes('Failed to fetch')
                            || msg.includes('NetworkError');
                          if (corsBlocked) {
                            setMkvError('CORS blocked: سرور ویدیو اجازه خواندن مستقیم را نمی‌دهد. فایل را دانلود و آپلود کنید یا از لینک مستقیم SRT استفاده کنید.');
                          } else {
                            setMkvError('استخراج ناموفق بود: ' + msg);
                          }
                        } finally {
                          setMkvLoading(false);
                        }
                      }}
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
                              onClick={() => loadSubtitleCues(t.cues, `${t.language || 'sub'} (MKV #${t.trackNumber})`)}
                              className="btn-primary py-1 px-2 text-[10px] shrink-0"
                            >
                              بارگذاری
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </Modal>

            {/* Subtitle Settings Modal */}
            <Modal
              isOpen={subtitleModalOpen}
              onClose={() => setSubtitleModalOpen(false)}
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
                    onClick={() => setSubtitleEnabled((s) => !s)}
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
                        {subtitleSettings.fontSize}px
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setSubtitleSettings((s) => ({ ...s, fontSize: Math.max(12, s.fontSize - 2) }))}
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
                        value={subtitleSettings.fontSize}
                        onChange={(e) => setSubtitleSettings((s) => ({ ...s, fontSize: Number(e.target.value) }))}
                        aria-label="اندازه فونت زیرنویس"
                        dir="ltr"
                        className="flex-1 neon-range"
                      />
                      <button
                        onClick={() => setSubtitleSettings((s) => ({ ...s, fontSize: Math.min(48, s.fontSize + 2) }))}
                        aria-label="افزایش اندازه فونت"
                        className="p-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
                      >
                        <Plus className="w-5 h-5" />
                      </button>
                    </div>
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
                        value={subtitleSettings.fontColor}
                        onChange={(e) => setSubtitleSettings((s) => ({ ...s, fontColor: e.target.value }))}
                        aria-label="رنگ فونت زیرنویس"
                        className="w-10 h-10 rounded-lg border border-white/10 cursor-pointer"
                      />
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {['#ffffff', '#ffeb3b', '#00e676', '#ff1744', '#2979ff', '#ff9100'].map((color) => (
                        <button
                          key={color}
                          onClick={() => setSubtitleSettings((s) => ({ ...s, fontColor: color }))}
                          aria-label={`رنگ ${color}`}
                          className={`w-8 h-8 rounded-lg border-2 transition-all ${subtitleSettings.fontColor === color ? 'border-red-400 scale-110' : 'border-white/10 hover:border-red-500/50'}`}
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
                        value={subtitleSettings.backgroundColor === 'transparent' ? '#000000' : subtitleSettings.backgroundColor}
                        onChange={(e) => setSubtitleSettings((s) => ({ ...s, backgroundColor: e.target.value }))}
                        aria-label="رنگ پس‌زمینه زیرنویس"
                        className="w-10 h-10 rounded-lg border border-white/10 cursor-pointer"
                      />
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {['#000000', '#1c1c24', '#8b0000', 'transparent'].map((bg) => (
                        <button
                          key={bg}
                          onClick={() => setSubtitleSettings((s) => ({ ...s, backgroundColor: bg }))}
                          aria-label={`پس‌زمینه ${bg === 'transparent' ? 'شفاف' : bg}`}
                          className={`w-20 h-10 rounded-lg border-2 flex items-center justify-center text-[10px] font-mono transition-all ${subtitleSettings.backgroundColor === bg ? 'border-red-400 scale-110' : 'border-white/10 hover:border-red-500/50'}`}
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
                        {subtitleSettings.backgroundBlur}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="20"
                      step="1"
                      value={subtitleSettings.backgroundBlur}
                      onChange={(e) => setSubtitleSettings((s) => ({ ...s, backgroundBlur: Number(e.target.value) }))}
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
                        {subtitleSettings.verticalOffset}px از پایین
                      </span>
                    </div>
                    <input
                      type="range"
                      min="8"
                      max="200"
                      step="4"
                      value={subtitleSettings.verticalOffset}
                      onChange={(e) => setSubtitleSettings((s) => ({ ...s, verticalOffset: Number(e.target.value) }))}
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
                      onClick={() => setSubtitleSettings((s) => ({ ...s, textShadow: !s.textShadow }))}
                      aria-label="فعال/غیرفعال کردن سایه متن"
                      className={`relative w-12 h-7 rounded-full transition-all ${subtitleSettings.textShadow ? 'bg-purple-500' : 'bg-gray-600'}`}
                      role="switch"
                      aria-checked={subtitleSettings.textShadow}
                    >
                      <span
                        className={`absolute top-0.5 bottom-0.5 w-6 rounded-full bg-white transition-transform shadow-lg ${subtitleSettings.textShadow ? 'translate-x-5' : 'translate-x-0.5'}`}
                      />
                    </button>
                  </div>

                  {/* Reset Button */}
                  <button
                    onClick={() => setSubtitleSettings({
                      fontSize: 20,
                      fontColor: '#ffffff',
                      backgroundColor: '#000000',
                      backgroundBlur: 4,
                      verticalOffset: 24,
                      fontFamily: 'inherit',
                      textShadow: true,
                    })}
                    className="w-full btn-secondary text-sm gap-2"
                  >
                    <SlidersHorizontal className="w-4 h-4" />
                    بازنشانی به پیش‌فرض
                  </button>
                </div>
              </div>
            </Modal>

            {/* Chat Modal */}
            <Modal
              isOpen={chatModalOpen}
              onClose={() => setChatModalOpen(false)}
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
                <form onSubmit={sendChatMessage} className="flex items-center gap-2 shrink-0">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="پیام خود را بنویسید..."
                    className="input-field py-2 text-sm flex-1"
                    autoFocus
                  />
                  <button type="submit" aria-label="ارسال پیام" className="btn-primary p-2.5 rounded-xl shrink-0">
                    <Send className="w-5 h-5" />
                  </button>
                </form>
              </div>
            </Modal>
          </div>

          {/* Quick Reactions Bar */}
          <div className="bg-zinc-950/80 border border-white/10 rounded-2xl p-2.5 md:p-3 flex items-center justify-between px-3 md:px-6 backdrop-blur-xl flex-wrap gap-2 shrink-0">
            <span className="text-[10px] md:text-xs font-medium text-gray-400 hidden sm:inline">واکنش سریع:</span>
            <div className="flex items-center gap-2 md:gap-6 mx-auto sm:mx-0 flex-wrap justify-center">
              {EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => sendReaction(emoji)}
                  aria-label={`ارسال واکنش ${emoji}`}
                  className="text-xl md:text-2xl hover:scale-125 transition-transform p-1 rounded-lg md:p-1.5 md:rounded-xl hover:bg-red-500/10"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Sidebar: Tabs (Chat, Users, Downloads) */}
        <div className="lg:col-span-1 bg-zinc-950/80 backdrop-blur-xl rounded-2xl md:rounded-3xl flex flex-col h-[42dvh] lg:h-auto lg:min-h-0 border border-white/10 overflow-hidden shrink-0">

          {/* Sidebar Tabs Header */}
          <div className="grid grid-cols-2 border-b border-white/5 bg-black/40 shrink-0">
            <button
              onClick={() => setActiveTab('chat')}
              className={`py-2.5 md:py-3 text-xs md:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 ${
                activeTab === 'chat' ? 'text-red-400 border-b-2 border-red-500 bg-red-500/10 shadow-[0_0_20px_rgba(239,68,68,0.15)]' : 'text-gray-400 hover:text-white'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5 md:w-4 md:h-4" />
              <span>چت</span>
            </button>
            <button
              onClick={() => setActiveTab('users')}
              className={`py-2.5 md:py-3 text-xs md:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 ${
                activeTab === 'users' ? 'text-red-400 border-b-2 border-red-500 bg-red-500/10 shadow-[0_0_20px_rgba(239,68,68,0.15)]' : 'text-gray-400 hover:text-white'
              }`}
            >
              <Users className="w-3.5 h-3.5 md:w-4 md:h-4" />
              <span>اعضا ({participants.length})</span>
            </button>
          </div>

          {/* Tab Content: Chat */}
          {activeTab === 'chat' && (
            <div className="flex-1 min-h-0 flex flex-col p-2.5 md:p-4 overflow-hidden">
              <div
                ref={chatScrollRef}
                onScroll={handleChatScroll}
                className="flex-1 min-h-0 overflow-y-auto space-y-2.5 pr-1 mb-2.5 chat-scroll"
              >
                {messages.length > chatWindow && (
                  <button
                    onClick={loadOlderMessages}
                    className="w-full text-center text-[10px] md:text-xs text-gray-500 hover:text-red-400 transition-colors py-1.5 border border-dashed border-white/10 rounded-lg"
                  >
                    نمایش {messages.length - chatWindow} پیام قدیمی‌تر
                  </button>
                )}
                {visibleMessages.length === 0 ? (
                  <div className="text-center text-gray-500 text-xs my-auto py-12">
                    هنوز پیامی ارسال نشده است. اولین پیام را بفرستید!
                  </div>
                ) : (
                  visibleMessages.map((msg) => (
                    <div key={msg.id} className="glass-card p-2.5 md:p-3 rounded-xl md:rounded-2xl animate-fade-in text-xs md:text-sm border-l-2 border-l-red-500/40">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold text-red-400 text-[10px] md:text-xs">{msg.sender}</span>
                        <span className="text-[9px] md:text-[10px] text-gray-500">{msg.time}</span>
                      </div>
                      <p className="text-gray-200 break-words">{msg.text}</p>
                    </div>
                  ))
                )}
              </div>

              <form onSubmit={sendChatMessage} className="flex items-center gap-2 shrink-0">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="پیام خود را بنویسید..."
                  className="input-field py-2 text-xs md:text-sm"
                />
                <button type="submit" aria-label="ارسال پیام" className="btn-primary p-2.5 rounded-xl shrink-0">
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>
          )}

          {/* Tab Content: Users */}
          {activeTab === 'users' && (
            <div className="flex-1 min-h-0 p-2.5 md:p-4 overflow-y-auto space-y-2.5 chat-scroll">
              {participants.map((user, idx) => {
                const me = isCurrentUser(user);
                const manageable = canManage && !me && !(user.isHost);
                return (
                  <div
                    key={user.id}
                    role={manageable ? 'button' : undefined}
                    tabIndex={manageable ? 0 : -1}
                    onClick={() => manageable && openManageModal(user)}
                    onKeyDown={(e) => {
                      if (manageable && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        openManageModal(user);
                      }
                    }}
                    className={`glass-card p-3 md:p-3.5 rounded-xl md:rounded-2xl flex items-center justify-between gap-2 ${
                      manageable ? 'cursor-pointer hover:border-red-500/50' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2.5 md:gap-3 min-w-0">
                      <div className="w-8 h-8 md:w-9 md:h-9 rounded-lg md:rounded-xl bg-red-600/20 border border-red-500/30 flex items-center justify-center font-bold text-red-300 text-xs md:text-sm shrink-0">
                        {user.name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <h4 className="font-bold text-xs md:text-sm text-white flex items-center gap-1.5 truncate">
                          {user.name}
                          {user.isHost && <Crown className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                          {!user.isHost && user.isAdmin && <Shield className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                          {me && <span className="text-[9px] text-gray-500 font-normal">(شما)</span>}
                        </h4>
                        <p className="text-[9px] md:text-[10px] text-gray-400">
                          {user.isHost ? 'میزبان اتاق' : user.isAdmin ? 'ادمین' : 'عضو اتاق'}
                        </p>
                      </div>
                    </div>
                    {manageable ? (
                      <Settings className="w-4 h-4 text-red-400/70 shrink-0" />
                    ) : (
                      <span className="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)] shrink-0"></span>
                    )}
                  </div>
                );
              })}
              {canManage && (
                <p className="text-[9px] md:text-[10px] text-gray-600 text-center pt-1">
                  برای مدیریت هر کاربر روی کارت او کلیک کنید
                </p>
              )}
            </div>
          )}

        </div>
      </div>

      {/* Footer */}
      <footer className="text-center py-1.5 text-[10px] md:text-xs text-gray-600 border-t border-white/5 bg-black/60 shrink-0">
        ساخته شده توسط <span className="text-red-500 font-bold">RADINMNX</span> — ببینیم
      </footer>

      {/* Share Room Modal */}
      <Modal isOpen={isShareModalOpen} onClose={() => setIsShareModalOpen(false)} title="دعوت دوستان به اتاق">
        <div className="space-y-4">
          <p className="text-sm text-gray-300 font-persian">
            برای تماشای همزمان فیلم با دوستانتان، لینک زیر یا کد اتاق را برای آن‌ها ارسال کنید:
          </p>

          <div className="p-3.5 rounded-2xl bg-black/60 border border-red-500/20 flex items-center justify-between gap-2">
            <span className="font-mono text-xs md:text-sm text-red-300 truncate max-w-[300px]" dir="ltr">{window.location.href}</span>
            <button
              onClick={copyRoomLink}
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

      {/* Manage User Modal */}
      <Modal
        isOpen={manageModalOpen}
        onClose={() => setManageModalOpen(false)}
        title={selectedUser ? `مدیریت کاربر: ${selectedUser.name}` : 'مدیریت کاربر'}
      >
        {selectedUser && (
          <div className="space-y-4">
            <div className="glass-card p-4 rounded-2xl flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-red-600/20 border border-red-500/30 flex items-center justify-center font-bold text-red-300">
                {selectedUser.name.charAt(0)}
              </div>
              <div>
                <h4 className="font-bold text-sm text-white">{selectedUser.name}</h4>
                <p className="text-[10px] text-gray-400">
                  {selectedUser.isHost ? 'میزبان اتاق' : selectedUser.isAdmin ? 'ادمین' : 'عضو اتاق'}
                </p>
              </div>
            </div>

            {isHost && !selectedUser.isHost && (
              <button
                onClick={() => toggleAdminRole(selectedUser.id, !selectedUser.isAdmin)}
                className={`btn-secondary w-full text-sm gap-2 ${selectedUser.isAdmin ? 'hover:border-red-500/70 hover:text-red-400' : ''}`}
              >
                {selectedUser.isAdmin
                  ? <><ShieldOff className="w-4 h-4 text-red-400" /> گرفتن دسترسی ادمین</>
                  : <><Shield className="w-4 h-4 text-red-400" /> ارتقا به ادمین</>}
              </button>
            )}

            {(isHost || (canManage && !selectedUser.isAdmin && !selectedUser.isHost)) && (
              <button
                onClick={() => kickUser(selectedUser.id)}
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

    </div>
  );
};

export default Room;