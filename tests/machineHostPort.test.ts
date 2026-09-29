import { describe, expect, it } from 'bun:test';
import { parsePort } from '../src/services/machineHealth';

describe('machine host ports', () => {
  it('takes whole numbers from 1 to 65535', () => {
    expect(parsePort('22')).toBe(22);
    expect(parsePort(' 2222 ')).toBe(2222);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
    expect(parsePort('022')).toBe(22);
  });

  it('turns down anything else rather than guessing', () => {
    for (const text of ['', ' ', '0', '65536', '99999', '-22', '2.5', '1e3', '22a', '0x16', '123456']) {
      expect(parsePort(text)).toBeNull();
    }
  });
});
