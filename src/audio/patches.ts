// Shared voice and macro configuration for live playback and offline WAV rendering.

import type { Voice } from '../music/types';
import { arpStepMs } from '../music/arpeggiator';
import type { ArpSettings, SoundSettings } from '../music/performanceTypes';
import { textureCompensationGain } from './textureCompensation';

type OscillatorType = 'sine' | 'triangle' | 'sawtooth' | 'square';

interface VoicePatch {
  oscillator: { type: OscillatorType };
  envelope: { attack: number; decay: number; sustain: number; release: number };
  cutoff: number;
  resonance: number;
  drive: number;
  textureMix: number;
  textureGain: number;
  volume: number;
  level: number;
  reverbAmount: number;
  reverbTime: number;
}

interface BasePatch {
  oscillator: { type: OscillatorType };
  envelope: Omit<VoicePatch['envelope'], 'attack'>;
  cutoff: number;
  volume: number;
}

const patches: Record<Voice, BasePatch> = {
  Felt: { oscillator: { type: 'triangle' }, envelope: { decay: 0.7, sustain: 0.17, release: 0.22 }, cutoff: 1700, volume: -14 },
  Glass: { oscillator: { type: 'sine' }, envelope: { decay: 1.1, sustain: 0.12, release: 0.7 }, cutoff: 9000, volume: -11 },
  Current: { oscillator: { type: 'sawtooth' }, envelope: { decay: 0.3, sustain: 0.34, release: 0.24 }, cutoff: 1800, volume: -19 },
  Pluck: { oscillator: { type: 'triangle' }, envelope: { decay: 0.28, sustain: 0.06, release: 0.16 }, cutoff: 3100, volume: -13 },
  Reed: { oscillator: { type: 'square' }, envelope: { decay: 0.52, sustain: 0.24, release: 0.32 }, cutoff: 1450, volume: -20 },
  Air: { oscillator: { type: 'sine' }, envelope: { decay: 0.95, sustain: 0.2, release: 0.82 }, cutoff: 4200, volume: -16 },
};

function macro(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

export function patchFor(voice: Voice, sound: SoundSettings): VoicePatch {
  const base = patches[voice];
  const color = macro(sound.color);
  const texture = macro(sound.texture);
  const decay = macro(sound.decay);
  const envelope = {
    attack: Math.max(0.001, .001 + macro(sound.attack) ** 2 * .28),
    decay: Math.max(0.01, base.envelope.decay * (0.3 + 1.8 * decay)),
    sustain: base.envelope.sustain,
    release: Math.max(0.03, base.envelope.release * (0.25 + 1.6 * decay)),
  };
  return {
    oscillator: base.oscillator,
    envelope,
    cutoff: base.cutoff * 2 ** ((color - 0.5) * 2),
    resonance: .65,
    drive: .2 + texture * ({ Felt: .52, Glass: .35, Current: .36, Pluck: .55, Reed: .31, Air: .42 }[voice]),
    textureMix: texture * ({ Felt: .85, Glass: .65, Current: .6, Pluck: .8, Reed: .55, Air: .7 }[voice]),
    textureGain: textureCompensationGain(voice, texture, color),
    volume: base.volume - texture * 1.8,
    level: macro(sound.masterVolume),
    reverbAmount: macro(sound.reverbAmount),
    reverbTime: macro(sound.reverbTime),
  };
}

/** Keep rapid arp attacks clear; MIDI Gate and the shared reverb stay unchanged. */
export function arpReleaseSeconds(release: number, settings: ArpSettings, tempo: number): number {
  if (settings.mode !== 'arp') return release;
  const step = arpStepMs(tempo, settings.division, settings.triplet) / 1000;
  return Math.max(.003, Math.min(release, step / 4, step * (1 - settings.gate)));
}
