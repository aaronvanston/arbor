import type { ReactNode } from 'react';
import { useLaunchSettled } from '../services/launchSettle';

/** Mounts what it holds once launch has settled, so monitors Home doesn't need start after Home's own reads. */
export function AfterLaunch({ children }: { children: ReactNode }) {
  return useLaunchSettled() ? <>{children}</> : null;
}
