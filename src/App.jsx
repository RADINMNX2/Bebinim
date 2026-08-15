import React, { useState, useEffect } from 'react';
import { ToastProvider } from './context/ToastContext';
import { Landing } from './components/Landing/Landing';
import { Room } from './components/Room/Room';
import { LoadingScreen } from './components/LoadingScreen';

export function App() {
  const [roomState, setRoomState] = useState({
    inRoom: false,
    roomId: null,
    userName: '',
    isHost: false,
  });
  const [isLoading, setIsLoading] = useState(true);

  // Read invite room id from the URL on load (opened via shared room link)
  const [inviteRoomId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('room') || null;
  });

  // If a user lands on the main page with no invite param, nothing to pre-fill
  useEffect(() => {
    if (!inviteRoomId) return;
    // The Landing will detect inviteRoomId and route directly to name-entry
  }, [inviteRoomId]);

  const handleJoinRoom = (roomId, userName, isHost) => {
    // Update URL query params without reloading page
    const url = new URL(window.location);
    url.searchParams.set('room', roomId);
    window.history.pushState({}, '', url);

    setRoomState({
      inRoom: true,
      roomId,
      userName,
      isHost,
    });
  };

  const handleLeaveRoom = () => {
    const url = new URL(window.location);
    url.searchParams.delete('room');
    window.history.pushState({}, '', url);

    setRoomState({
      inRoom: false,
      roomId: null,
      userName: '',
      isHost: false,
    });
  };

  return (
    <ToastProvider>
      {isLoading && <LoadingScreen onComplete={() => setIsLoading(false)} />}
      {roomState.inRoom ? (
        <Room
          roomId={roomState.roomId}
          userName={roomState.userName}
          isHost={roomState.isHost}
          onLeave={handleLeaveRoom}
        />
      ) : (
        <Landing onJoinRoom={handleJoinRoom} inviteRoomId={inviteRoomId} />
      )}
    </ToastProvider>
  );
}

export default App;
