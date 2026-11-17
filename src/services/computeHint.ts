import type { ComputeProviderId, ComputeSnapshot } from '../native/types';
import { savedStore } from './savedStore';

/**
 * What launch needs to know about Compute, and nothing more: the providers Arbor knows and the saved hint that says
 * which are connected. The shell, the sidebar, Home and the palette read only this, so the snapshot store and every
 * figure (services/compute.ts) load in their own chunk, and only once a provider is connected.
 */

/** The event Rust sends the snapshot in after every round. Here so the browser mock needn't load the store. */
export const COMPUTE_UPDATED_EVENT = 'compute-updated';

// ---------------------------------------------------------------------------
// The providers Arbor knows. A second one is one more entry here and one module in Rust.
// ---------------------------------------------------------------------------

export type ComputeProviderInfo = {
  id: ComputeProviderId;
  /** The provider's own name, never translated. */
  name: string;
  /** The letter its mark shows, until it has an icon of its own. */
  mark: string;
  /** What its API keys start with, for the key field's placeholder. */
  keyPlaceholder: string;
  /** The command that makes a key that can only read, where the user is signed in to the provider. */
  readOnlyKeyCommand: string;
  /** What a key needs to read the provider's limits, in the provider's own words; null when it doesn't say. */
  limitsScope: string | null;
};

export const COMPUTE_PROVIDERS: Readonly<Record<ComputeProviderId, ComputeProviderInfo>> = {
  boat: {
    id: 'boat',
    name: 'Boat',
    mark: 'B',
    keyPlaceholder: 'boat_…',
    readOnlyKeyCommand: 'boat api-key create arbor --actions sandbox.read,account.read --ttl 365d',
    limitsScope: 'account.read',
  },
};

export const COMPUTE_PROVIDER_IDS = Object.keys(COMPUTE_PROVIDERS) as ComputeProviderId[];

export const isComputeProviderId = (value: unknown): value is ComputeProviderId =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(COMPUTE_PROVIDERS, value);

export const computeProviderName = (id: ComputeProviderId) => COMPUTE_PROVIDERS[id].name;

// ---------------------------------------------------------------------------
// The hint: which providers are connected, saved so launch knows without asking the app
// ---------------------------------------------------------------------------

export const COMPUTE_HINT_KEY = 'arbor.compute.connected.v1';

/** The connected providers as saved: known ids only, each once, in the providers' order. */
export function parseComputeHint(raw: string | null): ComputeProviderId[] {
  if (!raw) return [];
  const stored = JSON.parse(raw) as unknown;
  if (!Array.isArray(stored)) return [];
  return COMPUTE_PROVIDER_IDS.filter((id) => stored.includes(id));
}

/**
 * Not a secret: only which providers have a key saved. Read synchronously at launch, so with none the window makes no
 * Compute call at all; `get_compute` corrects it whenever it says otherwise (services/compute.ts).
 */
export const computeHint = savedStore<ComputeProviderId[]>({ key: COMPUTE_HINT_KEY, parse: parseComputeHint, fallback: [] });

/** The providers the hint says are connected, for a component. Empty hides every part of Compute but its Settings page. */
export const useConnectedComputeProviders = computeHint.useValue;

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** The hint as a snapshot from Rust has it: Rust is the truth, so a hint that was wrong is put right. */
export function hintFor(snapshot: ComputeSnapshot): ComputeProviderId[] {
  const ids = new Set(snapshot.providers.map((provider) => provider.id));
  return COMPUTE_PROVIDER_IDS.filter((id) => ids.has(id));
}

export function correctComputeHint(snapshot: ComputeSnapshot) {
  const next = hintFor(snapshot);
  if (!sameIds(next, computeHint.get())) computeHint.set(next);
}
