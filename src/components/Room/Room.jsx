import React, { useState, useEffect, useRef } from 'react';
import Peer from 'peerjs';
import { 
  Play, Pause, Volume2, VolumeX, Maximize, Share2, Users, MessageSquare, 
  Send, Link as LinkIcon, Film, LogOut, Check, Radio, Wifi
} from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { Modal } from '../UI/Modal';

// Sample public domain / test video links
const SAMPLE_VIDEOS = [
  { title: 'Big Buck Bunny (انیمیشن)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
  { title: 'Elephants Dream (فانتزی)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4' },
  { title: 'Tears of Steel (علمی تخیلی)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' },
  { title: 'Sintel (ماجراجویی)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4' }
];

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

// --- Connection config from the URL (no rebuild needed) ---
// ?sig=ws://host:port        -> custom signaling server (PeerJS server, your PC or VPS)
// ?turn=turn:host:port:user:pass -> add a TURN relay (Metered Open Relay, Xirsys, coturn...)
// Both get embedded automatically into every invite link, so guests join the same network.
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

// Sync tuning parameters
const SYNC_INTERVAL_MS = 4000;        // Host broadcasts full state every 4s
const HARD_DRIFT_THRESHOLD = 1.5;     // Immediate seek if more than 1.5s off
const SOFT_DRIFT_THRESHOLD = 0.6;     // Seek if more than 0.6s off and cooldown passed
const CORRECTION_COOLDOWN_MS = 4000;  // Avoid seek-thrashing
const MAX_CONNECT_RETRIES = 3;        // Guest retries to find the host
const RETRY_DELAY_MS = 2500;

export const Room = ({ roomId, userName, isHost, onLeave }) => {
  const [connections, setConnections] = useState([]); // Array of active DataConnections
  const [participants, setParticipants] = useState([{ id: 'self', name: userName, isHost }]);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');

  // Video state
  const [videoUrl, setVideoUrl] = useState(SAMPLE_VIDEOS[0].url);
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  // UI states
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' | 'users' | 'movies'
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [reactions, setReactions] = useState([]); // Floating reactions
  const [isCopied, setIsCopied] = useState(false);

  const videoRef = useRef(null);
  const peerRef = useRef(null);
  const connectionsRef = useRef([]);   // Mirror of connections state (for closures)
  const isSyncingRef = useRef(false);  // Prevents infinite loops on sync events
  const pendingSeekRef = useRef(null); // Seek target applied after video metadata loads
  const lastCorrectionRef = useRef(0); // Timestamp of last corrective seek
  const videoUrlRef = useRef(videoUrl);
  const broadcastRef = useRef(null);
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

  // --- Initialize PeerJS ---
  useEffect(() => {
    const peerId = isHost
      ? `bebinim-host-${roomId}`
      : `bebinim-guest-${roomId}-${Math.random().toString(36).substring(2, 6)}`;

    const p = new Peer(peerId, PEER_CONFIG);
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

    return () => {
      connectionsRef.current = [];
      p.destroy();
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
      // Host not reachable yet -> retry a few times with backoff
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
        isHost: false
      });

      if (isHost) {
        // Send current full state to the newly joined peer right away
        if (videoRef.current) {
          conn.send({
            type: 'SYNC',
            url: videoUrlRef.current,
            time: videoRef.current.currentTime,
            playing: !videoRef.current.paused,
            sentAt: Date.now()
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
      addToast('یکی از کاربران اتاق را ترک کرد', 'info');
    });
  };

  // --- Host periodic sync loop: keeps everyone precisely aligned ---
  useEffect(() => {
    if (!isHost) return;
    const interval = setInterval(() => {
      if (videoRef.current && connectionsRef.current.length > 0) {
        broadcastRef.current({
          type: 'SYNC',
          url: videoUrlRef.current,
          time: videoRef.current.currentTime,
          playing: !videoRef.current.paused,
          sentAt: Date.now()
        });
      }
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isHost]);

  // --- Latency-compensated sync application ---
  // Host media time advances in real time, so by extrapolating with the elapsed
  // wall-clock we get the host's current position at the moment of receipt,
  // regardless of clock skew between the two machines.
  const applySync = (data) => {
    const video = videoRef.current;
    if (!video) return;

    const now = Date.now();
    const elapsed = (now - (data.sentAt || now)) / 1000;
    let estTime = (data.time || 0) + elapsed;

    // Source video changed on the host -> load it first, seek after metadata
    if (data.url && data.url !== videoUrlRef.current) {
      pendingSeekRef.current = estTime;
      videoUrlRef.current = data.url;
      setVideoUrl(data.url);
      return;
    }

    const maxTime = video.duration || estTime;
    estTime = Math.min(estTime, maxTime);
    const drift = estTime - video.currentTime;
    const nowPlaying = !video.paused;
    const bigDrift = Math.abs(drift) > HARD_DRIFT_THRESHOLD;
    const recentCorrection = now - lastCorrectionRef.current < CORRECTION_COOLDOWN_MS;

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
      lastCorrectionRef.current = now;
      setTimeout(() => { isSyncingRef.current = false; }, 300);
    } else if (data.playing && (bigDrift || (!recentCorrection && Math.abs(drift) > SOFT_DRIFT_THRESHOLD))) {
      // Continuous playback correction (bounded by cooldown to stay smooth)
      isSyncingRef.current = true;
      video.currentTime = estTime;
      lastCorrectionRef.current = now;
      setTimeout(() => { isSyncingRef.current = false; }, 300);
    } else if (!data.playing && Math.abs(drift) > 0.5) {
      isSyncingRef.current = true;
      video.currentTime = estTime;
      lastCorrectionRef.current = now;
      setTimeout(() => { isSyncingRef.current = false; }, 300);
    }
  };

  const handlePeerData = (data, conn) => {
    switch (data.type) {
      case 'JOIN_ROOM':
        setParticipants((prev) => {
          if (prev.some((p) => p.id === conn.peer)) return prev;
          addToast(`${data.name} به اتاق پیوست`, 'success');
          return [...prev, { id: conn.peer, name: data.name, isHost: data.isHost }];
        });
        break;

      case 'REQUEST_STATE':
        if (isHost && videoRef.current) {
          conn.send({
            type: 'SYNC',
            url: videoUrlRef.current,
            time: videoRef.current.currentTime,
            playing: !videoRef.current.paused,
            sentAt: Date.now()
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
          const est = (data.currentTime || 0) + (Date.now() - (data.sentAt || Date.now())) / 1000;
          videoRef.current.currentTime = Math.min(est, videoRef.current.duration || est);
        }
        break;

      case 'CHANGE_VIDEO':
        if (data.url && data.url !== videoUrlRef.current) {
          pendingSeekRef.current = 0;
          videoUrlRef.current = data.url;
          setVideoUrl(data.url);
        }
        addToast(`ویدیو تغییر کرد به: ${data.title || 'ویدیو جدید'}`, 'info');
        break;

      case 'CHAT_MESSAGE':
        setMessages((prev) => [...prev, { sender: data.sender, text: data.text, time: data.time }]);
        break;

      case 'REACTION':
        triggerFloatingReaction(data.emoji);
        break;

      default:
        break;
    }
  };

  // --- Video control handlers (with latency timestamp for accurate sync) ---
  const togglePlay = () => {
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
    pendingSeekRef.current = null;
    videoUrlRef.current = url;
    setVideoUrl(url);
    setIsUrlModalOpen(false);
    broadcastRef.current({
      type: 'CHANGE_VIDEO',
      url,
      title
    });
    addToast('ویدیو تغییر یافت', 'success');
  };

  const handleCustomUrlSubmit = (e) => {
    e.preventDefault();
    if (!customUrlInput.trim()) return;
    handleVideoSelect(customUrlInput.trim(), 'لینک سفارشی');
    setCustomUrlInput('');
  };

  // --- Chat ---
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

  const syncStatus = connections.length > 0
    ? `همگام‌سازی زنده P2P (${connections.length} اتصال)`
    : isHost
      ? 'در انتظار مهمان‌ها...'
      : 'در حال برقراری اتصال P2P...';

  const signalingHost = ACTIVE_SIGNALING.includes('://')
    ? new URL(ACTIVE_SIGNALING).host
    : ACTIVE_SIGNALING;

  return (
    <div className="h-screen flex flex-col bg-black text-gray-100 relative overflow-x-hidden">
      {/* Top Navbar */}
      <header className="bg-black/90 backdrop-blur-xl border-b border-white/5 px-4 md:px-6 py-3 flex items-center justify-between z-30 shadow-2xl shadow-black/50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-zinc-950 flex items-center justify-center border border-red-500/30 shadow-[0_0_20px_rgba(239,68,68,0.25)]">
            <Film className="w-5 h-5 text-red-500" />
          </div>
          <div>
            <h1 className="font-bold text-base md:text-lg flex items-center gap-2">
              <span>ببینیم</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-900/40 text-red-300 border border-red-500/30">
                {isHost ? 'میزبان (Host)' : 'تماشاگر'}
              </span>
            </h1>
            <p className="text-xs text-gray-500 font-mono">کد اتاق: {roomId}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsShareModalOpen(true)}
            className="btn-secondary py-2 px-3.5 text-sm gap-2"
          >
            <Share2 className="w-4 h-4 text-red-400" />
            <span className="hidden sm:inline">دعوت دوستان</span>
          </button>

          <button
            onClick={onLeave}
            className="btn-secondary py-2 px-3.5 text-sm gap-2 hover:border-red-500/70 hover:text-red-400 hover:bg-red-500/10"
          >
            <LogOut className="w-4 h-4 text-red-400" />
            <span className="hidden sm:inline">خروج</span>
          </button>
        </div>
      </header>

      {/* Main Content Grid */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-4 gap-4 p-4 md:p-6 max-w-[1600px] w-full mx-auto">

        {/* Left/Center: Video Player & Controls (3 cols on lg) */}
        <div className="lg:col-span-3 flex flex-col gap-4">

          {/* Video Container with Floating Reactions */}
          <div className="relative w-full aspect-video bg-black rounded-3xl overflow-hidden border border-red-500/20 shadow-[0_0_40px_rgba(239,68,68,0.15)] group flex items-center justify-center">

            {/* Floating Reactions Overlay */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
              {reactions.map((r) => (
                <div
                  key={r.id}
                  className="absolute bottom-10 text-4xl animate-float transition-all duration-1000"
                  style={{ left: `${r.left}%`, animationDuration: '2.5s' }}
                >
                  {r.emoji}
                </div>
              ))}
            </div>

            <video
              ref={videoRef}
              src={videoUrl}
              playsInline
              className="w-full h-full object-contain cursor-pointer"
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={() => {
                if (videoRef.current) {
                  setDuration(videoRef.current.duration);
                  if (pendingSeekRef.current != null) {
                    videoRef.current.currentTime = Math.min(
                      pendingSeekRef.current,
                      videoRef.current.duration || pendingSeekRef.current
                    );
                    pendingSeekRef.current = null;
                  }
                }
              }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onClick={togglePlay}
            />

            {/* Video Overlay Controls on Hover */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-between p-4 md:p-6 z-10 pointer-events-auto">

              {/* Top Video bar */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${connections.length > 0 ? 'bg-red-500 shadow-[0_0_10px_red] animate-pulse' : 'bg-amber-500 animate-pulse'}`}></span>
                  <span className="text-xs font-medium text-gray-300 flex items-center gap-1.5">
                    {connections.length > 0 ? <Radio className="w-3.5 h-3.5 text-red-400" /> : <Wifi className="w-3.5 h-3.5 text-amber-400" />}
                    {syncStatus}
                  </span>
                </div>
                <button
                  onClick={() => setIsUrlModalOpen(true)}
                  className="btn-secondary py-1.5 px-3 text-xs gap-1.5 bg-black/40"
                >
                  <Film className="w-3.5 h-3.5 text-red-400" />
                  <span>تغییر ویدیو</span>
                </button>
              </div>

              {/* Center big play/pause on hover if needed */}
              <div className="self-center">
                <button
                  onClick={togglePlay}
                  className="w-16 h-16 rounded-full bg-red-600/80 hover:bg-red-600 text-white flex items-center justify-center backdrop-blur-md shadow-[0_0_30px_rgba(239,68,68,0.5)] transition-all transform hover:scale-110 active:scale-95"
                >
                  {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
                </button>
              </div>

              {/* Bottom Video Controls Bar */}
              <div className="flex flex-col gap-3">
                {/* Progress bar */}
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  value={currentTime}
                  onChange={handleSeek}
                  className="neon-range w-full"
                />

                <div className="flex items-center justify-between text-xs text-gray-300">
                  <div className="flex items-center gap-4">
                    <button onClick={togglePlay} className="hover:text-red-400 transition-colors">
                      {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                    </button>

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
                        {isMuted ? <VolumeX className="w-5 h-5 text-red-400" /> : <Volume2 className="w-5 h-5" />}
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
                        className="neon-range w-20"
                      />
                    </div>

                    <span>
                      {Math.floor(currentTime / 60)}:{Math.floor(currentTime % 60).toString().padStart(2, '0')} / {Math.floor(duration / 60)}:{Math.floor(duration % 60).toString().padStart(2, '0')}
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
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
                      <Maximize className="w-5 h-5" />
                      <span>تمام صفحه</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Reactions Bar */}
          <div className="bg-zinc-950/80 border border-white/10 rounded-2xl p-3 flex items-center justify-between px-6 backdrop-blur-xl">
            <span className="text-xs font-medium text-gray-400 hidden sm:inline">واکنش سریع به فیلم:</span>
            <div className="flex items-center gap-3 md:gap-6 mx-auto sm:mx-0">
              {['❤️', '🔥', '😂', '👏', '😮', '🎉', '🍿'].map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => sendReaction(emoji)}
                  className="text-2xl hover:scale-125 transition-transform p-1.5 rounded-xl hover:bg-red-500/10"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Sidebar: Tabs (Chat, Users, Movies) */}
        <div className="lg:col-span-1 bg-zinc-950/80 backdrop-blur-xl rounded-3xl flex flex-col h-[600px] lg:h-auto border border-white/10 overflow-hidden">

          {/* Sidebar Tabs Header */}
          <div className="grid grid-cols-3 border-b border-white/5 bg-black/40">
            <button
              onClick={() => setActiveTab('chat')}
              className={`py-3 text-xs md:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 ${
                activeTab === 'chat' ? 'text-red-400 border-b-2 border-red-500 bg-red-500/10 shadow-[0_0_20px_rgba(239,68,68,0.15)]' : 'text-gray-400 hover:text-white'
              }`}
            >
              <MessageSquare className="w-4 h-4" />
              <span>چت</span>
            </button>
            <button
              onClick={() => setActiveTab('users')}
              className={`py-3 text-xs md:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 ${
                activeTab === 'users' ? 'text-red-400 border-b-2 border-red-500 bg-red-500/10 shadow-[0_0_20px_rgba(239,68,68,0.15)]' : 'text-gray-400 hover:text-white'
              }`}
            >
              <Users className="w-4 h-4" />
              <span>اعضا ({participants.length})</span>
            </button>
            <button
              onClick={() => setActiveTab('movies')}
              className={`py-3 text-xs md:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 ${
                activeTab === 'movies' ? 'text-red-400 border-b-2 border-red-500 bg-red-500/10 shadow-[0_0_20px_rgba(239,68,68,0.15)]' : 'text-gray-400 hover:text-white'
              }`}
            >
              <Film className="w-4 h-4" />
              <span>فیلم‌ها</span>
            </button>
          </div>

          {/* Tab Content: Chat */}
          {activeTab === 'chat' && (
            <div className="flex-1 flex flex-col justify-between p-4 overflow-hidden">
              <div className="flex-1 overflow-y-auto space-y-3 pr-1 mb-3">
                {messages.length === 0 ? (
                  <div className="text-center text-gray-500 text-xs my-auto py-12">
                    هنوز پیامی ارسال نشده است. اولین پیام را بفرستید!
                  </div>
                ) : (
                  messages.map((msg, idx) => (
                    <div key={idx} className="glass-card p-3 rounded-2xl animate-fade-in text-sm border-l-2 border-l-red-500/40">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold text-red-400 text-xs">{msg.sender}</span>
                        <span className="text-[10px] text-gray-500">{msg.time}</span>
                      </div>
                      <p className="text-gray-200 break-words">{msg.text}</p>
                    </div>
                  ))
                )}
              </div>

              <form onSubmit={sendChatMessage} className="flex items-center gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="پیام خود را بنویسید..."
                  className="input-field py-2.5 text-xs"
                />
                <button type="submit" className="btn-primary p-2.5 rounded-xl">
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>
          )}

          {/* Tab Content: Users */}
          {activeTab === 'users' && (
            <div className="flex-1 p-4 overflow-y-auto space-y-3">
              {participants.map((user, idx) => (
                <div key={idx} className="glass-card p-3.5 rounded-2xl flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-red-600/20 border border-red-500/30 flex items-center justify-center font-bold text-red-300 text-sm">
                      {user.name.charAt(0)}
                    </div>
                    <div>
                      <h4 className="font-bold text-sm text-white">{user.name}</h4>
                      <p className="text-[10px] text-gray-400">
                        {user.isHost ? 'میزبان اتاق' : 'عضو اتاق'}
                      </p>
                    </div>
                  </div>
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></span>
                </div>
              ))}
            </div>
          )}

          {/* Tab Content: Movies */}
          {activeTab === 'movies' && (
            <div className="flex-1 p-4 overflow-y-auto space-y-3">
              <p className="text-xs text-gray-400 mb-2">انتخاب از ویدیوهای آماده:</p>
              {SAMPLE_VIDEOS.map((movie, idx) => (
                <button
                  key={idx}
                  onClick={() => handleVideoSelect(movie.url, movie.title)}
                  className="w-full text-right glass-card p-3.5 rounded-2xl hover:border-red-500 transition-all flex items-center justify-between group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center text-red-400 group-hover:scale-110 transition-transform">
                      <Play className="w-4 h-4" />
                    </div>
                    <span className="text-xs font-semibold text-gray-200">{movie.title}</span>
                  </div>
                  <span className="text-[10px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">پخش</span>
                </button>
              ))}

              <div className="pt-4 border-t border-white/10 mt-4">
                <p className="text-xs text-gray-400 mb-2">یا وارد کردن لینک مستقیم ویدیو (MP4/WebM):</p>
                <form onSubmit={handleCustomUrlSubmit} className="space-y-2">
                  <input
                    type="url"
                    value={customUrlInput}
                    onChange={(e) => setCustomUrlInput(e.target.value)}
                    placeholder="https://example.com/video.mp4"
                    className="input-field text-xs py-2"
                  />
                  <button type="submit" className="btn-secondary w-full py-2 text-xs">
                    تایید و پخش ویدیو
                  </button>
                </form>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Share Room Modal */}
      <Modal isOpen={isShareModalOpen} onClose={() => setIsShareModalOpen(false)} title="دعوت دوستان به اتاق">
        <div className="space-y-4">
          <p className="text-sm text-gray-300 font-persian">
            برای تماشای همزمان فیلم با دوستانتان، لینک زیر یا کد اتاق را برای آن‌ها ارسال کنید:
          </p>

          <div className="p-3.5 rounded-2xl bg-black/60 border border-red-500/20 flex items-center justify-between">
            <span className="font-mono text-sm text-red-300 truncate max-w-[300px]" dir="ltr">{window.location.href}</span>
            <button
              onClick={copyRoomLink}
              className="btn-primary py-1.5 px-3 text-xs gap-1.5"
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
              <span className={ACTIVE_TURN ? 'text-emerald-400' : 'text-gray-500'}>
                {ACTIVE_TURN ? ACTIVE_TURN.split(':')[1] + ':' + ACTIVE_TURN.split(':')[2] : 'خاموش (فقط P2P)'}
              </span>
            </div>
          </div>
        </div>
      </Modal>

      {/* Change Video Modal */}
      <Modal isOpen={isUrlModalOpen} onClose={() => setIsUrlModalOpen(false)} title="انتخاب یا تغییر ویدیو">
        <div className="space-y-4">
          <p className="text-sm text-gray-300 font-persian">یکی از فیلم‌های پیش‌فرض را انتخاب کنید یا لینک مستقیم ویدیوی خود را وارد نمایید:</p>

          <div className="space-y-2">
            {SAMPLE_VIDEOS.map((movie, idx) => (
              <button
                key={idx}
                onClick={() => handleVideoSelect(movie.url, movie.title)}
                className="w-full text-right glass-card p-3 rounded-xl hover:border-red-500 text-xs font-medium text-gray-200 flex items-center justify-between"
              >
                <span>{movie.title}</span>
                <Play className="w-3.5 h-3.5 text-red-400" />
              </button>
            ))}
          </div>

          <form onSubmit={handleCustomUrlSubmit} className="pt-2 border-t border-white/10 space-y-3">
            <label className="block text-xs text-gray-400">لینک مستقیم (URL):</label>
            <div className="flex gap-2">
              <input
                type="url"
                value={customUrlInput}
                onChange={(e) => setCustomUrlInput(e.target.value)}
                placeholder="https://.../movie.mp4"
                className="input-field text-xs py-2"
              />
              <button type="submit" className="btn-primary py-2 px-4 text-xs whitespace-nowrap">
                پخش
              </button>
            </div>
          </form>
        </div>
      </Modal>

    </div>
  );
};
