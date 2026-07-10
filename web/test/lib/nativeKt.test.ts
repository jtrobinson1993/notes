import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { KtAuditReport } from '../../src/lib/native';

const native = vi.hoisted(() => ({
  isNative: true,
  ktSelfAudit: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

const evt = vi.hoisted(() => ({
  handler: null as null | ((e: { payload: KtAuditReport }) => void),
  unlisten: vi.fn(),
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: (e: { payload: KtAuditReport }) => void) => {
    evt.handler = cb;
    return evt.listen(name, cb);
  },
}));

import { onKtAlarm, startKtAudit, stopKtAudit, type KtAlarm } from '../../src/lib/nativeKt';

beforeEach(async () => {
  await stopKtAudit();
  vi.clearAllMocks();
  native.isNative = true;
  native.ktSelfAudit.mockResolvedValue({ ok: true, reason: null, epoch: 1 });
  evt.handler = null;
  evt.listen.mockResolvedValue(evt.unlisten);
});

describe('nativeKt', () => {
  it('subscribes to kt:alarm and runs one self-audit on start', async () => {
    await startKtAudit();
    expect(evt.listen).toHaveBeenCalledWith('kt:alarm', expect.any(Function));
    expect(native.ktSelfAudit).toHaveBeenCalledTimes(1);
  });

  it('raises an alarm when the initial self-audit fails', async () => {
    native.ktSelfAudit.mockResolvedValue({ ok: false, reason: 'self-audit-failed', epoch: 3 });
    const seen: KtAlarm[] = [];
    onKtAlarm((a) => seen.push(a));
    await startKtAudit();
    expect(seen).toEqual([{ reason: 'self-audit-failed' }]);
  });

  it('raises an alarm from a live kt:alarm event, fanned to all subscribers', async () => {
    await startKtAudit();
    const a: KtAlarm[] = [];
    const b: KtAlarm[] = [];
    onKtAlarm((x) => a.push(x));
    onKtAlarm((x) => b.push(x));
    evt.handler?.({ payload: { ok: false, reason: 'split-view', epoch: 5 } });
    expect(a).toEqual([{ reason: 'split-view' }]);
    expect(b).toEqual([{ reason: 'split-view' }]);
  });

  it('replays the latest alarm to a late subscriber', async () => {
    native.ktSelfAudit.mockResolvedValue({ ok: false, reason: 'split-view', epoch: 2 });
    await startKtAudit();
    const late: KtAlarm[] = [];
    onKtAlarm((x) => late.push(x)); // subscribes after the alarm already fired
    expect(late).toEqual([{ reason: 'split-view' }]);
  });

  it('does nothing outside the native shell', async () => {
    native.isNative = false;
    await startKtAudit();
    expect(evt.listen).not.toHaveBeenCalled();
    expect(native.ktSelfAudit).not.toHaveBeenCalled();
  });

  it('tears down the listener on stop', async () => {
    await startKtAudit();
    await stopKtAudit();
    expect(evt.unlisten).toHaveBeenCalled();
  });
});
