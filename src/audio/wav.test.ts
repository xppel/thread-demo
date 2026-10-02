// Focused PCM WAV encoding and offline render contract tests.

import { describe, expect, it, vi } from 'vitest';

const tone = vi.hoisted(() => {
  type Attack = [number, number, number, number];
  const state: {
    attacks: Attack[];
    offline: { duration: number; channels: number; sampleRate: number } | null;
    offlineCalls: number[];
    rendered: Float32Array[];
    gains: number[];
    gainNodes: Gain[];
    filters: number[];
    distortions: unknown[];
    synthOptions: unknown[];
    onConstruct?: () => void;
  } = {
    attacks: [],
    offline: null, offlineCalls: [],
    rendered: [new Float32Array([0, 0]), new Float32Array([0, 0])],
    gains: [], gainNodes: [], filters: [], distortions: [], synthOptions: [],
  };

  class Node {
    connect<T>(_destination: T): this { return this; }
    toDestination(): this { return this; }
  }
  class Gain extends Node {
    gain = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
    constructor(options: number | { gain: number; context: unknown }) { super(); state.gains.push(typeof options === 'number' ? options : options.gain); state.gainNodes.push(this); }
  }
  class Limiter extends Node {
    constructor(public readonly threshold: number) { super(); }
  }
  class Filter extends Node {
    Q = { value: 0 };
    constructor(options: { frequency: number; context: unknown }) { super(); state.filters.push(options.frequency); }
  }
  class Effect extends Node { wet = { value: 0, rampTo: vi.fn() }; }
  class Distortion extends Node { constructor(public readonly options: unknown) { super(); state.distortions.push(options); } }
  class Synth extends Node {
    constructor(public readonly options: unknown) { super(); state.synthOptions.push(options); state.onConstruct?.(); }
    triggerAttackRelease(frequency: number, duration: number, time: number, velocity: number): void {
      state.attacks.push([frequency, duration, time, velocity]);
    }
  }
  class OfflineContext {
    dispose = vi.fn();
    constructor(channels: number, duration: number, sampleRate: number) {
      state.offline = { duration, channels, sampleRate }; state.offlineCalls.push(duration);
    }
    render = vi.fn(async () => ({ toArray: () => state.rendered }));
  }
  const Frequency = vi.fn((midi: number) => ({ toFrequency: () => midi }));
  return { state, OfflineContext, Frequency, Gain, Limiter, Filter, Synth, Distortion, Reverb: class extends Effect { ready = Promise.resolve(); } };
});

vi.mock('tone', () => tone);

import { createSession } from '../state/session';
import { arpReleaseSeconds, patchFor } from './patches';
import { encodeWav, downloadWav, renderWav } from './wav';

describe('WAV export', () => {
  it('encodes stereo16 PCM headers, interleaving, clipping, and finite samples', () => {
    const bytes = encodeWav(
      [new Float32Array([-1, -0.5, 0, 0.5, 1, Number.NaN, 2]), new Float32Array([1, 0.5, 0, -0.5, -1])],
      44100,
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
    expect(text(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(28, true)).toBe(176400);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(28);
    expect(Array.from({ length: 14 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual([
      -32768, 32767,
      -16384, 16384,
      0, 0,
      16384, -16384,
      32767, -32768,
      0, 0,
      32767, 0,
    ]);
  });

  it('renders exact chord-span timing with an owned offline context and release tail', async () => {
    tone.state.attacks.length = 0;
    const session = createSession(); session.voice = 'Glass'; session.sound.reverbAmount = 0;
    session.loop = { ...session.loop, bars: 1, blocks: [{ id: 0, pad: 0, tick: 480, durationTicks: 240 }] };
    await renderWav(session);
    expect(tone.state.attacks).toEqual([[58,.3,.6,.68],[62,.3,.6,.68],[65,.3,.6,.68]]);
    expect(tone.state.offline).toMatchObject({ channels: 2, sampleRate: 44100 });
    expect(tone.state.offline!.duration).toBeCloseTo(2.4 + patchFor(session.voice,session.sound).envelope.release + .1);
  });

  it('downloads a WAV with a safe revocation delay', async () => {
    vi.useFakeTimers();
    const workClock = vi.spyOn(performance, 'now').mockReturnValue(0);
    tone.state.attacks.length = 0;
    tone.state.offline = null;
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() } as unknown as HTMLAnchorElement;
    const append = vi.fn();
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor), body: { append } });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:wav');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const session = createSession();

    session.loop = { ...session.loop, blocks: [] };
    await downloadWav(session);

    expect(anchor.href).toBe('blob:wav');
    expect(anchor.download).toBe('thread-loop-100bpm.wav');
    expect(append).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:wav');

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    vi.unstubAllGlobals();
    workClock.mockRestore();
    vi.useRealTimers();
  });

  it('uses the session macros for the selected voice and output level', async () => {
    tone.state.gains.length = 0;
    tone.state.filters.length = 0;
    tone.state.synthOptions.length = 0;
    const session = createSession();
    session.voice = 'Glass';
    session.sound = { ...session.sound, decay: .5, reverbAmount: 0 };

    session.loop = { ...session.loop, bars: 1, blocks: [{ id: 0, pad: 0, tick: 0, durationTicks: 240 }] };
    session.sound = { ...session.sound, color: 1, decay: 1, masterVolume: 0.4 };

    await renderWav(session);

    expect(tone.state.offline?.duration).toBeCloseTo(2.4 + 1.295 + .1);
    expect(tone.state.gains).toContain(0.4);
    expect(tone.state.filters).toContain(18000);
    expect((tone.state.synthOptions[0] as { envelope: { release: number } }).envelope.release).toBeCloseTo(1.295);
  });
  it('renders loop audio at the divided tempo', async () => {
    tone.state.attacks.length = 0;
    tone.state.offlineCalls.length = 0;
    const session = createSession();
    session.loop = { ...session.loop, tempo: 120, divider: 4, bars: 1, blocks: [session.loop.blocks[0]] };
    await renderWav(session);
    expect(tone.state.attacks[0][1]).toBeCloseTo(8);
    expect(tone.state.offlineCalls[0]).toBeGreaterThan(8);
    expect(session.loop.tempo).toBe(120);
  });

  it('renders a longer loop in bounded offline windows', async () => {
    tone.state.offlineCalls.length = 0;
    const session = createSession();
    session.loop = { ...session.loop, tempo: 120, bars: 16,
      blocks: Array.from({ length: 16 }, (_, index) => ({ id: index, pad: index % 4, tick: index * 1920, durationTicks: 1920 })) };
    await renderWav(session);
    expect(tone.state.offlineCalls).toHaveLength(3);
    expect(Math.max(...tone.state.offlineCalls)).toBeLessThan(16);
  });

  it('applies the production Texture compensation to every exported chord tone', async () => {
    tone.state.attacks.length = 0; tone.state.distortions.length = 0; tone.state.gains.length = 0;
    const session = createSession(); session.sound.texture = 1;
    session.loop = { ...session.loop, bars: 1, blocks: [session.loop.blocks[0]] };
    await renderWav(session);
    expect(tone.state.attacks).toHaveLength(3);
    expect(tone.state.distortions).toHaveLength(3);
    expect(tone.state.gains).toContain(patchFor(session.voice, session.sound).textureGain);
  });
});


describe('arp export and scheduler cooperation', () => {
  it('uses the shared short release for arp pitches, preserves Bass release and Gate', async () => {
    tone.state.attacks.length = 0; tone.state.synthOptions.length = 0; tone.state.distortions.length = 0;
    const session = createSession(); session.bass = true; session.sound.reverbAmount = 0;
    session.arp = { ...session.arp, mode: 'arp', division: 32, gate: .1, steps: [0,0,0,0,0,0,0,0] };
    session.loop = { ...session.loop, bars: 1, blocks: [session.loop.blocks[0]] };
    const patch = patchFor(session.voice, session.sound);
    await renderWav(session);
    const releases = tone.state.synthOptions.map(option => (option as { envelope: { release: number } }).envelope.release);
    expect(tone.state.distortions).toHaveLength(3);
    expect(releases.filter(release => release === patch.envelope.release)).toHaveLength(1);
    expect(releases.filter(release => release === arpReleaseSeconds(patch.envelope.release, session.arp, 100))).toHaveLength(32);
    expect(tone.state.attacks.filter(attack => attack[1] < 1).every(attack => Math.abs(attack[1] - .0075) < .000001)).toBe(true);
  });

  it('yields during expensive graph preparation before all attacks are constructed', async () => {
    tone.state.attacks.length = 0;
    let work = 0, observed = -1;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => work);
    tone.state.onConstruct = () => { work += 5; };
    const session = createSession(); session.sound.reverbAmount = 0;
    session.loop = { ...session.loop, bars: 1, blocks: [session.loop.blocks[0]] };
    const heartbeat = setTimeout(() => { observed = tone.state.attacks.length; }, 0);
    try {
      await renderWav(session);
      expect(observed).toBeGreaterThan(0);
      expect(observed).toBeLessThan(3);
    } finally { clearTimeout(heartbeat); clock.mockRestore(); tone.state.onConstruct = undefined; }
  });
});
