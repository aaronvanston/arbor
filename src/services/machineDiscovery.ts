import { invokeCommand } from '../native/commands';
import type { MessageKey } from '../i18n/resources';
import type { MachineKind } from './machineIdentity';
import type { DiscoveredHost, DiscoverySource, MachineHost } from '../native/types';
import { machineLookKey } from './machineLook';

/** Reads ~/.ssh/config (and what it includes), ~/.ssh/known_hosts and Tailscale's peers on this Mac. Never a key. */
export const discoverMachineHosts = () => invokeCommand('discover_machine_hosts');

export const SOURCE_LABEL: Record<DiscoverySource, MessageKey> = {
  sshConfig: 'machines.discovery.source.sshConfig',
  knownHosts: 'machines.discovery.source.knownHosts',
  tailscale: 'machines.discovery.source.tailscale',
};

/** An endpoint as ssh would reach it, for comparing: no `user@`, no trailing dot, any case. */
const hostKey = (endpoint: string) => endpoint.trim().toLowerCase().replace(/^[^@]*@/, '').replace(/\.$/, '');

/** Machine names compare as the backend compares them, so "Mac Mini" and "mac-mini" are one machine. */
const nameKey = machineLookKey;

/**
 * The suggestions for machines not in the list yet. One is left out when a machine already goes to any of its names or
 * addresses, or has its name and a host. A machine listed without a host yet, like one seeded from an API key, still
 * gets its suggestion, which fills the host in.
 */
export function newSuggestions(found: DiscoveredHost[], hosts: MachineHost[]): DiscoveredHost[] {
  const endpoints = new Set(hosts.map((host) => hostKey(host.endpoint)).filter(Boolean));
  const names = new Set(hosts.filter((host) => host.endpoint.trim()).map((host) => nameKey(host.machine)).filter(Boolean));
  return found.filter((suggestion) =>
    !endpoints.has(hostKey(suggestion.endpoint))
    && !suggestion.addresses.some((address) => endpoints.has(hostKey(address)))
    && !(suggestion.name && names.has(nameKey(suggestion.name))));
}

/** What picking a suggestion puts in the fields. It takes the name of a listed machine that has no host yet. */
export function suggestionFields(suggestion: DiscoveredHost, hosts: MachineHost[]): { name: string; endpoint: string; port: number } {
  const waiting = suggestion.name
    ? hosts.find((host) => !host.endpoint.trim() && nameKey(host.machine) === nameKey(suggestion.name))
    : undefined;
  return { name: waiting?.machine ?? suggestion.name, endpoint: suggestion.endpoint, port: suggestion.port };
}

/** Where a suggestion leads, as ssh would put it: `user@host:port`, leaving out what isn't known and port 22. */
export function suggestionTarget(suggestion: DiscoveredHost): string {
  const host = suggestion.hostName ?? suggestion.endpoint;
  return `${suggestion.user ? `${suggestion.user}@` : ''}${host}${suggestion.port === 22 ? '' : `:${suggestion.port}`}`;
}

/** Tailscale says when a peer is a Mac; nothing else says what a suggestion is. */
export const suggestionKind = (suggestion: DiscoveredHost): MachineKind => (suggestion.os?.toLowerCase() === 'macos' ? 'mac' : 'server');
