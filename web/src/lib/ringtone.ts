// A tiny synthesized ringtone (WebAudio) — no audio asset to bundle. Best-effort:
// browsers may block audio before a user gesture, in which case the incoming-call
// modal still shows silently. Two short tones repeated, classic ring cadence.

let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function blip(at: number, freq: number): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.15, at + 0.02);
  gain.gain.linearRampToValueAtTime(0, at + 0.4);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.45);
}

function ring(): void {
  if (!ctx) return;
  const t = ctx.currentTime;
  blip(t, 480);
  blip(t + 0.5, 440);
}

export function startRingtone(): void {
  if (timer) return;
  try {
    ctx = new AudioContext();
    void ctx.resume();
    ring();
    timer = setInterval(ring, 2000);
  } catch {
    /* audio blocked — visual ring only */
  }
}

export function stopRingtone(): void {
  if (timer) clearInterval(timer);
  timer = null;
  void ctx?.close();
  ctx = null;
}
