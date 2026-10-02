import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChordAudition } from './chordAudition';

const batchSpy = (spy: (...args: unknown[]) => void) => (notes: Array<{ id: string; midi: number; velocity: number; part: string }>) => notes.forEach(note => spy(note.id, note.midi, note.velocity, note.part));

const chord = [{ midi: 60, velocity: .68, part: 'chords' as const }, { midi: 64, velocity: .68, part: 'chords' as const }];

afterEach(() => { vi.useRealTimers(); });

describe('ChordAudition', () => {
  it('avoids repeating a pitch signature, including duplicate pads, while preserving note order', async () => {
    const attacks = vi.fn();
    const bank = [
      [{ midi: 60, velocity: .68, part: 'chords' as const }, { midi: 64, velocity: .68, part: 'chords' as const }, { midi: 67, velocity: .68, part: 'chords' as const }],
      [{ midi: 67, velocity: .68, part: 'chords' as const }, { midi: 60, velocity: .68, part: 'chords' as const }, { midi: 64, velocity: .68, part: 'chords' as const }],
      [{ midi: 62, velocity: .68, part: 'chords' as const }, { midi: 65, velocity: .68, part: 'chords' as const }],
    ];
    const audition = new ChordAudition(async () => undefined, batchSpy(attacks), vi.fn(), () => 0);
    await audition.play(bank.length, index => bank[index]);
    await audition.play(bank.length, index => bank[index]);
    expect(attacks.mock.calls.map(call => call[1])).toEqual([60, 64, 67, 62, 65]);
    expect(attacks.mock.calls.map(call => call[0].split(':')[3])).toEqual(['0', '0', '0', '2', '2']);
    audition.cancel();
  });

  it('allows another audition when all visible pads have the same pitches', async () => {
    const attacks = vi.fn();
    const audition = new ChordAudition(async () => undefined, batchSpy(attacks), vi.fn(), () => 0);
    await audition.play(2, () => chord);
    await audition.play(2, () => chord);
    expect(attacks).toHaveBeenCalledTimes(4);
    expect(attacks.mock.calls.map(call => call[0].split(':')[3])).toEqual(['0', '0', '0', '0']);
    audition.cancel();
  });

  it('supports a one-pad bank', async () => {
    const attacks = vi.fn();
    const onePad = new ChordAudition(async () => undefined, batchSpy(attacks), vi.fn(), () => .99);
    await onePad.play(1, () => chord);
    expect(attacks).toHaveBeenCalledTimes(2);
    onePad.cancel();
  });

  it('releases on timeout and cancels a previous audition immediately', async () => {
    vi.useFakeTimers();
    const attacks = vi.fn(), releases = vi.fn();
    const audition = new ChordAudition(async () => undefined, batchSpy(attacks), releases, () => 0);
    await audition.play(1, () => chord);
    expect(attacks).toHaveBeenCalledTimes(2);
    await audition.play(1, () => chord);
    expect(releases).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(600);
    expect(releases).toHaveBeenCalledTimes(4);
  });

  it('rejects an unlock that completes after cancellation', async () => {
    let resolveUnlock!: () => void;
    const unlock = vi.fn(() => new Promise<void>(resolve => { resolveUnlock = resolve; }));
    const attacks = vi.fn(), releases = vi.fn();
    const audition = new ChordAudition(unlock, batchSpy(attacks), releases, () => 0);
    const pending = audition.play(2, () => chord);
    audition.cancel();
    resolveUnlock();
    await pending;
    expect(attacks).not.toHaveBeenCalled();
    expect(releases).not.toHaveBeenCalled();
  });
});
