import { describe, expect, it, vi } from 'vitest';
import { viewTransitionsEnabled, withViewTransition } from '../../src/lib/viewTransition';

const win = (reduced: boolean) =>
  ({ matchMedia: () => ({ matches: reduced }) }) as unknown as Window;

const supportingDoc = () => {
  const startViewTransition = vi.fn((cb: () => unknown) => {
    cb();
    return { finished: Promise.resolve() };
  });
  return { doc: { startViewTransition } as unknown as Document, startViewTransition };
};

describe('viewTransitionsEnabled', () => {
  it('is true only when supported and motion is allowed', () => {
    const { doc } = supportingDoc();
    expect(viewTransitionsEnabled({ doc, win: win(false) })).toBe(true);
  });

  it('is false when the user prefers reduced motion', () => {
    const { doc } = supportingDoc();
    expect(viewTransitionsEnabled({ doc, win: win(true) })).toBe(false);
  });

  it('is false when the API is unsupported', () => {
    expect(viewTransitionsEnabled({ doc: {} as Document, win: win(false) })).toBe(false);
  });
});

describe('withViewTransition', () => {
  it('runs the mutation inside startViewTransition when enabled', async () => {
    const { doc, startViewTransition } = supportingDoc();
    const mutate = vi.fn();
    await withViewTransition(mutate, { doc, win: win(false) });
    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledOnce();
  });

  it('runs the mutation directly when disabled (no API)', async () => {
    const mutate = vi.fn();
    await withViewTransition(mutate, { doc: {} as Document, win: win(false) });
    expect(mutate).toHaveBeenCalledOnce();
  });

  it('still resolves if the transition is skipped (finished rejects)', async () => {
    const startViewTransition = vi.fn((cb: () => unknown) => {
      cb();
      return { finished: Promise.reject(new Error('skipped')) };
    });
    const mutate = vi.fn();
    await expect(
      withViewTransition(mutate, {
        doc: { startViewTransition } as unknown as Document,
        win: win(false),
      }),
    ).resolves.toBeUndefined();
    expect(mutate).toHaveBeenCalledOnce();
  });
});
