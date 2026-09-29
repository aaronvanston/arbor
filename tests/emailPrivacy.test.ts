import { afterEach, describe, expect, it } from 'bun:test';
import { setAppPreference } from '../src/appPreferences';
import { fileProfile } from '../src/services/accountProfiles';
import { maskEmail, maskEmailsIn, rememberCredentialEmails, shownIdentity } from '../src/services/emailPrivacy';

describe('maskEmail', () => {
  it('keeps the first and last letter of the name and the whole domain', () => {
    expect(maskEmail('samrivera@example.com')).toBe('s•••a@example.com');
    expect(maskEmail('sam@northwind.dev')).toBe('s•••m@northwind.dev');
  });

  it('keeps only the first letter of a name too short to keep two', () => {
    expect(maskEmail('ab@x.com')).toBe('a•••@x.com');
  });
});

describe('maskEmailsIn', () => {
  it("hides an address in a file name without taking in the provider's prefix", () => {
    expect(maskEmailsIn('claude-samrivera.alt@example.com', ['samrivera.alt@example.com'])).toBe('claude-s•••t@example.com');
  });

  it("hides the account's name where a file name repeats it without the domain", () => {
    expect(maskEmailsIn('CC-P1-samrivera', ['samrivera@example.com'])).toBe('CC-P1-s•••a');
    expect(maskEmailsIn('CC-P3-samr.core', ['samr.core@example.com'])).toBe('CC-P3-s•••e');
  });

  it('hides an address it was not told about', () => {
    expect(maskEmailsIn('claude-5772b8d7 casey@example.com', [])).toBe('claude-5772b8d7 c•••y@example.com');
  });

  it('leaves names under four letters, which would match ordinary words', () => {
    expect(maskEmailsIn('codex-ops', ['ops@example.com'])).toBe('codex-ops');
  });
});

describe('shownIdentity', () => {
  afterEach(() => setAppPreference('hideEmails', false));

  it('shows text as it is until the setting is on', () => {
    expect(shownIdentity('samrivera@example.com')).toBe('samrivera@example.com');
    setAppPreference('hideEmails', true);
    expect(shownIdentity('samrivera@example.com')).toBe('s•••a@example.com');
  });

  it("hides a file's fallback name with the email the last listing had for it", () => {
    rememberCredentialEmails([{ name: 'CC-W1-sam.json', email: 'samuel@northwind.dev' }]);
    setAppPreference('hideEmails', true);
    expect(fileProfile({ name: 'CC-W1-sam.json', auth_index: 'w1' }, {}).name).toBe('CC-W1-sam');
    rememberCredentialEmails([{ name: 'CC-W1-samuel.json', email: 'samuel@northwind.dev' }]);
    expect(fileProfile({ name: 'CC-W1-samuel.json', auth_index: 'w1' }, {}).name).toBe('CC-W1-s•••l');
    // A name the account was given is shown as it was written.
    expect(fileProfile({ name: 'CC-W1-samuel.json', auth_index: 'w1' }, { 'CC-W1-samuel.json::w1': { name: 'Work' } }).name).toBe('Work');
  });
});
