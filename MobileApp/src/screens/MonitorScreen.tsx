import React, { useState } from 'react';
import { ScreenMonitor } from '../components/ScreenMonitor';
import { Screen } from '../components/ui';

export function MonitorScreen(): React.JSX.Element {
  const [consentGranted] = useState(true);

  return (
    <Screen>
      <ScreenMonitor consentGranted={consentGranted} intervalMs={20000} />
    </Screen>
  );
}
