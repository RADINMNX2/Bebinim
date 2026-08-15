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

  // Check URL search params on load for quick room join via shared link
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      // If room link is opened, we can pre-set room id or prompt for name
      // For smooth UX, let's keep inRoom false until user enters name, or store roomParam
    }
  }, []);

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
        <Landing onJoinRoom={handleJoinRoom} />
      )}
    </ToastProvider>
  );
}

export default App;
