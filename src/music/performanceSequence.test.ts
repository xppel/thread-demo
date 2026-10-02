// Focused shared-note compilation tests.

import { describe, expect, it } from 'vitest';
import type { TapeNote } from './performanceTypes';
import { performanceSequence } from './performanceSequence';

const note = (id: number, tick: number, durationTicks: number, midi = 60, part: TapeNote['part'] = 'chords', velocity = 0.5): TapeNote => ({ id, tick, durationTicks, midi, part, velocity });

describe('performanceSequence', () => {
  it('merges nested and partial overlap chains while keeping the first attack identity', () => {
    const tape = [note(4, 300, 500, 60, 'chords', 0.2), note(2, 100, 250, 60, 'chords', 0.7), note(1, 0, 200, 60, 'chords', 0.9)];

    expect(performanceSequence(tape)).toEqual([note(1, 0, 800, 60, 'chords', 0.9)]);
  });

  it('retains disjoint and exactly abutting notes as distinct retriggers', () => {
    expect(performanceSequence([note(2, 480, 120), note(1, 0, 480), note(3, 700, 50)])).toEqual([
      note(1, 0, 480), note(2, 480, 120), note(3, 700, 50),
    ]);
  });

  it('keeps Bass independent from a chord tone at the same pitch', () => {
    expect(performanceSequence([note(1, 0, 100), note(2, 20, 80, 60, 'bass')])).toEqual([note(1, 0, 100), note(2, 20, 80, 60, 'bass')]);
  });

  it('does not mutate the raw take and always returns tick then ID order', () => {
    const tape = [note(8, 40, 100), note(2, 0, 40), note(1, 0, 20, 62)];
    const before = structuredClone(tape);
    const compiled = performanceSequence(tape);

    expect(tape).toEqual(before);
    expect(compiled.map(({ tick, id }) => [tick, id])).toEqual([[0, 1], [0, 2], [40, 8]]);
    expect(compiled[2]).not.toBe(tape[0]);
  });
});
