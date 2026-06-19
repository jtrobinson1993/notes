import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  denoiseStrength,
  formatKeyCode,
  pttKey,
  setDenoiseStrength,
  setPttKey,
  setVoiceActivation,
  voiceActivation,
} from '../../src/lib/voicePrefs';

beforeEach(() => {
  localStorage.clear();
});

describe('voice activation', () => {
  it('persists the chosen mode', () => {
    setVoiceActivation('ptt');
    expect(voiceActivation.value).toBe('ptt');
    expect(localStorage.getItem('notes:voice-activation')).toBe('ptt');
    setVoiceActivation('voice');
    expect(voiceActivation.value).toBe('voice');
  });
});

describe('push-to-talk key', () => {
  it('stores and clears the key code', () => {
    setPttKey('KeyV');
    expect(pttKey.value).toBe('KeyV');
    expect(localStorage.getItem('notes:voice-ptt-key')).toBe('KeyV');
    setPttKey(null);
    expect(pttKey.value).toBeNull();
    expect(localStorage.getItem('notes:voice-ptt-key')).toBeNull();
  });
});

describe('denoise strength', () => {
  it('clamps to 0..1 and persists', () => {
    setDenoiseStrength(0.5);
    expect(denoiseStrength.value).toBe(0.5);
    expect(localStorage.getItem('notes:voice-denoise-strength')).toBe('0.5');
    setDenoiseStrength(2);
    expect(denoiseStrength.value).toBe(1);
    setDenoiseStrength(-1);
    expect(denoiseStrength.value).toBe(0);
  });
});

describe('formatKeyCode', () => {
  it('renders friendly labels', () => {
    expect(formatKeyCode(null)).toBe('Not set');
    expect(formatKeyCode('KeyV')).toBe('V');
    expect(formatKeyCode('Digit4')).toBe('4');
    expect(formatKeyCode('Space')).toBe('Space');
    expect(formatKeyCode('ControlLeft')).toBe('Control Left');
    expect(formatKeyCode('ArrowUp')).toBe('Up arrow');
    expect(formatKeyCode('Numpad5')).toBe('Numpad 5');
  });
});

describe('initialisation from localStorage', () => {
  it('reads persisted values on module load', async () => {
    localStorage.setItem('notes:voice-activation', 'ptt');
    localStorage.setItem('notes:voice-ptt-key', 'KeyB');
    localStorage.setItem('notes:voice-denoise-strength', '0.25');
    vi.resetModules();
    const prefs = await import('../../src/lib/voicePrefs');
    expect(prefs.voiceActivation.value).toBe('ptt');
    expect(prefs.pttKey.value).toBe('KeyB');
    expect(prefs.denoiseStrength.value).toBe(0.25);
  });

  it('falls back to defaults when unset or invalid', async () => {
    localStorage.setItem('notes:voice-denoise-strength', 'not-a-number');
    vi.resetModules();
    const prefs = await import('../../src/lib/voicePrefs');
    expect(prefs.voiceActivation.value).toBe('voice');
    expect(prefs.pttKey.value).toBeNull();
    expect(prefs.denoiseStrength.value).toBe(1);
  });
});
