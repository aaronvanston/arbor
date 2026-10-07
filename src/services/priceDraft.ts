/** A manual price's fields that must be filled before it's saved. */
export type RequiredPriceField = 'model' | 'prompt' | 'completion';

/**
 * What a manual price still needs: a model, and its input and output prices. A blank price would be saved as 0, so a
 * model with no catalog price to fall back on would count as free; 0 typed in says that's meant.
 */
export function missingPriceFields(draft: { model: string; prompt: string; completion: string }): RequiredPriceField[] {
  return (['model', 'prompt', 'completion'] as const).filter((field) => !draft[field].trim());
}
