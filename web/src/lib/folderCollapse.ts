import { reactive } from 'vue';

// Collapsed-folder state, shared by the notes tree and the chat-sidebar tree.
// Folder ids are unique uuids across both, so one set is fine. Persisted so the
// expand/collapse layout survives reloads.
const KEY = 'folders:collapsed';

function load(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

const collapsed = reactive(new Set<string>(load()));

function persist(): void {
  localStorage.setItem(KEY, JSON.stringify([...collapsed]));
}

export function isCollapsed(id: string): boolean {
  return collapsed.has(id);
}

export function toggleCollapsed(id: string): void {
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  persist();
}
