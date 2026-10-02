import { describe, expect, it } from 'vitest';
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, savedAppearance, displayedColors, editDisplayedColor } from './settings';

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
describe('independent demo accents', () => {
  it('edits and persists each mode independently while preserving inverted background and text', () => {
    let appearance = editDisplayedColor(DEFAULT_APPEARANCE, false, 'accent', '#112233');
    appearance = editDisplayedColor(appearance, true, 'accent', '#aabbcc');
    appearance = editDisplayedColor(appearance, true, 'background', '#080808');
    const saved = storage({ [APPEARANCE_KEY]: JSON.stringify(appearance) });
    const restored = savedAppearance(saved);
    expect(displayedColors(restored, false)).toEqual({ background: '#f7f7f7', text: '#17191e', accent: '#112233' });
    expect(displayedColors(restored, true)).toEqual({ background: '#080808', text: '#e8e6e1', accent: '#aabbcc' });
    expect(restored.invert).toBeNull();
  });
  it('prefers valid v2 values and safely falls back from invalid or inaccessible storage', () => {
    const current = { ...DEFAULT_APPEARANCE, accentDark: '#445566' };
    expect(savedAppearance(storage({ [APPEARANCE_KEY]: JSON.stringify(current) }))).toEqual(current);
    expect(savedAppearance(storage({ [APPEARANCE_KEY]: '{broken' }))).toEqual(DEFAULT_APPEARANCE);
    expect(savedAppearance({ getItem: () => { throw new Error('unavailable'); } })).toEqual(DEFAULT_APPEARANCE);
  });
});
