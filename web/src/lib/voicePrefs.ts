import { ref, type Ref } from 'vue';

// Device-level voice preferences (like privacy.ts / theme.ts): persisted to
// localStorage, never sent to the server. How your mic behaves on this device
// is a purely local concern.

export type VoiceActivation = 'voice' | 'ptt';

const ACTIVATION_KEY = 'notes:voice-activation';
const PTT_KEY_KEY = 'notes:voice-ptt-key';
const STRENGTH_KEY = 'notes:voice-denoise-strength';

// How the mic transmits: continuous ("voice activity" / open mic) or
// push-to-talk (only while the PTT key/button is held).
function initActivation(): VoiceActivation {
  return localStorage.getItem(ACTIVATION_KEY) === 'ptt' ? 'ptt' : 'voice';
}
export const voiceActivation: Ref<VoiceActivation> = ref(initActivation());

// The key held to talk in push-to-talk mode, stored as a KeyboardEvent.code
// (e.g. "KeyV", "Space"). Null until the user records one — without it, PTT
// falls back to the on-screen hold-to-talk button.
export const pttKey: Ref<string | null> = ref(localStorage.getItem(PTT_KEY_KEY));

// RNNoise background-noise-removal strength as a 0..1 wet/dry mix. 1 = fully
// denoised (the prior fixed behaviour, and the default); 0 = raw mic.
function initStrength(): number {
  const raw = localStorage.getItem(STRENGTH_KEY);
  if (raw === null) return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}
export const denoiseStrength: Ref<number> = ref(initStrength());

export function setVoiceActivation(v: VoiceActivation): void {
  voiceActivation.value = v;
  localStorage.setItem(ACTIVATION_KEY, v);
}

export function setPttKey(code: string | null): void {
  pttKey.value = code;
  if (code === null) localStorage.removeItem(PTT_KEY_KEY);
  else localStorage.setItem(PTT_KEY_KEY, code);
}

export function setDenoiseStrength(v: number): void {
  const clamped = Math.min(1, Math.max(0, v));
  denoiseStrength.value = clamped;
  localStorage.setItem(STRENGTH_KEY, String(clamped));
}

/** Friendly label for a KeyboardEvent.code (e.g. "KeyV" → "V", "Space" → "Space"). */
export function formatKeyCode(code: string | null): string {
  if (!code) return 'Not set';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Numpad ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} arrow`;
  // Split CamelCase / trailing Left|Right into words: "ControlLeft" → "Control Left".
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}
