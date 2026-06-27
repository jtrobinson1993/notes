import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AudioPlayer from '../../src/components/AudioPlayer.vue';

describe('AudioPlayer', () => {
  const factory = () =>
    mount(AudioPlayer, { props: { src: 'blob:test', name: 'my-track.mp3', size: 3_200_000 } });

  it('renders custom controls instead of native ones', () => {
    const w = factory();
    // The <audio> element is present but hidden (driven by JS), not `controls`.
    const audio = w.find('audio');
    expect(audio.exists()).toBe(true);
    expect(audio.attributes('controls')).toBeUndefined();
    expect(audio.classes()).toContain('hidden');
    // A custom play button + a seek slider make up the controls.
    expect(w.find('button[aria-label="Play"]').exists()).toBe(true);
    expect(w.find('[role="slider"]').exists()).toBe(true);
  });

  it('shows the filename, size, and a time readout', () => {
    const w = factory();
    expect(w.text()).toContain('my-track.mp3');
    expect(w.text()).toContain('3.1 MB');
    expect(w.text()).toContain('0:00 / 0:00');
  });

  it('swaps the play/pause affordance from the audio element events', async () => {
    const w = factory();
    expect(w.find('button[aria-label="Play"]').exists()).toBe(true);
    await w.find('audio').trigger('play');
    expect(w.find('button[aria-label="Pause"]').exists()).toBe(true);
    await w.find('audio').trigger('pause');
    expect(w.find('button[aria-label="Play"]').exists()).toBe(true);
  });
});
