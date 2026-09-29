import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoreLockedPage } from '../src/components/CoreLockedPage';
import { CoreRuntimeProvider } from '../src/coreRuntime';
import { I18nProvider } from '../src/i18n';
import { coreLock, sidebarCoreState, type CoreLock } from '../src/services/coreLock';
import type { CoreStatus } from '../src/native/types';

const status = (fields: Partial<CoreStatus>): CoreStatus => ({
  installed: true, running: false, ready: false, starting: false, managed: true, processId: null,
  currentVersion: 'v6.8.21', installDir: '/core', binaryPath: '/core/cli-proxy-api', message: '', ...fields,
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const render = (lock: CoreLock, statusError = '') => renderToStaticMarkup(
  <I18nProvider>
    <CoreRuntimeProvider>
      <CoreLockedPage lock={lock} statusError={statusError} page="Auth Files" segments={['Settings', 'Auth Files']} width="readable" onInstall={() => {}} />
    </CoreRuntimeProvider>
  </I18nProvider>,
);

describe('what keeps a page that needs the core locked', () => {
  it('is nothing once the core answers', () => {
    expect(coreLock(status({ running: true, ready: true }), '')).toBeNull();
  });

  it('waits while the status is read, the core launches, or a live core isn’t answering yet', () => {
    expect(coreLock(null, '')).toBe('checking');
    expect(coreLock(status({ starting: true }), '')).toBe('starting');
    expect(coreLock(status({ running: true }), '')).toBe('starting');
  });

  it('asks to start a stopped core, install a missing one, or read a status that failed to read again', () => {
    expect(coreLock(status({}), '')).toBe('stopped');
    expect(coreLock(status({ installed: false, currentVersion: null, binaryPath: null }), '')).toBe('missing');
    expect(coreLock(null, 'status file locked')).toBe('unreadable');
  });
});

describe('a locked page', () => {
  it('keeps its breadcrumb, says why it’s locked, and offers Start core when the core is stopped', () => {
    const html = render('stopped');
    expect(html).toContain('data-slot="page-topbar"');
    expect(text(html)).toBe('Settings / Auth Files Auth Files needs the core The core isn’t running. Start it and Auth Files opens right here. Start core');
  });

  it('offers Install core when there’s no core to start', () => {
    expect(text(render('missing'))).toEndWith('The core isn’t installed yet. Install it from Settings › Updates, then start it here. Install core');
    expect(text(render('missing'))).not.toContain('Start core');
  });

  it('says why the status couldn’t be read, and offers to read it again', () => {
    expect(text(render('unreadable', 'status file locked'))).toEndWith('Arbor couldn’t tell whether the core is running: status file locked Check again');
  });

  it('only waits while the core starts', () => {
    const html = render('starting');
    expect(text(html)).toEndWith('Waiting for core startup This page opens as soon as the core answers.');
    expect(html).not.toContain('<button');
  });
});

describe('the core in the sidebar’s footer', () => {
  const missing = status({ installed: false, currentVersion: null, binaryPath: null });

  it('is a green dot while it answers, amber while it comes up, gray until its status is read', () => {
    expect(sidebarCoreState(status({ running: true, ready: true }), '')).toEqual({ tone: 'success', label: 'sidebar.core.running', down: null });
    expect(sidebarCoreState(status({ starting: true }), '')).toEqual({ tone: 'warning', label: 'sidebar.core.starting', down: null });
    expect(sidebarCoreState(status({ running: true }), '').tone).toBe('warning');
    expect(sidebarCoreState(null, '')).toEqual({ tone: 'muted', label: 'sidebar.core.checking', down: null });
  });

  it('adds the labeled row only while the core is stopped or not installed', () => {
    expect(sidebarCoreState(status({}), '')).toEqual({ tone: 'error', label: 'sidebar.core.stopped', down: 'stopped' });
    expect(sidebarCoreState(missing, '')).toEqual({ tone: 'muted', label: 'sidebar.core.missing', down: 'missing' });
    // A status that failed to read is red on the Core button, with no Start to offer.
    expect(sidebarCoreState(null, 'status file locked')).toEqual({ tone: 'error', label: 'sidebar.core.unreadable', down: null });
  });
});
