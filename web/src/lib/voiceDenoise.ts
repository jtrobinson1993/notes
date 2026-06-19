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
}

let workletAdded = false;

export async function createDenoisedStream(ctx: AudioContext, mic: MediaStream): Promise<Denoised> {
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
    source.connect(rnnoise).connect(dest);
    return {
      stream: dest.stream,
      cleanup: () => {
        try {
          rnnoise.destroy();
          source.disconnect();
          rnnoise.disconnect();
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    // RNNoise unavailable (load/worklet failure) — use the raw mic; the browser's
    // built-in noise suppression (from getUserMedia constraints) still applies.
    return { stream: mic, cleanup: () => {} };
  }
}
