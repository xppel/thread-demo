import type { ArpSettings } from './performanceTypes';

export interface ResolvedArpStep {
  /** Timeline column within the current eight-step pass. */
  column: number;
  /** Drawn column after the alternate-pass reverse operation. */
  sourceColumn: number;
  /** Effective visual row after the alternate-pass mirror operation. */
  row: number;
  midi: number;
  pass: number;
}

/** The eight visible rows span the chord's actual sorted tones. */
export function arpNotes(notes: readonly number[]): number[] {
  const ordered = [...new Set(notes)].sort((a, b) => a - b);
  if (!ordered.length) return [];
  return Array.from({ length: 8 }, (_, row) => ordered[Math.round(row * (ordered.length - 1) / 7)]);
}

function foldMidi(note: number): number {
  while (note < 0) note += 12;
  while (note > 127) note -= 12;
  return note;
}

/** Resolve the drawn step and its active playback cell from one shared mapping. */
export function resolveArpStep(notes: readonly number[], step: number, settings: ArpSettings): ResolvedArpStep | null {
  const pitches = arpNotes(notes);
  if (!pitches.length || !Number.isFinite(step) || step < 0) return null;
  const pass = Math.floor(step / 8);
  const column = step % 8;
  const alternate = pass % 2 === 1;
  const sourceColumn = alternate && settings.reverse ? 7 - column : column;
  const drawnRow = settings.steps[sourceColumn];
  if (drawnRow === null || drawnRow === undefined) return null;
  const row = alternate && settings.mirror ? 7 - drawnRow : drawnRow;
  const octave = alternate ? 12 * settings.register : 0;
  return { column, sourceColumn, row, midi: foldMidi(pitches[row] + octave), pass };
}

export function arpStepTicks(settings: Pick<ArpSettings, 'division' | 'triplet'>): number {
  return 1920 / settings.division * (settings.triplet ? 2 / 3 : 1);
}

export function arpStepMs(tempo: number, division: number, triplet = false): number {
  return 60000 / tempo * 4 / division * (triplet ? 2 / 3 : 1);
}

function randomArpSteps(seed: number): Array<number | null> {
  let state = seed >>> 0;
  return Array.from({ length: 8 }, (_, index) => {
    state = (Math.imul(state ^ (index + 1), 1664525) + 1013904223) >>> 0;
    return state % 7 === 0 ? null : (state >>> 8) % 8;
  });
}

/** Seeded randomization of the visible musical controls; on/off stays unchanged. */
export function randomArpSettings(settings: ArpSettings, seed: number): ArpSettings {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const steps = randomArpSteps(next());
  const hasNotes = steps.some(step => step !== null);
  if (!hasNotes) steps[next() % 8] = next() % 8;
  return { ...settings, steps,
    division: ([2, 4, 8, 16, 32] as const)[next() % 5],
    register: ([-1, 0, 1] as const)[next() % 3], gate: (.1 + (next() % 91) / 100),
    triplet: Boolean(next() & 0x80000000), reverse: Boolean(next() & 0x80000000), mirror: Boolean(next() & 0x80000000),
  };
}
