// MIDI export of the selected loop.

import { Midi } from '@tonejs/midi';
import { parseMidi, writeMidi } from 'midi-file';
import { PPQ } from '../music/types';
import { activeTiming, lengthTicks } from '../music/performanceTypes';
import { activeSequence } from '../music/loop';
import { performanceSequence } from '../music/performanceSequence';
import type { Session } from '../music/performanceTypes';

const TRACK_NAME = 'THREAD - loop';

export function tapeMidiBytes(session: Session): Uint8Array {
  const midi = new Midi();
  midi.header.name = 'THREAD';
  const timing = activeTiming(session);
  midi.header.setTempo(timing.tempo);
  midi.header.timeSignatures = [{ ticks: 0, timeSignature: [timing.meter.numerator, timing.meter.denominator] }];
  const scale = midi.header.ppq / PPQ;
  const endTick = lengthTicks(timing);
  const events = performanceSequence(activeSequence(session));

  const track = midi.addTrack();
  track.name = TRACK_NAME;
  track.channel = 0;
  for (const note of events) {
    track.addNote({
      midi: note.midi,
      ticks: note.tick * scale,
      durationTicks: note.durationTicks * scale,
      velocity: note.velocity,
    });
  }
  track.endOfTrackTicks = endTick * scale;

  // @tonejs/midi does not retain an explicit endOfTrackTicks value while
  // encoding. Patch each parsed track so an empty or sparse take still ends
  // at the exact selected clip length without adding dummy musical events.
  const data = parseMidi(midi.toArray());
  for (const track of data.tracks) {
    let carriedDelta = 0;
    const kept = track.filter((event) => {
      const delta = event.deltaTime + carriedDelta;
      if (event.type === 'programChange') {
        carriedDelta = delta;
        return false;
      }
      event.deltaTime = delta;
      carriedDelta = 0;
      return true;
    });
    if (carriedDelta > 0 && kept.length > 0) kept[kept.length - 1].deltaTime += carriedDelta;
    track.splice(0, track.length, ...kept);

    let elapsed = 0;
    for (const event of track) {
      if (event.type === 'endOfTrack') event.deltaTime = Math.max(0, endTick * scale - elapsed);
      elapsed += event.deltaTime;
    }
  }
  return new Uint8Array(writeMidi(data));
}

export function downloadTape(session: Session): void {
  const bytes = tapeMidiBytes(session);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/midi' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `thread-loop-${activeTiming(session).tempo}bpm.mid`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
