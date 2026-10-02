// Post-filter Texture gain trim, interpolated across Color and Texture.
import type { Voice } from '../music/types';

const TEXTURE_POINTS = [0, .25, .5, .75, 1] as const;
const COLOR_POINTS = [.25, .5, .75] as const;
type TextureCurve = readonly [number, number, number, number, number];
type ColorCurves = readonly [TextureCurve, TextureCurve, TextureCurve];

// dB trim points at the calibrated Texture and Color knots. Color interpolation is
// retained to follow the measured response, especially for Current.
const CURVES: Record<Voice, ColorCurves> = {
  Felt: [
    [0, -2.85, -4.92, -6.18, -6.86],
    [0, -2.86, -4.89, -6.21, -6.84],
    [0, -2.84, -4.91, -6.19, -6.85],
  ],
  Glass: [
    [0, -1.83, -3.28, -4.28, -4.95],
    [0, -1.84, -3.27, -4.30, -4.94],
    [0, -1.83, -3.28, -4.29, -4.95],
  ],
  Current: [
    [0, -2.25, -3.94, -5.47, -6.58],
    [0, -2.07, -4.08, -5.57, -6.56],
    [0, -2.42, -4.38, -5.77, -6.63],
  ],
  Pluck: [
    [0, -2.94, -5.19, -6.65, -7.54],
    [0, -2.96, -5.18, -6.69, -7.54],
    [0, -2.93, -5.20, -6.67, -7.55],
  ],
  Reed: [
    [0, -1.99, -3.66, -4.95, -5.91],
    [0, -2.00, -3.66, -4.96, -5.91],
    [0, -1.99, -3.66, -4.95, -5.91],
  ],
  Air: [
    [0, -2.32, -4.14, -5.38, -6.20],
    [0, -2.33, -4.13, -5.41, -6.20],
    [0, -2.31, -4.14, -5.39, -6.20],
  ],
};

function unit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : .5;
}

function between(points: readonly number[], value: number): { index: number; amount: number } {
  const bounded = Math.max(points[0], Math.min(points[points.length - 1], value));
  const index = Math.min(points.length - 2, Math.floor((bounded - points[0]) / (points[1] - points[0])));
  const start = points[index];
  const end = points[index + 1];
  return { index, amount: (bounded - start) / (end - start) };
}

/** Returns the measured dB trim at continuous Texture and Color settings. */
function textureCompensationDb(voice: Voice, textureValue: number, colorValue: number): number {
  const texture = unit(textureValue);
  const color = unit(colorValue);
  const textureBracket = between(TEXTURE_POINTS, texture);
  const colorBracket = between(COLOR_POINTS, color);
  const curve = CURVES[voice];
  const atColor = (index: number): number => {
    const row = curve[index];
    return row[textureBracket.index] + (row[textureBracket.index + 1] - row[textureBracket.index]) * textureBracket.amount;
  };
  const low = atColor(colorBracket.index);
  const high = atColor(colorBracket.index + 1);
  return low + (high - low) * colorBracket.amount;
}

/** Linear-amplitude gain corresponding to the measured dB trim. */
export function textureCompensationGain(voice: Voice, texture: number, color: number): number {
  return 10 ** (textureCompensationDb(voice, texture, color) / 20);
}
