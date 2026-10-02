import { NOTE_NAMES, pitchClass } from './types';
import type { Chord, Quality, VoicingState } from './types';

export const CHORD_INTERVALS: Record<Quality, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], '7': [0, 4, 7, 10],
  sus2: [0, 2, 7], sus4: [0, 5, 7], dim: [0, 3, 6], maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14], '9': [0, 4, 7, 10, 14], add9: [0, 4, 7, 14],
  minAdd9: [0, 3, 7, 14], custom: [],
};
const suffix: Record<Quality, string> = {
  maj: '', min: 'm', maj7: 'maj7', min7: 'm7', '7': '7', sus2: 'sus2', sus4: 'sus4', dim: 'dim',
  maj9: 'maj9', min9: 'm9', '9': '9', add9: 'add9', minAdd9: 'm(add9)', custom: ' shape',
};
export function chordSymbol(root: number, quality: Quality) { return NOTE_NAMES[pitchClass(root)] + suffix[quality]; }
export type ChordAction = 'major' | 'minor' | 'sus' | 'dim' | 'seventh' | 'majorSeventh' | 'ninth' |
  'invertUp' | 'invertDown' | 'rootUp' | 'rootDown';
export function isMinor(chord: Chord) { return chord.quality.startsWith('min'); }
export function hasSeventh(chord: Chord) { return chord.notes.some(n => [10, 11].includes(pitchClass(n - chord.root))); }
export function hasNinth(chord: Chord) { return chord.notes.some(n => pitchClass(n - chord.root) === 2); }

export function neutralVoicing(notes: readonly number[]): VoicingState {
  return { base: [...notes], inversion: 0 };
}
export function renderVoicing(state: VoicingState): number[] | null {
  const notes = [...state.base].sort((a, b) => a - b);
  if (state.inversion > 0) for (let step = 0; step < state.inversion; step++) {
    notes[0] += 12;
    notes.sort((a, b) => a - b);
  }
  if (state.inversion < 0) for (let step = 0; step < -state.inversion; step++) {
    notes[notes.length - 1] -= 12;
    notes.sort((a, b) => a - b);
  }
  if (notes.some((note, index) => note < 0 || note > 127 || index > 0 && note <= notes[index - 1])) return null;
  return notes;
}
function voiced(chord: Chord, state: VoicingState): Chord | null {
  const notes = renderVoicing(state);
  return notes ? { ...chord, notes, voicing: state } : null;
}
function reshape(chord: Chord, quality: Quality): Chord {
  const source = chord.voicing.base;
  const mean = source.reduce((sum, note) => sum + note, 0) / source.length;
  const base = CHORD_INTERVALS[quality].map(interval => {
    const pc = pitchClass(chord.root + interval);
    const old = source.find(note => pitchClass(note) === pc);
    if (old !== undefined) return old;
    return Math.max(pc, Math.min(pc + 12 * Math.floor((127 - pc) / 12), pc + 12 * Math.round((mean - pc) / 12)));
  }).sort((a, b) => a - b);
  const next = { ...chord, quality, symbol: chordSymbol(chord.root, quality) };
  const state = { base, inversion: chord.voicing.inversion };
  return voiced(next, state) ?? { ...next, notes: base, voicing: neutralVoicing(base) };
}
function transposeChord(chord: Chord, delta: number): Chord {
  const notes = chord.notes.map(note => note + delta);
  const base = (chord.voicing.base).map(note => note + delta);
  if ([...notes, ...base].some(note => note < 0 || note > 127)) return chord;
  const root = pitchClass(chord.root + delta);
  return { ...chord, root, notes, symbol: chordSymbol(root, chord.quality),
    voicing: { base, inversion: chord.voicing.inversion } };
}
export function alterChord(chord: Chord, action: ChordAction): Chord {
  const minor = isMinor(chord), seven = hasSeventh(chord), nine = hasNinth(chord);
  const majorSeven = CHORD_INTERVALS[chord.quality].includes(11);
  let quality = chord.quality;
  if (action === 'major') quality = nine ? (seven ? (majorSeven ? 'maj9' : '9') : 'add9') : (seven ? (majorSeven ? 'maj7' : '7') : 'maj');
  else if (action === 'minor') quality = nine ? (seven ? 'min9' : 'minAdd9') : (seven ? 'min7' : 'min');
  else if (action === 'sus') quality = 'sus4';
  else if (action === 'dim') quality = 'dim';
  else if (action === 'seventh') quality = majorSeven ? (nine ? '9' : '7') : seven ? (nine ? (minor ? 'minAdd9' : 'add9') : (minor ? 'min' : 'maj')) : (nine ? (minor ? 'min9' : '9') : (minor ? 'min7' : '7'));
  else if (action === 'majorSeventh') quality = majorSeven ? (nine ? 'add9' : 'maj') : (nine ? 'maj9' : 'maj7');
  else if (action === 'ninth') quality = nine ? (seven ? (minor ? 'min7' : majorSeven ? 'maj7' : '7') : (minor ? 'min' : 'maj')) : (seven ? (minor ? 'min9' : majorSeven ? 'maj9' : '9') : (minor ? 'minAdd9' : 'add9'));
  else if (action === 'rootUp' || action === 'rootDown') return transposeChord(chord, action === 'rootUp' ? 1 : -1);
  else {
    const state = chord.voicing;
    const next = { ...state,
      inversion: state.inversion + (action === 'invertUp' ? 1 : action === 'invertDown' ? -1 : 0),
    };
    if (Math.abs(next.inversion) > 12) return chord;
    return voiced(chord, next) ?? chord;
  }
  return quality === chord.quality ? chord : reshape(chord, quality);
}
