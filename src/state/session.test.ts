import { describe, expect, it } from 'vitest';
import { createSession, validateSession } from './session';
import { retuneSession } from '../music/scale';
import { alterChord } from '../music/chordControls';
import { renderVoicing } from '../music/chordControls';

describe('demo sessions', () => {
  it('opens the four-bar progression with two reserved pads and unchanged sound defaults', () => {
    const session = createSession();
    expect(session).toMatchObject({ version: 1, padCount: 4, key: 0, scale: 'dorian', keyLocked: true, voice: 'Felt', bass: false,
      loop: { tempo: 100, bars: 4, meter: { numerator: 4, denominator: 4 } }, arp: { mode: 'off' }, sound: { masterVolume: .75 } });
    expect(session.bank.map(chord => chord.notes)).toEqual([[58,62,65],[58,62,65,67],[53,57,60],[55,58,62],[53,57,62],[53,55,58,62]]);
    expect(session.bank.every(chord => JSON.stringify(renderVoicing(chord.voicing!)) === JSON.stringify(chord.notes))).toBe(true);
    expect(session.loop.blocks.map(block => [block.pad,block.tick,block.durationTicks])).toEqual([[0,0,1920],[1,1920,1920],[2,3840,1920],[3,5760,1920]]);
    expect(validateSession(JSON.parse(JSON.stringify(session)))).toEqual(session);
  });
  it('validates bounds and detaches restored mutable data', () => {
    const session = createSession(), restored = validateSession(session)!;
    restored.bank[0].notes[0] += 12; expect(restored.bank).not.toEqual(session.bank);
    for (const update of [{ version: 0 }, { padCount: 7 }, { bank: session.bank.slice(1) }, { key: 12 },
      { loop: { ...session.loop, tempo: 39 } }, { loop: { ...session.loop, bars: 17 } },
      { arp: { ...session.arp, division: '16' } }, { arp: { ...session.arp, gate: .09 } },
      { sound: { ...session.sound, decay: NaN } }, { unsupported: true }]) expect(validateSession({ ...session, ...update })).toBeNull();
    for (const tempo of [40,200]) expect(validateSession({ ...session, loop: { ...session.loop, tempo } })).not.toBeNull();
  });
  it('retains hidden arrangement spans and rejects overlaps, invalid voicings and nonfinite values', () => {
    const session = createSession(); session.loop.bars = 1;
    expect(validateSession(session)).toEqual(session);
    expect(validateSession({ ...session, loop: { ...session.loop, blocks: [...session.loop.blocks, {id:99,pad:0,tick:0,durationTicks:1}] } })).toBeNull();
    expect(validateSession({ ...session, bank: session.bank.map((chord,i) => i ? chord : { ...chord, voicing: { ...chord.voicing, inversion: 0 } }) })).toBeNull();
    expect(validateSession({ ...session, sound: { ...session.sound, masterVolume: Infinity } })).toBeNull();
  });
});

it('retuned extended chords preserve pitches and remain reloadable in pentatonic scales', () => {
  const session = createSession(); session.scale = 'major';
  session.bank[0] = { root: 0, quality: 'add9', symbol: 'Cadd9', notes: [60,62,64,67], voicing: { base: [60,62,64,67], inversion: 0 } };
  const retuned = retuneSession(session, 0, 'pentatonic');
  expect(retuned.bank[0].notes).toEqual([60,62,74,79]);
  expect(validateSession(retuned)).toEqual(retuned);
  expect(validateSession({ ...retuned, bank: retuned.bank.map(chord => alterChord(chord, 'minor')) })).not.toBeNull();
});
