import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const native = vi.hoisted(() => ({
  isNative: true,
  vaultStatus: vi.fn(),
  vaultCreate: vi.fn(),
  vaultUnlock: vi.fn(),
  vaultUnlockKeychain: vi.fn(),
  vaultUnlockRecovery: vi.fn(),
  vaultRestoreFromEscrow: vi.fn(),
  vaultLock: vi.fn(),
  // markUnlocked() kicks the re-lock policy read; default = stay unlocked.
  settingsGet: vi.fn().mockResolvedValue(null),
  settingsSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/native', () => native);

const invites = vi.hoisted(() => ({
  registerViaInvite: vi.fn(),
  registerOnRelay: vi.fn(),
}));
vi.mock('../../src/lib/nativeInvites', () => invites);

// parseInvite decides friend-invite vs bare relay code in the gate: anything
// starting with `accord-invite:` parses as a friend invite; else it throws.
vi.mock('../../src/lib/invites', () => ({
  parseInvite: (s: string) => {
    if (s.startsWith('accord-invite:')) {
      return { relayUrl: 'http://r', relayFp: 'f', token: 't', handle: 'H#0001', identityPub: 'i', sealingPub: 's' };
    }
    throw new Error('not an Accord invite');
  },
}));

import NativeGate from '../../src/components/NativeGate.vue';

const mountGate = () =>
  mount(NativeGate, { slots: { default: '<div data-testid="app">app</div>' } });

/** Make the gate treat the account as already onboarded (relay URL + handle
 *  present) so an unlock/restore lands on 'ready' instead of the signup step. */
function onboarded(): void {
  native.settingsGet.mockImplementation(async (key: string) =>
    key === 'identity.handle' ? 'Me#0001' : key === 'relay.url' ? 'https://relay.example' : null,
  );
}

/** First run opens on a splash; click through to the signup / login sub-view. */
async function gotoSignup(w: ReturnType<typeof mountGate>): Promise<void> {
  await w.find('[data-testid="signup"]').trigger('click');
  await flushPromises();
}
async function gotoLogin(w: ReturnType<typeof mountGate>): Promise<void> {
  await w.find('[data-testid="login"]').trigger('click');
  await flushPromises();
}

/** From the recovery-code screen (right after createVault): save the code, then
 *  fill the required display name — landing the wizard on the onboarding step. */
async function passRecoveryAndDisplayName(
  w: ReturnType<typeof mountGate>,
  name = 'My Name',
): Promise<void> {
  await w.find('button').trigger('click'); // "I saved my recovery code"
  await flushPromises();
  await w.find('input[type="text"]').setValue(name); // display name (required)
  await w.find('form').trigger('submit');
  await flushPromises();
}

beforeEach(() => {
  vi.resetAllMocks();
  native.isNative = true;
  // Default: no relay account yet, so a fresh unlock routes to onboarding.
  native.settingsGet.mockResolvedValue(null);
});

describe('NativeGate', () => {
  it('slots straight through in the browser', async () => {
    native.isNative = false;
    const w = mountGate();
    await flushPromises();
    expect(w.find('[data-testid="app"]').exists()).toBe(true);
    expect(native.vaultStatus).not.toHaveBeenCalled();
  });

  it('unlocks silently via the keychain when locked', async () => {
    onboarded();
    native.vaultStatus.mockResolvedValue('locked');
    native.vaultUnlockKeychain.mockResolvedValue(undefined);
    const w = mountGate();
    await flushPromises();
    expect(w.find('[data-testid="app"]').exists()).toBe(true);
  });

  it('falls back to the unlock form when the keychain fails', async () => {
    onboarded();
    native.vaultStatus.mockResolvedValue('locked');
    native.vaultUnlockKeychain.mockRejectedValue(new Error('nope'));
    const w = mountGate();
    await flushPromises();
    expect(w.find('[data-testid="app"]').exists()).toBe(false);
    expect(w.text()).toContain('Unlock');

    native.vaultUnlock.mockResolvedValue(undefined);
    await w.find('input[type="password"]').setValue('some password here!!');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(w.find('[data-testid="app"]').exists()).toBe(true);
  });

  it('opens on a welcome splash and offers Sign up / Log in', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    const w = mountGate();
    await flushPromises();
    expect(w.text()).toContain('Welcome to Accord');
    expect(w.find('[data-testid="signup"]').exists()).toBe(true);
    expect(w.find('[data-testid="login"]').exists()).toBe(true);
    expect(w.find('[data-testid="app"]').exists()).toBe(false);
  });

  it('recover explainer says recovery needs your code (no email reset) and backs out', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    const w = mountGate();
    await flushPromises();
    await w.find('[data-testid="recover"]').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('recovery code');
    expect(w.text().toLowerCase()).toContain('email');
    // Back returns to the splash.
    await w.find('button').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Welcome to Accord');
  });

  it('walks signup → recovery display → onboarding on first run (no account yet)', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    native.vaultCreate.mockResolvedValue('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
    const w = mountGate();
    await flushPromises();
    await gotoSignup(w);
    expect(w.text()).toContain('Create your account');

    const [pw, confirm] = w.findAll('input[type="password"]');
    await pw.setValue('a sixteen char password');
    await confirm.setValue('a sixteen char password');
    await w.find('form').trigger('submit');
    await flushPromises();

    expect(w.find('[data-testid="recovery-code"]').text()).toContain('AAAA-BBBB');
    await w.find('button').trigger('click'); // "I saved my recovery code"
    await flushPromises();
    // Signup now requires a display name before onboarding.
    expect(w.text()).toContain('Choose a display name');
    await w.find('input[type="text"]').setValue('My Name');
    await w.find('form').trigger('submit');
    await flushPromises();
    // A brand-new vault has no relay account, so the gate asks the user to
    // create one rather than opening straight into the app.
    expect(w.find('[data-testid="app"]').exists()).toBe(false);
    expect(w.text()).toContain('Join with an invite');
  });

  it('signup requires a display name and passes the picked handle + name to register', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    native.vaultCreate.mockResolvedValue('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
    invites.registerOnRelay.mockResolvedValue({ handle: 'Otter#0421' });
    const w = mountGate();
    await flushPromises();
    await gotoSignup(w);
    // A handle is pre-selected from generated options; pick a specific one.
    const opts = w.findAll('[data-testid="handle-option"]');
    expect(opts.length).toBe(4);
    const pickedHandle = opts[1]!.text();
    await opts[1]!.trigger('click');
    const [pw, confirm] = w.findAll('input[type="password"]');
    await pw.setValue('a sixteen char password');
    await confirm.setValue('a sixteen char password');
    await w.find('form').trigger('submit');
    await flushPromises();
    // Recovery → display name. Empty name is rejected.
    await w.find('button').trigger('click'); // saved recovery code
    await flushPromises();
    await w.find('form').trigger('submit'); // submit with empty display name
    await flushPromises();
    expect(w.text().toLowerCase()).toContain('display name');
    expect(invites.registerOnRelay).not.toHaveBeenCalled();
    // Fill it, continue → onboarding → relay path.
    await w.find('input[type="text"]').setValue('Jarrod');
    await w.find('form').trigger('submit');
    await flushPromises();
    await w.find('button.underline').trigger('click'); // switch to relay path
    await w.find('input[type="url"]').setValue('http://localhost:8787');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(invites.registerOnRelay).toHaveBeenCalledWith('http://localhost:8787', '', {
      handle: pickedHandle,
      displayName: 'Jarrod',
    });
  });

  it('onboards a new account by redeeming an invite, then opens the gate', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    native.vaultCreate.mockResolvedValue('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
    invites.registerViaInvite.mockResolvedValue({ handle: 'Me#0001', inviterHandle: 'Al#0002' });
    const w = mountGate();
    await flushPromises();
    await gotoSignup(w);
    // Create the vault to reach the onboarding step.
    const [pw, confirm] = w.findAll('input[type="password"]');
    await pw.setValue('a sixteen char password');
    await confirm.setValue('a sixteen char password');
    await w.find('form').trigger('submit');
    await flushPromises();
    await passRecoveryAndDisplayName(w);

    await w.find('textarea').setValue('accord-invite:pasted');
    await w.find('form').trigger('submit');
    await flushPromises();

    expect(invites.registerViaInvite).toHaveBeenCalledWith('accord-invite:pasted', {
      handle: expect.any(String),
      displayName: 'My Name',
    });
    expect(w.find('[data-testid="app"]').exists()).toBe(true);
  });

  it('auto-switches a pasted registration code to the relay path (pre-filled)', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    native.vaultCreate.mockResolvedValue('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
    const w = mountGate();
    await flushPromises();
    await gotoSignup(w);
    const [pw, confirm] = w.findAll('input[type="password"]');
    await pw.setValue('a sixteen char password');
    await confirm.setValue('a sixteen char password');
    await w.find('form').trigger('submit');
    await flushPromises();
    await passRecoveryAndDisplayName(w);

    // Paste a bare operator code (not a friend-invite blob) into the invite box.
    await w.find('textarea').setValue('bare-operator-code-xyz');
    await w.find('form').trigger('submit');
    await flushPromises();

    // It shouldn't try to redeem it as a friend invite — it switches to the
    // relay path with the code pre-filled.
    expect(invites.registerViaInvite).not.toHaveBeenCalled();
    expect(w.text()).toContain('Join a relay');
    expect((w.find('input[type="text"]').element as HTMLInputElement).value).toBe('bare-operator-code-xyz');
  });

  it('onboards via relay address + operator registration code', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    native.vaultCreate.mockResolvedValue('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
    invites.registerOnRelay.mockResolvedValue({ handle: 'Me#0001' });
    const w = mountGate();
    await flushPromises();
    await gotoSignup(w);
    const [pw, confirm] = w.findAll('input[type="password"]');
    await pw.setValue('a sixteen char password');
    await confirm.setValue('a sixteen char password');
    await w.find('form').trigger('submit');
    await flushPromises();
    await passRecoveryAndDisplayName(w);

    // Switch to the relay-address path.
    await w.find('button.underline').trigger('click');
    await w.find('input[type="url"]').setValue('http://localhost:8787');
    await w.find('input[type="text"]').setValue('operator-code-123');
    await w.find('form').trigger('submit');
    await flushPromises();

    expect(invites.registerOnRelay).toHaveBeenCalledWith('http://localhost:8787', 'operator-code-123', {
      handle: expect.any(String),
      displayName: 'My Name',
    });
    expect(w.find('[data-testid="app"]').exists()).toBe(true);
  });

  it('restores an existing account on a fresh device via escrow', async () => {
    onboarded();
    native.vaultStatus.mockResolvedValue('uninitialized');
    native.vaultRestoreFromEscrow.mockResolvedValue(undefined);
    const w = mountGate();
    await flushPromises();

    await gotoLogin(w);
    expect(w.text()).toContain('Log in');

    await w.find('input[type="url"]').setValue('https://relay.example');
    await w.find('input[type="text"]').setValue('Word#1234');
    await w.find('input[type="password"]').setValue('a sixteen char password');
    await w.find('form').trigger('submit');
    await flushPromises();

    expect(native.vaultRestoreFromEscrow).toHaveBeenCalledWith(
      'https://relay.example',
      'Word#1234',
      'a sixteen char password',
    );
    expect(w.find('[data-testid="app"]').exists()).toBe(true);
  });

  it('requires all restore fields before calling the core', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    const w = mountGate();
    await flushPromises();
    await gotoLogin(w);

    await w.find('input[type="url"]').setValue('https://relay.example');
    // handle + password left blank
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(native.vaultRestoreFromEscrow).not.toHaveBeenCalled();
    expect(w.text()).toContain('required');
  });

  it('surfaces a restore failure without opening the gate', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    native.vaultRestoreFromEscrow.mockRejectedValue(new Error('no escrow for handle'));
    const w = mountGate();
    await flushPromises();
    await gotoLogin(w);

    await w.find('input[type="url"]').setValue('https://relay.example');
    await w.find('input[type="text"]').setValue('Word#1234');
    await w.find('input[type="password"]').setValue('a sixteen char password');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(w.find('[data-testid="app"]').exists()).toBe(false);
    expect(w.text()).toContain('no escrow for handle');
  });

  it('rejects a short password client-side', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    const w = mountGate();
    await flushPromises();
    await gotoSignup(w);
    const [pw, confirm] = w.findAll('input[type="password"]');
    await pw.setValue('short');
    await confirm.setValue('short');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(native.vaultCreate).not.toHaveBeenCalled();
    expect(w.text()).toContain('at least 16 characters');
  });
});
