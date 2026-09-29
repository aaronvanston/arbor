import type { AntiburnStatus, SessionTranscript } from '../native/types';

/** Antiburn's site, where a Mac without it gets it. */
export const ANTIBURN_URL = 'https://antiburn.com';

/** The agent homes Antiburn reads: Claude Code's and Codex's own. It doesn't look in T3 Code's provider homes. */
export const ANTIBURN_HOMES = ['~/.claude', '~/.codex'];

/**
 * What Antiburn can do for a session: `missing` when it isn't on this Mac, `listed` when it lists the session, and why
 * it doesn't otherwise. `unknown` when Arbor has no transcript for the session, or hasn't yet learned which agent home
 * the transcript is in.
 */
export type AntiburnReach = 'missing' | 'listed' | 'otherHome' | 'otherMachine' | 'unknown';

/** Antiburn reads the transcripts on the Mac it runs on, in the agents' own homes. */
export function antiburnReach(status: AntiburnStatus, transcript: SessionTranscript | null): AntiburnReach {
  if (!status.installed) return 'missing';
  if (!transcript) return 'unknown';
  if (transcript.machine !== status.thisMachine) return 'otherMachine';
  if (!transcript.agentHome) return 'unknown';
  return ANTIBURN_HOMES.includes(transcript.agentHome) ? 'listed' : 'otherHome';
}
