import { useCallback, useState } from 'react';
import { SUBTITLE_SETTINGS_DEFAULTS } from './constants';

// Subtitle appearance settings + the settings modal open state.
// Owns the defaults so init and "reset to default" can never drift apart.
export function useSubtitleSettings() {
  const [subtitleSettings, setSubtitleSettings] = useState(SUBTITLE_SETTINGS_DEFAULTS);
  const [subtitleModalOpen, setSubtitleModalOpen] = useState(false);

  const resetSubtitleSettings = useCallback(() => {
    setSubtitleSettings(SUBTITLE_SETTINGS_DEFAULTS);
  }, []);

  return {
    subtitleSettings,
    setSubtitleSettings,
    subtitleModalOpen,
    setSubtitleModalOpen,
    resetSubtitleSettings,
  };
}