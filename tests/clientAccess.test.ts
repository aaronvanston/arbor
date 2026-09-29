import { afterEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { clientApiProfiles, loadProxyBaseUrl, webUiManagementUrl } from '../src/services/clientAccess';

describe('客户端 API 接入信息', () => {
  it('生成 OpenAI、Claude 和 Gemini 三种正确格式', () => {
    const profiles = clientApiProfiles(9527);

    expect(profiles.map((profile) => profile.id)).toEqual(['openai', 'claude', 'gemini']);
    expect(profiles[0]?.baseUrl).toBe('http://127.0.0.1:9527/v1');
    expect(profiles[1]?.baseUrl).toBe('http://127.0.0.1:9527');
    expect(profiles[2]?.baseUrl).toBe('http://127.0.0.1:9527');
  });

  it('端口无效时回退到 8317，缺少局域网地址时保持为空', () => {
    const [openai] = clientApiProfiles(0);

    expect(openai?.baseUrl).toBe('http://127.0.0.1:8317/v1');
  });

  it('TLS 开启时生成 HTTPS 客户端地址', () => {
    const profiles = clientApiProfiles(9527, true);

    expect(profiles[0]?.baseUrl).toBe('https://127.0.0.1:9527/v1');
    expect(profiles[1]?.baseUrl).toBe('https://127.0.0.1:9527');
  });

  it('使用当前内核端口生成 WebUI 登录地址', () => {
    expect(webUiManagementUrl(9527)).toBe(
      'http://127.0.0.1:9527/management.html#/login',
    );
    expect(webUiManagementUrl(0)).toBe(
      'http://127.0.0.1:8317/management.html#/login',
    );
    expect(webUiManagementUrl(9527, true)).toBe(
      'https://127.0.0.1:9527/management.html#/login',
    );
  });

  it('uses the configured listen IP for API and WebUI URLs', () => {
    const [openai] = clientApiProfiles(9527, true, '192.168.1.20');

    expect(openai?.baseUrl).toBe('https://192.168.1.20:9527/v1');
    expect(webUiManagementUrl(9527, true, '192.168.1.20')).toBe(
      'https://192.168.1.20:9527/management.html#/login',
    );
  });

  it('converts wildcard and IPv6 listen IPs to connectable URL hosts', () => {
    expect(webUiManagementUrl(8317, false, '0.0.0.0')).toBe(
      'http://127.0.0.1:8317/management.html#/login',
    );
    expect(webUiManagementUrl(8317, false, '::')).toBe(
      'http://[::1]:8317/management.html#/login',
    );
    expect(clientApiProfiles(8317, false, '2001:db8::1')[0]?.baseUrl).toBe(
      'http://[2001:db8::1]:8317/v1',
    );
  });
});

describe('the base URL the search palette copies', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  afterEach(() => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const settings = (gui: { host: string; port: number }, tls: boolean | 'fails') => {
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
    mockCommands({
      get_gui_settings: () => ({ ...gui, allowLan: false, runOnStartup: false, closeBehavior: 'ask' }),
      get_core_tls_settings: () => {
        if (tls === 'fails') throw new Error('no TLS settings');
        return { enabled: tls, cert: '', key: '' };
      },
    });
  };

  it('is the OpenAI-style one the Home page shows first, ending in /v1', async () => {
    settings({ host: '0.0.0.0', port: 9527 }, false);
    expect(await loadProxyBaseUrl()).toBe('http://127.0.0.1:9527/v1');
    // The same as the first the Home page lists.
    const [openai] = clientApiProfiles(9527, false, '0.0.0.0');
    expect(openai?.id).toBe('openai');
    expect(await loadProxyBaseUrl()).toBe(openai?.baseUrl ?? '');
  });

  it('follows TLS, and reads it as off when its settings can’t be read', async () => {
    settings({ host: '192.168.1.20', port: 8317 }, true);
    expect(await loadProxyBaseUrl()).toBe('https://192.168.1.20:8317/v1');
    settings({ host: '127.0.0.1', port: 8317 }, 'fails');
    expect(await loadProxyBaseUrl()).toBe('http://127.0.0.1:8317/v1');
  });
});
