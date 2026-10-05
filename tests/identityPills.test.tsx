import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClientName, ClientPill, MachinePill, ModelName, ModelNames, modelProvider, ProviderPill } from '../src/components/identity/Identity';
import { I18nProvider } from '../src/i18n';
import { identityColorCss, identityColorIsLight, identityColors } from '../src/services/identityColors';
import { defaultMachineColor, machineLookKey, resolveMachineLook, setMachineLook, useMachineLookChoices } from '../src/services/machineLook';

const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

afterEach(() => {
  setMachineLook('Mac Mini', { color: undefined, icon: undefined, fill: undefined });
});

describe('machine colors', () => {
  it('offers every color, but only gives a machine one that doesn’t mean healthy, needs you, failing or the accent', () => {
    expect(identityColors).toContain('red');
    expect(identityColors).toContain('teal');
    const names = Array.from({ length: 200 }, (_, index) => `machine-${index}`);
    const defaults = new Set(names.map(defaultMachineColor));
    expect([...defaults].filter((color) => ['green', 'emerald', 'teal', 'amber', 'orange', 'red', 'yellow', 'lime', 'slate', 'stone'].includes(color))).toEqual([]);
  });

  it('keeps the color a machine always had by default as the palette grows', () => {
    // The first seven colors, in their original order, so the same hash lands on the same color.
    expect(['ci-01', 'cedar-02', 'lab-box', 'cam-mbp', 'Mac Mini'].map(defaultMachineColor)).toEqual(['violet', 'pink', 'indigo', 'fuchsia', 'pink']);
  });

  it('gives a machine the same color every time, however its name is written', () => {
    expect(defaultMachineColor('Mac Mini')).toBe(defaultMachineColor('mac-mini'));
    expect(identityColors).toContain(defaultMachineColor('cam-mbp'));
    // Slate reads as no color, so it's only ever picked.
    expect(['ci-01', 'cedar-02', 'lab-box', 'cam-mbp', 'Mac Mini'].map(defaultMachineColor)).not.toContain('slate');
    expect(machineLookKey('Mac Mini')).toBe(machineLookKey('mac_mini'));
  });

  it('keeps what was picked over the default, and the model’s icon until one is picked', () => {
    expect(resolveMachineLook('ci-01', undefined, 'laptop')).toEqual({ color: defaultMachineColor('ci-01'), icon: 'laptop', fill: 'soft', picked: false });
    expect(resolveMachineLook('ci-01', { color: 'pink' }, 'laptop')).toEqual({ color: 'pink', icon: 'laptop', fill: 'soft', picked: true });
    expect(resolveMachineLook('ci-01', { fill: 'solid' }, null)).toMatchObject({ fill: 'solid', picked: true });
    expect(resolveMachineLook('ci-01', { icon: 'server' }, null).icon).toBe('server');
    expect(resolveMachineLook('ci-01', undefined, undefined).icon).toBeNull();
  });

  it('sets a choice by name and clears it again', () => {
    let seen: ReturnType<typeof useMachineLookChoices> = {};
    const Probe = () => {
      seen = useMachineLookChoices();
      return null;
    };
    setMachineLook('Mac Mini', { color: 'indigo' });
    render(<Probe />);
    expect(seen[machineLookKey('mac-mini')]).toEqual({ color: 'indigo' });
    setMachineLook('Mac Mini', { icon: 'macMini' });
    render(<Probe />);
    expect(seen[machineLookKey('Mac Mini')]).toEqual({ color: 'indigo', icon: 'macMini' });
    setMachineLook('Mac Mini', { color: undefined, icon: undefined });
    render(<Probe />);
    expect(seen[machineLookKey('Mac Mini')]).toBeUndefined();
  });

  it('keeps a fill other than soft, and any color picked outside the palette as lower-case hex', () => {
    let seen: ReturnType<typeof useMachineLookChoices> = {};
    const Probe = () => {
      seen = useMachineLookChoices();
      return null;
    };
    setMachineLook('Mac Mini', { fill: 'soft' });
    render(<Probe />);
    expect(seen[machineLookKey('Mac Mini')]).toBeUndefined();
    setMachineLook('Mac Mini', { color: '#FF8800', fill: 'outline' });
    render(<Probe />);
    expect(seen[machineLookKey('Mac Mini')]).toEqual({ color: '#ff8800', fill: 'outline' });
    // Not a color: the one picked before stays.
    setMachineLook('Mac Mini', { color: 'chartreuse' as never });
    render(<Probe />);
    expect(seen[machineLookKey('Mac Mini')]?.color).toBe('#ff8800');
  });

  it('writes a palette color as its variable and a picked one as itself', () => {
    expect(identityColorCss('rose')).toBe('var(--color-rose-500)');
    expect(identityColorCss('#123abc')).toBe('#123abc');
  });

  it('puts dark words on the light colors when a pill is filled with them, and white on the rest', () => {
    expect(identityColorIsLight('yellow')).toBe(true);
    expect(identityColorIsLight('blue')).toBe(false);
    // White letters on a solid green, teal, cyan or sky pill fell under 4.5:1; they take dark ones.
    expect(['green', 'emerald', 'teal', 'cyan', 'sky', 'orange'].map((color) => identityColorIsLight(color as never))).toEqual([true, true, true, true, true, false]);
    expect(identityColorIsLight('#fde047')).toBe(true);
    expect(identityColorIsLight('#1e3a8a')).toBe(false);
  });
});

describe('identity pills', () => {
  it('names a machine in its color, or says the fallback without one', () => {
    setMachineLook('Mac Mini', { color: 'violet' });
    const html = render(<MachinePill name="Mac Mini" />);
    expect(text(html)).toBe('Mac Mini');
    expect(html).toContain('data-machine-color="violet"');
    expect(html).toContain('data-fill="soft"');
    expect(text(render(<MachinePill name="  " fallback="Unassigned" />))).toBe('Unassigned');
  });

  it('fills a machine’s pill the way it was picked, with dark words on a light solid color', () => {
    setMachineLook('Mac Mini', { color: 'yellow', fill: 'solid' });
    const html = render(<MachinePill name="Mac Mini" />);
    expect(html).toContain('data-fill="solid"');
    expect(html).toContain('data-ink="dark"');
    setMachineLook('Mac Mini', { color: 'blue' });
    expect(render(<MachinePill name="Mac Mini" />)).not.toContain('data-ink');
  });

  it('is a button with its own name when it opens something, and a plain mark otherwise', () => {
    const button = render(<MachinePill name="Mac Mini" onClick={() => undefined} label="Open Mac Mini" />);
    expect(button).toMatch(/^<button[^>]*aria-label="Open Mac Mini"/);
    expect(render(<MachinePill name="Mac Mini" />)).toMatch(/^<span/);
    expect(render(<MachinePill name="" fallback="Unassigned" onClick={() => undefined} />)).toMatch(/^<button/);
  });

  it('names the client from its User-Agent, with its version and what it ran in', () => {
    const hosted = render(<ClientPill userAgent="claude-cli/2.1.283 (external, sdk-ts, agent-sdk/0.3.276) AcmeDesk/1.4.205" />);
    expect(text(hosted)).toBe('Claude Agent SDK 0.3.276 · AcmeDesk');
    expect(hosted).toContain('claude');
    expect(text(render(<ClientPill userAgent="codex_cli_rs/0.149.1 (Mac OS 26.5.2; arm64)" version={false} />))).toBe('Codex CLI');
    expect(text(render(<ClientPill userAgent={null} />))).toBe('Unknown client');
  });

  it('names a provider by its brand, and passes through one it doesn’t know', () => {
    expect(text(render(<ProviderPill provider="anthropic" />))).toBe('Claude');
    expect(text(render(<ProviderPill provider="openai" />))).toBe('Codex');
    expect(text(render(<ProviderPill provider="acme" />))).toBe('acme');
  });

  it('reads a model’s provider from its name when the row doesn’t say', () => {
    expect(['claude-opus-5-5', 'opus-5', 'gpt-5.6-luna', 'o3-mini', 'gemini-3-pro', 'grok-4', 'kimi-k2', 'anthropic/claude-sonnet-5', 'mistral-large'].map(modelProvider))
      .toEqual(['claude', 'claude', 'codex', 'codex', 'gemini', 'xai', 'kimi', 'claude', null]);
  });

  it('names a model as Requests does: its provider’s mark, no claude- prefix, the effort in small print', () => {
    const opus = render(<ModelName model="claude-opus-5-5" effort="xhigh" />);
    expect(text(opus)).toBe('opus-5-5 xhigh');
    expect(opus).toContain('title="claude-opus-5-5"');
    expect(opus).toContain('<img');
    // The provider that served it wins when Arbor has its mark; otherwise the name says.
    expect(render(<ModelName model="claude-opus-5-5" provider="antigravity" />)).toContain('alt="Antigravity"');
    expect(render(<ModelName model="claude-opus-5-5" provider="openai-compatible" />)).toContain('alt="Claude"');
    // Without a mark the name stays whole.
    const unknown = render(<ModelName model="mistral-large" />);
    expect(text(unknown)).toBe('mistral-large');
    expect(unknown).not.toContain('<img');
  });

  it('shows a session’s first model and counts the rest', () => {
    expect(text(render(<ModelNames models={['claude-opus-5-5', 'claude-haiku-4-5', 'gpt-5.6-sol']} />))).toBe('opus-5-5 +2');
    expect(text(render(<ModelNames models={[]} />))).toBe('—');
  });

  it('marks a client known only by name', () => {
    expect(render(<ClientName name="Claude Code" />)).toContain('<img');
    expect(render(<ClientName name="Aider" />)).not.toContain('<img');
  });
});
