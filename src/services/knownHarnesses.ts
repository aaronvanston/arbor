import type { HarnessInfo } from '../native/types';

// Apart from `agentHomes.ts`, which the window loads at launch, so this comes with the Settings page that uses it.

/**
 * The harnesses Arbor knows, for its reference list: those some machine has (Claude Code and Codex always count) first,
 * then the rest, each group in the catalog's order. Everywhere else shows only the first group (`harnesses::is_found`).
 */
export const knownHarnessOrder = (harnesses: readonly HarnessInfo[]): HarnessInfo[] =>
  [...harnesses.filter((harness) => harness.found), ...harnesses.filter((harness) => !harness.found)];
