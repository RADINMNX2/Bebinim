import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import Peer from 'peerjs';
import {
  Play, Pause, Volume2, VolumeX, Maximize, Share2, Users, MessageSquare,
  Send, Link as LinkIcon, Film, LogOut, Check, Radio, Wifi, RefreshCw,
  Crown, Shield, ShieldOff, UserX, Settings, Loader2
} from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { Modal } from '../UI/Modal';

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
// Credentials are fetched at runtime via the Xirsys API so they can be rotated
// from the Xirsys dashboard without rebuilding the app. Used only as a fallback
// when direct P2P fails; if the TURN server is unreachable, WebRTC keeps working
// over STUN/P2P (graceful degradation).
const XIRSYS = {
  ident: 'RADINMNX',
  secret: '25a5cd9e-98ec-11f1-8480-cafcf9cf945e',
  channel: 'mnx-bebinim'
};
const XIRSYS_TTL_MS = 30 * 60 * 1000; // Refresh cached TURN creds every 30min
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

// --- Connection config from the URL (no rebuild needed) ---
// ?sig=ws://host:port        -> custom signaling server (PeerJS server, your PC or VPS)
// ?turn=turn:host:port:user:pass -> add a TURN relay (Metered Open Relay, Xirsys, coturn...)
// Both get embedded automatically into every invite link, so guests join the same network.
// Without ?turn=, the built-in Xirsys free TURN is fetched automatically at runtime.
const getUrlParams = () => new URLSearchParams(window.location.search);

const buildPeerConfig = () => {
  const iceServers = [...DEFAULT_STUN_SERVERS];

  const turnParam = getUrlParams().get('turn');
  if (turnParam) {
    const parts = turnParam.split(':');
    const username = parts[parts.length - 2];
    const credential = parts[parts.length - 1];
    const turnUrl = parts.slice(0, parts.length - 2).join(':');
    if (turnUrl.startsWith('turn:') || turnUrl.startsWith('turns:')) {
      iceServers.push({ urls: turnUrl, username, credential });
    }
  }

  const config = {
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    config: { iceServers },
    debug: 1
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
// Strategy:
//  1. Host is the media reference clock. It broadcasts full state every 2s
//     with an ever-increasing sequence number (stale SYNCs are dropped).
//  2. Guests measure the host clock offset with NTP-style PING/PONG (lowest
//     RTT wins) and extrapolate the host position at the moment of receipt:
//     est = sentTime + (now - sentAt + clockOffset).
//  3. Small drift is corrected with a smooth playbackRate adjustment (no
//     seeking, no visual jumps). Only drift >= HARD_DRIFT_THRESHOLD triggers
//     a precise seek. Play/pause transitions always align exactly.
//  4. Video changes force a 10s pre-buffer on EVERY client; play is gated on
//     a shared absolute deadline (readyAt) so nobody starts ahead of others.
const SYNC_INTERVAL_MS = 2000;        // Host broadcasts full state every 2s
const PING_INTERVAL_MS = 15000;       // Guests re-measure host clock offset
const HARD_DRIFT_THRESHOLD = 1.0;     // Drift >= 1s -> hard seek
const RATE_CORRECTION_GAIN = 0.12;    // playbackRate = 1 + drift * gain
const RATE_CORRECTION_LIMIT = 0.08;   // max smooth rate deviation (8%)
const BUFFER_SECONDS = 10;            // Pre-buffer before a new video plays
const MAX_CONNECT_RETRIES = 3;        // Guest retries to find the host
const RETRY_DELAY_MS = 2500;
const CHAT_WINDOW = 60;               // Lazy chat: render at most N messages

export const Room = ({ roomId, userName, isHost, onLeave }) => {
  const [connections, setConnections] = useState([]);
  const [participants, setParticipants] = useState([{ id: 'self', name: userName, isHost, isAdmin: false }]);
  const [messages, setMessages] = useState([]);
  const [chatWindow, setChatWindow] = useState(CHAT_WINDOW);
  const [chatInput, setChatInput] = useState('');

  // Video state
  const [videoUrl, setVideoUrl] = useState('');
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferCountdown, setBufferCountdown] = useState(0);

  // Role / management state
  const [selfIsAdmin, setSelfIsAdmin] = useState(false);
  const [manageModalOpen, setManageModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);

  // UI states
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' | 'users'
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [reactions, setReactions] = useState([]);
  const [isCopied, setIsCopied] = useState(false);
  const [xirsysTurnActive, setXirsysTurnActive] = useState(false);

  const videoRef = useRef(null);
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

  // Sync internals
  const clockOffsetRef = useRef(0);      // hostClock - guestClock (ms)
  const bestRttRef = useRef(Infinity);
  const seqRef = useRef(0);              // host: broadcast sequence
  const lastSeqRef = useRef(-1);         // guest: last applied sequence
  const readyAtRef = useRef(0);          // shared play deadline after video change
  const pendingAutoPlayRef = useRef(false);
  const bufferTimerRef = useRef(null);
  const leavingRef = useRef(false);

  // Fresh refs for role checks inside event handlers
  const selfIsAdminRef = useRef(false);
  const isHostRef = useRef(isHost);
  selfIsAdminRef.current = selfIsAdmin;
  isHostRef.current = isHost;
  participantsRef.current = participants;

  const canControl = isHost || selfIsAdmin;
  const canControlRef = useRef(canControl);
  canControlRef.current = canControl;

  const { addToast } = useToast();

  useEffect(() => { videoUrlRef.current = videoUrl; }, [videoUrl]);

  // Broadcast to all connected peers (uses ref so closures never go stale)
  const broadcast = (data, excludePeerId = null) => {
    connectionsRef.current.forEach((conn) => {
      if (conn.open && conn.peer !== excludePeerId) {
        conn.send(data);
      }
    });
  };
  broadcastRef.current = broadcast;

  // --- Host periodic sync loop: keeps everyone precisely aligned ---
  useEffect(() => {
    if (!isHost) return;
    const interval = setInterval(() => {
      if (videoRef.current && connectionsRef.current.length > 0) {
        seqRef.current += 1;
        broadcastRef.current({
          type: 'SYNC',
          url: videoUrlRef.current,
          time: videoRef.current.currentTime,
          playing: !videoRef.current.paused,
          sentAt: Date.now(),
          seq: seqRef.current
        });
      }
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isHost]);

  // --- Guest clock-offset measurement (NTP-style, lowest RTT wins) ---
  useEffect(() => {
    if (isHost) return;
    const measure = () => {
      connectionsRef.current.forEach((c) => {
        if (c.open) c.send({ type: 'PING', t0: Date.now() });
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
        // The host (reference clock) starts playback once the buffer window ends
        if (isHostRef.current) {
          const v = videoRef.current;
          if (v && v.readyState >= 2 && v.paused) {
            v.play().catch(() => {});
            setIsPlaying(true);
            broadcastRef.current({ type: 'PLAY', currentTime: v.currentTime, sentAt: Date.now() });
          } else {
            pendingAutoPlayRef.current = true;
          }
        }
      }
    }, 500);
  };

  // --- Latency-compensated sync application ---
  const applySync = (data) => {
    const video = videoRef.current;
    if (!video) return;

    const now = Date.now();
    // Drop stale periodic broadcasts (out-of-order / duplicates)
    if (data.seq != null) {
      if (data.seq <= lastSeqRef.current) return;
      lastSeqRef.current = data.seq;
    }

    // Extrapolate the host's media position at this instant, compensating for
    // both network latency and host/guest clock skew.
    const elapsed = (now - (data.sentAt || now) + clockOffsetRef.current) / 1000;
    let estTime = (data.time || 0) + elapsed;

    // Source video changed on the host -> load it first, seek after metadata
    if (data.url && data.url !== videoUrlRef.current) {
      pendingSeekRef.current = Math.max(0, estTime);
      videoUrlRef.current = data.url;
      setVideoUrl(data.url);
      startBuffering(data.readyAt || now + BUFFER_SECONDS * 1000);
      return;
    }

    // Everyone waits for the shared pre-buffer deadline before playing
    if (readyAtRef.current && now < readyAtRef.current) return;

    const maxTime = video.duration || estTime;
    estTime = Math.min(estTime, maxTime);
    const drift = estTime - video.currentTime;
    const nowPlaying = !video.paused;

    if (data.playing !== nowPlaying) {
      // Play/Pause transition -> align precisely and immediately
      isSyncingRef.current = true;
      if (data.playing) {
        video.currentTime = estTime;
        video.play().catch(() => {});
        setIsPlaying(true);
      } else {
        video.pause();
        if (Math.abs(drift) > 0.5) video.currentTime = estTime;
        setIsPlaying(false);
      }
      video.playbackRate = 1;
      lastCorrectionRef.current = now;
      setTimeout(() => { isSyncingRef.current = false; }, 300);
    } else if (data.playing) {
      if (Math.abs(drift) >= HARD_DRIFT_THRESHOLD) {
        // Big drift -> precise seek
        isSyncingRef.current = true;
        video.currentTime = estTime;
        video.playbackRate = 1;
        lastCorrectionRef.current = now;
        setTimeout(() => { isSyncingRef.current = false; }, 300);
      } else if (Math.abs(drift) > 0.05) {
        // Small drift -> smooth playbackRate correction, zero visual jumps
        video.playbackRate = 1 + Math.max(
          -RATE_CORRECTION_LIMIT,
          Math.min(RATE_CORRECTION_LIMIT, drift * RATE_CORRECTION_GAIN)
        );
      } else {
        video.playbackRate = 1;
      }
    } else {
      if (Math.abs(drift) > 0.5) {
        isSyncingRef.current = true;
        video.currentTime = estTime;
        lastCorrectionRef.current = now;
        setTimeout(() => { isSyncingRef.current = false; }, 300);
      }
      video.playbackRate = 1;
    }
  };

  const handleKicked = () => {
    leavingRef.current = true;
    addToast('شما توسط میزبان از اتاق حذف شدید', 'error');
    setTimeout(onLeave, 600);
  };

  const handlePeerData = (data, conn) => {
    switch (data.type) {
      case 'JOIN_ROOM':
        setParticipants((prev) => {
          if (prev.some((p) => p.id === conn.peer)) return prev;
          addToast(`${data.name} به اتاق پیوست`, 'success');
          return [...prev, { id: conn.peer, name: data.name, isHost: false, isAdmin: false }];
        });
        break;

      case 'REQUEST_STATE':
        if (isHost && videoRef.current) {
          seqRef.current += 1;
          conn.send({
            type: 'SYNC',
            url: videoUrlRef.current,
            time: videoRef.current.currentTime,
            playing: !videoRef.current.paused,
            sentAt: Date.now(),
            seq: seqRef.current
          });
        }
        break;

      case 'SYNC':
        applySync(data);
        break;

      case 'PLAY':
        applySync({ ...data, playing: true, time: data.currentTime });
        break;

      case 'PAUSE':
        applySync({ ...data, playing: false, time: data.currentTime });
        break;

      case 'SEEK':
        if (videoRef.current && !isSyncingRef.current) {
          const est = (data.currentTime || 0)
            + (Date.now() - (data.sentAt || Date.now()) + clockOffsetRef.current) / 1000;
          videoRef.current.currentTime = Math.min(est, videoRef.current.duration || est);
        }
        break;

      case 'CHANGE_VIDEO':
        if (data.url && data.url !== videoUrlRef.current) {
          pendingSeekRef.current = 0;
          videoUrlRef.current = data.url;
          setVideoUrl(data.url);
          startBuffering(data.readyAt || Date.now() + BUFFER_SECONDS * 1000);
        }
        addToast(`ویدیو در حال بارگذاری: ${data.title || 'ویدیو جدید'}`, 'info');
        break;

      case 'CHAT_MESSAGE':
        setMessages((prev) => [...prev, { sender: data.sender, text: data.text, time: data.time }]);
        break;

      case 'REACTION':
        triggerFloatingReaction(data.emoji);
        break;

      case 'PING':
        conn.send({ type: 'PONG', t0: data.t0, hostTime: Date.now() });
        break;

      case 'PONG': {
        const rtt = Date.now() - data.t0;
        if (rtt < bestRttRef.current) {
          bestRttRef.current = rtt;
          clockOffsetRef.current = data.hostTime - (data.t0 + rtt / 2);
        }
        break;
      }

      case 'UPDATE_ROLE':
        setParticipants((prev) =>
          prev.map((p) => (p.id === data.targetId ? { ...p, isAdmin: data.isAdmin } : p))
        );
        if (peerRef.current && data.targetId === peerRef.current.id) {
          setSelfIsAdmin(data.isAdmin);
        }
        break;

      case 'KICK':
        setParticipants((prev) => prev.filter((p) => p.id !== data.targetId));
        if (peerRef.current && data.targetId === peerRef.current.id) {
          handleKicked();
        }
        break;

      case 'KICKED':
        handleKicked();
        break;

      default:
        break;
    }
  };

  // --- Initialize PeerJS ---
  useEffect(() => {
    const peerId = isHost
      ? `bebinim-host-${roomId}`
      : `bebinim-guest-${roomId}-${Math.random().toString(36).substring(2, 6)}`;

    let cancelled = false;
    const initPeer = async () => {
      const config = {
        ...PEER_CONFIG,
        config: { ...PEER_CONFIG.config, iceServers: [...PEER_CONFIG.config.iceServers] }
      };

      // Auto-TURN: unless an explicit ?turn= relay was given, try Xirsys free TURN
      if (!ACTIVE_TURN) {
        const turnServers = await fetchXirsysTurn();
        if (cancelled) return;
        if (turnServers) {
          config.config.iceServers.push(...turnServers);
          setXirsysTurnActive(true);
        }
      }

      const p = new Peer(peerId, config);
      peerRef.current = p;

      p.on('open', (id) => {
        console.log('Peer connected with ID:', id);
        if (isHost) {
          addToast(`اتاق ایجاد شد. کد اتاق: ${roomId}`, 'success');
        } else {
          addToast('در حال اتصال به میزبان...', 'info');
          connectToHost(p, `bebinim-host-${roomId}`, 1);
        }
      });

      p.on('connection', (conn) => {
        setupConnection(conn, 1);
      });

      p.on('error', (err) => {
        console.error('Peer error:', err);
        if (err.type !== 'peer-unavailable') {
          addToast(`خطای اتصال P2P: ${err.type || err.message}`, 'error');
        }
      });
    };

    initPeer();

    return () => {
      cancelled = true;
      leavingRef.current = true;
      connectionsRef.current = [];
      clearInterval(bufferTimerRef.current);
      if (peerRef.current) peerRef.current.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const connectToHost = (pInstance, hostPeerId, attempt) => {
    const conn = pInstance.connect(hostPeerId, { reliable: true });
    setupConnection(conn, attempt);
  };

  const setupConnection = (conn, attempt = 1) => {
    let settled = false;

    conn.on('error', (err) => {
      if (settled) return;
      if (err.type === 'peer-unavailable' && attempt < MAX_CONNECT_RETRIES) {
        settled = true;
        addToast(`میزبان هنوز آنلاین نیست، تلاش مجدد (${attempt}/${MAX_CONNECT_RETRIES - 1})...`, 'info');
        setTimeout(() => {
          if (peerRef.current) {
            const retry = peerRef.current.connect(`bebinim-host-${roomId}`, { reliable: true });
            setupConnection(retry, attempt + 1);
          }
        }, RETRY_DELAY_MS);
      } else if (!settled) {
        settled = true;
        addToast(`خطای اتصال: ${err.type || err.message}`, 'error');
      }
    });

    conn.on('open', () => {
      settled = true;
      const exists = connectionsRef.current.some((c) => c.peer === conn.peer);
      if (!exists) {
        connectionsRef.current = [...connectionsRef.current, conn];
        setConnections((prev) => (prev.some((c) => c.peer === conn.peer) ? prev : [...prev, conn]));
      }

      conn.send({
        type: 'JOIN_ROOM',
        name: userName,
        isHost: false,
        isAdmin: selfIsAdminRef.current
      });

      if (isHost) {
        // Send current full state to the newly joined peer right away
        if (videoRef.current) {
          seqRef.current += 1;
          conn.send({
            type: 'SYNC',
            url: videoUrlRef.current,
            time: videoRef.current.currentTime,
            playing: !videoRef.current.paused,
            sentAt: Date.now(),
            seq: seqRef.current
          });
        }
      } else {
        // Ask the host for the current state (reliable late-join catch-up)
        setTimeout(() => conn.send({ type: 'REQUEST_STATE' }), 300);
      }
    });

    conn.on('data', (data) => {
      handlePeerData(data, conn);
    });

    conn.on('close', () => {
      connectionsRef.current = connectionsRef.current.filter((c) => c.peer !== conn.peer);
      setConnections((prev) => prev.filter((c) => c.peer !== conn.peer));
      setParticipants((prev) => prev.filter((p) => p.id !== conn.peer));
      if (!leavingRef.current) {
        addToast('یکی از کاربران اتاق را ترک کرد', 'info');
      }
    });
  };

  // --- Video control handlers (with latency timestamp for accurate sync) ---
  const togglePlay = () => {
    if (!canControlRef.current) return;
    if (isBuffering) {
      addToast(`ویدیو در حال بارگذاری است (${bufferCountdown}s)...`, 'info');
      return;
    }
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
      broadcastRef.current({
        type: 'PLAY',
        currentTime: videoRef.current.currentTime,
        sentAt: Date.now()
      });
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
      broadcastRef.current({
        type: 'PAUSE',
        currentTime: videoRef.current.currentTime,
        sentAt: Date.now()
      });
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleSeek = (e) => {
    if (!canControlRef.current || isBuffering) return;
    const newTime = parseFloat(e.target.value);
    setCurrentTime(newTime);
    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
    }
    if (!isSyncingRef.current) {
      broadcastRef.current({
        type: 'SEEK',
        currentTime: newTime,
        sentAt: Date.now()
      });
    }
  };

  const handleVideoSelect = (url, title) => {
    pendingSeekRef.current = 0;
    videoUrlRef.current = url;
    setVideoUrl(url);
    setIsUrlModalOpen(false);
    const readyAt = Date.now() + BUFFER_SECONDS * 1000;
    startBuffering(readyAt);
    broadcastRef.current({
      type: 'CHANGE_VIDEO',
      url,
      title,
      readyAt
    });
    addToast(`ویدیو در حال بارگذاری (${BUFFER_SECONDS} ثانیه)...`, 'info');
  };

  const handleCustomUrlSubmit = (e) => {
    e.preventDefault();
    if (!customUrlInput.trim()) return;
    handleVideoSelect(customUrlInput.trim(), 'لینک سفارشی');
    setCustomUrlInput('');
  };

  // --- Manual re-sync (no page reload: everyone aligns to the host again) ---
  const syncNow = () => {
    if (isHost) {
      if (videoRef.current) {
        seqRef.current += 1;
        broadcastRef.current({
          type: 'SYNC',
          url: videoUrlRef.current,
          time: videoRef.current.currentTime,
          playing: !videoRef.current.paused,
          sentAt: Date.now(),
          seq: seqRef.current
        });
      }
    } else {
      connectionsRef.current.forEach((c) => {
        if (c.open) c.send({ type: 'REQUEST_STATE' });
      });
    }
    addToast('همگام‌سازی مجدد انجام شد', 'success');
  };

  // --- Chat (lazy loading: only the last N messages are rendered) ---
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

  // Keep chat pinned to the bottom for new messages (unless user scrolled up)
  useLayoutEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    if (pendingChatShiftRef.current != null) {
      // Keep scroll position stable while older messages load above
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
      sender: userName,
      text: chatInput.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages((prev) => [...prev, newMsg]);
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

  const copyRoomLink = () => {
    const link = window.location.href;
    navigator.clipboard.writeText(link);
    setIsCopied(true);
    addToast('لینک اتاق کپی شد!', 'success');
    setTimeout(() => setIsCopied(false), 2000);
  };

  // --- User management (host/admin) ---
  const canManage = canControl;
  const canManageRef = useRef(canManage);
  canManageRef.current = canManage;

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

  const syncStatus = connections.length > 0
    ? `همگام‌سازی زنده P2P (${connections.length} اتصال)`
    : isHost
      ? 'در انتظار مهمان‌ها...'
      : 'در حال برقراری اتصال P2P...';

  const signalingHost = ACTIVE_SIGNALING.includes('://')
    ? new URL(ACTIVE_SIGNALING).host
    : ACTIVE_SIGNALING;

  const isCurrentUser = (user) => user.id === 'self' || (peerRef.current && user.id === peerRef.current.id);

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
            className="btn-secondary py-2 px-2.5 md:px-3.5 text-xs md:text-sm gap-1.5"
          >
            <Share2 className="w-4 h-4 text-red-400" />
            <span className="hidden sm:inline">دعوت دوستان</span>
          </button>

          <button
            onClick={onLeave}
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

          {/* Video Container with Floating Reactions */}
          <div className="relative w-full aspect-video bg-black rounded-2xl md:rounded-3xl overflow-hidden border border-red-500/20 shadow-[0_0_40px_rgba(239,68,68,0.15)] group flex items-center justify-center gpu-layer">

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
              // Placeholder when no video has been chosen yet
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-gradient-to-b from-black via-zinc-950 to-black z-10 px-4 text-center">
                <Film className="w-12 h-12 md:w-16 md:h-16 text-red-500/70 neon-text" />
                <p className="text-sm md:text-base text-gray-400 font-persian">
                  هنوز ویدیویی انتخاب نشده است
                </p>
                <button
                  onClick={() => setIsUrlModalOpen(true)}
                  className="btn-primary text-xs md:text-sm"
                >
                  <Film className="w-4 h-4" />
                  انتخاب یا وارد کردن لینک ویدیو
                </button>
              </div>
            ) : (
              <video
                ref={videoRef}
                src={videoUrl}
                playsInline
                className="w-full h-full object-contain cursor-pointer"
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={() => {
                  if (videoRef.current) {
                    setDuration(videoRef.current.duration);
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
                    v.play().catch(() => {});
                    setIsPlaying(true);
                    broadcastRef.current({ type: 'PLAY', currentTime: v.currentTime, sentAt: Date.now() });
                  }
                }}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onClick={togglePlay}
              />
            )}

            {/* Buffering overlay (10s pre-buffer after a video change) */}
            {isBuffering && videoUrl && (
              <div className="absolute inset-0 z-30 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-10 h-10 md:w-14 md:h-14 text-red-500 animate-spin" />
                <p className="text-sm md:text-base text-gray-200 font-persian">در حال بارگذاری ویدیو...</p>
                <p className="text-2xl md:text-4xl font-bold text-red-400 neon-text">{bufferCountdown}s</p>
                <p className="text-[10px] md:text-xs text-gray-500 font-persian">
                  برای هماهنگی همهٔ کاربران، پخش بعد از {BUFFER_SECONDS} ثانیه شروع می‌شود
                </p>
              </div>
            )}

            {/* Video Overlay Controls on Hover */}
            <div className={`absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-between p-3 md:p-6 z-10 overlay-coarse ${canControl ? '' : 'pointer-events-none'}`}>

              {/* Top Video bar */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 md:w-2.5 md:h-2.5 rounded-full ${connections.length > 0 ? 'bg-red-500 shadow-[0_0_10px_red] animate-pulse' : 'bg-amber-500 animate-pulse'}`}></span>
                  <span className="text-[10px] md:text-xs font-medium text-gray-300 flex items-center gap-1.5 truncate">
                    {connections.length > 0 ? <Radio className="w-3 h-3 md:w-3.5 md:h-3.5 text-red-400" /> : <Wifi className="w-3 h-3 md:w-3.5 md:h-3.5 text-amber-400" />}
                    {syncStatus}
                  </span>
                </div>
                {canControl && (
                  <button
                    onClick={() => setIsUrlModalOpen(true)}
                    className="btn-secondary py-1.5 px-3 text-xs gap-1.5 bg-black/40 shrink-0"
                  >
                    <Film className="w-3.5 h-3.5 text-red-400" />
                    <span>تغییر ویدیو</span>
                  </button>
                )}
              </div>

              {/* Center big play/pause on hover if needed */}
              {canControl && (
                <div className="self-center">
                  <button
                    onClick={togglePlay}
                    disabled={isBuffering}
                    className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-red-600/80 hover:bg-red-600 disabled:opacity-50 text-white flex items-center justify-center backdrop-blur-md shadow-[0_0_30px_rgba(239,68,68,0.5)] transition-all transform hover:scale-110 active:scale-95"
                  >
                    {isBuffering ? <Loader2 className="w-7 h-7 animate-spin" /> : (isPlaying ? <Pause className="w-7 h-7 md:w-8 md:h-8" /> : <Play className="w-7 h-7 md:w-8 md:h-8 ml-1" />)}
                  </button>
                </div>
              )}

              {/* Bottom Video Controls Bar */}
              <div className="flex flex-col gap-2.5 md:gap-3">
                {/* Progress bar */}
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  value={currentTime}
                  onChange={handleSeek}
                  disabled={!canControl || isBuffering}
                  className="neon-range w-full"
                />

                <div className="flex items-center justify-between gap-2 text-[10px] md:text-xs text-gray-300">
                  <div className="flex items-center gap-2 md:gap-4 min-w-0">
                    {canControl && (
                      <button onClick={togglePlay} disabled={isBuffering} className="hover:text-red-400 transition-colors">
                        {isBuffering ? <Loader2 className="w-4 h-4 md:w-5 md:h-5 animate-spin" /> : (isPlaying ? <Pause className="w-4 h-4 md:w-5 md:h-5" /> : <Play className="w-4 h-4 md:w-5 md:h-5" />)}
                      </button>
                    )}

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          if (videoRef.current) {
                            videoRef.current.muted = !isMuted;
                            setIsMuted(!isMuted);
                          }
                        }}
                        className="hover:text-red-400 transition-colors"
                      >
                        {isMuted ? <VolumeX className="w-4 h-4 md:w-5 md:h-5 text-red-400" /> : <Volume2 className="w-4 h-4 md:w-5 md:h-5" />}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={isMuted ? 0 : volume}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setVolume(v);
                          setIsMuted(v === 0);
                          if (videoRef.current) videoRef.current.volume = v;
                        }}
                        className="neon-range w-16 md:w-20 hidden md:block"
                      />
                    </div>

                    <span className="tabular-nums whitespace-nowrap">
                      {Math.floor(currentTime / 60)}:{Math.floor(currentTime % 60).toString().padStart(2, '0')} / {Math.floor(duration / 60)}:{Math.floor(duration % 60).toString().padStart(2, '0')}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 md:gap-3 shrink-0">
                    <button
                      onClick={() => {
                        if (videoRef.current) {
                          if (document.fullscreenElement) {
                            document.exitFullscreen();
                          } else {
                            videoRef.current.requestFullscreen?.();
                          }
                        }
                      }}
                      className="hover:text-red-400 transition-colors flex items-center gap-1"
                    >
                      <Maximize className="w-4 h-4 md:w-5 md:h-5" />
                      <span className="hidden md:inline">تمام صفحه</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Non-controller hint */}
            {!canControl && videoUrl && (
              <div className="absolute top-14 md:top-16 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
                <span className="text-[10px] md:text-xs px-2.5 py-1 rounded-full bg-black/60 border border-white/10 text-gray-400 whitespace-nowrap">
                  کنترل توسط میزبان/ادمین انجام می‌شود
                </span>
              </div>
            )}
          </div>

          {/* Quick Reactions Bar */}
          <div className="bg-zinc-950/80 border border-white/10 rounded-2xl p-2.5 md:p-3 flex items-center justify-between px-3 md:px-6 backdrop-blur-xl flex-wrap gap-2 shrink-0">
            <span className="text-[10px] md:text-xs font-medium text-gray-400 hidden sm:inline">واکنش سریع:</span>
            <div className="flex items-center gap-2 md:gap-6 mx-auto sm:mx-0 flex-wrap justify-center">
              {['❤️', '🔥', '😂', '👏', '😮', '🎉', '🍿'].map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => sendReaction(emoji)}
                  className="text-xl md:text-2xl hover:scale-125 transition-transform p-1 rounded-lg md:p-1.5 md:rounded-xl hover:bg-red-500/10"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Sidebar: Tabs (Chat, Users) */}
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

          {/* Tab Content: Chat (bounded height + lazy loading + inner scroll) */}
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
                  visibleMessages.map((msg, idx) => (
                    <div key={messages.length - chatWindow + idx} className="glass-card p-2.5 md:p-3 rounded-xl md:rounded-2xl animate-fade-in text-xs md:text-sm border-l-2 border-l-red-500/40">
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
                <button type="submit" className="btn-primary p-2.5 rounded-xl shrink-0">
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>
          )}

          {/* Tab Content: Users (with role management) */}
          {activeTab === 'users' && (
            <div className="flex-1 min-h-0 p-2.5 md:p-4 overflow-y-auto space-y-2.5 chat-scroll">
              {participants.map((user, idx) => {
                const me = isCurrentUser(user);
                const manageable = canManage && !me && !(user.isHost);
                return (
                  <div
                    key={user.id}
                    onClick={() => manageable && openManageModal(user)}
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
          </div>
        </div>
      </Modal>

      {/* Change Video Modal (direct URL only - no test videos) */}
      <Modal isOpen={isUrlModalOpen} onClose={() => setIsUrlModalOpen(false)} title="تغییر ویدیو">
        <div className="space-y-4">
          <p className="text-sm text-gray-300 font-persian">لینک مستقیم ویدیو را وارد کنید (MP4/WebM):</p>

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