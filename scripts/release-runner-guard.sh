#!/usr/bin/env bash
# Runs before every job the release runner picks up (ACTIONS_RUNNER_HOOK_JOB_STARTED, set by
# install-release-runner.sh) and fails the job, before any of its steps, unless it's the Release workflow as committed
# on main, started by its schedule or by hand. A pull request, a fork's included, can change workflow files and ask for
# this runner by its labels; GitHub can't limit a personal repository's runner to one workflow, so the runner does.
set -euo pipefail

repository="aaronvanston/arbor"
workflow="$repository/.github/workflows/arbor-release.yml@refs/heads/main"

refuse() {
  echo "The release runner only runs $workflow on its schedule or by hand; refusing: $1" >&2
  exit 1
}

[[ "${GITHUB_REPOSITORY:-}" == "$repository" ]] || refuse "repository ${GITHUB_REPOSITORY:-unknown}"
[[ "${GITHUB_WORKFLOW_REF:-}" == "$workflow" ]] || refuse "workflow ${GITHUB_WORKFLOW_REF:-unknown}"
[[ "${GITHUB_REF:-}" == "refs/heads/main" ]] || refuse "ref ${GITHUB_REF:-unknown}"
case "${GITHUB_EVENT_NAME:-}" in
  schedule | workflow_dispatch) ;;
  *) refuse "event ${GITHUB_EVENT_NAME:-unknown}" ;;
esac
