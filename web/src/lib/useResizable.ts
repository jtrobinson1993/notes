import { ref } from 'vue';

// A draggable width (px), clamped and persisted. The drag is delta-based off the
// pointer, so it works regardless of the element's position.
export function useResizable(storageKey: string, def: number, min: number, max: number) {
  const clamp = (w: number) => Math.min(max, Math.max(min, w));
  const saved = Number(localStorage.getItem(storageKey));
  const width = ref(Number.isFinite(saved) && saved > 0 ? clamp(saved) : def);
  const dragging = ref(false);
  let startX = 0;
  let startW = 0;

  function onMove(e: PointerEvent): void {
    width.value = clamp(startW + e.clientX - startX);
  }
  function stop(): void {
    dragging.value = false;
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stop);
    localStorage.setItem(storageKey, String(width.value));
  }
  function start(e: PointerEvent): void {
    startX = e.clientX;
    startW = width.value;
    dragging.value = true;
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
  }

  return { width, dragging, start };
}
