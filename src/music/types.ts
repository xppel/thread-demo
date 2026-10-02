export type Voice = 'Felt' | 'Glass' | 'Current' | 'Pluck' | 'Reed' | 'Air';
export type Quality = 'maj' | 'min' | 'maj7' | 'min7' | '7' | 'sus2' | 'sus4' | 'dim' | 'maj9' | 'min9' | '9' | 'add9' | 'minAdd9' | 'custom';
export interface VoicingState { base: number[]; inversion: number }
export interface Chord { root: number; quality: Quality; notes: number[]; symbol: string; voicing: VoicingState }
export interface TimedNote { midi: number; tick: number; durationTicks: number; velocity: number; part: 'chords' | 'bass' }
export const PPQ = 480;
export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export function pitchClass(note: number) { return ((note % 12) + 12) % 12; }
export function noteName(note: number) { return NOTE_NAMES[pitchClass(note)] + (Math.floor(note / 12) - 1); }
