import type { AntiburnStatus, SessionTranscript } from '../native/types';

/** The agent homes Antiburn reads: Claude Code's and Codex's own, and no others. */
export const ANTIBURN_HOMES = ['~/.claude', '~/.codex'];

/**
 * What Antiburn on this Mac can do for a session: `listed` when it lists the session, and why it doesn't otherwise.
 * `unknown` when Arbor has no transcript for the session, or hasn't yet learned which agent home the transcript is in.
 */
export type AntiburnReach = 'listed' | 'otherHome' | 'otherMachine' | 'unknown';

/** Antiburn reads the transcripts on the Mac it runs on, in the agents' own homes. */
export function antiburnReach(status: AntiburnStatus, transcript: SessionTranscript | null): AntiburnReach {
  if (!transcript) return 'unknown';
  if (transcript.machine !== status.thisMachine) return 'otherMachine';
  if (!transcript.agentHome) return 'unknown';
  return ANTIBURN_HOMES.includes(transcript.agentHome) ? 'listed' : 'otherHome';
}
