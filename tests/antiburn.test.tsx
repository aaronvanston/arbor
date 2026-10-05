import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import type { AntiburnStatus, SessionTranscript } from '../src/native/types';
import { AntiburnRow } from '../src/pages/SessionAntiburn';
import { antiburnReach } from '../src/services/antiburn';

const installed: AntiburnStatus = { installed: true, thisMachine: 'cam-mbp' };

const transcript = (fields: Partial<SessionTranscript> = {}): SessionTranscript => ({
  machine: 'cam-mbp', agent: 'claude', home: '/Users/cam', agentHome: '~/.claude', cwd: '/Users/cam/src/proxy', repoRoot: '', mainRepo: '',
  branch: '', commitHash: '', repositoryUrl: '', title: '', titleSource: '', pullRequests: [], linesAdded: null, linesRemoved: null,
  compactions: [], toolUsage: null, readAtMs: 0,
  ...fields,
});

const render = (status: AntiburnStatus, item: SessionTranscript | null) =>
  renderToStaticMarkup(
    <I18nProvider>
      <AntiburnRow status={status} transcript={item} />
    </I18nProvider>,
  )
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('what Antiburn can do for a session', () => {
  test('lists a session whose transcript is on this Mac in Claude Code’s or Codex’s own home', () => {
    expect(antiburnReach(installed, transcript())).toBe('listed');
    expect(antiburnReach(installed, transcript({ agent: 'codex', agentHome: '~/.codex' }))).toBe('listed');
  });

  test('doesn’t list one from another agent home, or from another machine', () => {
    expect(antiburnReach(installed, transcript({ agentHome: '~/work/.claude' }))).toBe('otherHome');
    expect(antiburnReach(installed, transcript({ machine: 'Cedar 01' }))).toBe('otherMachine');
  });

  test('can’t say without a transcript, or before a scan has said which home it’s in', () => {
    expect(antiburnReach(installed, null)).toBe('unknown');
    expect(antiburnReach(installed, transcript({ agentHome: '' }))).toBe('unknown');
  });

});

describe('the Antiburn row', () => {
  test('opens Antiburn when it lists the session, and credits it', () => {
    const html = render(installed, transcript());
    expect(html).toContain('More checks in Antiburn');
    expect(html).toContain('Antiburn lists this session');
    expect(html).toContain('Open Antiburn');
    expect(html).toContain('Arbor’s session page is based on Antiburn.');
  });

  test('says why Antiburn doesn’t list a session, and still opens it', () => {
    const other = render(installed, transcript({ agentHome: '~/work/.claude' }));
    expect(other).toContain('whose transcript is in ~/work/.claude');
    expect(other).toContain('Open Antiburn');
    expect(render(installed, transcript({ machine: 'Cedar 01' }))).toContain('doesn’t list this session from Cedar 01');
  });
});
