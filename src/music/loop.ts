import { resolveArpStep, arpStepTicks } from './arpeggiator';
import { ARRANGEMENT_CAPACITY, lengthTicks, gridTicks } from './performanceTypes';
import type { LoopBlock, LoopState, Session, TapeNote } from './performanceTypes';

/** The active loop is a window on the saved arrangement, never a destructive trim. */
function visibleBlocks(notes: readonly LoopBlock[], loop: Pick<LoopState, 'bars' | 'meter'>): LoopBlock[] {
  const end = lengthTicks(loop);
  return notes.filter(note => note.tick < end).map(note => ({ ...note, durationTicks: Math.min(note.durationTicks, end - note.tick) }));
}
export function visibleLoop(loop: LoopState): LoopState {
  return { ...loop, blocks: visibleBlocks(loop.blocks, loop) };
}

/** Merge a visible edit into the canonical arrangement without disturbing hidden clips. */
export function editRetainedBlock(loop: LoopState, block: LoopBlock, padCount: number, strict = false): LoopState | null {
  const visible = visibleLoop(loop);
  const edited = strict ? placeBlock(visible, block, padCount) : insertBlock(visible, block, padCount);
  if (!edited) return null;
  const blocks = edited.blocks.map(next => {
    const before = visible.blocks.find(item => item.id === next.id);
    const original = loop.blocks.find(item => item.id === next.id);
    if (!before || !original || next.id === block.id) return next;
    // A shifted neighbor keeps the tail that extends beyond the visible boundary.
    return { ...next, durationTicks: next.durationTicks === before.durationTicks ? original.durationTicks : next.durationTicks };
  });
  blocks.push(...loop.blocks.filter(item => item.tick >= lengthTicks(loop)));
  blocks.sort((a, b) => a.tick - b.tick || a.id - b.id);
  return validBlocks(blocks, ARRANGEMENT_CAPACITY, padCount) ? { ...loop, blocks } : null;
}

export function bassPitch(root: number, notes: readonly number[]): number {
  const lowest = Math.min(...notes);
  let pitch = root;
  while (pitch + 12 <= lowest - 12) pitch += 12;
  while (pitch > lowest - 12 && pitch >= 12) pitch -= 12;
  return Math.max(0, Math.min(127, pitch));
}

export function validBlocks(blocks: readonly LoopBlock[], loop: Pick<LoopState, 'bars' | 'meter'>, padCount: number): boolean {
  const end = lengthTicks(loop);
  const ids = new Set<number>();
  const ordered = [...blocks].sort((a, b) => a.tick - b.tick || a.id - b.id);
  let lastEnd = 0;
  for (const block of ordered) {
    if (!Number.isInteger(block.id) || block.id < 0 || ids.has(block.id) ||
      !Number.isInteger(block.pad) || block.pad < 0 || block.pad >= padCount ||
      !Number.isInteger(block.tick) || block.tick < lastEnd ||
      !Number.isInteger(block.durationTicks) || block.durationTicks < 1 ||
      block.tick + block.durationTicks > end) return false;
    ids.add(block.id);
    lastEnd = block.tick + block.durationTicks;
  }
  return true;
}

export function placeBlock(loop: LoopState, block: LoopBlock, padCount: number): LoopState | null {
  const blocks = [...loop.blocks.filter(candidate => candidate.id !== block.id), block]
    .sort((a, b) => a.tick - b.tick || a.id - b.id);
  return validBlocks(blocks, loop, padCount) ? { ...loop, blocks } : null;
}

/** Edit within the chosen length. A move onto a clip exchanges their order. */
export function insertBlock(loop: LoopState, block: LoopBlock, padCount: number): LoopState | null {
  if (!Number.isInteger(block.pad) || block.pad < 0 || block.pad >= padCount || block.durationTicks < 1) return null;
  const placed = { ...block, tick: snapTick(block.tick, loop.meter, loop.grid) };
  const original = loop.blocks.find(item => item.id === block.id);
  const others = loop.blocks.filter(item => item.id !== block.id).sort((a, b) => a.tick - b.tick || a.id - b.id);
  if (original && original.durationTicks === placed.durationTicks) {
    const target = others.find(item => placed.tick >= item.tick && placed.tick < item.tick + item.durationTicks);
    if (target) {
      const ordered = [...loop.blocks].sort((a, b) => a.tick - b.tick || a.id - b.id);
      const from = ordered.findIndex(item => item.id === original.id);
      const to = ordered.findIndex(item => item.id === target.id);
      const gaps = ordered.map((item, index) => index ? item.tick - (ordered[index - 1].tick + ordered[index - 1].durationTicks) : item.tick);
      [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
      let cursor = 0;
      const swapped = ordered.map((item, index) => {
        cursor += gaps[index];
        const next = { ...item, tick: cursor };
        cursor += item.durationTicks;
        return next;
      });
      return validBlocks(swapped, loop, padCount) ? { ...loop, blocks: swapped } : null;
    }
    const moved = [...others, placed].sort((a, b) => a.tick - b.tick || a.id - b.id);
    return validBlocks(moved, loop, padCount) ? { ...loop, blocks: moved } : null;
  }
  // New clips and lengthened clips push only later clips that collide. Shortening leaves the gap.
  const before: LoopBlock[] = [], after: LoopBlock[] = [];
  for (const item of others) {
    if (item.tick + item.durationTicks <= placed.tick) before.push(item);
    else after.push(item);
  }
  let cursor = placed.tick + placed.durationTicks;
  const shifted = after.map(item => {
    const next = { ...item, tick: Math.max(item.tick, cursor) };
    cursor = next.tick + next.durationTicks;
    return next;
  });
  const blocks = [...before, placed, ...shifted].sort((a, b) => a.tick - b.tick || a.id - b.id);
  return validBlocks(blocks, loop, padCount) ? { ...loop, blocks } : null;
}

export function snapTick(tick: number, meter: LoopState['meter'], grid: LoopState['grid']): number {
  const step = gridTicks(meter, grid);
  return Math.max(0, Math.round(tick / step) * step);
}

export function blockInGap(loop: LoopState, pad: number, tick: number, suggestedTicks: number): LoopBlock | null {
  const start = snapTick(tick, loop.meter, loop.grid);
  const end = lengthTicks(loop);
  if (start >= end || loop.blocks.some(block => start >= block.tick && start < block.tick + block.durationTicks)) return null;
  const next = loop.blocks.filter(block => block.tick > start).reduce((minimum, block) => Math.min(minimum, block.tick), end);
  const durationTicks = Math.min(Math.max(gridTicks(loop.meter, loop.grid), suggestedTicks), next - start);
  if (durationTicks < gridTicks(loop.meter, loop.grid)) return null;
  return { id: Math.max(0, ...loop.blocks.map(block => block.id + 1)), pad, tick: start, durationTicks };
}

/** Later played holds replace only the spans they touch. Untouched fragments keep their place. */
export function replaceRecordedSpans(loop: LoopState, recorded: readonly Omit<LoopBlock, 'id'>[], padCount: number, edgeToleranceTicks = 0): LoopState | null {
  const end = lengthTicks(loop);
  let nextId = Math.max(0, ...loop.blocks.map(block => block.id + 1));
  let blocks = [...loop.blocks];
  for (const take of recorded) {
    let start = Math.max(0, Math.min(end - 1, take.tick));
    let stop = Math.max(start + 1, Math.min(end, take.tick + take.durationTicks));
    const overlapped = blocks.filter(block => block.tick < stop && block.tick + block.durationTicks > start);
    const first = overlapped[0], last = overlapped.at(-1);
    if (first && start >= first.tick && start - first.tick <= edgeToleranceTicks) start = first.tick;
    const lastEnd = last ? Math.min(end, last.tick + last.durationTicks) : stop;
    if (last && stop <= lastEnd && lastEnd - stop <= edgeToleranceTicks) stop = lastEnd;
    const kept: LoopBlock[] = [];
    for (const block of blocks) {
      const blockEnd = block.tick + block.durationTicks;
      if (blockEnd <= start || block.tick >= stop) { kept.push(block); continue; }
      if (block.tick < start) kept.push({ ...block, durationTicks: start - block.tick });
      if (blockEnd > stop) kept.push({ ...block, id: nextId++, tick: stop, durationTicks: blockEnd - stop });
    }
    kept.push({ id: nextId++, pad: take.pad, tick: start, durationTicks: stop - start });
    blocks = kept.sort((a, b) => a.tick - b.tick || a.id - b.id);
  }
  return validBlocks(blocks, ARRANGEMENT_CAPACITY, padCount) ? { ...loop, blocks } : null;
}

export function activeSequence(session: Session): TapeNote[] {
  const events: TapeNote[] = [];
  const { bank, arp, bass } = session;
  const loop = visibleLoop(session.loop);
  let id = 0;
  for (const block of loop.blocks) {
    const chord = bank[block.pad];
    if (!chord) continue;
    if (bass) events.push({ id: id++, midi: bassPitch(chord.root, chord.notes), tick: block.tick, durationTicks: block.durationTicks, velocity: .58, part: 'bass', pad: block.pad });
    if (arp.mode !== 'arp') {
      for (const midi of chord.notes) events.push({ id: id++, midi, tick: block.tick, durationTicks: block.durationTicks, velocity: .68, part: 'chords', pad: block.pad });
      continue;
    }
    const stepTicks = arpStepTicks(arp);
    for (let tick = block.tick, step = 0; tick < block.tick + block.durationTicks; tick += stepTicks, step++) {
      const resolved = resolveArpStep(chord.notes, step, arp);
      if (!resolved) continue;
      const durationTicks = Math.max(1, Math.min(Math.round(stepTicks * arp.gate), block.tick + block.durationTicks - tick));
      events.push({ id: id++, midi: resolved.midi, tick, durationTicks, velocity: .68, part: 'chords', pad: block.pad });
    }
  }
  return events.sort((a, b) => a.tick - b.tick || a.id - b.id);
}
