import { describe, expect, it } from 'bun:test';
import { rememberSetupComparison, takeSetupCompare, takeSetupShow } from '../src/pages/setupComparison';

describe('a link into Sync’s comparison', () => {
  it('starts Overview at Compare machines for the one visit it asked', () => {
    rememberSetupComparison({ compare: true });
    expect(takeSetupCompare()).toBe(true);
    expect(takeSetupCompare()).toBe(false);
  });

  it('leaves a later link without it at the top', () => {
    rememberSetupComparison({ compare: true });
    rememberSetupComparison({ show: 'review' });
    expect(takeSetupCompare()).toBe(false);
    expect(takeSetupShow()).toBe('review');
  });
});
