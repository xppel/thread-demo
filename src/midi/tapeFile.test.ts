// Loop MIDI export tests.

import { Midi } from '@tonejs/midi';
import { parseMidi } from 'midi-file';
import { describe, expect, it, vi } from 'vitest';
import { ticksPerBar, DEFAULT_METER } from '../music/performanceTypes';
import { createSession } from '../state/session';
import { downloadTape, tapeMidiBytes } from './tapeFile';

const TICKS_PER_BAR = ticksPerBar(DEFAULT_METER);

function loopSession() {
  const session = createSession();
  session.loop = { ...session.loop, bars: 1, blocks: [{ id: 3, pad: 0, tick: 37, durationTicks: 900 }] };
  return session;
}

describe('loop MIDI export', () => {
  it('writes one loop track with exact off-grid span timing', () => {
    const session = loopSession();
    const bytes = tapeMidiBytes(session);
    const midi = new Midi(bytes);
    expect(midi.tracks).toHaveLength(1);
    expect(midi.header.tempos[0].bpm).toBeCloseTo(session.loop.tempo, 3);
    expect(midi.header.timeSignatures[0].timeSignature).toEqual([4, 4]);
    const track = midi.tracks[0];
    expect([track.name, track.channel]).toEqual(['THREAD - loop', 0]);
    expect(track.notes.map(note => [note.midi, note.ticks, note.durationTicks])).toEqual([[58, 37, 900], [62, 37, 900], [65, 37, 900]]);
    expect(track.endOfTrackTicks).toBe(TICKS_PER_BAR);
    const parsed = parseMidi(bytes);
    expect(parsed.tracks[0].some(event => event.type === 'programChange')).toBe(false);
    expect(parsed.tracks[0].reduce((ticks, event) => ticks + event.deltaTime, 0)).toBe(TICKS_PER_BAR);
  });

  it('exports the sounded arpeggiator steps and rests in one track', () => {
    const session = createSession();
    session.loop = { ...session.loop, bars: 1, blocks: [{ id: 0, pad: 0, tick: 0, durationTicks: TICKS_PER_BAR }] };
    session.arp = { ...session.arp, mode: 'arp', division: 8, steps: [0, null, 1, null, 2, null, 1, null], gate: .75 };
    const midi = new Midi(tapeMidiBytes(session));
    expect(midi.tracks).toHaveLength(1);
    expect(midi.tracks[0].notes.map(note => [note.ticks, note.durationTicks])).toEqual([[0, 180], [480, 180], [960, 180], [1440, 180]]);
  });

  it('exports the effective loop tempo while retaining the same event ticks', () => {
    const session = createSession();
    session.loop.tempo = 120;
    session.loop.divider = 4;
    const midi = new Midi(tapeMidiBytes(session));
    expect(midi.header.tempos[0].bpm).toBeCloseTo(30, 3);
    expect(midi.tracks[0].notes[0].ticks).toBe(0);
    expect(midi.tracks[0].notes[0].durationTicks).toBe(TICKS_PER_BAR);
    expect(midi.tracks[0].endOfTrackTicks).toBe(TICKS_PER_BAR * 4);
    expect(session.loop.tempo).toBe(120);
  });

  it('writes empty but exact-length tracks without dummy notes', () => {
    const session = createSession();
    session.loop = { ...session.loop, bars: 2, blocks: [] };
    const midi = new Midi(tapeMidiBytes(session));

    expect(midi.tracks).toHaveLength(1);
    expect(midi.tracks.every((track) => track.notes.length === 0)).toBe(true);
    expect(midi.tracks.every((track) => track.endOfTrackTicks === TICKS_PER_BAR * 2)).toBe(true);
  });

  it('downloads a blob and revokes its object URL safely', () => {
    vi.useFakeTimers();
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement;
    const append = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thread');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    downloadTape(loopSession());

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor.href).toBe('blob:thread');
    expect(anchor.download).toBe('thread-loop-100bpm.mid');
    expect(append).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:thread');

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
