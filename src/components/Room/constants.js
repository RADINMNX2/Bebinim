// ---------------------------------------------------------------------------
// Room module: shared constants, config & pure helpers.
// Deliberately dependency-free so every Room sub-module can import from here.
// ---------------------------------------------------------------------------

// Default free STUN servers to maximize NAT traversal success inside Iran
export const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.services.mozilla.com' },
  { urls: 'stun:stun.1und1.de:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

// --- Xirsys TURN (free tier) ---
export const XIRSYS = {
  ident: 'RADINMNX',
  secret: '25a5cd9e-98ec-11f1-8480-cafcf9cf945e',
  channel: 'mnx-bebinim'
};
export const XIRSYS_TTL_MS = 30 * 60 * 1000;
let xirsysCache = null;

export const fetchXirsysTurn = async () => {
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

export const getUrlParams = () => new URLSearchParams(window.location.search);

// Robust TURN URL parser: accepts `turn:user:pass@host`, `turn:user:pass@host:3478`,
// `turns://user:pass@host:5349`, etc. (the old split(':') logic mangled these).
export const parseTurnParam = (raw) => {
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

export const buildPeerConfig = () => {
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

export const PEER_CONFIG = buildPeerConfig();
export const ACTIVE_SIGNALING = getUrlParams().get('sig') || '0.peerjs.com';
export const ACTIVE_TURN = getUrlParams().get('turn') || null;

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
export const SYNC_INTERVAL_MS = 2000;
export const SYNC_FAST_INTERVAL_MS = 900;
export const PING_INTERVAL_MS = 15000;
export const HEARTBEAT_INTERVAL_MS = 10000;
export const HEARTBEAT_TIMEOUT_MS = 45000;
export const MAX_RECONNECT_ATTEMPTS = 6;
export const RECONNECT_BASE_MS = 1000;
export const MAX_HOST_ID_RETRIES = 5;
export const HOST_ID_RETRY_DELAY_MS = 3000;
export const HARD_DRIFT_THRESHOLD = 1.0;
export const RATE_CORRECTION_GAIN = 0.12;
export const RATE_CORRECTION_LIMIT = 0.08;
export const DRIFT_SMA_WINDOW = 5;
export const FAST_AFTER_EVENT_MS = 5000;
export const DRIFT_REPORT_MIN_RTT = 120; // hard seeks are only safe once the clock is measured
export const BUFFER_SECONDS = 10;
export const MAX_CONNECT_RETRIES = 3;
export const RETRY_DELAY_MS = 2500;
export const CHAT_WINDOW = 60;
export const SKIP_SECONDS = 10;
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// Matroska/H.265 URL detection (query strings / fragments ignored)
export const isMkvLike = (url) => /\.(mkv|mks|hevc|h265|265)(?:[?#].*)?$/i.test(String(url || ''));

// Subtitle font options for the modern Select (family applied via CSS)
export const SUBTITLE_FONTS = [
  { value: 'inherit', label: 'پیش‌فرض' },
  { value: "'Vazirmatn', sans-serif", label: 'وزیرمتن' },
  { value: "'Inter', sans-serif", label: 'Inter' },
  { value: 'Tahoma', label: 'Tahoma' },
  { value: 'Arial', label: 'Arial' },
];

export const ACTION_LABELS = {
  toggle: 'پخش / توقف',
  seek: 'پرش به زمان',
  fullscreen: 'تمام صفحه'
};

export const EMOJIS = ['❤️', '🔥', '😂', '👏', '😮', '🎉', '🍿'];

// Default subtitle appearance — single source of truth for init AND reset
export const SUBTITLE_SETTINGS_DEFAULTS = {
  fontSize: 20,
  fontColor: '#ffffff',
  backgroundColor: '#000000',
  backgroundBlur: 4,
  verticalOffset: 24, // bottom offset in px
  fontFamily: 'inherit',
  textShadow: true,
};

export const hexToRgba = (hex, alpha) => {
  let h = String(hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

export const fmtTime = (sec) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  return `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, '0')}`;
};

// Full player time: "M:SS" under an hour, "H:MM:SS" above (movies are long).
export const fmtPlayerTime = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};

// Stored volume/mute preferences (persisted across visits)
export const readStoredVolume = () => {
  try {
    const n = parseFloat(localStorage.getItem('bebinim-volume'));
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
  } catch {
    return 1;
  }
};

export const readStoredMuted = () => {
  try {
    return localStorage.getItem('bebinim-muted') === '1';
  } catch {
    return false;
  }
};

// iOS/iPadOS detection — safe to compute once at module scope: Room is
// lazy-loaded in the browser, so `navigator` is always available here.
export const IS_IOS = (() => {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/i.test(ua)
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // iPadOS 13+
})();

// Play only when the element can actually play (never stalls on buffering).
// Resolves `true` on success so callers don't lie about the play state.
export const safePlay = (video) => {
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