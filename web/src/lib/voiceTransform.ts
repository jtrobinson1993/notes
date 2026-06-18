// Main-thread side of E2EE voice: owns the frame-crypto Worker and attaches the
// WebRTC Encoded Transform to senders/receivers. Uses the standards-track
// `RTCRtpScriptTransform` (native in Firefox/Safari and recent Chromium). If a
// target must support older Chromium, a `createEncodedStreams` fallback is the
// follow-up (see spec/voice.md). Browser-runtime only (manual verification).

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL('./voiceFrameWorker.ts', import.meta.url), { type: 'module' });
  return worker;
}

interface ScriptTransformCtor {
  new (worker: Worker, options: { operation: 'encrypt' | 'decrypt' }): unknown;
}
function scriptTransform(): ScriptTransformCtor | undefined {
  return (globalThis as { RTCRtpScriptTransform?: ScriptTransformCtor }).RTCRtpScriptTransform;
}

/** Whether this browser supports per-frame E2EE (WebRTC Encoded Transform). */
export function voiceE2eeSupported(): boolean {
  return scriptTransform() !== undefined;
}

/** Deliver (or rotate in) the media key for an epoch into the worker. */
export function setFrameKey(epoch: number, rawKey: Uint8Array): void {
  const buf = rawKey.slice().buffer; // a transferable copy
  getWorker().postMessage({ type: 'key', epoch, raw: buf }, [buf]);
}

/** Set which epoch the local mic is encrypted under (the latest committed). */
export function setSendEpoch(epoch: number): void {
  getWorker().postMessage({ type: 'sendEpoch', epoch });
}

/** Forget an epoch's key (after it's well superseded). */
export function dropFrameKey(epoch: number): void {
  getWorker().postMessage({ type: 'dropEpoch', epoch });
}

type Transformable = { transform?: unknown };

/** Encrypt this sender's outgoing audio frames. */
export function encryptSender(sender: RTCRtpSender): void {
  const Ctor = scriptTransform();
  if (Ctor) (sender as Transformable).transform = new Ctor(getWorker(), { operation: 'encrypt' });
}

/** Decrypt this receiver's incoming audio frames. */
export function decryptReceiver(receiver: RTCRtpReceiver): void {
  const Ctor = scriptTransform();
  if (Ctor) (receiver as Transformable).transform = new Ctor(getWorker(), { operation: 'decrypt' });
}

/** Tear down the worker (on leaving all calls). */
export function resetVoiceWorker(): void {
  worker?.terminate();
  worker = null;
}
