import { pitchClass } from '../music/types';
import type { Chord, Quality, Voice } from '../music/types';
import { CHORD_INTERVALS, chordSymbol, renderVoicing } from '../music/chordControls';
import { ARRANGEMENT_CAPACITY, DEFAULT_METER, ticksPerBar } from '../music/performanceTypes';
import type { ArpSettings, LoopBlock, LoopState, Meter, Quantize, ScaleId, Session, SoundSettings } from '../music/performanceTypes';
import { SCALE_IDS } from '../music/scale';
import { validBlocks } from '../music/loop';

export const SESSION_KEY = 'thread.demo.session.v1';
const VOICES: Voice[] = ['Felt', 'Glass', 'Current', 'Pluck', 'Reed', 'Air'];
export const DEFAULT_ARP: ArpSettings = { mode: 'off', division: 16, triplet: false, steps: [0, 4, 7, 4, 0, null, 7, null], register: 0, gate: .5, reverse: false, mirror: false };
export const DEFAULT_SOUND: SoundSettings = { attack: 0, decay: 1, color: .5, texture: .5, reverbAmount: .5, reverbTime: .5, masterVolume: .75 };
const integer = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function meter(value: unknown): Meter | null {
  if (!record(value) || !integer(value.numerator, 2, 12) || (value.denominator !== 4 && value.denominator !== 8)) return null;
  return { numerator: value.numerator, denominator: value.denominator };
}
function timing(tempo: unknown, bars: unknown, meterValue: unknown): { tempo: number; bars: number; meter: Meter } | null {
  const parsedMeter = meter(meterValue);
  return integer(tempo, 40, 200) && integer(bars, 1, 16) && parsedMeter ? { tempo, bars, meter: parsedMeter } : null;
}
function chord(value: unknown): Chord | null {
  if (!record(value) || !integer(value.root, 0, 11) || typeof value.quality !== 'string' || !Object.hasOwn(CHORD_INTERVALS, value.quality) ||
    !Array.isArray(value.notes) || value.notes.length < 2 || value.notes.length > 6 ||
    !value.notes.every((note): note is number => integer(note, 0, 127)) ||
    !value.notes.every((note, index) => index === 0 || note > (value.notes as number[])[index - 1])) return null;
  const quality = value.quality as Quality;
  if (value.symbol !== chordSymbol(value.root, quality)) return null;
  const notes = value.notes as number[];
  const root = value.root as number;
  if (quality !== 'custom') {
    const expected = CHORD_INTERVALS[quality].map(pitchClass).sort((a, b) => a - b);
    const actual = notes.map((note: number) => pitchClass(note - root)).sort((a: number, b: number) => a - b);
    if (actual.length !== expected.length || actual.some((pc: number, index: number) => pc !== expected[index])) return null;
  }
  const rawVoicing = value.voicing;
  if (!record(rawVoicing) || !Array.isArray(rawVoicing.base) || rawVoicing.base.length !== notes.length ||
    !rawVoicing.base.every((pitch): pitch is number => integer(pitch, 0, 127)) ||
    !integer(rawVoicing.inversion, -12, 12)) return null;
  const voicing = { base: [...rawVoicing.base], inversion: rawVoicing.inversion };
  if (JSON.stringify(renderVoicing(voicing)) !== JSON.stringify(notes)) return null;
  return { root, quality, symbol: value.symbol as string, notes: [...notes], voicing };
}
function sound(value: unknown): SoundSettings | null {
  if (!record(value)) return null;
  const keys = ['attack', 'decay', 'color', 'texture', 'reverbAmount', 'reverbTime', 'masterVolume'] as const;
  if (!keys.every(key => unit(value[key]))) return null;
  return Object.fromEntries(keys.map(key => [key, value[key]])) as unknown as SoundSettings;
}
function arp(value: unknown): ArpSettings | null {
  if (!record(value) || !['off', 'arp'].includes(String(value.mode)) || !integer(value.division, 2, 32) || ![2, 4, 8, 16, 32].includes(value.division) || !unit(value.gate) || value.gate < .1) return null;
  if (!Array.isArray(value.steps) || value.steps.length !== 8 || !value.steps.every(step => step === null || integer(step, 0, 7))) return null;
  if (typeof value.triplet !== 'boolean' || !integer(value.register, -1, 1) || typeof value.reverse !== 'boolean' || typeof value.mirror !== 'boolean') return null;
  return { mode: value.mode as ArpSettings['mode'], division: value.division as ArpSettings['division'], triplet: value.triplet, steps: [...value.steps], register: value.register as ArpSettings['register'], gate: value.gate, reverse: value.reverse, mirror: value.mirror };
}
function loop(value: unknown, padCount: number): LoopState | null {
  if (!record(value)) return null;
  const base = timing(value.tempo, value.bars, value.meter);
  if (!base || !['beat', 'half', 'quarter'].includes(String(value.grid)) || (!integer(value.divider, 1, 4) || ![1, 2, 4].includes(value.divider)) || !Array.isArray(value.blocks) || value.blocks.length > 2048) return null;
  const blocks: LoopBlock[] = value.blocks.map(candidate => record(candidate) ? { id: candidate.id as number, pad: candidate.pad as number, tick: candidate.tick as number, durationTicks: candidate.durationTicks as number } : { id: -1, pad: -1, tick: -1, durationTicks: 0 });
  if (!validBlocks(blocks, ARRANGEMENT_CAPACITY, padCount)) return null;
  return { ...base, grid: value.grid as LoopState['grid'], divider: value.divider as LoopState['divider'], blocks };
}
const openingBank: Chord[] = [
  { root: 10, quality: 'maj', symbol: 'B♭', notes: [58, 62, 65], voicing: { base: [46, 50, 53], inversion: 3 } },
  { root: 7, quality: 'min7', symbol: 'Gm7', notes: [58, 62, 65, 67], voicing: { base: [41, 43, 46, 50], inversion: 6 } },
  { root: 5, quality: 'maj', symbol: 'F', notes: [53, 57, 60], voicing: { base: [41, 45, 48], inversion: 3 } },
  { root: 7, quality: 'min', symbol: 'Gm', notes: [55, 58, 62], voicing: { base: [43, 46, 50], inversion: 3 } },
  { root: 2, quality: 'min', symbol: 'Dm', notes: [53, 57, 62], voicing: { base: [50, 53, 57], inversion: 1 } },
  { root: 10, quality: 'custom', symbol: 'B♭ shape', notes: [53, 55, 58, 62], voicing: { base: [46, 50, 53, 55], inversion: 2 } },
];
export function createSession(): Session {
  const bar = ticksPerBar(DEFAULT_METER);
  return { version: 1, voice: 'Felt', key: 0, scale: 'dorian', keyLocked: true,
    bank: structuredClone(openingBank), padCount: 4,
    loop: { tempo: 100, bars: 4, meter: { ...DEFAULT_METER }, grid: 'beat', divider: 1,
      blocks: Array.from({ length: 4 }, (_, pad) => ({ id: pad, pad, tick: pad * bar, durationTicks: bar })) },
    quantize: 'off', countIn: true, bass: false, arp: structuredClone(DEFAULT_ARP), sound: { ...DEFAULT_SOUND } };
}
export function validateSession(value: unknown): Session | null {
  if (!record(value) || value.version !== 1) return null;
  const fields = ['version', 'voice', 'key', 'scale', 'keyLocked', 'bank', 'padCount', 'loop', 'quantize', 'countIn', 'bass', 'arp', 'sound'];
  if (Object.keys(value).some(key => !fields.includes(key)) ||
    !VOICES.includes(value.voice as Voice) || !integer(value.key, 0, 11) || !SCALE_IDS.includes(value.scale as ScaleId) ||
    typeof value.keyLocked !== 'boolean' || !Array.isArray(value.bank) || value.bank.length !== 6 || !integer(value.padCount, 1, 6) ||
    !['off', 'beat', 'half', 'quarter'].includes(String(value.quantize)) ||
    typeof value.countIn !== 'boolean' || typeof value.bass !== 'boolean') return null;
  const bank = value.bank.map(chord);
  const checkedLoop = loop(value.loop, value.padCount), checkedArp = arp(value.arp), checkedSound = sound(value.sound);
  if (bank.some(item => item === null) || !checkedLoop || !checkedArp || !checkedSound) return null;
  return { version: 1, voice: value.voice as Voice, key: value.key, scale: value.scale as ScaleId, keyLocked: value.keyLocked,
    bank: bank as Chord[], padCount: value.padCount, loop: checkedLoop,
    quantize: value.quantize as Quantize, countIn: value.countIn, bass: value.bass, arp: checkedArp, sound: checkedSound };
}
