import { pitchClass } from './types';
import type { Chord, Quality } from './types';
import type { ScaleId, Session } from './performanceTypes';
import { CHORD_INTERVALS, chordSymbol, neutralVoicing, renderVoicing } from './chordControls';

export const SCALE_INTERVALS: Record<ScaleId, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic: [0, 2, 4, 7, 9],
};
export const SCALE_IDS = Object.keys(SCALE_INTERVALS) as ScaleId[];

function nearestDegree(semitone: number, intervals: readonly number[]): number {
  let best = 0;
  let distance = Infinity;
  for (let index = 0; index < intervals.length; index++) {
    const delta = Math.abs(semitone - intervals[index]);
    if (delta < distance) { best = index; distance = delta; }
  }
  return best;
}

function retunePitch(midi: number, fromKey: number, fromScale: ScaleId, toKey: number, toScale: ScaleId): number {
  const source = SCALE_INTERVALS[fromScale];
  const target = SCALE_INTERVALS[toScale];
  const offset = midi - fromKey;
  const octave = Math.floor(offset / 12);
  const degree = nearestDegree(pitchClass(offset), source);
  const mapped = Math.round(degree * (target.length - 1) / (source.length - 1));
  let result = toKey + octave * 12 + target[mapped];
  while (result < 0) result += 12;
  while (result > 127) result -= 12;
  return result;
}

export function inferChord(root: number, notes: readonly number[]): Quality {
  const intervals = notes.map(note => pitchClass(note - root)).sort((a, b) => a - b);
  for (const [quality, values] of Object.entries(CHORD_INTERVALS) as Array<[Quality, number[]]>) {
    if (quality === 'custom') continue;
    const expected = values.map(pitchClass).sort((a, b) => a - b);
    if (expected.length === intervals.length && expected.every((value, index) => value === intervals[index])) return quality;
  }
  return 'custom';
}

function retuneChord(chord: Chord, fromKey: number, fromScale: ScaleId, toKey: number, toScale: ScaleId): Chord {
  const root = pitchClass(retunePitch(chord.root + 60, fromKey, fromScale, toKey, toScale));
  const source = chord.voicing;
  const base = source.base.map(note => retunePitch(note, fromKey, fromScale, toKey, toScale)).sort((a, b) => a - b);
  for (let index = 1; index < base.length; index++) {
    while (base[index] <= base[index - 1] && base[index] + 12 <= 127) base[index] += 12;
  }
  base.sort((a, b) => a - b);
  const voicing = { ...source, base };
  const notes = renderVoicing(voicing) ?? base;
  const stored = renderVoicing(voicing) ? voicing : neutralVoicing(notes);
  const quality = inferChord(root, notes);
  return { root, quality, notes, symbol: chordSymbol(root, quality), voicing: stored };
}

export function retuneSession(session: Session, key: number, scale: ScaleId): Session {
  if (key === session.key && scale === session.scale) return session;
  return {
    ...session, key, scale, keyLocked: true,
    bank: session.bank.map(chord => retuneChord(chord, session.key, session.scale, key, scale)),
  };
}
