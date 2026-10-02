import { invertHex } from './theme';

export type ColorKey = 'background' | 'text' | 'accent';
export interface Appearance {
  version: 2;
  background: string;
  text: string;
  accentLight: string;
  accentDark: string;
  invert: boolean | null;
}
export const APPEARANCE_KEY = 'thread.demo.appearance.v2';
export const DEFAULT_APPEARANCE: Appearance = {
  version: 2, background: '#f2f2f2', text: '#17191e',
  accentLight: '#245bef', accentDark: '#dba410', invert: null,
};
const validColors = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string' && /^#[0-9a-f]{6}$/i.test(value[key] as string));
const validMode = (value: unknown) => value === null || typeof value === 'boolean';

export function savedAppearance(storage: Pick<Storage, 'getItem'>): Appearance {
  try {
    const value = JSON.parse(storage.getItem(APPEARANCE_KEY) || 'null');
    if (value?.version === 2 && validColors(value, ['background', 'text', 'accentLight', 'accentDark']) && validMode(value.invert))
      return { version: 2, background: value.background, text: value.text, accentLight: value.accentLight, accentDark: value.accentDark, invert: value.invert };
  } catch { /* Appearance storage is optional. */ }
  return { ...DEFAULT_APPEARANCE };
}

export function displayedColors(appearance: Appearance, dark: boolean) {
  return {
    background: dark ? invertHex(appearance.background) : appearance.background,
    text: dark ? invertHex(appearance.text) : appearance.text,
    accent: dark ? appearance.accentDark : appearance.accentLight,
  };
}

export function editDisplayedColor(appearance: Appearance, dark: boolean, key: ColorKey, value: string): Appearance {
  if (key === 'accent') return { ...appearance, [dark ? 'accentDark' : 'accentLight']: value };
  return { ...appearance, [key]: dark ? invertHex(value) : value };
}
