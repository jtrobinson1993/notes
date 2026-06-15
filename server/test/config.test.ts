import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const ENV_KEYS = ['KLIPY_API_KEY', 'APP_ORIGIN', 'PORT'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loadConfig — klipyApiKey', () => {
  it('is null when KLIPY_API_KEY is unset', () => {
    delete process.env.KLIPY_API_KEY;
    expect(loadConfig().klipyApiKey).toBeNull();
  });

  it('is null when KLIPY_API_KEY is blank/whitespace', () => {
    process.env.KLIPY_API_KEY = '   ';
    expect(loadConfig().klipyApiKey).toBeNull();
  });

  it('trims a present key', () => {
    process.env.KLIPY_API_KEY = '  abc123  ';
    expect(loadConfig().klipyApiKey).toBe('abc123');
  });
});
