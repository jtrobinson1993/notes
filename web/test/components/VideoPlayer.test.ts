import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import VideoPlayer from '../../src/components/VideoPlayer.vue';

describe('VideoPlayer', () => {
  const factory = () => mount(VideoPlayer, { props: { src: 'blob:v', name: 'clip.mp4' } });

  it('renders custom controls (no native chrome) with a seek bar and fullscreen', () => {
    const w = factory();
    const video = w.find('video');
    expect(video.exists()).toBe(true);
    expect(video.attributes('controls')).toBeUndefined();
    expect(w.find('[role="slider"]').exists()).toBe(true);
    expect(w.find('button[aria-label="Fullscreen"]').exists()).toBe(true);
  });

  it('shows a centered play button while paused and removes it while playing', async () => {
    const w = factory();
    // Paused → a Play affordance is shown (so it doesn't look like a static image).
    expect(w.find('button[aria-label="Play"]').exists()).toBe(true);
    await w.find('video').trigger('play');
    // Playing → no Play overlay; the bar shows Pause instead.
    expect(w.find('button[aria-label="Play"]').exists()).toBe(false);
    expect(w.find('button[aria-label="Pause"]').exists()).toBe(true);
    await w.find('video').trigger('pause');
    expect(w.find('button[aria-label="Play"]').exists()).toBe(true);
  });
});
