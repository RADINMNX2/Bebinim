import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { ToastProvider } from './context/ToastContext';
import { Landing } from './components/Landing/Landing';
import { LoadingScreen } from './components/LoadingScreen';
import { Loader2 } from 'lucide-react';

// Room pulls in peerjs (~90 KB) — load it only when a room is actually entered
const Room = lazy(() => import('./components/Room/Room'));

const normalizeRoomId = (id) =>
  String(id || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

export function App() {
  const [roomState, setRoomState] = useState({
    inRoom: false,
    roomId: null,
    userName: '',
    isHost: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [inviteRoomId, setInviteRoomId] = useState(() =>
    normalizeRoomId(new URLSearchParams(window.location.search).get('room')) || null
  );

  // Keep app state in sync with browser back/forward navigation
  useEffect(() => {
    const onPop = () => {
      const room = normalizeRoomId(new URLSearchParams(window.location.search).get('room')) || null;
      setInviteRoomId(room);
      setRoomState((prev) => {
        if (!room && prev.inRoom) {
          return { inRoom: false, roomId: null, userName: '', isHost: false };
        }
        return prev;
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const handleJoinRoom = useCallback((roomId, userName, isHost) => {
    const clean = normalizeRoomId(roomId);
    if (!clean) return;
    // Update URL query params without reloading page
    const url = new URL(window.location);
    url.searchParams.set('room', clean);
    window.history.pushState({}, '', url);

    setRoomState({
      inRoom: true,
      roomId: clean,
      userName,
      isHost,
    });
  }, []);

  const handleLeaveRoom = useCallback(() => {
    const url = new URL(window.location);
    url.searchParams.delete('room');
    window.history.pushState({}, '', url);

    setRoomState({
      inRoom: false,
      roomId: null,
      userName: '',
      isHost: false,
    });
  }, []);

  return (
    <ToastProvider>
      {isLoading && <LoadingScreen onComplete={() => setIsLoading(false)} />}
      {roomState.inRoom ? (
        <Suspense
          fallback={
            <div className="h-dvh w-full bg-black flex items-center justify-center">
              <Loader2 className="w-10 h-10 text-red-500 animate-spin" />
            </div>
          }
        >
          <Room
            roomId={roomState.roomId}
            userName={roomState.userName}
            isHost={roomState.isHost}
            onLeave={handleLeaveRoom}
          />
        </Suspense>
      ) : (
        <Landing onJoinRoom={handleJoinRoom} inviteRoomId={inviteRoomId} />
      )}
    </ToastProvider>
  );
}

export default App;