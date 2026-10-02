import { neutralVoicing, CHORD_INTERVALS, chordSymbol } from './chordControls';
import { retuneSession, SCALE_IDS, SCALE_INTERVALS, inferChord } from './scale';
import type { Session } from './performanceTypes';
import type { Chord, Quality } from './types';
import { pitchClass } from './types';

const QUALITY_CHOICES: Quality[] = ['maj', 'min', 'sus2', 'sus4', 'dim', 'maj7', 'min7', '7', 'add9', 'minAdd9'];
function random(seed: number, salt: number): number {
  let value = (seed + Math.imul(salt, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d); value ^= value >>> 15; value = Math.imul(value, 0x846ca68b); value ^= value >>> 16;
  return value >>> 0;
}
function chordForDegree(key: number, scale: Session['scale'], degree: number, seed: number, forced?: Quality): Chord {
  const intervals = SCALE_INTERVALS[scale];
  const root = pitchClass(key + intervals[degree]);
  const inScale = new Set(intervals.map(interval => pitchClass(key + interval)));
  const options = QUALITY_CHOICES.filter(quality => CHORD_INTERVALS[quality].every(interval => inScale.has(pitchClass(root + interval))));
  const quality = forced ?? (options.length ? options[random(seed, 50 + degree) % Math.min(3, options.length)] : 'custom');
  const chordIntervals = quality === 'custom' ? [0, 2, 4].map(offset => {
    const position = degree + offset;
    return intervals[position % intervals.length] + 12 * Math.floor(position / intervals.length) - intervals[degree];
  }) : CHORD_INTERVALS[quality];
  const rootNote = 48 + root;
  const notes = chordIntervals.map(interval => rootNote + interval).sort((a, b) => a - b);
  const named = quality === 'custom' ? inferChord(root, notes) : quality;
  return { root, quality: named, symbol: chordSymbol(root, named), notes, voicing: neutralVoicing(notes) };
}
function distinctBank(session: Session, count: number, seed: number): Chord[] {
  const degreeCount = SCALE_INTERVALS[session.scale].length;
  const order = degreeCount === 5 ? [0, 3, 4, 1, 2] : [0, 4, 3, 5, 1, 6, 2];
  const chosen = order.slice(0, Math.min(count, degreeCount)).map(degree => chordForDegree(session.key, session.scale, degree, seed));
  const used = new Set(chosen.map(chord => chord.symbol));
  const inScale = new Set(SCALE_INTERVALS[session.scale].map(interval => pitchClass(session.key + interval)));
  const candidates = order.flatMap(degree => QUALITY_CHOICES.filter(quality => {
    const root = pitchClass(session.key + SCALE_INTERVALS[session.scale][degree]);
    return CHORD_INTERVALS[quality].every(interval => inScale.has(pitchClass(root + interval)));
  }).map(quality => chordForDegree(session.key, session.scale, degree, seed, quality)));
  for (const chord of candidates) {
    if (chosen.length >= 6) break;
    if (used.has(chord.symbol)) continue;
    chosen.push(chord);
    used.add(chord.symbol);
    if (chosen.length === 6) break;
  }
  return chosen;
}
export function newChords(session: Session, seed: number): Session {
  let next = session;
  if (!session.keyLocked) next = { ...retuneSession(session, random(seed, 1) % 12, SCALE_IDS[random(seed, 2) % SCALE_IDS.length]), keyLocked: false };
  return { ...next, bank: distinctBank(next, 6, seed) };
}
