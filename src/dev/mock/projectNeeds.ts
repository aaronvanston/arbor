import type { CellNeed, ProjectCell } from '../../native/types';

/**
 * A project cell with what it needs, as project_places.rs's `cell_needs` works it out, for the mock's answers and the
 * tests that build cells by hand: the place first, then bringing the checkout up to date.
 */
export const withNeeds = (cell: ProjectCell): ProjectCell => {
  const needs: CellNeed[] = [];
  const place: Partial<Record<ProjectCell['state'], CellNeed>> = { elsewhere: 'link', missing: 'clone', blocked: 'clear', notScanned: 'scan' };
  const first = place[cell.state];
  if (first) needs.push(first);
  const status = cell.status;
  if (status?.fetchFailed) needs.push('fetch');
  const behind = status?.behind ?? 0;
  if (status && behind > 0 && status.upstream && status.branch && (status.defaultBranch === null || status.upstream === status.defaultBranch)) needs.push('pull');
  if (cell.skillsOut > 0) needs.push('skills');
  return { ...cell, needs };
};
