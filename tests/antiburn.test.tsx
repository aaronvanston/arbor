import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import type { AntiburnStatus, SessionTranscript } from '../src/native/types';
import { AntiburnRow } from '../src/pages/SessionAntiburn';
import { antiburnReach } from '../src/services/antiburn';

const installed: AntiburnStatus = { installed: true, thisMachine: 'casey-mbp' };

const transcript = (fields: Partial<SessionTranscript> = {}): SessionTranscript => ({
  machine: 'casey-mbp', agent: 'claude', home: '/Users/casey', agentHome: '~/.claude', cwd: '/Users/casey/src/proxy', repoRoot: '', mainRepo: '',
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

  test('doesn’t list one from a T3 Code provider home, or from another machine', () => {
    expect(antiburnReach(installed, transcript({ agentHome: '~/.t3/provider-homes/claude-proxy' }))).toBe('otherHome');
    expect(antiburnReach(installed, transcript({ machine: 'Cedar 01' }))).toBe('otherMachine');
  });

  test('can’t say without a transcript, or before a scan has said which home it’s in', () => {
    expect(antiburnReach(installed, null)).toBe('unknown');
    expect(antiburnReach(installed, transcript({ agentHome: '' }))).toBe('unknown');
  });

  test('is missing on a Mac without it, whatever the session', () => {
    expect(antiburnReach({ installed: false, thisMachine: 'casey-mbp' }, transcript())).toBe('missing');
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
    const t3 = render(installed, transcript({ agentHome: '~/.t3/provider-homes/claude-proxy' }));
    expect(t3).toContain('whose transcript is in ~/.t3/provider-homes/claude-proxy');
    expect(t3).toContain('Open Antiburn');
    expect(render(installed, transcript({ machine: 'Cedar 01' }))).toContain('doesn’t list this session from Cedar 01');
  });

  test('offers to get Antiburn on a Mac without it', () => {
    const html = render({ installed: false, thisMachine: 'casey-mbp' }, transcript());
    expect(html).toContain('Antiburn is a free app');
    expect(html).toContain('Get Antiburn');
    expect(html).not.toContain('Open Antiburn');
  });
});
