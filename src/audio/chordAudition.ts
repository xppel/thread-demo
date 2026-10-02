type AuditionPart = 'chords' | 'bass';
export type AuditionNote = { midi: number; velocity: number; part: AuditionPart };

/** Owns one short audition and invalidates attacks waiting for audio unlock. */
export class ChordAudition {
  private generation = 0;
  private serial = 0;
  private lastPitchSignature: string | null = null;
  private ids: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly unlock: () => Promise<void>,
    private readonly attack: (notes: Array<AuditionNote & { id: string }>) => void,
    private readonly release: (id: string) => void,
    private readonly random: () => number = Math.random,
  ) {}

  async play(padCount: number, notesForPad: (index: number) => AuditionNote[]): Promise<void> {
    this.cancel();
    const count = Math.max(1, Math.floor(padCount));
    const bank = Array.from({ length: count }, (_, index) => notesForPad(index));
    const signature = (notes: AuditionNote[]) => notes.map(note => note.midi).sort((a, b) => a - b).join(',');
    const distinctPads = bank.map((notes, index) => ({ notes, index, signature: signature(notes) }))
      .filter(pad => pad.signature !== this.lastPitchSignature);
    const candidates = distinctPads.length ? distinctPads : bank.map((notes, index) => ({ notes, index, signature: signature(notes) }));
    const chosen = candidates[Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length))];
    const { index, notes } = chosen;
    this.lastPitchSignature = chosen.signature;
    const generation = this.generation;
    const serial = ++this.serial;
    const ids = notes.map((_, note) => `thread:audition:${serial}:${index}:${note}`);
    try { await this.unlock(); } catch { if (this.generation === generation) this.cancel(); return; }
    if (this.generation !== generation) return;
    this.ids = ids;
    this.attack(notes.map((note, index) => ({ ...note, id: ids[index] })));
    this.timer = setTimeout(() => this.cancel(), 600);
  }

  cancel(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ids = this.ids;
    this.ids = [];
    ids.forEach(id => this.release(id));
  }
}
