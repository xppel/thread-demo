import { describe, expect, it } from 'vitest';
import { createSession, validateSession } from '../state/session';
import { activeSequence, blockInGap, editRetainedBlock, visibleLoop, insertBlock, placeBlock, replaceRecordedSpans, validBlocks } from './loop';
import { newChords } from './randomize';
import { resolveArpStep } from './arpeggiator';

describe('loop and session behavior', () => {
  it('starts with four linked bars and rejects overlaps while preserving gaps', () => {
    const session = createSession();
    expect(session.version).toBe(1);
    expect(session.loop.blocks.map(b => [b.pad, b.tick, b.durationTicks])).toEqual([[0, 0, 1920], [1, 1920, 1920], [2, 3840, 1920], [3, 5760, 1920]]);
    expect(placeBlock(session.loop, { id: 9, pad: 0, tick: 0, durationTicks: 480 }, session.padCount)).toBeNull();
    const loop = { ...session.loop, blocks: [session.loop.blocks[0], session.loop.blocks[2]] };
    expect(validBlocks(loop.blocks, loop, session.padCount)).toBe(true);
    expect(activeSequence({ ...session, loop }).some(note => note.tick >= 1920 && note.tick < 3840)).toBe(false);
  });

  it('swaps occupied clips, moves into gaps and never changes the bar count', () => {
    const session = createSession();
    const moved = insertBlock(session.loop, { ...session.loop.blocks[0], tick: 1920 }, session.padCount);
    expect(moved?.blocks.map(block => block.pad)).toEqual([1, 0, 2, 3]);
    expect(moved?.bars).toBe(4);
    const gapped = { ...session.loop, blocks: [session.loop.blocks[0], { ...session.loop.blocks[1], tick: 3840 }] };
    const filled = insertBlock(gapped, { id: 11, pad: 2, tick: 1920, durationTicks: 960 }, session.padCount);
    expect(filled?.blocks.map(block => block.tick)).toEqual([0, 1920, 3840]);
    expect(insertBlock(session.loop, { id: 10, pad: 0, tick: 1920, durationTicks: 1920 }, session.padCount)).toBeNull();
  });
  it('pushes later clips only while there is room and preserves gaps', () => {
    const session = createSession();
    const loop = { ...session.loop, blocks: [session.loop.blocks[0], { ...session.loop.blocks[1], tick: 3840 }] };
    const stretched = insertBlock(loop, { ...loop.blocks[0], durationTicks: 2880 }, session.padCount);
    expect(stretched?.blocks.map(block => block.tick)).toEqual([0, 3840]);
    const full = { ...session.loop, bars: 16, blocks: Array.from({ length: 16 }, (_, id) => ({ id, pad: 0, tick: id * 1920, durationTicks: 1920 })) };
    expect(insertBlock(full, { id: 17, pad: 0, tick: 0, durationTicks: 1920 }, session.padCount)).toBeNull();
    expect(full.bars).toBe(16);
  });
  it('generates distinct scale-aware pads while preserving the sequence', () => {
    const session = createSession();

    for (let seed = 1; seed <= 64; seed++) {
      const next = newChords(session, seed);
      expect(next.padCount).toBeGreaterThanOrEqual(3);
      expect(next.padCount).toBeLessThanOrEqual(6);
      expect(new Set(next.bank.slice(0, next.padCount).map(chord => chord.symbol)).size).toBe(next.padCount);
      expect(next.bank).toHaveLength(6);
      expect(new Set(next.bank.map(chord => chord.symbol)).size).toBe(6);
      expect(validBlocks(next.loop.blocks, next.loop, next.padCount)).toBe(true);
      expect(next.loop.bars).toBe(session.loop.bars);
      expect(next.loop).toEqual(session.loop);
      expect(next.padCount).toBe(session.padCount);
      expect(validateSession(next)).not.toBeNull();
    }

  });
  it('adds one bass note per block and follows drawn arp rests', () => {
    const session = createSession(); session.bass = true; session.arp.mode = 'arp'; session.arp.division = 8;
    expect(activeSequence(session).filter(note => note.part === 'bass')).toHaveLength(4);
    expect(activeSequence(session).filter(note => note.part === 'chords').some(note => note.tick === 1200)).toBe(false);
  });
  it('uses the shared arp resolver for each clip from its own pass zero', () => {
    const session = createSession();
    session.loop = { ...session.loop, bars: 2, blocks: [
      { id: 0, pad: 0, tick: 0, durationTicks: 1920 },
      { id: 1, pad: 1, tick: 1920, durationTicks: 1920 },
    ] };
    session.arp = { ...session.arp, mode: 'arp', division: 32, steps: [0, 4, 7, 4, 0, null, 7, null], register: 1 };
    const chords = activeSequence(session).filter(note => note.part === 'chords');
    for (const block of session.loop.blocks) {
      const notes = chords.filter(note => note.pad === block.pad);
      const expected = resolveArpStep(session.bank[block.pad].notes, 0, session.arp);
      expect(notes[0]).toMatchObject({ tick: block.tick, midi: expected?.midi });
    }
    expect(chords.some(note => note.tick === 300)).toBe(false);
    expect(chords.find(note => note.tick === 120)?.midi).toBe(resolveArpStep(session.bank[0].notes, 2, session.arp)?.midi);
  });

  it('fits a suggested clip into a gap and replaces only played spans', () => {
    const session = createSession();
    const loop = { ...session.loop, blocks: [{ id: 1, pad: 0, tick: 0, durationTicks: 480 }, { id: 2, pad: 1, tick: 1440, durationTicks: 480 }] };
    expect(blockInGap(loop, 2, 480, 1920)).toMatchObject({ tick: 480, durationTicks: 960 });
    expect(blockInGap(loop, 2, 0, 480)).toBeNull();
    const replaced = replaceRecordedSpans(loop, [{ pad: 2, tick: 240, durationTicks: 1440 }], session.padCount);
    expect(replaced?.blocks.map(block => [block.pad, block.tick, block.durationTicks])).toEqual([[0, 0, 240], [2, 240, 1440], [1, 1680, 240]]);
    expect(replaced?.bars).toBe(loop.bars);
  });
  it('gives the later overlapping recorded hold priority while preserving untouched spans', () => {
    const session = createSession();
    const loop = { ...session.loop, bars: 1, blocks: [{ id: 0, pad: 0, tick: 0, durationTicks: 1920 }] };
    const replaced = replaceRecordedSpans(loop, [
      { pad: 1, tick: 240, durationTicks: 960 },
      { pad: 2, tick: 720, durationTicks: 720 },
    ], session.padCount);
    expect(replaced?.blocks.map(block => [block.pad, block.tick, block.durationTicks])).toEqual([
      [0, 0, 240], [1, 240, 480], [2, 720, 720], [0, 1440, 480],
    ]);
  });

});

it('New chords preserves exact clips, pad count at every visible count', () => {
  for (let count=1; count<=6; count++) {
    const session = createSession(); session.padCount=count;
    session.loop.blocks=[{id:9,pad:count-1,tick:120,durationTicks:300}];
    for (let seed=0; seed<32; seed++) {
      const next=newChords(session,seed);
      expect(next.loop).toBe(session.loop);
      expect(next.padCount).toBe(count); expect(next.bank).toHaveLength(6);
      expect(validateSession(next)).not.toBeNull();
    }
  }
});

describe('retained arrangement window', () => {
  it('projects boundary-crossing clips without mutating canonical data', () => {
    const session = createSession(); session.loop.bars = 1;
    session.loop.blocks = [{ id: 12, pad: 0, tick: 0, durationTicks: 2880 }, { id: 30, pad: 1, tick: 3840, durationTicks: 1920 }];
    const before = structuredClone(session);
    expect(visibleLoop(session.loop).blocks).toEqual([{ id: 12, pad: 0, tick: 0, durationTicks: 1920 }]);
    for (const events of [activeSequence(session)]) {
      expect(events.every(note => note.tick + note.durationTicks <= 1920)).toBe(true);
    }
    expect(session).toEqual(before);
    session.loop.bars = 4;
    expect(visibleLoop(session.loop).blocks).toEqual(before.loop.blocks);
  });
  it('retains hidden clips through edits, reserves their IDs and rejects collisions', () => {
    const session = createSession(); session.loop.bars = 1;
    session.loop.blocks = [{ id: 0, pad: 0, tick: 0, durationTicks: 960 }, { id: 40, pad: 1, tick: 1920, durationTicks: 960 }];
    expect(blockInGap(session.loop, 2, 960, 480)?.id).toBe(41);
    const edited = editRetainedBlock(session.loop, { id: 41, pad: 2, tick: 960, durationTicks: 480 }, 6)!;
    expect(edited.blocks.find(block => block.id === 40)).toEqual(session.loop.blocks[1]);
    session.loop.blocks = [{ id: 0, pad: 0, tick: 0, durationTicks: 2400 }, { id: 40, pad: 1, tick: 2400, durationTicks: 480 }];
    expect(editRetainedBlock(session.loop, { id: 41, pad: 2, tick: 0, durationTicks: 480 }, 6)).toBeNull();
  });
  it('recording replaces only touched spans and preserves the original hidden tail', () => {
    const session = createSession(); session.loop.bars = 1;
    session.loop.blocks = [{ id: 3, pad: 0, tick: 0, durationTicks: 2880 }, { id: 55, pad: 1, tick: 4000, durationTicks: 480 }];
    const next = replaceRecordedSpans(session.loop, [{ pad: 2, tick: 1800, durationTicks: 120 }], 6)!;
    expect(next.blocks.find(block => block.id === 55)).toEqual(session.loop.blocks[1]);
    expect(next.blocks.find(block => block.tick === 1920)).toMatchObject({ pad: 0, durationTicks: 960 });
    expect(new Set(next.blocks.map(block => block.id)).size).toBe(next.blocks.length);
    expect(next.blocks.filter(block => block.id !== 3 && block.id !== 55).every(block => block.id > 55)).toBe(true);
  });
});

it('recording boundary tolerance removes alignment remnants without touching gaps, short clips or hidden tails', () => {
  const session = createSession();
  const loop = { ...session.loop, bars: 1, blocks: [
    { id: 5, pad: 0, tick: 0, durationTicks: 480 },
    { id: 8, pad: 1, tick: 600, durationTicks: 3 },
    { id: 11, pad: 2, tick: 1920, durationTicks: 480 },
  ] };
  const result = replaceRecordedSpans(loop, [{ pad: 3, tick: 4, durationTicks: 473 }], 6, 5)!;
  expect(result.blocks.find(b => b.pad === 3)).toMatchObject({ tick: 0, durationTicks: 480 });
  expect(result.blocks.filter(b => b.id === 8 || b.id === 11)).toEqual(loop.blocks.slice(1));
  const partial = replaceRecordedSpans(loop, [{ pad: 3, tick: 30, durationTicks: 400 }], 6, 5)!;
  expect(partial.blocks.filter(b => b.pad === 0).map(b => b.durationTicks)).toEqual([30, 50]);
  const crossing = { ...loop, blocks: [{ id: 5, pad: 0, tick: 0, durationTicks: 2880 }] };
  const take = replaceRecordedSpans(crossing, [{ pad: 3, tick: 3, durationTicks: 1914 }], 6, 5)!;
  expect(take.blocks.find(b => b.pad === 0)).toMatchObject({ tick: 1920, durationTicks: 960 });
});
