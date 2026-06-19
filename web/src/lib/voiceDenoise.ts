import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

// NOTE: the package is imported dynamically (inside the function) on purpose —
// its `RnnoiseWorkletNode extends AudioWorkletNode` evaluates a browser-only
// global at import time, which would crash any unit test that transitively
// imports the voice store under jsdom. Deferring keeps module load test-safe.

// ML noise suppression (RNNoise) on the mic, on top of the browser's built-in
// echo-cancel/noise-suppress/AGC. RNNoise strips steady + transient background
// noise (keyboard/trackpad, fans, hum) that the browser's basic NS leaves in.
// It runs entirely client-side, before E2EE encryption — so it's compatible
// with the encrypted pipeline and never involves the server.
//
// RNNoise assumes a 48 kHz context (matching Opus). If anything fails to load,
// we fall back to the raw mic stream so a call never breaks over denoising.

export interface Denoised {
  stream: MediaStream;
  cleanup: () => void;
  /** Adjust the wet/dry mix (0..1) live, e.g. from the settings slider. */
  setStrength: (v: number) => void;
}

let workletAdded = false;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// `strength` is a 0..1 wet/dry mix: RNNoise has no native intensity knob, so we
// blend the denoised (wet) signal with the raw (dry) mic. 1 = fully denoised
// (default); 0 = raw mic. Intermediate values let through more of the original.
export async function createDenoisedStream(ctx: AudioContext, mic: MediaStream, strength = 1): Promise<Denoised> {
  try {
    const { loadRnnoise, RnnoiseWorkletNode } = await import('@sapphi-red/web-noise-suppressor');
    const wasmBinary = await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdWasmPath });
    if (!workletAdded) {
      await ctx.audioWorklet.addModule(rnnoiseWorkletPath);
      workletAdded = true;
    }
    const source = ctx.createMediaStreamSource(mic);
    const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    const dest = ctx.createMediaStreamDestination();
    const wet = ctx.createGain(); // denoised path
    const dry = ctx.createGain(); // raw path
    wet.gain.value = clamp01(strength);
    dry.gain.value = 1 - clamp01(strength);
    source.connect(rnnoise).connect(wet).connect(dest);
    source.connect(dry).connect(dest);
    return {
      stream: dest.stream,
      cleanup: () => {
        try {
          rnnoise.destroy();
          source.disconnect();
          rnnoise.disconnect();
          wet.disconnect();
          dry.disconnect();
        } catch {
          /* ignore */
        }
      },
      setStrength: (v: number) => {
        wet.gain.value = clamp01(v);
        dry.gain.value = 1 - clamp01(v);
      },
    };
  } catch {
    // RNNoise unavailable (load/worklet failure) — use the raw mic; the browser's
    // built-in noise suppression (from getUserMedia constraints) still applies.
    return { stream: mic, cleanup: () => {}, setStrength: () => {} };
  }
}
