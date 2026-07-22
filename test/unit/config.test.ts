import { describe, it, expect } from 'vitest';
import { loadConfig, durationWithDefault } from '../../src/config.js';
import { PENDING_TTL_MS } from '../../src/sweep/service.js';

/**
 * Config parsing is pure and worth pinning: the duration form the TTL knobs use
 * (`72h`, `500ms`, …) and the fallbacks that keep the service bootable with only
 * DATABASE_URL set.
 */
describe('durationWithDefault', () => {
  it('parses each supported unit into milliseconds', () => {
    expect(durationWithDefault('X', '72h', 0)).toBe(72 * 60 * 60 * 1000);
    expect(durationWithDefault('X', '90m', 0)).toBe(90 * 60 * 1000);
    expect(durationWithDefault('X', '30s', 0)).toBe(30 * 1000);
    expect(durationWithDefault('X', '500ms', 0)).toBe(500);
    expect(durationWithDefault('X', '2d', 0)).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it('falls back when unset or empty', () => {
    expect(durationWithDefault('X', undefined, 1234)).toBe(1234);
    expect(durationWithDefault('X', '', 1234)).toBe(1234);
  });

  it('rejects a malformed duration', () => {
    expect(() => durationWithDefault('PENDING_TTL', '72', 0)).toThrow(/must be a duration/);
    expect(() => durationWithDefault('PENDING_TTL', 'soon', 0)).toThrow(/must be a duration/);
    expect(() => durationWithDefault('PENDING_TTL', '10y', 0)).toThrow(/must be a duration/);
  });
});

describe('loadConfig', () => {
  const base = { DATABASE_URL: 'postgres://localhost/db' };

  it('defaults PENDING_TTL to 72h when unset', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).pendingTtlMs).toBe(PENDING_TTL_MS);
  });

  it('reads PENDING_TTL from the env in duration form', () => {
    const config = loadConfig({ ...base, PENDING_TTL: '1h' } as NodeJS.ProcessEnv);
    expect(config.pendingTtlMs).toBe(60 * 60 * 1000);
  });
});
