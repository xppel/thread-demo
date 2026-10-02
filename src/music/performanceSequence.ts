import type { TapeNote } from './performanceTypes';

function compareNotes(left: TapeNote, right: TapeNote): number {
  return left.tick - right.tick || left.id - right.id;
}

/**
 * Merge overlapping pitches per part. Adjacent notes remain separate attacks.
 */
export function performanceSequence(tape: readonly TapeNote[]): TapeNote[] {
  const currentByPitch = new Map<string, TapeNote>();
  const compiled: TapeNote[] = [];
  for (const note of [...tape].sort(compareNotes)) {
    const key = `${note.part}:${note.midi}`;
    const current = currentByPitch.get(key);
    const end = note.tick + note.durationTicks;
    if (current && note.tick < current.tick + current.durationTicks) {
      current.durationTicks = Math.max(current.durationTicks, end - current.tick);
      continue;
    }
    const clone = { ...note };
    currentByPitch.set(key, clone);
    compiled.push(clone);
  }
  return compiled.sort(compareNotes);
}
