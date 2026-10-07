import { useCallback, useEffect, useState } from 'react';
import { invokeCommand } from '../native/commands';
import type { CoreApiKeyView, CoreConfigView } from '../native/types';

/** The keys the core accepts, and the ones paused: kept by Arbor, out of the core's list until resumed. */
type ClientKeys = Pick<CoreConfigView, 'apiKeys' | 'pausedApiKeys'>;

/**
 * A key with only its ends showing, as usage records keep it (`mask_api_key` in usage.rs), so a key reads the same on
 * Settings, the heavy-session banner and Usage › Requests: "sk-1••••0a2c", or for a short one its first two.
 */
export function maskApiKey(apiKey: string) {
  const value = [...apiKey.trim()];
  if (!value.length) return '';
  if (value.length <= 8) return `${value.slice(0, 2).join('')}••••`;
  return `${value.slice(0, 4).join('')}••••${value.slice(-4).join('')}`;
}

/** A new client key: `sk-` and 48 random hex digits. */
export function newClientKey(random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)) {
  return `sk-${Array.from(random(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Adds a new key to the proxy, named `remark`, and gives back the keys it then accepts. */
export async function addNewClientKey(remark: string) {
  return (await invokeCommand('add_core_api_key', { apiKey: newClientKey(), remark })).apiKeys;
}

/** A key by its remark, or masked when it has none. */
export const clientKeyName = (key: CoreApiKeyView) => key.remark || maskApiKey(key.apiKey);

/**
 * The key Arbor hands out when it doesn't ask which: the first the core accepts. Home's Key shows it, Copy API key
 * copies it and Connect an agent starts on it, each naming it, so they never quietly disagree after a pause.
 */
export const defaultClientKey = ({ apiKeys }: Pick<CoreConfigView, 'apiKeys'>): CoreApiKeyView | null => apiKeys[0] ?? null;

const clientKeys = ({ apiKeys, pausedApiKeys }: CoreConfigView): ClientKeys => ({ apiKeys, pausedApiKeys });

/** The client keys, loaded while `enabled`, with pause and resume keeping them current. */
export function useClientKeys(enabled: boolean) {
  const [keys, setKeys] = useState<ClientKeys | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    invokeCommand('get_core_config_settings')
      .then((view) => {
        if (!disposed) setKeys(clientKeys(view));
      })
      .catch((error) => console.warn('Failed to load the client keys', error));
    return () => {
      disposed = true;
    };
  }, [enabled]);
  const change = useCallback(async (command: 'pause_core_api_key' | 'resume_core_api_key', apiKeyHash: string) => {
    setKeys(clientKeys(await invokeCommand(command, { apiKeyHash })));
  }, []);
  const pause = useCallback((apiKeyHash: string) => change('pause_core_api_key', apiKeyHash), [change]);
  const resume = useCallback((apiKeyHash: string) => change('resume_core_api_key', apiKeyHash), [change]);
  return { keys, pause, resume };
}
