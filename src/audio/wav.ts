// Stereo WAV export of the selected loop.

import * as Tone from 'tone';
import { arpReleaseSeconds, patchFor } from './patches';
import { PPQ } from '../music/types';
import { activeTiming, lengthTicks } from '../music/performanceTypes';
import { activeSequence } from '../music/loop';
import { createEffect, reverbDecaySeconds, reverbWet } from './effect';
import { performanceSequence } from '../music/performanceSequence';
import type { Session } from '../music/performanceTypes';

const SAMPLE_RATE = 44100;

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function pcm16(sample: number): number {
  const finite = Number.isFinite(sample) ? sample : 0;
  const clamped = Math.max(-1, Math.min(1, finite));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function wavBuffer(channels: Float32Array[], sampleRate: number) {
  const channelCount = Math.max(1, Math.min(0xffff, channels.length));
  const frames = channels.reduce((maximum, channel) => Math.max(maximum, channel.length), 0);
  const dataSize = frames * channelCount * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : SAMPLE_RATE;

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  return { bytes, view, channelCount, frames };
}

function writeFrames(target: ReturnType<typeof wavBuffer>, channels: Float32Array[], start: number, end: number): void {
  let offset = 44 + start * target.channelCount * 2;
  for (let frame = start; frame < end; frame++) {
    for (let channel = 0; channel < target.channelCount; channel++) {
      target.view.setInt16(offset, pcm16(channels[channel]?.[frame] ?? 0), true);
      offset += 2;
    }
  }
}

export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const target = wavBuffer(channels, sampleRate);
  writeFrames(target, channels, 0, target.frames);
  return target.bytes;
}

// Yield actual tasks, so the live scheduling timer can run between work slices.
const WORK_MS = 4;
const FRAME_BATCH = 4096;
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function encodeWavCooperatively(channels: Float32Array[], sampleRate: number): Promise<Uint8Array> {
  const target = wavBuffer(channels, sampleRate);
  let began = performance.now();
  for (let frame = 0; frame < target.frames; frame += FRAME_BATCH) {
    writeFrames(target, channels, frame, Math.min(target.frames, frame + FRAME_BATCH));
    if (performance.now() - began >= WORK_MS) { await yieldTask(); began = performance.now(); }
  }
  return target.bytes;
}

export async function renderWav(session: Session): Promise<Uint8Array> {
  const timing = activeTiming(session);
  const secondsPerTick = 60 / timing.tempo / PPQ;
  const loopSeconds = lengthTicks(timing) * secondsPerTick;
  const patch = patchFor(session.voice, session.sound);
  const arpRelease = arpReleaseSeconds(patch.envelope.release, session.arp, timing.tempo);
  const tail = (session.bass ? patch.envelope.release : arpRelease) + (patch.reverbAmount > 0 ? reverbDecaySeconds(patch.reverbTime) + .25 : .1);
  const events = performanceSequence(activeSequence(session));
  const totalFrames = Math.ceil((loopSeconds + tail) * SAMPLE_RATE);
  const output = [new Float32Array(totalFrames), new Float32Array(totalFrames)];
  const chunkSeconds = 12;
  for (let chunkStart = 0; chunkStart < loopSeconds; chunkStart += chunkSeconds) {
    const chunkEnd = Math.min(loopSeconds, chunkStart + chunkSeconds);
    const included = events.filter(note => {
      const start = note.tick * secondsPerTick;
      return start >= chunkStart && start < chunkEnd;
    });
    if (!included.length) continue;
    const latestEnd = Math.max(chunkEnd, ...included.map(note => (note.tick + note.durationTicks) * secondsPerTick));
    const duration = latestEnd - chunkStart + tail;
    // Explicit context ownership keeps async impulse preparation out of the live graph.
    const context = new Tone.OfflineContext(2, duration, SAMPLE_RATE);
    try {
      const gain = new Tone.Gain({ gain: patch.level, context }).toDestination();
      const limiter = new Tone.Limiter({ threshold: -3, context }).connect(gain);
      const bus = new Tone.Gain({ gain: 1, context });
      bus.connect(limiter);
      if (patch.reverbAmount > 0) {
        const effect = createEffect(session.sound.reverbTime, context);
        await effect.ready;
        effect.wet.value = 1;
        const damping = new Tone.Filter({ frequency: 6200, type: 'lowpass', context }).connect(new Tone.Gain({ gain: reverbWet(patch.reverbAmount), context }).connect(limiter));
        bus.connect(effect); effect.connect(damping);
      }
      const slots: Array<{ available: number; part: typeof included[number]['part']; input: Tone.Distortion }> = [];
      let began = performance.now();
      for (const note of included) {
        const time = note.tick * secondsPerTick - chunkStart;
        const noteDuration = note.durationTicks * secondsPerTick;
        const release = note.part === 'bass' ? patch.envelope.release : arpRelease;
        let slot = slots.find(candidate => candidate.part === note.part && candidate.available <= time);
        if (!slot) {
          const textureGain = new Tone.Gain({ gain: patch.textureGain, context }).connect(bus);
          const filter = new Tone.Filter({ frequency: patch.cutoff, type: 'lowpass', Q: patch.resonance, context }).connect(textureGain);
          const input = new Tone.Distortion({ context, distortion: patch.drive, wet: patch.textureMix }).connect(filter);
          slot = { available: 0, part: note.part, input }; slots.push(slot);
        }
        // Export settings are immutable. Share a path only after its prior dry
        // tail and settling interval, retaining separate simultaneous voices.
        slot.available = time + noteDuration + release + .1;
        const synth = new Tone.Synth({ context, oscillator: patch.oscillator, envelope: { ...patch.envelope, release }, volume: patch.volume }).connect(slot.input);
        synth.triggerAttackRelease(Tone.Frequency(note.midi, 'midi').toFrequency(), noteDuration, time, note.velocity);
        if (performance.now() - began >= WORK_MS) { await yieldTask(); began = performance.now(); }
      }
      const rendered = await context.render();
      const channels = rendered.toArray();
      const data = Array.isArray(channels) ? channels : [channels];
      const frameOffset = Math.round(chunkStart * SAMPLE_RATE);
      began = performance.now();
      for (let channel = 0; channel < 2; channel++) {
        const source = data[channel] ?? data[0];
        const frames = Math.min(source.length, totalFrames - frameOffset);
        for (let frame = 0; frame < frames; frame += FRAME_BATCH) {
          for (let index = frame; index < Math.min(frames, frame + FRAME_BATCH); index++) output[channel][frameOffset + index] += source[index];
          if (performance.now() - began >= WORK_MS) { await yieldTask(); began = performance.now(); }
        }
      }
    } finally { context.dispose(); }
  }
  return encodeWavCooperatively(output, SAMPLE_RATE);
}

export async function downloadWav(session: Session): Promise<void> {
  const bytes = await renderWav(session);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `thread-loop-${activeTiming(session).tempo}bpm.wav`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
