import { useEffect } from 'react';
import { settingControl } from '../components/layout/settings';
import { clearFocusRequest, useFocusRequest } from '../focusRequests';
import type { SettingsPageId } from '../navigation';
import { revealStep, settingEntry } from '../services/settingsIndex';

/** As long as the row-highlight animation in styles.css. */
const HIGHLIGHT_MS = 1_600;
/** A folded group grows open over 200ms (CollapsiblePanel); scrolled to before that, the row would land short. */
const GROUP_OPENING_MS = 220;

const rowOnScreen = (id: string) => document.querySelector<HTMLElement>(`main [data-setting-id="${CSS.escape(id)}"]`);

function highlight(element: HTMLElement) {
  // Taken off and put back, so a row found twice in a row tints again.
  delete element.dataset.highlight;
  void element.offsetWidth;
  element.dataset.highlight = '';
  window.setTimeout(() => delete element.dataset.highlight, HIGHLIGHT_MS);
}

/**
 * Brings the setting Settings search picked into view once its page shows it: scrolled to the middle, tinted for a
 * moment, and (picked from the sidebar's search) with the keyboard on its control. Search opens a folded group itself;
 * this waits for the row to be there. With reduced motion it jumps rather than scrolls, and the tint holds still.
 */
export function useSettingReveal(page: SettingsPageId | null) {
  const requested = useFocusRequest('setting');
  useEffect(() => {
    if (!requested) return undefined;
    const entry = settingEntry(requested);
    if (!entry) {
      clearFocusRequest('setting');
      return undefined;
    }
    // Waits for its page to open.
    if (entry.page !== page) return undefined;
    const started = performance.now();
    let frame = 0;
    const tick = () => {
      const step = revealStep(entry, (id) => rowOnScreen(id) !== null, performance.now() - started);
      if (step === 'wait') {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      clearFocusRequest('setting');
      const element = step === 'give-up' ? null : rowOnScreen(step.reveal);
      if (!element) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Only a pick from the sidebar's search takes the keyboard along; the palette hands focus back as it closes.
      const fromSearch = Boolean(document.activeElement?.closest('[data-settings-search]'));
      const inGroup = Boolean(element.closest('[data-slot="collapsible-panel"]'));
      // Not canceled with the effect: clearing the request above runs it again straight away.
      window.setTimeout(() => {
        element.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
        highlight(element);
        if (fromSearch && element.dataset.slot === 'settings-row') settingControl(element)?.focus({ preventScroll: true });
      }, inGroup && !reduced ? GROUP_OPENING_MS : 0);
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [requested, page]);
}
