import { invokeCommand } from '../native/commands';
import { setFormatRegion } from '../lib/format';

/** How long the first render waits for the region. The shell's own wait for the page (main_window.rs) must outlast it. */
export const SYSTEM_REGION_WAIT_MS = 250;

/**
 * Formats dates and numbers the way the Mac's region has them. The web view's own language can say
 * "en-US" on a Mac set to Australia, so the region comes from the native side. The first render waits
 * for it only briefly; a late answer still applies to everything drawn after it.
 */
export async function loadSystemRegion(waitMs = SYSTEM_REGION_WAIT_MS): Promise<void> {
  const loaded = invokeCommand('system_locale')
    .then((reply) => {
      if (reply?.locale) setFormatRegion({ locale: reply.locale, hourCycle: reply.hourCycle === 'h23' ? 'h23' : 'h12' });
    })
    .catch(() => {
      // Outside the app shell, or on a platform without an answer: keep the web view's defaults.
    });
  await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, waitMs))]);
}
