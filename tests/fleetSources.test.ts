import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { T3_THREADS_UPDATED_EVENT } from '../src/services/fleetSources';

describe('fleet sources', () => {
  it('listens for the event the native side sends when a T3 Code snapshot changes', () => {
    const rust = readFileSync(new URL('../src-tauri/src/usage/machine_health/t3_threads.rs', import.meta.url), 'utf8');
    expect(rust).toContain(`const T3_THREADS_UPDATED_EVENT: &str = "${T3_THREADS_UPDATED_EVENT}";`);
  });
});
