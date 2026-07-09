import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import NativeCallPanel from '../../src/components/NativeCallPanel.vue';
import type { CallState } from '../../src/lib/voiceCall';

const mountPanel = (state: CallState, peerName: string | null = 'Alice') =>
  mount(NativeCallPanel, { props: { state, peerName } });

describe('NativeCallPanel', () => {
  it('is hidden when idle or ended', () => {
    expect(mountPanel('idle').find('[data-testid="call-panel"]').exists()).toBe(false);
    expect(mountPanel('ended').find('[data-testid="call-panel"]').exists()).toBe(false);
  });

  it('shows accept + decline on an incoming ring and emits them', async () => {
    const w = mountPanel('ringing', 'Bob');
    expect(w.find('[data-testid="call-status"]').text()).toBe('Incoming call');
    expect(w.text()).toContain('Bob');
    await w.find('[data-testid="call-accept"]').trigger('click');
    await w.find('[data-testid="call-decline"]').trigger('click');
    expect(w.emitted('accept')).toHaveLength(1);
    expect(w.emitted('decline')).toHaveLength(1);
    expect(w.find('[data-testid="call-hangup"]').exists()).toBe(false);
  });

  it('shows a single cancel/hangup for outgoing + active states', async () => {
    const dialing = mountPanel('dialing');
    expect(dialing.find('[data-testid="call-status"]').text()).toBe('Calling…');
    expect(dialing.find('[data-testid="call-hangup"]').text()).toContain('Cancel');
    expect(dialing.find('[data-testid="call-accept"]').exists()).toBe(false);

    const connecting = mountPanel('connecting');
    expect(connecting.find('[data-testid="call-status"]').text()).toBe('Connecting…');

    const connected = mountPanel('connected');
    expect(connected.find('[data-testid="call-status"]').text()).toBe('In call');
    expect(connected.find('[data-testid="call-hangup"]').text()).toContain('Hang up');
    await connected.find('[data-testid="call-hangup"]').trigger('click');
    expect(connected.emitted('hangup')).toHaveLength(1);
  });

  it('falls back to Unknown when the peer name is absent', () => {
    expect(mountPanel('ringing', null).text()).toContain('Unknown');
  });
});
