import { describe, expect, it } from 'bun:test';
import { newSuggestions, suggestionFields, suggestionKind, suggestionTarget } from '../src/services/machineDiscovery';
import type { DiscoveredHost, MachineHost } from '../src/native/types';

const found = (name: string, endpoint: string, extra: Partial<DiscoveredHost> = {}): DiscoveredHost => ({
  name,
  endpoint,
  port: 22,
  hostName: null,
  user: null,
  addresses: [endpoint.toLowerCase(), name].filter(Boolean),
  sources: ['sshConfig'],
  os: null,
  online: null,
  ...extra,
});
const host = (machine: string, endpoint: string, port = 22): MachineHost => ({ machine, endpoint, port, enabled: true, source: 'manual' });

describe('machine discovery', () => {
  it('leaves out machines already added, by any name or address they go by', () => {
    const suggestions = [
      found('ci-01', 'ci-01', { hostName: 'ci-01.tailc0ffee.ts.net', addresses: ['ci-01', 'ci-01.tailc0ffee.ts.net', '100.64.0.23'] }),
      found('cedar-02', 'cedar-02.tailc0ffee.ts.net', { sources: ['tailscale'] }),
      found('Mac Mini', 'macmini.local'),
      found('nas', 'nas.local'),
      found('', '100.64.0.24', { addresses: ['100.64.0.24'] }),
      found('build-arm', 'build-arm'),
    ];
    const hosts = [
      host('ci-01 box', 'ci@100.64.0.23'),
      host('cedar-02', 'CEDAR-02.tailc0ffee.ts.net.'),
      host('mac-mini', 'studio.local'),
      host('cam-mbp', 'localhost'),
    ];
    expect(newSuggestions(suggestions, hosts).map((item) => item.endpoint)).toEqual(['nas.local', '100.64.0.24', 'build-arm']);
  });

  it('keeps a suggestion for a machine listed without a host, and picking it fills that machine in', () => {
    const lab = found('lab-box', 'lab-box.local', { port: 2222, sources: ['knownHosts'] });
    const hosts = [{ ...host('Lab Box', ''), source: 'seed' }];
    expect(newSuggestions([lab], hosts)).toEqual([lab]);
    expect(suggestionFields(lab, hosts)).toEqual({ name: 'Lab Box', endpoint: 'lab-box.local', port: 2222 });
    expect(suggestionFields(lab, [])).toEqual({ name: 'lab-box', endpoint: 'lab-box.local', port: 2222 });
    expect(suggestionFields(found('', '192.168.1.77'), hosts).name).toBe('');
  });

  it('says where a suggestion leads the way ssh would', () => {
    expect(suggestionTarget(found('build-arm', 'build-arm', { hostName: '10.0.4.21', user: 'ubuntu', port: 2200 }))).toBe('ubuntu@10.0.4.21:2200');
    expect(suggestionTarget(found('mac-studio', 'mac-studio.tailc0ffee.ts.net'))).toBe('mac-studio.tailc0ffee.ts.net');
    expect(suggestionTarget(found('nas', 'nas.local', { port: 2222 }))).toBe('nas.local:2222');
  });

  it('draws a Mac only when Tailscale says it is one', () => {
    expect(suggestionKind(found('studio', 'studio', { os: 'macOS' }))).toBe('mac');
    expect(suggestionKind(found('cedar', 'cedar', { os: 'linux' }))).toBe('server');
    expect(suggestionKind(found('build', 'build'))).toBe('server');
  });
});
