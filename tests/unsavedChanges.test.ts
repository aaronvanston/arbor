import { describe, expect, it } from 'bun:test';
import { hasUnsavedChanges, holdUnsavedChanges, settingsEscape } from '../src/services/unsavedChanges';

describe('unsaved changes', () => {
  it('are held while any page holds some, and let go page by page', () => {
    expect(hasUnsavedChanges()).toBe(false);
    const network = holdUnsavedChanges();
    const hosts = holdUnsavedChanges();
    network();
    expect(hasUnsavedChanges()).toBe(true);
    // Letting go twice doesn't let go of another page's.
    network();
    expect(hasUnsavedChanges()).toBe(true);
    hosts();
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('keep Escape from leaving Settings until they’re saved or undone', () => {
    // A switch turned off, not saved yet: Esc stays rather than leaving and throwing the change away.
    expect(settingsEscape(false, true)).toBe('stay');
    // In a field it lets go of the field first, then stays while the typing is unsaved.
    expect(settingsEscape(true, true)).toBe('blur');
    expect(settingsEscape(true, false)).toBe('blur');
    expect(settingsEscape(false, false)).toBe('leave');
  });
});
