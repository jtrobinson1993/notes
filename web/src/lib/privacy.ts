import { ref, type Ref } from 'vue';

// Media privacy preferences: remote images and video embeds are click-to-load
// by default so no request reaches a third party until the reader opts in
// (loading remote content reveals your IP to whoever hosts it). Device-level
// settings, like theme.

function persisted(key: string, def: boolean): Ref<boolean> {
  const raw = localStorage.getItem(key);
  return ref(raw === null ? def : raw === 'true');
}

export const clickToLoadImages = persisted('notes:click-load-images', true);
export const clickToLoadEmbeds = persisted('notes:click-load-embeds', true);

export function setClickToLoadImages(v: boolean): void {
  clickToLoadImages.value = v;
  localStorage.setItem('notes:click-load-images', String(v));
}

export function setClickToLoadEmbeds(v: boolean): void {
  clickToLoadEmbeds.value = v;
  localStorage.setItem('notes:click-load-embeds', String(v));
}
