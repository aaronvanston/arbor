import { describe, expect, it } from 'bun:test';
import { missingPriceFields } from '../src/services/priceDraft';

describe('manual prices', () => {
  it("won't save a model name alone, which would price it as free", () => {
    expect(missingPriceFields({ model: 'acme-coder', prompt: '', completion: '' })).toEqual(['prompt', 'completion']);
    expect(missingPriceFields({ model: '  ', prompt: ' ', completion: '2' })).toEqual(['model', 'prompt']);
  });

  it('takes 0 typed in as meaning free', () => {
    expect(missingPriceFields({ model: 'acme-coder', prompt: '0', completion: '0' })).toEqual([]);
  });
});
