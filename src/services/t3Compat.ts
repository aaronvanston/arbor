import type { AgentKind, T3Policy } from '../native/types';

/**
 * Whether T3 Code works with a machine's Claude Code or Codex, decided the way T3 Code decides it (its
 * `providerCompatibility.ts`): the first policy for the agent whose `t3CodeRange` holds the T3 Code version there, then
 * the first of that policy's ranges holding the agent's version. Only a stable x.y.z version is looked up; anything
 * else is unknown, as it is there. Only `broken` and `unsupported` are worth a warning.
 */

type Parts = [number, number, number];

const partsOf = (match: RegExpMatchArray): Parts => [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];

function compareParts(a: Parts, b: Parts): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/**
 * T3 Code's range check (`satisfiesSemverRange`): comparators separated by spaces, all of which must hold, in groups
 * joined by `||`, any of which may. A comparator is `^`, `>=`, `>`, `<=`, `<` or `=` (the default) and up to three
 * numbers; a missing one counts as 0, and a version's pre-release is ignored.
 */
export function satisfiesRange(rawVersion: string, range: string): boolean {
  const found = rawVersion.trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/);
  if (!found) return false;
  const version = partsOf(found);
  return range.split('||').some((group) => {
    const comparators = group.trim().split(/\s+/).filter(Boolean);
    return comparators.length > 0 && comparators.every((comparator) => {
      const match = comparator.trim().match(/^(\^|>=|>|<=|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
      if (!match) return false;
      const target: Parts = [Number(match[2]), Number(match[3] || 0), Number(match[4] || 0)];
      const compared = compareParts(version, target);
      switch (match[1] || '=') {
        case '^':
          if (compared < 0) return false;
          if (target[0] > 0) return version[0] === target[0];
          if (target[1] > 0) return version[0] === 0 && version[1] === target[1];
          return version[0] === 0 && version[1] === 0 && version[2] === target[2];
        case '>=': return compared >= 0;
        case '>': return compared > 0;
        case '<=': return compared <= 0;
        case '<': return compared < 0;
        default: return compared === 0;
      }
    });
  });
}

/** T3 Code turns down a policy whose recommended version it doesn't itself support, and so a manifest holding one. */
const readable = (policy: T3Policy) => {
  const recommended = policy.recommendedVersion;
  return recommended === null
    || ((policy.recommendedRange === null || satisfiesRange(recommended, policy.recommendedRange))
      && policy.ranges.find((entry) => satisfiesRange(recommended, entry.range))?.status === 'supported');
};

export type T3Advisory = {
  status: 'broken' | 'unsupported';
  /** The version, or else the range, T3 Code recommends. */
  recommendation: string | null;
};

/**
 * What T3 Code makes of an agent's version on a machine that runs it. Without T3 Code's version there, a policy is used
 * only when it's the agent's one policy, since which one applies depends on it. Null when the policies are unknown or
 * there's nothing to warn about.
 */
export function t3Advisory(policies: T3Policy[] | null, agent: AgentKind, version: string | null, t3Version: string | null): T3Advisory | null {
  if (!policies || !version || !policies.every(readable)) return null;
  const candidates = policies.filter((policy) => policy.agent === agent);
  const policy = t3Version ? candidates.find((policy) => satisfiesRange(t3Version, policy.t3CodeRange)) : candidates.length === 1 ? candidates[0] : undefined;
  const stable = version.trim().replace(/^v/, '');
  if (!policy || !/^\d+\.\d+\.\d+$/.test(stable)) return null;
  const status = policy.ranges.find((entry) => satisfiesRange(stable, entry.range))?.status;
  return status === 'broken' || status === 'unsupported' ? { status, recommendation: policy.recommendedVersion ?? policy.recommendedRange } : null;
}
