import type { Chord, Voice, TimedNote } from './types';

export interface TapeNote extends TimedNote { id: number; pad?: number }
export type Bars = number;
export type ScaleId = 'major' | 'minor' | 'dorian' | 'mixolydian' | 'pentatonic';
export type Quantize = 'off' | 'beat' | 'half' | 'quarter';
export interface Meter { numerator: number; denominator: 4 | 8 }
export interface Timing { tempo: number; bars: Bars; meter: Meter }
export interface LoopBlock { id: number; pad: number; tick: number; durationTicks: number }
export interface LoopState extends Timing { grid: Exclude<Quantize, 'off'>; divider: 1 | 2 | 4; blocks: LoopBlock[] }
export interface SoundSettings {
  attack: number; decay: number; color: number; texture: number;
  reverbAmount: number; reverbTime: number; masterVolume: number;
}
export interface ArpSettings {
  mode: 'off' | 'arp'; division: 2 | 4 | 8 | 16 | 32; triplet: boolean;
  steps: Array<number | null>; register: -1 | 0 | 1; gate: number;
  reverse: boolean; mirror: boolean;
}
export interface Session {
  version: 1;
  voice: Voice; key: number; scale: ScaleId; keyLocked: boolean;
  bank: Chord[]; padCount: number; loop: LoopState;
  quantize: Quantize; countIn: boolean; bass: boolean;
  arp: ArpSettings; sound: SoundSettings;
}
export const DEFAULT_METER: Meter = { numerator: 4, denominator: 4 };
export function ticksPerBar(meter: Meter): number { return meter.numerator * (1920 / meter.denominator); }
export function lengthTicks(timing: Pick<Timing, 'bars' | 'meter'>): number { return timing.bars * ticksPerBar(timing.meter); }
export function gridTicks(meter: Meter, grid: Exclude<Quantize, 'off'>): number {
  const beat = 1920 / meter.denominator;
  return grid === 'beat' ? beat : grid === 'half' ? beat / 2 : beat / 4;
}
export function activeTiming(session: Session): Timing {
  return { ...session.loop, tempo: session.loop.tempo / session.loop.divider };
}

// Canonical arrangements retain material outside the currently selected loop window.
export const ARRANGEMENT_CAPACITY = { bars: 16, meter: { numerator: 12, denominator: 4 } } as const;
