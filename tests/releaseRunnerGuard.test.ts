import { expect, test } from 'bun:test';

const release = {
  GITHUB_REPOSITORY: 'aaronvanston/arbor',
  GITHUB_WORKFLOW_REF: 'aaronvanston/arbor/.github/workflows/arbor-release.yml@refs/heads/main',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'schedule',
};

function guard(env: Partial<typeof release>) {
  const result = Bun.spawnSync(['bash', 'scripts/release-runner-guard.sh'], { env: { PATH: process.env.PATH ?? '', ...release, ...env } });
  return { ok: result.exitCode === 0, stderr: result.stderr.toString() };
}

test('the release runner takes the Release workflow from main, on its schedule or started by hand', () => {
  expect(guard({}).ok).toBe(true);
  expect(guard({ GITHUB_EVENT_NAME: 'workflow_dispatch' }).ok).toBe(true);
});

test('the release runner refuses pull requests, other workflows, other branches and forks', () => {
  expect(guard({ GITHUB_EVENT_NAME: 'pull_request' }).stderr).toContain('refusing: event pull_request');
  expect(guard({ GITHUB_EVENT_NAME: 'pull_request_target' }).ok).toBe(false);
  expect(guard({ GITHUB_EVENT_NAME: 'push' }).ok).toBe(false);
  expect(guard({ GITHUB_WORKFLOW_REF: 'aaronvanston/arbor/.github/workflows/sneaky.yml@refs/heads/main' }).ok).toBe(false);
  expect(guard({ GITHUB_WORKFLOW_REF: 'aaronvanston/arbor/.github/workflows/arbor-release.yml@refs/pull/7/merge', GITHUB_REF: 'refs/pull/7/merge' }).ok).toBe(false);
  expect(guard({ GITHUB_REF: 'refs/heads/feature' }).ok).toBe(false);
  expect(guard({ GITHUB_REPOSITORY: 'someone/arbor' }).ok).toBe(false);
  expect(guard({ GITHUB_WORKFLOW_REF: '' }).stderr).toContain('workflow unknown');
});
