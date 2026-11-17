import type { ComputePoint, ComputeProviderId, ComputeSnapshot } from './types';

/**
 * Compute: cloud sandboxes from the providers the user connected. `get_compute` reads what Arbor holds and never the
 * network; the `compute-updated` event carries the same snapshot after every round.
 */
export type ComputeCommands = {
  get_compute: { result: ComputeSnapshot };
  refresh_compute: { result: ComputeSnapshot };
  get_compute_sandbox_history: { args: { provider: ComputeProviderId; sandboxId: string }; result: ComputePoint[] };
  connect_compute_provider: { args: { provider: ComputeProviderId; key: string }; result: ComputeSnapshot };
  disconnect_compute_provider: { args: { provider: ComputeProviderId }; result: ComputeSnapshot };
  open_compute_sandbox: { args: { provider: ComputeProviderId; sandboxId: string }; result: void };
  link_compute_sandbox: { args: { provider: ComputeProviderId; sandboxId: string; machine: string; session?: string | null }; result: void };
  unlink_compute_sandbox: { args: { provider: ComputeProviderId; sandboxId: string }; result: void };
};
