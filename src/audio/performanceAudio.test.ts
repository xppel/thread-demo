// Focused lifecycle regression tests for PerformanceAudio.

import { afterEach, describe, expect, it, vi } from 'vitest';

const tone = vi.hoisted(() => {
  const state: {
    synths: Synth[];
    filters: Filter[];
    effects: Reverb[];
    gainNodes: Gain[];
    start: () => Promise<void>;
    suspend?: () => Promise<void>;
    contexts: Context[];
    curveUpdates: number[];
    onConstruct?: () => void;
    effectReady?: () => Promise<void>;
  } = { synths: [], filters: [], effects: [], gainNodes: [], start: async () => undefined, contexts: [], curveUpdates: [] };
  class Signal { rampTo = vi.fn(); setValueAtTime = vi.fn(); cancelScheduledValues = vi.fn(); }
  class Node { connect<T>(_destination: T): this { return this; } disconnect(): this { return this; } toDestination(): this { return this; } dispose = vi.fn(); }
  class Gain extends Node { gain = new Signal(); constructor(public readonly amount: number) { super(); state.gainNodes.push(this); } }
  class Limiter extends Node { constructor(public readonly threshold: number) { super(); } }
  class Filter extends Node { frequency = new Signal(); Q = Object.assign(new Signal(), { value: 1 }); constructor(public readonly cutoff: number | { frequency: number; Q?: number; type: string }, public readonly type?: string) { super(); if (typeof cutoff === 'object') this.Q.value = cutoff.Q ?? 1; state.filters.push(this); } }
  class Waveform extends Node { getValue = vi.fn(() => new Float32Array(256)); constructor(public readonly size: number) { super(); } }
  class Effect extends Node { wet = { value: 0, rampTo: vi.fn() }; disconnect() { return this; } }
  class Reverb extends Effect { ready: Promise<void>; constructor() { super(); this.ready = state.effectReady?.() ?? Promise.resolve(); state.effects.push(this); } }
  class Context {
    state = 'running';
    sampleRate = 48000;
    immediate = () => tone.immediate();
    events = new Map<string, () => void>();
    on(name: string, callback: () => void) { this.events.set(name, callback); }
    off(name: string, callback: () => void) { if (this.events.get(name) === callback) this.events.delete(name); }
    rawContext = { state: 'running', createMediaStreamDestination: vi.fn(), suspend: vi.fn(async () => { await state.suspend?.(); this.state = 'suspended'; }) };
    resume = vi.fn(async () => { await state.start(); this.state = 'running'; });
    dispose = vi.fn(() => { this.state = 'closed'; });
    constructor(public readonly options: unknown) { state.contexts.push(this); Object.defineProperty(this.rawContext, 'state', { get: () => this.state }); }
  }
  class Distortion extends Node {
    private drive = 0;
    constructor(options?: { distortion: number }) { super(); this.drive = options?.distortion ?? 0; }
    get distortion() { return this.drive; }
    set distortion(value: number) { this.drive = value; state.curveUpdates.push(value); }
    wet = Object.assign(new Signal(), { value: 0 });
  }
  class Synth extends Node {
    volume = new Signal();
    frequency = new Signal();
    triggerAttack = vi.fn();
    triggerAttackRelease = vi.fn();
    triggerRelease = vi.fn();
    envelope = { cancel: vi.fn(), triggerRelease: vi.fn(), getValueAtTime: vi.fn(() => 0), release: 0 };
    oscillator = { start: vi.fn(), restart: vi.fn(), state: 'stopped' };
    set = vi.fn();
    constructor(public readonly options: unknown) { super(); state.synths.push(this); state.onConstruct?.(); }
  }
  return { state, start: vi.fn(() => state.start()), getContext: vi.fn(() => ({ state: 'running' })), setContext: vi.fn(), Context, immediate: vi.fn(() => 0), Frequency: vi.fn((midi: number) => ({ toFrequency: () => midi })), Gain, Limiter, Filter, Synth, Waveform, Reverb, Distortion };
});

vi.mock('tone', () => tone);

import { PerformanceAudio } from './performanceAudio';
import { arpReleaseSeconds, patchFor } from './patches';
import { DEFAULT_ARP, DEFAULT_SOUND } from '../state/session';

function owned(engine: PerformanceAudio) {
  return engine as unknown as { voices: Set<unknown>; idleVoices: { chords: unknown[]; bass: unknown[] }; deadlineMisses: number };
}

async function flush(): Promise<void> { for (let index = 0; index < 8; index++) await Promise.resolve(); }

afterEach(() => {
  tone.state.synths.length = 0;
  tone.state.filters.length = 0;
  tone.state.effects.length = 0;
  tone.state.gainNodes.length = 0;
  tone.state.start = async () => undefined;
  tone.state.onConstruct = undefined;
  tone.state.effectReady = undefined;
  tone.state.suspend = undefined;
  tone.state.contexts.length = 0;
  tone.state.curveUpdates.length = 0;
  vi.useRealTimers();
  tone.immediate.mockReturnValue(0);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('PerformanceAudio lifecycle', () => {
  it('does not create an audio context when disposed before the first gesture', () => {
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, decay: .5, reverbAmount: 0 });
    engine.dispose();
    expect(tone.immediate).not.toHaveBeenCalled();
    expect(tone.getContext).not.toHaveBeenCalled();
    expect(tone.state.contexts).toHaveLength(0);
  });

  it('closes its owned context when unmounted, including a pending unlock', async () => {
    let resume!: () => void;
    tone.state.start = () => new Promise<void>(resolve => { resume = resolve; });
    const engine = new PerformanceAudio(vi.fn());
    engine.attackBatch([{ id: 'bass:pad', midi: 36, velocity: .58, part: 'bass' }]);
    const context = tone.state.contexts[0];
    engine.dispose();
    expect(context.dispose).toHaveBeenCalledOnce();
    resume(); await flush();
    expect(tone.state.synths).toHaveLength(0);
    engine.dispose();
    expect(context.dispose).toHaveBeenCalledOnce();
  });

  it('keeps a replaced bass voice until its scheduled release and tail finish', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.attackBatch([{ id: 'bass:pad', midi: 36, velocity: .58, part: 'bass' }]); await flush();
    tone.immediate.mockReturnValue(.02);
    tone.state.onConstruct = () => tone.immediate.mockReturnValue(.22);
    engine.attackBatch([{ id: 'bass:pad', midi: 38, velocity: .58, part: 'bass' }]);
    const releaseAt = tone.state.synths[0].triggerRelease.mock.calls[0][0];
    const release = patchFor('Felt', DEFAULT_SOUND).envelope.release;
    const remaining = (releaseAt - tone.immediate() + release + .1) * 1000;
    tone.immediate.mockReturnValue(releaseAt + release + .099);
    vi.advanceTimersByTime(remaining - 1);
    expect(tone.state.synths[0].dispose).not.toHaveBeenCalled();
    tone.immediate.mockReturnValue(releaseAt + release + .101);
    vi.advanceTimersByTime(2);
    expect(owned(engine).idleVoices.bass).toHaveLength(1);
    expect(owned(engine).voices.size).toBe(1);
    engine.dispose();
  });

  it('plays dry and warm pad notes without preparing reverb or resuming the context again', async () => {
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, decay: .5, reverbAmount: 0 });
    engine.attackBatch([{ id: 'pad:0', midi: 60, velocity: .8, part: 'chords' }]);
    await flush();
    expect(tone.state.synths).toHaveLength(1);
    expect(tone.state.effects).toHaveLength(0);
    expect(tone.state.contexts[0].resume).toHaveBeenCalledTimes(1);
    expect(tone.setContext).toHaveBeenCalledTimes(1);
    expect(tone.setContext.mock.invocationCallOrder[0]).toBeLessThan(tone.state.contexts[0].resume.mock.invocationCallOrder[0]);
    engine.attackBatch([{ id: 'pad:1', midi: 64, velocity: .8, part: 'chords' }]);
    expect(tone.state.synths).toHaveLength(2);
    expect(tone.state.contexts[0].resume).toHaveBeenCalledTimes(1);
    expect(tone.setContext).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it('does not rebuild distortion curves for unrelated sound controls', async () => {
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.attackBatch([{ id: 'bass:pad', midi: 36, velocity: .58, part: 'bass' }]); await flush();
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0, masterVolume: .5 });
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0, color: .7 });
    expect(tone.state.curveUpdates).toEqual([]);
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0, texture: .7 });
    expect(tone.state.curveUpdates).toHaveLength(1);
    engine.dispose();
  });

  it('lets a sounding bass fade before background disposal and suspension', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.attackBatch([{ id: 'bass:pad', midi: 36, velocity: .58, part: 'bass' }]); await flush();
    tone.immediate.mockReturnValue(.01);
    engine.setPageActive(false); await flush();
    expect(tone.state.synths[0].dispose).not.toHaveBeenCalled();
    expect(tone.state.contexts[0].rawContext.suspend).not.toHaveBeenCalled();
    tone.immediate.mockReturnValue(.08); vi.advanceTimersByTime(70); await flush();
    expect(tone.state.synths[0].dispose).toHaveBeenCalledOnce();
    expect(tone.state.contexts[0].rawContext.suspend).toHaveBeenCalledOnce();
    engine.dispose();
  });

  it('clears stale voices and inputs after an unexpected foreground context interruption', async () => {
    const error = vi.fn(), pause = vi.fn();
    const engine = new PerformanceAudio(error, pause);
    engine.attackBatch([{ id: 'bass:pad', midi: 36, velocity: .58, part: 'bass' }]); await flush();
    const context = tone.state.contexts[0];
    context.state = 'interrupted'; context.events.get('statechange')?.();
    expect(pause).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('Sound was interrupted. Play again to resume.');
    expect(tone.state.synths[0].dispose).toHaveBeenCalledOnce();
    engine.attackBatch([{ id: 'bass:next', midi: 38, velocity: .58, part: 'bass' }]); await flush();
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(tone.state.synths[1].triggerAttack).toHaveBeenCalledOnce();
    engine.dispose();
    expect(context.events.size).toBe(0);
  });

  it('schedules a wet impulse after the first dry attack', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, decay: .5, reverbAmount: 0 });
    engine.setSound({ attack: .25, decay: .5, color: .5, texture: .5, reverbAmount: .6, reverbTime: .9, masterVolume: .7 });
    engine.attackBatch([{ id: 'pad:0', midi: 60, velocity: .8, part: 'chords' }]);
    await flush();
    expect(tone.state.synths).toHaveLength(1);
    expect(tone.state.effects).toHaveLength(0);
    vi.advanceTimersByTime(0);
    expect(tone.state.effects).toHaveLength(1);
    engine.dispose();
  });
  it('keeps an old same-ID release from disposing its retriggered replacement', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, decay: .5, reverbAmount: 0 });
    engine.attackBatch([{ id: 'pad:0', midi: 60, velocity: 0.8, part: 'chords' }]);
    await flush();
    tone.immediate.mockReturnValue(tone.immediate() + .01);
    engine.release('pad:0');
    engine.attackBatch([{ id: 'pad:0', midi: 64, velocity: 0.8, part: 'chords' }]);
    await flush();

    expect(tone.state.synths).toHaveLength(2);
    tone.immediate.mockReturnValue(tone.immediate() + .332); vi.advanceTimersByTime(332);
    expect(owned(engine).voices.size).toBe(1);
    expect(owned(engine).idleVoices.chords).toHaveLength(1);
    expect(tone.state.synths[1].dispose).not.toHaveBeenCalled();

    tone.immediate.mockReturnValue(tone.immediate() + .01);
    engine.release('pad:0');
    tone.immediate.mockReturnValue(tone.immediate() + .332); vi.advanceTimersByTime(332);
    expect(owned(engine).voices.size).toBe(0);
    expect(owned(engine).idleVoices.chords).toHaveLength(2);
    engine.dispose();
    expect(tone.state.synths.every(synth => synth.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('keeps the creating voice release when the preset changes during that tail', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, decay: .5, reverbAmount: 0 });
    engine.setVoice('Glass');
    engine.attackBatch([{ id: 'pad:1', midi: 67, velocity: 0.6, part: 'chords' }]);
    await flush();
    tone.immediate.mockReturnValue(.01);
    engine.release('pad:1');
    engine.setVoice('Felt');

    tone.immediate.mockReturnValue(.331); vi.advanceTimersByTime(321);
    expect(tone.state.synths[0].dispose).not.toHaveBeenCalled();
    tone.immediate.mockReturnValue(.851); vi.advanceTimersByTime(520);
    expect(owned(engine).voices.size).toBe(0);
    expect(owned(engine).idleVoices.chords).toHaveLength(1);
    engine.dispose();
  });

  it('ramps the independent Texture gain and retains it only in a retired slot', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, decay: .5, reverbAmount: 0 });
    engine.attackBatch([{ id: 'pad:0', midi: 60, velocity: 0.8, part: 'chords' }]);
    await flush();
    const initialPatch = patchFor('Felt', DEFAULT_SOUND);
    const compensation = tone.state.gainNodes.find(node => node.amount === initialPatch.textureGain);
    expect(compensation).toBeDefined();
    expect(compensation?.amount).toBeLessThan(1);

    const nextSound = { ...DEFAULT_SOUND, texture: .75 };
    engine.setSound(nextSound);
    expect(compensation?.gain.rampTo).toHaveBeenCalledWith(patchFor('Felt', nextSound).textureGain, .025, 0);

    tone.immediate.mockReturnValue(tone.immediate() + .01);
    engine.release('pad:0');
    tone.immediate.mockReturnValue(.41); vi.advanceTimersByTime(400);
    expect(owned(engine).voices.size).toBe(0);
    expect(compensation?.dispose).not.toHaveBeenCalled();
    engine.dispose();
    expect(compensation?.dispose).toHaveBeenCalledOnce();
  });

  it('cancels an attack released before audio unlock and fades/disposes a stopped voice', async () => {
    vi.useFakeTimers();
    let resolveStart: (() => void) | undefined;
    tone.state.start = () => new Promise<void>((resolve) => { resolveStart = resolve; });
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, decay: .5, reverbAmount: 0 });
    engine.attackBatch([{ id: 'pad:2', midi: 72, velocity: 0.7, part: 'chords' }]);
    engine.release('pad:2');
    resolveStart?.();
    await flush();
    expect(tone.state.synths).toHaveLength(0);

    tone.state.start = async () => undefined;
    engine.attackBatch([{ id: 'pad:3', midi: 60, velocity: 0.7, part: 'chords' }]);
    await flush();
    tone.immediate.mockReturnValue(.01);
    engine.stop();
    tone.immediate.mockReturnValue(.071); vi.advanceTimersByTime(61);
    expect(tone.state.synths[0].triggerRelease).toHaveBeenCalled();
    expect(tone.state.synths[0].volume.rampTo).toHaveBeenCalledWith(-96, 0.04, .01);
    expect(tone.state.synths[0].dispose).toHaveBeenCalledOnce();
  });

  it('starts a late-enabled metronome at the current beat instead of replaying missed beats', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, decay: .5, reverbAmount: 0 });
    await engine.unlock();
    engine.startMetronome(120, 0);

    expect(tone.state.synths).toHaveLength(1);
    expect(tone.state.synths[0].triggerAttackRelease).toHaveBeenCalledWith(950, 0.03, 0, 0.5);
    engine.stop();
  });

  it('defers reverb preparation during a gesture and retires the previous wet response after crossfade', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, decay: .5, reverbAmount: 0 });
    await engine.unlock(); await flush();
    expect(tone.state.effects).toHaveLength(0);
    engine.setSound({ attack: .25, decay: .5, color: .5, texture: .5, reverbAmount: .6, reverbTime: .45, masterVolume: .7 });
    vi.advanceTimersByTime(0); await flush();
    expect(tone.state.effects).toHaveLength(1);
    const first = tone.state.effects[0];
    engine.setSound({ attack: .25, decay: .5, color: .5, texture: .5, reverbAmount: .6, reverbTime: .9, masterVolume: .7 }, true);
    expect(tone.state.effects).toHaveLength(1);
    engine.commitReverbTime(); await flush();
    expect(tone.state.effects).toHaveLength(2);
    expect(first.dispose).not.toHaveBeenCalled();
    tone.immediate.mockReturnValue(.36); vi.advanceTimersByTime(350);
    expect(first.dispose).toHaveBeenCalledOnce();
    engine.dispose();
  });
});

describe('audio-clock scheduling regressions', () => {
  it('shares cold unlock across every chord pitch and bass, including cancellation', async () => {
    let resume!: () => void;
    tone.state.start = () => new Promise<void>(resolve => { resume = resolve; });
    const engine = new PerformanceAudio(vi.fn());
    engine.attackBatch([{ id: 'bass:pad', midi: 36, velocity: .58, part: 'bass' }]);
    for (const pitch of [60, 64, 67]) engine.attackBatch([{ id: `pad:${pitch}`, midi: pitch, velocity: .68, part: 'chords' }]);
    expect(tone.state.contexts[0].resume).toHaveBeenCalledOnce();
    resume(); await flush();
    expect(tone.state.synths.map(synth => synth.triggerAttack.mock.calls[0][0])).toEqual([36,60,64,67]);
    engine.dispose();
  });

  it('chooses a valid attack deadline after expensive voice construction', async () => {
    let now = 0;
    tone.immediate.mockImplementation(() => now);
    tone.state.onConstruct = () => { now += .02; };
    const engine = new PerformanceAudio(vi.fn());
    engine.attackBatch([{ id: 'bass:pad', midi: 36, velocity: .58, part: 'bass' }]);
    engine.attackBatch([{ id: 'pad:60', midi: 60, velocity: .68, part: 'chords' }]);
    await flush();
    const attacks = tone.state.synths.map(synth => synth.triggerAttack.mock.calls[0][1]);
    expect(attacks[0]).toBeCloseTo(.02 + 256 / 48000, 8);
    expect(attacks[1]).toBeCloseTo(.04 + 256 / 48000, 8);
    engine.dispose();
  });

  it('starts the playback clock on the actual first bass attack after graph allocation', async () => {
    let now = 0;
    tone.immediate.mockImplementation(() => now);
    tone.state.onConstruct = () => { now += .02; };
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    await engine.loop([
      { id: 1, midi: 36, tick: 0, durationTicks: 480, velocity: .58, part: 'bass' },
    ], 1920, 120, vi.fn(), vi.fn());
    const attack = tone.state.synths[0].triggerAttack.mock.calls[0][1];
    expect(engine.playbackClock()!.origin).toBe(attack);
    expect(engine.playbackClock()!.tick).toBe(0);
    // The attack itself is unchanged; allocation is not followed by extra padding.
    expect(attack).toBe(.03);
    engine.dispose();
  });

  it('queues short loop notes across delayed pump ticks and loop wraps exactly once', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    const note = { id: 1, midi: 60, tick: 40, durationTicks: 4, velocity: .68, part: 'chords' as const };
    await engine.loop([note], 160, 200, vi.fn(), vi.fn());
    const queued = tone.state.synths.length;
    expect(queued).toBeGreaterThan(1);
    expect(tone.state.synths[0].triggerAttack).toHaveBeenCalledWith(60,.025,.68);
    expect(tone.state.synths[0].triggerRelease).toHaveBeenCalledWith(.0275);
    tone.immediate.mockReturnValue(.04); vi.advanceTimersByTime(16);
    expect(tone.state.synths).toHaveLength(queued);
    tone.immediate.mockReturnValue(.09); vi.advanceTimersByTime(16);
    const starts = tone.state.synths.map(voice => voice.triggerAttack.mock.calls[0][1]);
    expect(new Set(starts).size).toBe(starts.length);
    expect(tone.state.synths[1].triggerAttack.mock.calls[0][1]).toBeCloseTo(.125);
    engine.stop();
    expect(tone.state.synths[1].dispose).toHaveBeenCalledOnce(); // queued future wrap cancelled
    engine.dispose();
  });

  it('extends a sounding clip without retriggering and cancels removed future notes', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    const chord = { id: 1, midi: 60, tick: 0, durationTicks: 480, velocity: .68, part: 'chords' as const };
    const future = { ...chord, id: 2, midi: 67, tick: 100, durationTicks: 4 };
    await engine.loop([chord,future],1920,200,vi.fn(),vi.fn());
    expect(tone.state.synths).toHaveLength(2);
    tone.immediate.mockReturnValue(.02);
    engine.updateLoop([{ ...chord, durationTicks: 960 }],1920,200);
    expect(tone.state.synths).toHaveLength(2);
    expect(tone.state.synths[0].triggerAttack).toHaveBeenCalledOnce();
    expect(tone.state.synths[0].envelope.cancel).toHaveBeenCalledWith(.31);
    expect(tone.state.synths[0].oscillator.restart).toHaveBeenCalledWith(.02);
    expect(tone.state.synths[0].triggerRelease).toHaveBeenLastCalledWith(.61);
    expect(tone.state.synths[1].dispose).toHaveBeenCalledOnce();
    engine.dispose();
  });

  it('starts the default wet patch dry first, then connects a ready reverb', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.attackBatch([{ id: 'pad:60', midi: 60, velocity: .68, part: 'chords' }]); await flush();
    expect(tone.state.synths).toHaveLength(1);
    expect(tone.state.effects).toHaveLength(0);
    vi.advanceTimersByTime(0); await flush();
    expect(tone.state.effects).toHaveLength(1);
    engine.dispose();
  });
});

describe('foreground scheduler stalls', () => {
  it('queues every short held-arp step across a delayed foreground refill', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.startHeldArp('pad', [60], {
      ...DEFAULT_ARP, mode: 'arp', division: 32, triplet: true,
      gate: .1, steps: [0, 0, 0, 0, 0, 0, 0, 0],
    }, 200, vi.fn());
    await flush();
    const queuedBeforeStall = tone.state.synths.map(voice => voice.triggerAttackRelease.mock.calls[0][2]);
    // The audio clock keeps running while Safari delays the JS refill.
    for (let step = 0; step < 8; step++) {
      expect(queuedBeforeStall.some(time => Math.abs(time - (.01 + step * .025)) < .00001)).toBe(true);
    }
    tone.immediate.mockReturnValue(.205); vi.advanceTimersByTime(8);
    const attacks = tone.state.synths.map(voice => voice.triggerAttackRelease.mock.calls[0][2]);
    expect(new Set(attacks).size).toBe(attacks.length);
    engine.dispose();
  });

  it('skips uncovered expired attacks without stopping covered voices or bursting late notes', async () => {
    vi.useFakeTimers();
    const error = vi.fn(), pause = vi.fn();
    const engine = new PerformanceAudio(error, pause);
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.startHeldArp('pad', [60], { ...DEFAULT_ARP, mode: 'arp' }, 120, vi.fn());
    await flush();
    const count = tone.state.synths.length;
    tone.immediate.mockReturnValue(.4); vi.advanceTimersByTime(8);
    const future = tone.state.synths.slice(count).flatMap(voice => voice.triggerAttackRelease.mock.calls);
    expect(future.length).toBeGreaterThan(0);
    expect(future.every(call => call[2] >= .4)).toBe(true);
    expect(owned(engine).deadlineMisses).toBeGreaterThan(0);
    expect(pause).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    expect(tone.state.synths.every(voice => voice.triggerRelease.mock.calls.length === 0)).toBe(true);
    engine.dispose();
  });

  it('queues short sequence notes and bass on the same grid across a delayed refill', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const notes = Array.from({ length: 8 }, (_, step) => ({
      id: step, midi: step === 0 ? 36 : 60, tick: step * 40,
      durationTicks: 4, velocity: .68, part: step === 0 ? 'bass' as const : 'chords' as const,
    }));
    await engine.loop(notes, 1920, 200, vi.fn(), vi.fn());
    const queuedBeforeStall = tone.state.synths.map(voice => voice.triggerAttack.mock.calls[0][1]);
    for (let step = 1; step < 8; step++) expect(queuedBeforeStall.some(time => Math.abs(time - (.01 + step * .025)) < .00001)).toBe(true);
    tone.immediate.mockReturnValue(.205); vi.advanceTimersByTime(8);
    expect(tone.state.synths).toHaveLength(8);
    engine.dispose();
  });
});

describe('held arpeggio audio deadlines', () => {
  it('uses unique event IDs, fills lookahead, preserves the sounding note and phase on edits', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const settings = { ...DEFAULT_ARP, mode: 'arp' as const, division: 32 as const, triplet: true, steps: [0, 1, 2, 3, 4, 5, 6, 7], gate: .5 };
    engine.startHeldArp('key:Digit1', [60, 64, 67], settings, 200, vi.fn()); await flush();
    expect(tone.state.synths.length).toBeGreaterThan(2);
    const first = tone.state.synths[0], attack = first.triggerAttackRelease.mock.calls[0];
    expect(attack[1]).toBeCloseTo(.0125); expect(attack[2]).toBeGreaterThan(0);
    tone.immediate.mockReturnValue(.01);
    engine.updateHeldArp('key:Digit1', [60, 64, 67], { ...settings, gate: 1, reverse: true }, 200);
    expect(first.triggerAttackRelease).toHaveBeenCalledTimes(1); expect(first.triggerRelease).not.toHaveBeenCalled();
    expect(tone.state.synths[1].dispose).not.toHaveBeenCalled();
    const live = engine as unknown as { heldArps: Map<string, { events: { step: number; start: number; live?: { id: string } }[] }> };
    const events = live.heldArps.get('key:Digit1')!.events;
    expect(events.slice(0, 4).map(e => e.step)).toEqual([0, 1, 2, 3]);
    expect(new Set(events.map(e => e.live?.id)).size).toBe(events.length);
    expect(events[1].start).toBeCloseTo(.035);
    engine.stopHeldArp('key:Digit1'); tone.immediate.mockReturnValue(2); vi.advanceTimersByTime(2000);
    expect(first.dispose).toHaveBeenCalledOnce();
    engine.dispose();
    expect(tone.state.synths.every(synth => synth.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('changes rate at the next boundary, keeps rests and consecutive equal pitches independent', async () => {
    vi.useFakeTimers(); const cells = vi.fn();
    const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const settings = { ...DEFAULT_ARP, mode: 'arp' as const, steps: [0, null, 0, 0, 0, 0, 0, 0], gate: 1 };
    engine.startHeldArp('pad', [60, 64, 67], settings, 120, cells); await flush();
    tone.immediate.mockReturnValue(.02); engine.updateHeldArp('pad', [60, 64, 67], { ...settings, division: 32 }, 120);
    tone.immediate.mockReturnValue(.06); vi.advanceTimersByTime(8);
    const state = engine as unknown as { heldArps: Map<string, { events: { step: number; start: number; next: number; resolved: unknown }[] }> };
    expect(state.heldArps.get('pad')!.events[1]).toMatchObject({ step: 1, resolved: null });
    expect(state.heldArps.get('pad')!.events[1].start).toBeCloseTo(.135);
    expect(state.heldArps.get('pad')!.events[1].next).toBeCloseTo(.1975);
    tone.immediate.mockReturnValue(.15); vi.advanceTimersByTime(8);
    expect(cells.mock.calls.at(-1)?.[0]).toBeNull();
    tone.immediate.mockReturnValue(.22); vi.advanceTimersByTime(8);
    expect(tone.state.synths[0].triggerRelease).not.toHaveBeenCalled(); engine.dispose();
  });

  it('cancels held arp unlock, future attacks and painting on stop', async () => {
    let ready: (() => void) | undefined; tone.state.start = () => new Promise<void>(resolve => { ready = resolve; });
    const engine = new PerformanceAudio(vi.fn()); const paint = vi.fn();
    engine.startHeldArp('pad', [60, 64, 67], DEFAULT_ARP, 120, paint); engine.stopHeldArp('pad'); ready?.(); await flush();
    expect(tone.state.synths).toHaveLength(0); expect(paint).toHaveBeenLastCalledWith(null); engine.dispose();
  });
});

it('recording override cancels backing including queued attacks and preserves the playhead', async () => {
  vi.useFakeTimers(); const engine = new PerformanceAudio(vi.fn());
  engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  await engine.loop([
    { id: 1, midi: 60, tick: 0, durationTicks: 480, velocity: .7, part: 'chords' },
    { id: 2, midi: 40, tick: 0, durationTicks: 480, velocity: .7, part: 'bass' },
    { id: 4, midi: 62, tick: 60, durationTicks: 60, velocity: .7, part: 'chords' },
  ], 1920, 120, vi.fn(), vi.fn());
  tone.immediate.mockReturnValue(.02); const before = engine.playbackClock()!;
  engine.setRecordingOverride(true);
  expect(tone.state.synths[0].volume.rampTo).toHaveBeenCalledWith(-96, .04, .02);
  expect(tone.state.synths[2].dispose).toHaveBeenCalledOnce();
  const count = tone.state.synths.length;
  tone.immediate.mockReturnValue(.1); vi.advanceTimersByTime(8); expect(tone.state.synths.length).toBe(count);
  engine.setRecordingOverride(false); expect(tone.state.synths.length).toBeGreaterThan(count);
  expect(engine.playbackClock()!.origin).toBe(before.origin); expect(engine.playbackClock()!.tick).toBeCloseTo((.1 - before.origin) * 960);
  engine.dispose();
});

describe('background audio ownership', () => {
  it('does not create a context or attack while hidden before the first gesture', async () => {
    const engine = new PerformanceAudio(vi.fn());
    engine.setPageActive(false);
    engine.attackBatch([{ id: 'pad:0', midi: 60, velocity: .8, part: 'chords' }]);
    engine.startHeldArp('arp', [60], { ...DEFAULT_ARP, mode: 'arp' }, 120, vi.fn());
    await flush();
    expect(tone.state.contexts).toHaveLength(0);
    engine.setPageActive(true); await flush();
    expect(tone.state.contexts).toHaveLength(0);
    engine.attackBatch([{ id: 'pad:1', midi: 64, velocity: .8, part: 'chords' }]); await flush();
    expect(tone.state.synths).toHaveLength(1);
    engine.dispose();
  });

  it('suspends its owned context, cancels voices and waits for a playing gesture on return', async () => {
    const engine = new PerformanceAudio(vi.fn());
    engine.attackBatch([{ id: 'pad:0', midi: 60, velocity: .8, part: 'chords' }]); await flush();
    const context = tone.state.contexts[0];
    engine.setPageActive(false); await flush();
    expect(context.state).toBe('suspended');
    expect(tone.state.synths[0].dispose).toHaveBeenCalledOnce();
    engine.setPageActive(true); await flush();
    expect(context.resume).toHaveBeenCalledOnce();
    engine.attackBatch([{ id: 'pad:1', midi: 64, velocity: .8, part: 'chords' }]); await flush();
    expect(context.state).toBe('running');
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(tone.state.contexts).toHaveLength(1);
    engine.dispose();
  });

  it.each(['attack', 'arp', 'loop'] as const)('cancels a cold %s when hidden during a pending resume', async kind => {
    let resume!: () => void;
    tone.state.start = () => new Promise<void>(resolve => { resume = resolve; });
    const engine = new PerformanceAudio(vi.fn());
    const position = vi.fn();
    let looping: Promise<void> | undefined;
    if (kind === 'attack') engine.attackBatch([{ id: 'pad:0', midi: 60, velocity: .8, part: 'chords' }]);
    if (kind === 'arp') engine.startHeldArp('arp', [60], { ...DEFAULT_ARP, mode: 'arp' }, 120, vi.fn());
    if (kind === 'loop') looping = engine.loop([], 384, 120, position, vi.fn(), 0, true);
    engine.setPageActive(false);
    resume(); await looping; await flush();
    expect(tone.state.synths).toHaveLength(0);
    expect(position).not.toHaveBeenCalled();
    expect(tone.state.contexts[0].state).toBe('suspended');
    engine.dispose();
  });

  it('finishes pending suspension before resuming and honors release during the wait', async () => {
    let suspended!: () => void;
    const engine = new PerformanceAudio(vi.fn());
    engine.attackBatch([{ id: 'pad:0', midi: 60, velocity: .8, part: 'chords' }]); await flush();
    tone.state.suspend = () => new Promise<void>(resolve => { suspended = resolve; });
    engine.setPageActive(false);
    engine.setPageActive(true);
    engine.attackBatch([{ id: 'pad:1', midi: 64, velocity: .8, part: 'chords' }]);
    engine.release('pad:1');
    expect(tone.state.contexts[0].resume).toHaveBeenCalledOnce();
    suspended(); await flush();
    expect(tone.state.contexts[0].resume).toHaveBeenCalledTimes(2);
    expect(tone.state.contexts[0].state).toBe('running');
    expect(tone.state.synths).toHaveLength(1);
    engine.dispose();
  });

  it('cannot revive a disposed engine after pending suspension', async () => {
    let suspended!: () => void;
    const engine = new PerformanceAudio(vi.fn());
    await engine.unlock();
    tone.state.suspend = () => new Promise<void>(resolve => { suspended = resolve; });
    engine.setPageActive(false); engine.setPageActive(true);
    engine.attackBatch([{ id: 'pad:0', midi: 60, velocity: .8, part: 'chords' }]); engine.dispose();
    suspended(); await flush();
    expect(tone.state.contexts[0].resume).toHaveBeenCalledOnce();
    expect(tone.state.synths).toHaveLength(0);
  });
});

// These reproduce cleanup and allocation defects without recording audio.
describe('owned clock and batch deadlines', () => {
  it('keeps a queued short note until its audio deadline even if wall time runs ahead', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.startHeldArp('pad', [60], { ...DEFAULT_ARP, mode: 'arp', gate: .1875, steps: [0,null,null,null,null,null,null,null] }, 100, vi.fn());
    await flush();
    // Isolate cleanup wake-ups from foreground refill interruption handling.
    clearInterval((engine as unknown as { heldArpTimer: ReturnType<typeof setInterval> }).heldArpTimer);
    vi.advanceTimersByTime(2000);
    expect(tone.state.synths[0].dispose).not.toHaveBeenCalled();
    tone.immediate.mockReturnValue(3); vi.advanceTimersByTime(1000);
    expect(owned(engine).voices.size).toBe(0);
    expect(owned(engine).idleVoices.chords).toHaveLength(1);
    engine.dispose();
  });

  it('submits simultaneous loop bass and chord attacks after the entire batch is built', async () => {
    let now = 0;
    tone.immediate.mockImplementation(() => now);
    tone.state.onConstruct = () => { now += .02; };
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    await engine.loop([36,60,64,67].map((pitch, id) => ({ id, midi: pitch, tick: 0, durationTicks: 480, velocity: .68, part: id ? 'chords' as const : 'bass' as const })), 1920, 120, vi.fn(), vi.fn());
    const attacks = tone.state.synths.map(voice => voice.triggerAttack.mock.calls[0][1]);
    expect(new Set(attacks).size).toBe(1);
    expect(attacks[0]).toBeCloseTo(.09);
    expect(engine.playbackClock()!.origin).toBeCloseTo(attacks[0]);
    engine.dispose();
  });

  it('rebuilds a closed owned context on a fresh playing gesture', async () => {
    const error = vi.fn();
    const engine = new PerformanceAudio(error);
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.attackBatch([{ id: 'pad:60', midi: 60, velocity: .68, part: 'chords' }]); await flush();
    tone.state.contexts[0].state = 'closed';
    tone.state.contexts[0].events.get('statechange')?.();
    engine.attackBatch([{ id: 'pad:64', midi: 64, velocity: .68, part: 'chords' }]); await flush();
    expect(tone.state.contexts).toHaveLength(2);
    expect(tone.state.synths.at(-1)!.triggerAttack).toHaveBeenCalledWith(64, expect.any(Number), .68);
    engine.dispose();
  });
});

it('does not dispose frozen background voices or deadlock the next unlock', async () => {
  vi.useFakeTimers();
  const engine = new PerformanceAudio(vi.fn());
  engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  engine.attackBatch([{ id: 'pad:60', midi: 60, velocity: .68, part: 'chords' }]); await flush();
  tone.immediate.mockReturnValue(.01); engine.setPageActive(false); await flush();
  vi.advanceTimersByTime(1000); await flush();
  expect(tone.state.synths[0].dispose).not.toHaveBeenCalled();
  expect(tone.state.contexts[0].state).toBe('suspended');
  engine.setPageActive(true); await engine.unlock();
  tone.immediate.mockReturnValue(2); vi.advanceTimersByTime(1000);
  expect(tone.state.synths[0].dispose).toHaveBeenCalledOnce();
  engine.dispose();
});

it('starts Bass on the held chord grid even when the arp starts with a rest', async () => {
  vi.useFakeTimers();
  const engine = new PerformanceAudio(vi.fn());
  engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  engine.startHeldArp('pad', [60], { ...DEFAULT_ARP, mode: 'arp', steps: [null,0,0,0,0,0,0,0] }, 120, vi.fn(), { id: 'bass:pad', midi: 36 });
  await flush();
  expect(tone.state.synths[0].triggerAttack).toHaveBeenCalledWith(36, .01, .58);
  expect(tone.state.synths[1].triggerAttackRelease.mock.calls[0][2]).toBeCloseTo(.135);
  engine.dispose();
});

it('prepares a complete live chord and Bass before assigning their shared onset', async () => {
  let now = 0; tone.immediate.mockImplementation(() => now); tone.state.onConstruct = () => { now += .02; };
  const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  engine.attackBatch([36,60,64,67].map((midi, index) => ({ id: `live:${index}`, midi, velocity: .68, part: index ? 'chords' as const : 'bass' as const })));
  await flush(); for (const synth of tone.state.synths) expect(synth.triggerAttack.mock.calls[0][1]).toBeCloseTo(.08 + 256 / 48000, 8); engine.dispose();
});

for (const action of ['restore', 'edit'] as const) it(`prepares current backing after ${action} as one batch without moving future grid notes`, async () => {
  vi.useFakeTimers(); let now = 0;
  tone.immediate.mockImplementation(() => now);
  const error = vi.fn(), engine = new PerformanceAudio(error);
  engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  const notes = [36,60,64,67].map((midi, id) => ({ id, midi, tick: 0, durationTicks: 480, velocity: .68, part: id ? 'chords' as const : 'bass' as const }));
  await engine.loop(notes, 1920, 120, vi.fn(), vi.fn());
  const origin = engine.playbackClock()!.origin;
  now = .1; engine.setRecordingOverride(true);
  const count = tone.state.synths.length;
  tone.state.onConstruct = () => { now += .02; };
  if (action === 'edit') engine.updateLoop(notes.map(note => ({ ...note, midi: note.midi + 1 })), 1920, 120);
  engine.setRecordingOverride(false);
  expect(error).not.toHaveBeenCalled();
  const restored = tone.state.synths.slice(count);
  expect(restored.map(synth => synth.triggerAttack.mock.calls[0][1])).toEqual([.19,.19,.19,.19]);
  expect(restored.every(synth => synth.triggerRelease.mock.calls[0][0] === origin + .5)).toBe(true);
  expect(engine.playbackClock()!.origin).toBeCloseTo(origin);
  now = .3;
  engine.updateLoop([...notes, { ...notes[0], id: 9, midi: 72, tick: 480 }], 1920, 120);
  expect(tone.state.synths.at(-1)!.triggerAttack.mock.calls[0][1]).toBeCloseTo(origin + .5);
  expect(error).not.toHaveBeenCalled(); engine.dispose();
});

it('attacks an extended clip freshly when its previous release has already begun', async () => {
  vi.useFakeTimers(); const error = vi.fn(), engine = new PerformanceAudio(error);
  engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  const note = { id: 1, midi: 60, tick: 0, durationTicks: 480, velocity: .68, part: 'chords' as const };
  await engine.loop([note], 1920, 200, vi.fn(), vi.fn());
  tone.immediate.mockReturnValue(.32);
  engine.updateLoop([{ ...note, durationTicks: 960 }], 1920, 200);
  expect(tone.state.synths).toHaveLength(2);
  expect(tone.state.synths[1].triggerAttack).toHaveBeenCalledWith(60, .33, .68);
  expect(tone.state.synths[1].triggerRelease.mock.calls[0][0]).toBeCloseTo(.61);
  expect(error).not.toHaveBeenCalled(); engine.dispose();
});

it('does not revive a short backing note that expires during restoration construction', async () => {
  vi.useFakeTimers(); let now = 0; tone.immediate.mockImplementation(() => now);
  const error = vi.fn(), engine = new PerformanceAudio(error); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  const note = { id: 1, midi: 60, tick: 0, durationTicks: 48, velocity: .68, part: 'chords' as const };
  await engine.loop([note], 1920, 120, vi.fn(), vi.fn());
  now = .04; engine.setRecordingOverride(true);
  tone.state.onConstruct = () => { now += .02; }; engine.setRecordingOverride(false);
  expect(tone.state.synths[1].triggerAttack).not.toHaveBeenCalled();
  expect(tone.state.synths[1].dispose).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled(); engine.dispose();
});

it('does not allocate an ended grid note at a floating-point release boundary', async () => {
  vi.useFakeTimers(); let now = 1.8146666666666667;
  tone.immediate.mockImplementation(() => now);
  const error = vi.fn(), engine = new PerformanceAudio(error); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  await engine.loop([{ id: 1, midi: 60, tick: 240, durationTicks: 48, velocity: .68, part: 'chords' }], 1920, 120, vi.fn(), vi.fn());
  now = tone.state.synths[0].triggerRelease.mock.calls[0][0];
  tone.state.onConstruct = () => { now += .002; };
  vi.advanceTimersByTime(8);
  expect(tone.state.synths).toHaveLength(1);
  expect(error).not.toHaveBeenCalled(); engine.dispose();
});


describe('audio interruption regressions', () => {
  it('keeps queued held notes and Bass sounding across a refill delay within coverage', async () => {
    vi.useFakeTimers(); const pause = vi.fn(), error = vi.fn();
    const engine = new PerformanceAudio(error, pause);
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.startHeldArp('live', [58,62,65], { ...DEFAULT_ARP, mode: 'arp', division: 32, steps: [0,0,0,0,0,0,0,0] }, 100, vi.fn(), { id: 'bass:live', midi: 34 });
    await flush();
    tone.immediate.mockReturnValue(.31); vi.advanceTimersByTime(8);
    expect(pause).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    expect(tone.state.synths[0].triggerRelease).not.toHaveBeenCalled();
    expect(tone.state.synths.at(-1)!.triggerAttackRelease).toHaveBeenCalled();
    engine.dispose();
  });

  it('does not silence a completed attack when the submission returns after its onset', async () => {
    let now = 0; tone.immediate.mockImplementation(() => now);
    tone.state.onConstruct = () => { tone.state.synths.at(-1)!.triggerAttack.mockImplementation(() => { now += .02; }); };
    const pause = vi.fn(), error = vi.fn(), engine = new PerformanceAudio(error, pause);
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.attackBatch([{ id: 'bass:live', midi: 34, velocity: .58, part: 'bass' }]); await flush();
    expect(tone.state.synths[0].triggerAttack).toHaveBeenCalled();
    expect(tone.state.synths[0].triggerRelease).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('initializes native resonance before the first attack rather than at Tone lookahead', async () => {
    const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.attackBatch([{ id: 'live:58', midi: 58, velocity: .68, part: 'chords' }]); await flush();
    expect(tone.state.filters[0].cutoff).toMatchObject({ Q: patchFor('Felt', DEFAULT_SOUND).resonance });
    engine.dispose();
  });
});


describe('prepared voice slots', () => {
  it('reuses a completed filter/Texture graph with a fresh Synth and reserves its Bass pool', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.attackBatch([{ id: 'first', midi: 60, velocity: .68, part: 'chords' }]); await flush();
    tone.immediate.mockReturnValue(.02); engine.release('first');
    tone.immediate.mockReturnValue(1); vi.advanceTimersByTime(1000);
    expect(owned(engine).idleVoices.chords).toHaveLength(1);
    const prepared = tone.state.synths[1];
    expect(prepared.triggerAttack).not.toHaveBeenCalled();
    engine.attackBatch([{ id: 'bass:second', midi: 36, velocity: .58, part: 'bass' }]);
    expect(tone.state.synths).toHaveLength(3);
    expect(owned(engine).idleVoices.chords).toHaveLength(1);
    const chordFilter = tone.state.filters[0];
    engine.attackBatch([{ id: 'second', midi: 62, velocity: .68, part: 'chords' }]);
    expect(tone.state.synths).toHaveLength(3);
    expect(tone.state.filters).toHaveLength(2);
    expect(tone.state.synths[0].dispose).toHaveBeenCalledOnce();
    expect(chordFilter.frequency.cancelScheduledValues).toHaveBeenCalledWith(0);
    expect(chordFilter.Q.cancelScheduledValues).toHaveBeenCalledWith(0);
    expect(prepared.oscillator.start).toHaveBeenCalledOnce();
    expect(prepared.triggerAttack.mock.calls[0][0]).toBe(62);
    expect(owned(engine).idleVoices.chords).toHaveLength(0);
    engine.dispose();
  });

  it('discards silent preparation when sound changes and disposes remaining preparation on teardown', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.attackBatch([{ id: 'first', midi: 60, velocity: .68, part: 'chords' }]); await flush();
    tone.immediate.mockReturnValue(.02); engine.release('first');
    tone.immediate.mockReturnValue(1); vi.advanceTimersByTime(1000);
    const prepared = tone.state.synths[1];
    expect(prepared.triggerAttack).not.toHaveBeenCalled();
    engine.setVoice('Glass');
    expect(prepared.dispose).toHaveBeenCalledOnce();
    engine.attackBatch([{ id: 'second', midi: 64, velocity: .68, part: 'chords' }]);
    expect(tone.state.synths[2].options).toMatchObject({ oscillator: { type: 'sine' } });
    tone.immediate.mockReturnValue(1.1); engine.release('second');
    tone.immediate.mockReturnValue(3); vi.advanceTimersByTime(2000);
    const remaining = tone.state.synths.at(-1)!;
    expect(remaining.triggerAttack).not.toHaveBeenCalled();
    engine.dispose();
    expect(remaining.dispose).toHaveBeenCalledOnce();
  });

  it('never recycles a native source that is still started or has a nonzero envelope', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.attackBatch([{ id: 'active', midi: 60, velocity: .68, part: 'chords' }, { id: 'nonzero', midi: 62, velocity: .68, part: 'chords' }]); await flush();
    tone.state.synths[0].oscillator.state = 'started';
    tone.state.synths[1].envelope.getValueAtTime.mockReturnValue(.1);
    tone.immediate.mockReturnValue(.02); engine.release('active'); engine.release('nonzero');
    tone.immediate.mockReturnValue(1); vi.advanceTimersByTime(1000);
    expect(owned(engine).idleVoices.chords).toHaveLength(0);
    expect(tone.state.synths.every(synth => synth.dispose.mock.calls.length === 1)).toBe(true);
    engine.dispose();
  });

  it('caps future arp tails without changing Gate durations or owned tails', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const arp = { ...DEFAULT_ARP, mode: 'arp' as const, division: 32 as const, gate: .1 };
    engine.startHeldArp('pad', [60], arp, 100, vi.fn()); await flush();
    const first = [...owned(engine).voices][0] as { releaseSeconds: number; cleanupAt: number };
    const deadline = first.cleanupAt;
    expect(first.releaseSeconds).toBeCloseTo(.01875);
    expect(tone.state.synths[0].triggerAttackRelease.mock.calls[0][1]).toBeCloseTo(.0075);
    engine.updateHeldArp('pad', [60], { ...arp, division: 16 }, 100);
    expect(first.cleanupAt).toBe(deadline);
    expect(first.releaseSeconds).toBeCloseTo(.01875);
    engine.dispose();
    expect(arpReleaseSeconds(1, { ...arp, gate: 1 }, 200)).toBe(.003);
    expect(arpReleaseSeconds(.01, { ...arp, division: 2 }, 40)).toBe(.01);
    expect(arpReleaseSeconds(1, { ...arp, mode: 'off' }, 200)).toBe(1);
  });
});


describe('timeline startup preparation', () => {
  it('retains a short first Gate when the audio clock advances before the first pump', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const scheduler = engine as unknown as { pumpLoop: (preserve: boolean) => void };
    const pump = scheduler.pumpLoop.bind(engine);
    vi.spyOn(scheduler, 'pumpLoop').mockImplementationOnce(preserve => { tone.immediate.mockReturnValue(.006); pump(preserve); });
    await engine.loop([
      { id:0,midi:36,tick:0,durationTicks:1920,velocity:.58,part:'bass' },
      { id:1,midi:60,tick:0,durationTicks:2,velocity:.68,part:'chords' },
      { id:2,midi:64,tick:40,durationTicks:2,velocity:.68,part:'chords' },
    ],1920,200,vi.fn(),vi.fn());
    const attacks = tone.state.synths.flatMap(synth => synth.triggerAttack.mock.calls);
    const bass = attacks.find(call => call[0] === 36)!, first = attacks.find(call => call[0] === 60)!;
    expect(first, 'startup preparation must not consume the first short Gate').toBeDefined();
    expect(first[1]).toBe(bass[1]);
    expect(tone.state.synths.find(synth => synth.triggerAttack.mock.calls.some(call => call[0] === 60))!.triggerRelease.mock.calls[0][0] - first[1]).toBeCloseTo(.00125);
    expect(attacks.find(call => call[0] === 64)![1] - first[1]).toBeCloseTo(.025);
    expect(owned(engine).deadlineMisses).toBe(0);
    engine.dispose();
  });
});


describe('missed native deadlines', () => {
  it('counts one missed timeline attack once and also counts fully expired unqueued notes', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const notes = [
      { id: 1, midi: 36, tick: 480, durationTicks: 960, velocity: .58, part: 'bass' as const },
      { id: 2, midi: 60, tick: 960, durationTicks: 10, velocity: .68, part: 'chords' as const },
    ];
    await engine.loop(notes, 1920, 120, vi.fn(), vi.fn());
    tone.immediate.mockReturnValue(.6); vi.advanceTimersByTime(8);
    expect(owned(engine).deadlineMisses).toBe(1);
    vi.advanceTimersByTime(8);
    expect(owned(engine).deadlineMisses).toBe(1);
    tone.immediate.mockReturnValue(1.2); vi.advanceTimersByTime(8);
    expect(owned(engine).deadlineMisses).toBe(2);
    engine.dispose();
  });
});

describe('backing queue restoration', () => {
  it('resubmits cancelled future arp attacks after a recording override', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const notes = Array.from({ length: 8 }, (_, step) => ({ id: step, midi: 60, tick: step * 60, durationTicks: 30, velocity: .68, part: 'chords' as const }));
    await engine.loop(notes, 1920, 100, vi.fn(), vi.fn(), 0, false, { ...DEFAULT_ARP, mode: 'arp', division: 32 });
    tone.immediate.mockReturnValue(.03);
    engine.setRecordingOverride(true);
    const count = tone.state.synths.length;
    engine.setRecordingOverride(false);
    const newAttacks = tone.state.synths.slice(count).flatMap(synth => synth.triggerAttack.mock.calls);
    expect(newAttacks.some(call => Math.abs(call[1] - .085) < .00001)).toBe(true);
    expect(newAttacks.length).toBeGreaterThan(3);
    engine.dispose();
  });
});


describe('Gate edits preserve source ownership', () => {
  it('updates queued held envelopes without reconstructing sources or touching the sounding release', async () => {
    vi.useFakeTimers(); const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const arp = { ...DEFAULT_ARP, mode: 'arp' as const, division: 32 as const, gate: .5 };
    engine.startHeldArp('pad', [60,64,67], arp, 100, vi.fn(), { id: 'bass:pad', midi: 36 }); await flush();
    const queued = [...tone.state.synths], current = queued[1];
    const state = engine as unknown as { heldArps: Map<string, { events: { start: number; end: number; live?: { cleanupAt: number; releaseSeconds: number } }[] }> };
    const first = state.heldArps.get('pad')!.events[0], deadline = first.live!.cleanupAt;
    tone.immediate.mockReturnValue(first.start + .002);
    for (const gate of [.1,1,.2,.9,.4]) engine.updateHeldArp('pad', [60,64,67], { ...arp, gate }, 100);
    expect(tone.state.synths).toEqual(queued);
    expect(queued.every(synth => synth.dispose.mock.calls.length === 0)).toBe(true);
    expect(current.triggerAttackRelease).toHaveBeenCalledTimes(1);
    expect(first.live!.cleanupAt).toBe(deadline);
    expect(queued[2].triggerAttackRelease.mock.calls.at(-1)![1]).toBeCloseTo(.075 * .4);
    expect(queued[2].envelope.cancel.mock.calls.at(-1)![0]).toBeCloseTo(first.start + .075);
    expect(owned(engine).deadlineMisses).toBe(0); engine.dispose();
  });

  it('keeps timeline Gate edits on the same absolute grid and leaves current arp/Bass deadlines owned', async () => {
    vi.useFakeTimers(); const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const arp = { ...DEFAULT_ARP, mode: 'arp' as const, division: 32 as const, gate: .5 };
    const notes = (gate: number) => [
      { id: 99, midi: 36, tick: 0, durationTicks: 1920, velocity: .58, part: 'bass' as const },
      ...Array.from({ length: 32 }, (_, id) => ({ id, midi: 60, tick: id * 60, durationTicks: 60 * gate, velocity: .68, part: 'chords' as const })),
    ];
    await engine.loop(notes(.5), 1920, 100, vi.fn(), vi.fn(), 0, false, arp);
    const queued = [...tone.state.synths], current = queued.find(synth => synth.triggerAttack.mock.calls[0][0] === 60)!, bass = queued.find(synth => synth.triggerAttack.mock.calls[0][0] === 36)!, origin = engine.playbackClock()!.origin;
    tone.immediate.mockReturnValue(origin + .002);
    const currentEnd = current.triggerRelease.mock.calls[0][0];
    for (const gate of [.1,1,.2,.9,.4]) engine.updateLoop(notes(gate), 1920, 100, { ...arp, gate });
    expect(tone.state.synths).toEqual(queued);
    expect(queued.every(synth => synth.dispose.mock.calls.length === 0)).toBe(true);
    expect(current.triggerRelease.mock.calls).toEqual([[currentEnd]]);
    expect(bass.triggerRelease).toHaveBeenCalledTimes(1);
    expect(engine.playbackClock()!.origin).toBe(origin);
    const future = queued.find(synth => synth.triggerAttack.mock.calls[0][1] > origin)!;
    expect(future.triggerAttackRelease.mock.calls.at(-1)![1]).toBeCloseTo(.075 * .4);
    // A reduced canonical Gate must not truncate the still-owned attack.
    tone.immediate.mockReturnValue(origin + .02); engine.updateLoop(notes(.1), 1920, 100, { ...arp, gate: .1 }); vi.advanceTimersByTime(8);
    expect(current.triggerRelease.mock.calls).toEqual([[currentEnd]]);
    expect(owned(engine).deadlineMisses).toBe(0); engine.dispose();
  });
});


it('still edits clip duration when the arp Gate itself did not change', async () => {
  vi.useFakeTimers(); const engine = new PerformanceAudio(vi.fn());
  engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  const arp = { ...DEFAULT_ARP, mode: 'arp' as const };
  const note = { id: 0, midi: 60, tick: 0, durationTicks: 120, velocity: .68, part: 'chords' as const };
  await engine.loop([note], 1920, 100, vi.fn(), vi.fn(), 0, false, arp);
  tone.immediate.mockReturnValue(.02);
  engine.updateLoop([{ ...note, durationTicks: 240 }], 1920, 100, arp);
  expect(tone.state.synths[0].triggerRelease.mock.calls.at(-1)![0]).toBeCloseTo(.31);
  engine.dispose();
});


it('does not replay a consumed arp step after an unchanged-grid edit and Gate extension', async () => {
  vi.useFakeTimers(); const engine = new PerformanceAudio(vi.fn());
  engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  const arp = { ...DEFAULT_ARP, mode: 'arp' as const, division: 16 as const, gate: .1 };
  const notes = (gate: number) => [{ id: 0, midi: 60, tick: 0, durationTicks: 120 * gate, velocity: .68, part: 'chords' as const }];
  await engine.loop(notes(.1), 1920, 96, vi.fn(), vi.fn(), 0, false, arp);
  const origin = engine.playbackClock()!.origin;
  tone.immediate.mockReturnValue(origin + .002);
  engine.updateLoop(notes(.1), 1920, 96, arp);
  tone.immediate.mockReturnValue(origin + .03); vi.advanceTimersByTime(8);
  engine.updateLoop(notes(1), 1920, 96, { ...arp, gate: 1 });
  expect(tone.state.synths).toHaveLength(1);
  expect(owned(engine).deadlineMisses).toBe(0); engine.dispose();
});


describe('live arp pattern edits', () => {
  it('retunes only future held steps without rebuilding the queue or cancelling a near-onset attack', async () => {
    vi.useFakeTimers(); let now = 0; tone.immediate.mockImplementation(() => now);
    const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const arp = { ...DEFAULT_ARP, mode: 'arp' as const, division: 32 as const, triplet: true, gate: .5, steps: Array(8).fill(0) };
    engine.startHeldArp('pad', [60,64,67], arp, 200, vi.fn(), { id: 'bass:pad', midi: 36 }); await flush();
    const initial = [...tone.state.synths];
    const state = engine as unknown as { heldArps: Map<string, { events: { start: number; end: number; live?: { synth: typeof initial[number]; cleanupAt: number } }[] }> };
    const events = state.heldArps.get('pad')!.events, near = events[1], later = events[2];
    const nearEnd = near.end, deadline = near.live!.cleanupAt;
    now = near.start - .005;
    // A full replacement batch would miss the next onset during construction.
    tone.state.onConstruct = () => { now += .02; };
    for (const row of [7,3,6]) engine.updateHeldArp('pad', [60,64,67], { ...arp, steps: Array(8).fill(row) }, 200);
    expect(tone.state.synths).toEqual(initial);
    expect(initial.every(synth => synth.dispose.mock.calls.length === 0)).toBe(true);
    expect(near.live!.synth.triggerAttackRelease).toHaveBeenCalledTimes(1);
    expect(near.end).toBe(nearEnd); expect(near.live!.cleanupAt).toBe(deadline);
    const revised = later.live!.synth.triggerAttackRelease.mock.calls.at(-1)!;
    expect(revised[0]).toBe(67); expect(revised[1]).toBeCloseTo(.0125); expect(revised[2]).toBe(later.start); expect(revised[3]).toBe(.68);
    expect(owned(engine).deadlineMisses).toBe(0); engine.dispose();
  });

  it('preserves the current timeline arp and Bass while future pitches and rests change', async () => {
    vi.useFakeTimers(); const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const arp = { ...DEFAULT_ARP, mode: 'arp' as const, division: 32 as const, gate: .8, steps: Array(8).fill(0) };
    const notes = (midi: number, rest = false) => [
      { id: 99, midi: 36, tick: 0, durationTicks: 1920, velocity: .58, part: 'bass' as const },
      ...Array.from({ length: 32 }, (_, id) => ({ id, midi, tick: id * 60, durationTicks: 48, velocity: .68, part: 'chords' as const })).filter(note => !rest || note.tick > 0),
    ];
    await engine.loop(notes(60), 1920, 100, vi.fn(), vi.fn(), 0, false, arp);
    const initial = [...tone.state.synths], current = initial.find(s => s.triggerAttack.mock.calls[0][0] === 60)!;
    const end = current.triggerRelease.mock.calls[0][0], origin = engine.playbackClock()!.origin;
    tone.immediate.mockReturnValue(origin + .002);
    engine.updateLoop(notes(67), 1920, 100, { ...arp, steps: Array(8).fill(7) });
    expect(tone.state.synths).toEqual(initial);
    expect(current.triggerRelease.mock.calls).toEqual([[end]]);
    expect(current.triggerAttack.mock.calls).toEqual([[60,origin,.68]]);
    expect(initial.every(synth => synth.dispose.mock.calls.length === 0)).toBe(true);
    const future = initial.find(s => s.triggerAttack.mock.calls[0][1] > origin)!;
    expect(future.triggerAttackRelease.mock.calls.at(-1)![0]).toBe(67);
    engine.updateLoop(notes(67,true), 1920, 100, { ...arp, steps: [null,7,7,7,7,7,7,7] });
    expect(current.triggerRelease.mock.calls).toEqual([[end]]);
    expect(engine.playbackClock()!.origin).toBe(origin);
    expect(initial[0].triggerRelease).toHaveBeenCalledTimes(1);
    expect(owned(engine).deadlineMisses).toBe(0); engine.dispose();
  });

  it.each(['pitch','rest'] as const)('does not replay an elapsed %s step when pattern changes then Gate extends', async kind => {
    vi.useFakeTimers(); const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const arp = { ...DEFAULT_ARP, mode: 'arp' as const, division: 16 as const, gate: .1, steps: [kind === 'rest' ? null : 0,null,null,null,null,null,null,null] };
    const notes = (midi: number | null, gate: number) => [
      { id: 99, midi: 36, tick: 0, durationTicks: 1920, velocity: .58, part: 'bass' as const },
      ...(midi === null ? [] : [{ id: 0, midi, tick: 0, durationTicks: 120 * gate, velocity: .68, part: 'chords' as const }]),
    ];
    await engine.loop(notes(kind === 'rest' ? null : 60,.1), 1920, 96, vi.fn(), vi.fn(), 0, false, arp);
    const initial = [...tone.state.synths], origin = engine.playbackClock()!.origin;
    tone.immediate.mockReturnValue(origin + .03); vi.advanceTimersByTime(8);
    const edited = { ...arp, steps: [7,null,null,null,null,null,null,null] };
    engine.updateLoop(notes(67,.1), 1920, 96, edited);
    engine.updateLoop(notes(67,1), 1920, 96, { ...edited, gate: 1 });
    expect(tone.state.synths).toEqual(initial);
    expect(owned(engine).deadlineMisses).toBe(0); engine.dispose();
  });
});


it('restores a newly drawn near-onset backing step after a recording override', async () => {
  vi.useFakeTimers(); const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  const arp = { ...DEFAULT_ARP, mode: 'arp' as const, division: 32 as const, steps: [null,null,null,null,null,null,null,null] };
  const bass = { id: 99, midi: 36, tick: 0, durationTicks: 1920, velocity: .58, part: 'bass' as const };
  await engine.loop([bass],1920,100,vi.fn(),vi.fn(),0,false,arp);
  const origin = engine.playbackClock()!.origin;
  tone.immediate.mockReturnValue(origin + .07); engine.setRecordingOverride(true);
  engine.updateLoop([bass,{ id: 0, midi: 67, tick: 60, durationTicks: 30, velocity: .68, part: 'chords' }],1920,100,{ ...arp, steps: [null,7,null,null,null,null,null,null] });
  engine.setRecordingOverride(false);
  expect(tone.state.synths.some(s => s.triggerAttack.mock.calls.some(call => call[0] === 67 && Math.abs(call[1] - origin - .075) < .00001))).toBe(true);
  expect(owned(engine).deadlineMisses).toBe(0); engine.dispose();
});


it('keeps a near-onset held attack and reuses the queued sources when Randomize changes rate', async () => {
  vi.useFakeTimers(); let now = 0; tone.immediate.mockImplementation(() => now);
  const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  const arp = { ...DEFAULT_ARP, mode: 'arp' as const, division: 16 as const, steps: Array(8).fill(0), gate: .5 };
  engine.startHeldArp('pad',[60,64,67],arp,100,vi.fn()); await flush();
  const initial=[...tone.state.synths], next=initial[1], onset=next.triggerAttackRelease.mock.calls[0][2];
  now=onset-.005; tone.state.onConstruct=() => { now+=.03; };
  engine.updateHeldArp('pad',[60,64,67],{ ...arp, division: 8, steps:Array(8).fill(7), gate:1, reverse:true },100);
  expect(next.dispose).not.toHaveBeenCalled(); expect(next.triggerAttackRelease).toHaveBeenCalledTimes(1);
  expect(tone.state.synths).toEqual(initial);
  expect(owned(engine).deadlineMisses).toBe(0); engine.dispose();
});


for (const phase of ['current','near'] as const) for (const replacement of ['pitch','rest'] as const) it(`keeps ${phase} owned pattern ${replacement} through a following Gate edit`, async () => {
  vi.useFakeTimers(); const engine=new PerformanceAudio(vi.fn());engine.setSound({...DEFAULT_SOUND,reverbAmount:0});
  const arp={...DEFAULT_ARP,mode:'arp' as const,division:32 as const,gate:.8,steps:Array(8).fill(0)};
  const editedStep=phase==='current'?0:1;
  const notes=(changed:boolean,gate:number)=>[
    {id:99,midi:36,tick:0,durationTicks:1920,velocity:.58,part:'bass' as const},
    ...Array.from({length:32},(_,id)=>({id,midi:changed&&id===editedStep?67:60,tick:id*60,durationTicks:60*gate,velocity:.68,part:'chords' as const})).filter(note=>!changed||replacement!=='rest'||note.id!==editedStep),
  ];
  await engine.loop(notes(false,.8),1920,100,vi.fn(),vi.fn(),0,false,arp);
  const origin=engine.playbackClock()!.origin, voice=tone.state.synths.find(s=>s.triggerAttack.mock.calls[0][0]===60&&Math.abs(s.triggerAttack.mock.calls[0][1]-origin-editedStep*.075)<.00001)!;
  const end=voice.triggerRelease.mock.calls[0][0];tone.immediate.mockReturnValue(origin+(phase==='current'?.002:.07));
  const steps=[...arp.steps];steps[editedStep]=replacement==='rest'?null:7;
  const edited={...arp,steps};engine.updateLoop(notes(true,.8),1920,100,edited);
  expect(()=>engine.updateLoop(notes(true,.1),1920,100,{...edited,gate:.1})).not.toThrow();
  expect(()=>engine.updateLoop(notes(true,1),1920,100,{...edited,gate:1})).not.toThrow();
  expect(voice.triggerRelease.mock.calls).toEqual([[end]]);
  expect(voice.triggerAttackRelease).not.toHaveBeenCalled();
  expect(owned(engine).deadlineMisses).toBe(0);engine.dispose();
});


it('cancels old queued automation before constructing extra voices for a faster held rate', async () => {
  vi.useFakeTimers(); let now=0;tone.immediate.mockImplementation(()=>now);
  const engine=new PerformanceAudio(vi.fn());engine.setSound({...DEFAULT_SOUND,reverbAmount:0});
  const arp={...DEFAULT_ARP,mode:'arp' as const,division:8 as const,steps:Array(8).fill(0),gate:1};
  engine.startHeldArp('pad',[60,64,67],arp,200,vi.fn());await flush();
  const pending=tone.state.synths.slice(1);now=.14;
  tone.state.onConstruct=()=>{
    for(const synth of pending) {
      const start=synth.triggerAttackRelease.mock.calls[0][2];
      expect(synth.envelope.cancel).toHaveBeenCalledWith(start);
      expect(synth.frequency.cancelScheduledValues).toHaveBeenCalledWith(start);
    }
    now+=.02;
  };
  engine.updateHeldArp('pad',[60,64,67],{...arp,division:32,triplet:true,steps:Array(8).fill(7)},200);
  expect(owned(engine).deadlineMisses).toBeGreaterThan(0);
  engine.dispose();
});


it('preserves an owned onset when the audio clock crosses its edit margin during reconciliation', async () => {
  vi.useFakeTimers();let now=0;tone.immediate.mockImplementation(()=>now);
  const engine=new PerformanceAudio(vi.fn());engine.setSound({...DEFAULT_SOUND,reverbAmount:0});
  const arp={...DEFAULT_ARP,mode:'arp' as const,division:32 as const,triplet:true,steps:Array(8).fill(0)};
  engine.startHeldArp('pad',[60,64,67],arp,200,vi.fn());await flush();
  const near=tone.state.synths[1],at=near.triggerAttackRelease.mock.calls[0][2];now=at-.012;
  let reads=0;vi.spyOn(engine,'audioTime').mockImplementation(()=>{if(++reads===2)now+=.004;return now;});
  engine.updateHeldArp('pad',[60,64,67],{...arp,steps:Array(8).fill(7)},200);
  expect(near.triggerAttackRelease).toHaveBeenCalledTimes(1);expect(near.dispose).not.toHaveBeenCalled();
  expect(tone.state.synths[2].triggerAttackRelease.mock.calls.at(-1)![0]).toBe(67);
  expect(owned(engine).deadlineMisses).toBe(0);engine.dispose();
});


it('starts the latest arp pattern when an edit arrives during audio unlock', async () => {
  vi.useFakeTimers(); let resume!: () => void;
  tone.state.start = () => new Promise<void>(resolve => { resume = resolve; });
  const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
  const arp = { ...DEFAULT_ARP, mode: 'arp' as const, steps: Array(8).fill(0) };
  const notes = (midi: number) => [{ id: 0, midi, tick: 0, durationTicks: 120, velocity: .68, part: 'chords' as const }];
  const starting = engine.loop(notes(60),1920,100,vi.fn(),vi.fn(),0,false,arp);
  engine.updateLoop(notes(67),1920,100,{ ...arp, steps: Array(8).fill(7) });
  resume(); await starting;
  expect(tone.state.synths[0].triggerAttack.mock.calls[0][0]).toBe(67);
  expect(owned(engine).deadlineMisses).toBe(0); engine.dispose();
});


it.each(['added','retuned'] as const)('reconciles %s Bass when a session edit also changes the arp pattern', async kind => {
  vi.useFakeTimers(); const engine=new PerformanceAudio(vi.fn());engine.setSound({...DEFAULT_SOUND,reverbAmount:0});
  const arp={...DEFAULT_ARP,mode:'arp' as const,division:8 as const,gate:1,steps:Array(8).fill(0)};
  const notes=(midi:number,bass?:number)=>[
    ...(bass===undefined?[]:[{id:99,midi:bass,tick:0,durationTicks:1920,velocity:.58,part:'bass' as const}]),
    ...Array.from({length:8},(_,id)=>({id,midi,tick:id*240,durationTicks:240,velocity:.68,part:'chords' as const})),
  ];
  await engine.loop(notes(60,kind==='retuned'?46:undefined),1920,100,vi.fn(),vi.fn(),0,false,arp);
  const origin=engine.playbackClock()!.origin,current=tone.state.synths.find(s=>s.triggerAttack.mock.calls[0][0]===60)!;
  const end=current.triggerRelease.mock.calls[0][0];tone.immediate.mockReturnValue(origin+.035);
  engine.updateLoop(notes(67,34),1920,100,{...arp,steps:Array(8).fill(7)});
  expect(tone.state.synths.some(s=>s.triggerAttack.mock.calls.some(call=>call[0]===34&&Math.abs(call[1]-origin-.045)<.00001))).toBe(true);
  expect(current.triggerAttack.mock.calls).toEqual([[60,origin,.68]]);expect(current.triggerRelease.mock.calls).toEqual([[end]]);
  expect(owned(engine).deadlineMisses).toBe(0);engine.dispose();
});


it('restores queued Bass across a loop boundary after combined pattern remove and restore edits', async () => {
  vi.useFakeTimers();let now=0;tone.immediate.mockImplementation(()=>now);
  const engine=new PerformanceAudio(vi.fn());engine.setSound({...DEFAULT_SOUND,reverbAmount:0});
  const arp={...DEFAULT_ARP,mode:'arp' as const,division:8 as const,gate:1,steps:Array(8).fill(0)};
  const notes=(midi:number,bass:boolean)=>[
    ...(bass?[{id:99,midi:46,tick:0,durationTicks:1920,velocity:.58,part:'bass' as const}]:[]),
    ...Array.from({length:8},(_,id)=>({id,midi,tick:id*240,durationTicks:240,velocity:.68,part:'chords' as const})),
  ];
  await engine.loop(notes(60,true),1920,200,vi.fn(),vi.fn(),0,false,arp);
  const origin=engine.playbackClock()!.origin;
  for(let step=1;step<=11;step++){now=origin+step*.1;vi.advanceTimersByTime(100);}
  engine.updateLoop(notes(67,false),1920,200,{...arp,steps:Array(8).fill(7)});
  engine.updateLoop(notes(60,true),1920,200,arp);
  expect(tone.state.synths.some(s=>!s.dispose.mock.calls.length&&s.triggerAttack.mock.calls.some(call=>call[0]===46&&Math.abs(call[1]-origin-1.2)<.00001))).toBe(true);
  expect(owned(engine).deadlineMisses).toBe(0);engine.dispose();
});


describe('remaining Bass coverage', () => {
  it('recovers one still-active Bass after an uncovered refill without moving its end or next grid attack', async () => {
    vi.useFakeTimers(); const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    const notes = [
      { id: 0, midi: 39, tick: 0, durationTicks: 480, velocity: .58, part: 'bass' as const },
      { id: 1, midi: 37, tick: 480, durationTicks: 960, velocity: .58, part: 'bass' as const },
      { id: 2, midi: 41, tick: 1440, durationTicks: 480, velocity: .58, part: 'bass' as const },
    ];
    await engine.loop(notes, 1920, 120, vi.fn(), vi.fn());
    const origin = engine.playbackClock()!.origin;
    tone.immediate.mockReturnValue(.64); vi.advanceTimersByTime(8);
    const recovered = tone.state.synths.find(synth => synth.triggerAttack.mock.calls[0]?.[0] === 37);
    expect(recovered).toBeDefined();
    expect(recovered!.triggerAttack).toHaveBeenCalledWith(37, .65, .58);
    expect(recovered!.triggerRelease).toHaveBeenCalledWith(origin + 1.5);
    vi.advanceTimersByTime(16);
    expect(tone.state.synths.filter(synth => synth.triggerAttack.mock.calls[0]?.[0] === 37)).toHaveLength(1);
    expect(owned(engine).deadlineMisses).toBe(1);
    tone.immediate.mockReturnValue(1.2); vi.advanceTimersByTime(8);
    expect(tone.state.synths.at(-1)!.triggerAttack).toHaveBeenCalledWith(41, origin + 1.5, .58);
    expect(engine.playbackClock()!.origin).toBe(origin); engine.dispose();
  });

  it('retains a Bass whose onset passes during complete batch construction without replaying late arp attacks', async () => {
    vi.useFakeTimers(); let now = 0; tone.immediate.mockImplementation(() => now);
    const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    await engine.loop([37,60,64].map((midi,id) => ({ id,midi,tick:480,durationTicks:960,velocity:.58,part:id ? 'chords' as const : 'bass' as const })),1920,120,vi.fn(),vi.fn());
    const origin = engine.playbackClock()!.origin;
    now = .25; tone.state.onConstruct = () => { now += .1; };
    vi.advanceTimersByTime(8);
    expect(tone.state.synths[0].triggerAttack).toHaveBeenCalledTimes(1);
    expect(tone.state.synths[0].triggerAttack.mock.calls[0][0]).toBe(37);
    expect(tone.state.synths[0].triggerAttack.mock.calls[0][1]).toBeCloseTo(.56, 8);
    expect(tone.state.synths[0].triggerRelease).toHaveBeenCalledWith(origin + 1.5);
    expect(tone.state.synths.slice(1).every(synth => !synth.triggerAttack.mock.calls.length)).toBe(true);
    expect(owned(engine).deadlineMisses).toBe(3);
    expect(engine.playbackClock()!.origin).toBe(origin); engine.dispose();
  });

  it('does not revive an expired Bass or extend it after recovery construction', async () => {
    vi.useFakeTimers(); let now = 0; tone.immediate.mockImplementation(() => now);
    const engine = new PerformanceAudio(vi.fn()); engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    await engine.loop([{ id:0,midi:37,tick:480,durationTicks:48,velocity:.58,part:'bass' }],1920,120,vi.fn(),vi.fn());
    now = .54; tone.state.onConstruct = () => { now += .03; }; vi.advanceTimersByTime(8);
    expect(tone.state.synths).toHaveLength(1);
    expect(tone.state.synths[0].triggerAttack).not.toHaveBeenCalled();
    expect(tone.state.synths[0].dispose).toHaveBeenCalledOnce();
    expect(owned(engine).deadlineMisses).toBe(1); engine.dispose();
  });
});

describe('owned pending reverb', () => {
  it('deduplicates an unfinished impulse across unrelated Sound edits', async () => {
    vi.useFakeTimers(); let ready!: () => void;
    tone.state.effectReady = () => new Promise<void>(resolve => { ready = resolve; });
    const engine = new PerformanceAudio(vi.fn()); const sound = { ...DEFAULT_SOUND,reverbAmount:1,reverbTime:.2 };
    engine.setSound(sound); engine.attackBatch([{ id:'bass:live',midi:39,velocity:.58,part:'bass' }]); await flush(); vi.advanceTimersByTime(0);
    for (const color of [.1,.2,.3]) { engine.setSound({ ...sound,color }); vi.advanceTimersByTime(0); }
    expect(tone.state.effects).toHaveLength(1);
    ready(); await flush(); engine.dispose();
  });

  it('labels the completed impulse with its requested Time and prepares the deferred new Time', async () => {
    vi.useFakeTimers(); const ready: Array<() => void> = [];
    tone.state.effectReady = () => new Promise<void>(resolve => ready.push(resolve));
    const engine = new PerformanceAudio(vi.fn()); const sound = { ...DEFAULT_SOUND,reverbAmount:1,reverbTime:.2 };
    engine.setSound(sound); engine.attackBatch([{ id:'bass:live',midi:39,velocity:.58,part:'bass' }]); await flush(); vi.advanceTimersByTime(0);
    engine.setSound({ ...sound,reverbTime:.8 },true); ready[0](); await flush();
    expect((engine as unknown as { renderedReverbTime:number }).renderedReverbTime).toBe(.2);
    engine.commitReverbTime(); expect(tone.state.effects).toHaveLength(2);
    ready[1](); await flush(); engine.dispose();
  });

  it('retains the old wet path until its fade deadline on the owned audio clock', async () => {
    vi.useFakeTimers(); const engine = new PerformanceAudio(vi.fn());
    const sound = { ...DEFAULT_SOUND,reverbAmount:1,reverbTime:.2 };
    engine.setSound(sound); engine.attackBatch([{ id:'bass:live',midi:39,velocity:.58,part:'bass' }]); await flush(); vi.advanceTimersByTime(0); await flush();
    const old = tone.state.effects[0];
    engine.setSound({ ...sound,reverbTime:.8 }); vi.advanceTimersByTime(0); await flush();
    tone.immediate.mockReturnValue(.05); vi.advanceTimersByTime(1000);
    expect(old.dispose).not.toHaveBeenCalled();
    tone.immediate.mockReturnValue(.36); vi.advanceTimersByTime(350);
    expect(old.dispose).toHaveBeenCalledOnce(); engine.dispose();
  });
});


it('keeps the active reverb when Time returns to it before a different pending impulse finishes', async () => {
  vi.useFakeTimers(); const ready: Array<() => void> = [];
  tone.state.effectReady = () => new Promise<void>(resolve => ready.push(resolve));
  const engine = new PerformanceAudio(vi.fn()); const sound = { ...DEFAULT_SOUND,reverbAmount:1,reverbTime:.2 };
  engine.setSound(sound); engine.attackBatch([{ id:'bass:live',midi:39,velocity:.58,part:'bass' }]); await flush(); vi.advanceTimersByTime(0); ready[0](); await flush();
  const active = tone.state.effects[0];
  engine.setSound({ ...sound,reverbTime:.8 }); vi.advanceTimersByTime(0);
  engine.setSound(sound); ready[1](); await flush();
  expect((engine as unknown as { effect: unknown }).effect).toBe(active);
  expect(active.dispose).not.toHaveBeenCalled();
  expect(tone.state.effects[1].dispose).toHaveBeenCalledOnce(); engine.dispose();
});


describe('live pad response', () => {
  it('uses a short live margin after complete preparation without changing the shared onset', async () => {
    let now = 0;
    tone.immediate.mockImplementation(() => now);
    tone.state.onConstruct = () => { now += .02; };
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.attackBatch([36,60,64,67].map((midi, index) => ({ id: `live:${index}`, midi, velocity: .68, part: index ? 'chords' as const : 'bass' as const })));
    await flush();
    const expected = now + Math.max(.003, 256 / tone.state.contexts[0].sampleRate);
    for (const synth of tone.state.synths) {
      expect(synth.triggerAttack.mock.calls[0][1]).toBeCloseTo(expected, 8);
      expect(synth.oscillator.start.mock.calls[0][0]).toBeLessThan(expected);
    }
    engine.dispose();
  });

  it('reuses the effect slot only after an explicit stop fade finishes on its owned clock', async () => {
    vi.useFakeTimers();
    const engine = new PerformanceAudio(vi.fn());
    engine.setSound({ ...DEFAULT_SOUND, reverbAmount: 0 });
    engine.attackBatch([{ id: 'live:60', midi: 60, velocity: .68, part: 'chords' }]); await flush();
    const first = tone.state.synths[0], filter = tone.state.filters[0];
    first.oscillator.state = 'started'; first.envelope.getValueAtTime.mockReturnValue(.2);
    tone.immediate.mockReturnValue(.02); engine.releaseSource('live', true, true);
    vi.advanceTimersByTime(1000); // A wall clock cannot retire a frozen source.
    expect(first.dispose).not.toHaveBeenCalled();
    expect(owned(engine).idleVoices.chords).toHaveLength(0);
    tone.immediate.mockReturnValue(.081); vi.advanceTimersByTime(60);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(filter.dispose).not.toHaveBeenCalled();
    expect(owned(engine).idleVoices.chords).toHaveLength(1);
    engine.attackBatch([{ id: 'live:64', midi: 64, velocity: .68, part: 'chords' }]);
    expect(tone.state.filters).toHaveLength(1);
    expect(tone.state.synths).toHaveLength(2);
    expect(tone.state.synths[1].oscillator.start).toHaveBeenCalledOnce();
    expect(filter.frequency.cancelScheduledValues).toHaveBeenCalledWith(0);
    expect(filter.Q.cancelScheduledValues).toHaveBeenCalledWith(0);
    engine.dispose();
    expect(filter.dispose).toHaveBeenCalledOnce();
  });
});
