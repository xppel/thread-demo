import * as Tone from 'tone';
import { PPQ } from '../music/types';
import type { Voice } from '../music/types';
import type { ArpSettings, Meter, SoundSettings, TapeNote } from '../music/performanceTypes';
import { arpReleaseSeconds, patchFor } from './patches';
import { createEffect, reverbWet } from './effect';
import type { VoiceEffect } from './effect';
import { arpStepMs, resolveArpStep } from '../music/arpeggiator';
import type { ResolvedArpStep } from '../music/arpeggiator';
import { performanceSequence } from '../music/performanceSequence';
import { DEFAULT_SOUND } from '../state/session';

type Part = 'chords' | 'bass';
type VoiceSlot = { preparedSynth?: Tone.Synth; filter: Tone.Filter; distortion?: Tone.Distortion; textureGain?: Tone.Gain; part: Part };
type LiveVoice = VoiceSlot & { synth: Tone.Synth; id: string; slot?: VoiceSlot; releaseSeconds: number; startTime?: number; releaseAt?: number; cleanupAt?: number; timer?: ReturnType<typeof setTimeout>; released: boolean; stopping: boolean };
type ScheduledNote = { id: string; note: TapeNote; start: number; end: number; nominalStart: number; nominalEnd: number; live: LiveVoice };
type HeldArpEvent = { step: number; start: number; next: number; end: number; resolved: ResolvedArpStep | null; live?: LiveVoice };
type HeldArp = { notes: readonly number[]; settings: ArpSettings; tempo: number; step: number; next: number; ready: boolean; events: HeldArpEvent[]; painted: string; onCell: (cell: ResolvedArpStep | null) => void };
type ReverbPath = { effect: VoiceEffect; gain: Tone.Gain; filter: Tone.Filter; bus: Tone.Gain; context: Tone.Context; time: number; disposed: boolean; cleanupAt?: number; timer?: ReturnType<typeof setTimeout> };
type PlaybackClock = { audioTime: number; origin: number; absoluteTick: number; tick: number; cycle: number; secondsPerTick: number; lengthTicks: number };
const STOP_RAMP_SECONDS = 0.04;
// Common startup headroom covers native automation submission after preparation.
const BATCH_LEAD_SECONDS = .01;
// Refill queues native commands ahead of the grid without shifting attacks.
const LOOKAHEAD_SECONDS = .35;
const IDLE_VOICES = { chords: 24, bass: 4 };

function sameArpGrid(left: ArpSettings, right: ArpSettings): boolean {
  return left.mode === right.mode && left.division === right.division && left.triplet === right.triplet &&
    left.register === right.register && left.reverse === right.reverse && left.mirror === right.mirror &&
    left.steps.length === right.steps.length && left.steps.every((step, index) => step === right.steps[index]);
}

export class PerformanceAudio {
  private output: Tone.Gain | null = null;
  private limiter: Tone.Limiter | null = null;
  private bus: Tone.Gain | null = null;
  private effect: VoiceEffect | null = null;
  private wetGain: Tone.Gain | null = null;
  private wetFilter: Tone.Filter | null = null;
  private dryGain: Tone.Gain | null = null;
  private reverbVersion = 0;
  private reverbPrepareTimer: ReturnType<typeof setTimeout> | null = null;
  private liveContext: Tone.Context | null = null;
  private pageActive = true;
  private suspending: Promise<void> | null = null;
  private unlocking: Promise<void> | null = null;
  private renderedReverbTime = -1;
  private pendingReverb: ReverbPath | null = null;
  private retiringReverbs = new Set<ReverbPath>();
  private waveform: Tone.Waveform | null = null;
  // This Set retains release tails after an ID is retriggered. The Map owns only
  // the latest playable voice for each input ID, so old timers cannot remove it.
  private voices = new Set<LiveVoice>();
  private idleVoices: Record<Part, VoiceSlot[]> = { chords: [], bass: [] };
  private deadlineMisses = 0;
  private lateSubmissions = 0;
  private currentById = new Map<string, LiveVoice>();
  private requested = new Map<string, number>();
  private serial = 0;
  private generation = 0;
  private heldArps = new Map<string, HeldArp>();
  private heldArpTimer: ReturnType<typeof setInterval> | null = null;
  private backingSuppressed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loopState: { events: TapeNote[]; lengthTicks: number; tempo: number;
    scheduled: Map<string, ScheduledNote>; seen: Set<string>; scannedTick: number; audioOrigin: number; startingTick?: number; onPosition: (tick: number) => void; onStop: () => void; arp?: ArpSettings } | null = null;
  private pendingLoop: { events: TapeNote[]; lengthTicks: number; tempo: number; arp?: ArpSettings } | null = null;
  private click: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private voice: Voice = 'Felt';
  private sound: SoundSettings = { ...DEFAULT_SOUND };

  constructor(private onError: (message: string) => void, private onPause: () => void = () => {}) {}

  async unlock(): Promise<void> {
    if (this.disposed || !this.pageActive) return;
    if (this.output && this.liveContext?.state === 'running' && !this.suspending) return;
    if (this.unlocking) return this.unlocking;
    if (this.liveContext?.state === 'closed') this.clearGraph();
    if (!this.liveContext) {
      // Safari opens its output route at the playing gesture, not module import.
      this.liveContext = new Tone.Context({ latencyHint: 'interactive' });
      Tone.setContext(this.liveContext, true);
      this.liveContext.on('statechange', this.contextStateChanged);
    }
    const context = this.liveContext;
    const suspension = this.suspending;
    this.unlocking = (async () => {
      // Capture before publishing this unlock: a hide may await that unlock.
      if (suspension) await suspension;
      if (this.disposed || !this.pageActive) return;
      await context.resume();
      if (context.state !== 'running') throw new Error('Audio context did not resume');
      if (this.disposed || !this.pageActive || this.output) return;
      this.output = new Tone.Gain(this.sound.masterVolume).toDestination();
      this.waveform = new Tone.Waveform(256);
      this.waveform.connect(this.output);
      this.limiter = new Tone.Limiter(-3).connect(this.waveform);
      this.bus = new Tone.Gain(1);
      this.dryGain = new Tone.Gain(1).connect(this.limiter);
      this.bus.connect(this.dryGain);
      this.scheduleReverbPreparation();
    })();
    try { await this.unlocking; } finally { this.unlocking = null; }
  }

  private contextStateChanged = (): void => {
    if (this.disposed || !this.pageActive || !this.output || this.liveContext?.state === 'running') return;
    // Safari can interrupt a visible page. Clear the frozen queue and input state
    // so returning audio never replays old notes or waits on disposed voices.
    this.stop();
    for (const live of [...this.voices]) this.disposeVoice(live);
    this.onPause();
    this.onError('Sound was interrupted. Play again to resume.');
  };

  /** Stop musical activity while hidden; returning never resumes by itself. */
  setPageActive(active: boolean): void {
    this.pageActive = active;
    if (active || this.disposed) return;
    this.stop();
    const fading = [...this.voices];
    const context = this.liveContext;
    if (!context || this.suspending) return;
    const unlock = this.unlocking;
    const suspension = (async () => {
      // A cold resume must finish before suspending the same owned context.
      if (unlock) await unlock.catch(() => undefined);
      if (this.disposed || this.liveContext !== context) return;
      // Give the stop ramp time to run before suspending. A frozen audio
      // clock must still retain its voices until their owned cleanup deadlines.
      if (fading.length && context.state === 'running') {
        // Suspend after the short ramp opportunity, but do not disconnect
        // voices here. Their owned-clock cleanup must survive a frozen clock.
        await new Promise<void>(resolve => setTimeout(resolve, STOP_RAMP_SECONDS * 1000 + 20));
      }
      if (this.disposed || this.liveContext !== context) return;
      if (this.pageActive) return;
      const raw = context.rawContext;
      if (raw.state === 'running' && 'createMediaStreamDestination' in raw) await raw.suspend();
    })().catch(() => this.onError('Sound could not pause in the background. Reload if sound stops.'));
    this.suspending = suspension;
    void suspension.then(() => { if (this.suspending === suspension) this.suspending = null; });
  }

  private scheduleReverbPreparation(): void {
    if (this.sound.reverbAmount <= 0 || this.reverbPrepareTimer || this.disposed) return;
    // Let the first dry note be scheduled before constructing an offline impulse.
    this.reverbPrepareTimer = setTimeout(() => {
      this.reverbPrepareTimer = null;
      this.commitReverbTime();
    }, 0);
  }

  setVoice(voice: Voice): void {
    this.clearPreparedSynths();
    this.voice = voice;
    this.updateSoundingTimbre();
  }

  getWaveform(): Float32Array { return this.waveform?.getValue() ?? new Float32Array(256); }

  setSound(settings: SoundSettings, deferReverbTime = false): void {
    this.clearPreparedSynths();
    this.sound = { ...settings };
    if (this.pendingReverb && this.sound.reverbTime === this.renderedReverbTime) this.commitReverbTime();
    if (this.output) this.output.gain.rampTo(this.sound.masterVolume, 0.025, Tone.immediate());
    this.wetGain?.gain.rampTo(reverbWet(this.sound.reverbAmount), .025, Tone.immediate());
    if (!deferReverbTime && this.sound.reverbAmount > 0 && this.sound.reverbTime !== this.renderedReverbTime && this.sound.reverbTime !== this.pendingReverb?.time) this.scheduleReverbPreparation();
    this.updateSoundingTimbre();
  }

  commitReverbTime(): void {
    const time = this.sound.reverbTime, bus = this.bus, context = this.liveContext;
    if (this.renderedReverbTime === time) {
      if (this.pendingReverb) { this.reverbVersion++; this.disposeReverb(this.pendingReverb); }
      return;
    }
    if (!bus || !context || !this.limiter || this.disposed || this.sound.reverbAmount <= 0 || this.pendingReverb?.time === time) return;
    const version = ++this.reverbVersion;
    const effect = createEffect(time, context);
    const gain = new Tone.Gain({ gain: 0, context }).connect(this.limiter);
    const filter = new Tone.Filter({ frequency: 6200, type: 'lowpass', context }).connect(gain);
    const path: ReverbPath = { effect, gain, filter, bus, context, time, disposed: false };
    const previous = this.pendingReverb;
    this.pendingReverb = path;
    if (previous) this.disposeReverb(previous);
    bus.connect(effect); effect.connect(filter);
    void effect.ready.then(() => {
      if (path.disposed) return;
      if (this.disposed || version !== this.reverbVersion || context !== this.liveContext) { this.disposeReverb(path); return; }
      const oldEffect = this.effect, oldGain = this.wetGain, oldFilter = this.wetFilter;
      this.pendingReverb = null;
      this.effect = effect; this.wetGain = gain; this.wetFilter = filter; this.renderedReverbTime = time;
      const now = context.immediate();
      gain.gain.rampTo(reverbWet(this.sound.reverbAmount), .16, now);
      oldGain?.gain.rampTo(0, .16, now);
      if (oldEffect && oldGain && oldFilter) {
        const old: ReverbPath = { effect: oldEffect, gain: oldGain, filter: oldFilter, bus, context, time, disposed: false, cleanupAt: now + .35 };
        this.retiringReverbs.add(old);
        const retire = () => {
          if (old.disposed) return;
          const remaining = old.cleanupAt! - context.immediate();
          if (context !== this.liveContext || context.state === 'closed' || remaining <= 0) this.disposeReverb(old);
          else old.timer = setTimeout(retire, Math.max(20, Math.min(1000, remaining * 1000)));
        };
        old.timer = setTimeout(retire, 350);
      }
    }).catch(() => {
      if (path.disposed) return;
      this.disposeReverb(path);
      if (!this.disposed && version === this.reverbVersion) this.onError('Reverb could not be prepared. Dry sound is still available.');
    });
  }

  private disposeReverb(path: ReverbPath): void {
    if (path.disposed) return;
    path.disposed = true;
    if (path.timer) clearTimeout(path.timer);
    path.bus.disconnect(path.effect); path.effect.dispose(); path.filter.dispose(); path.gain.dispose();
    this.retiringReverbs.delete(path);
    if (this.pendingReverb === path) this.pendingReverb = null;
  }

  private updateSoundingTimbre(): void {
    const patch = patchFor(this.voice, this.sound);
    for (const live of this.voices) {
      if (live.stopping) continue;
      // Preserve the original envelope/release ownership while changing colour.
      const now = Tone.immediate();
      live.filter.frequency.rampTo(patch.cutoff, 0.025, now);
      live.filter.Q.rampTo(patch.resonance, 0.025, now);
      live.synth.volume.rampTo(patch.volume, 0.025, now);
      live.textureGain?.gain.rampTo(patch.textureGain, 0.025, now);
      if (live.distortion) {
        // Setting even the same drive rebuilds Tone's WaveShaper curve.
        if (live.distortion.distortion !== patch.drive) live.distortion.distortion = patch.drive;
        live.distortion.wet.rampTo(patch.textureMix, .025, now);
      }
    }
  }

  private detachVoice(live: LiveVoice): void {
    if (live.timer) clearTimeout(live.timer);
    this.voices.delete(live);
    if (this.currentById.get(live.id) === live) {
      this.currentById.delete(live.id);
      this.requested.delete(live.id);
    }
  }

  private clearPreparedSynths(): void {
    for (const idle of Object.values(this.idleVoices)) for (const slot of idle) {
      slot.preparedSynth?.dispose(); slot.preparedSynth = undefined;
    }
  }

  private prepareSynth(slot: VoiceSlot): Tone.Synth {
    const patch = patchFor(this.voice, this.sound);
    const synth = new Tone.Synth({ oscillator: patch.oscillator, envelope: patch.envelope, volume: patch.volume }).connect(slot.distortion!);
    // Prepare a fresh source at zero frequency with its envelope still silent.
    // This keeps phase frozen and moves allocation out of the next input event.
    synth.frequency.cancelScheduledValues(0);
    synth.frequency.setValueAtTime(0, this.audioTime());
    synth.oscillator.start(this.audioTime());
    return synth;
  }

  private disposeSlot(slot: VoiceSlot): void {
    slot.preparedSynth?.dispose(); slot.preparedSynth = undefined;
    slot.filter.dispose();
    slot.distortion?.dispose(); slot.textureGain?.dispose();
  }

  private disposeVoice(live: LiveVoice): void {
    if (!this.voices.has(live)) return;
    this.detachVoice(live); live.synth.dispose(); this.disposeSlot(live);
  }

  private retireVoice(live: LiveVoice): void {
    const idle = this.idleVoices[live.part];
    // Retire the sounding source only after its owned cleanup deadline.
    // Keep the effects and prepare a fresh silent source for the next input.
    const now = this.audioTime();
    const finished = live.stopping
      ? live.cleanupAt !== undefined && now >= live.cleanupAt && this.liveContext?.state === 'running'
      : live.synth.oscillator.state === 'stopped' && live.synth.envelope.getValueAtTime(now) <= .00001;
    if (!live.slot || !finished || idle.length >= IDLE_VOICES[live.part]) {
      this.disposeVoice(live); return;
    }
    this.detachVoice(live);
    live.synth.dispose();
    live.textureGain?.disconnect(this.bus!);
    // The replacement stays disconnected from the mix until claimed.
    live.slot.preparedSynth = this.prepareSynth(live.slot);
    idle.push(live.slot);
  }

  private disposeLater(live: LiveVoice, delayMs: number): void {
    if (live.timer) clearTimeout(live.timer);
    const context = this.liveContext;
    live.cleanupAt = this.audioTime() + Math.max(0, delayMs) / 1000;
    const check = () => {
      if (!this.voices.has(live)) return;
      // A wall timer is only a wake-up. Audio may have stalled or suspended.
      // Explicit source cancellation and context destruction bypass this wait.
      if (context !== this.liveContext || context?.state === 'closed') { this.disposeVoice(live); return; }
      const remaining = live.cleanupAt! - (context?.immediate() ?? 0);
      if (remaining <= 0) this.retireVoice(live);
      else live.timer = setTimeout(check, Math.max(20, Math.min(1000, remaining * 1000)));
    };
    live.timer = setTimeout(check, Math.max(0, delayMs));
  }

  private releaseVoice(live: LiveVoice, time: number, cleanupMs?: number): void {
    if (live.released || !this.voices.has(live)) return;
    if (live.startTime !== undefined && time < live.startTime) { this.disposeVoice(live); return; }
    live.released = true;
    if (this.currentById.get(live.id) === live) this.currentById.delete(live.id);
    live.synth.triggerRelease(time);
    this.disposeLater(live, Math.max(0, time - Tone.immediate()) * 1000 + (cleanupMs ?? (live.releaseSeconds * 1000 + 100)));
  }

  private stopVoice(live: LiveVoice, time: number): void {
    if (live.stopping) return;
    if (live.startTime !== undefined && time < live.startTime) { this.disposeVoice(live); return; }
    live.stopping = true;
    // Fade and then dispose pending/current sources so a stop cannot leave an orphan.
    live.synth.volume.rampTo(-96, STOP_RAMP_SECONDS, time);
    if (live.released) { this.disposeLater(live, STOP_RAMP_SECONDS * 1000 + 20); return; }
    this.releaseVoice(live, time, STOP_RAMP_SECONDS * 1000 + 20);
  }

  private createVoice(id: string, part: Part = 'chords', release?: number): LiveVoice | undefined {
    if (!this.bus) return;
    const patch = patchFor(this.voice, this.sound);
    const envelope = { ...patch.envelope, release: release ?? patch.envelope.release };
    let slot = this.idleVoices[part].pop();
    const preparationTime = this.audioTime();
    if (slot) {
      slot.filter.frequency.cancelScheduledValues(0);
      slot.filter.frequency.setValueAtTime(patch.cutoff, preparationTime);
      slot.filter.Q.cancelScheduledValues(0);
      slot.filter.Q.setValueAtTime(patch.resonance, preparationTime);
      slot.textureGain!.gain.cancelScheduledValues(0);
      slot.textureGain!.gain.setValueAtTime(patch.textureGain, preparationTime);
      if (slot.distortion!.distortion !== patch.drive) slot.distortion!.distortion = patch.drive;
      slot.distortion!.wet.cancelScheduledValues(0);
      slot.distortion!.wet.setValueAtTime(patch.textureMix, preparationTime);
      slot.textureGain!.connect(this.bus);
    } else {
      const textureGain = new Tone.Gain(patch.textureGain).connect(this.bus);
      const filter = new Tone.Filter({ frequency: patch.cutoff, type: 'lowpass', Q: patch.resonance }).connect(textureGain);
      const distortion = new Tone.Distortion({ distortion: patch.drive, wet: patch.textureMix }).connect(filter);
      slot = { filter, distortion, textureGain, part };
    }
    const synth = slot.preparedSynth ?? this.prepareSynth(slot);
    slot.preparedSynth = undefined;
    synth.envelope.release = envelope.release;
    const live: LiveVoice = { ...slot, synth, slot, id, releaseSeconds: envelope.release, released: false, stopping: false };
    this.voices.add(live); this.currentById.set(id, live);
    return live;
  }

  private submitVoice(live: LiveVoice, midi: number, velocity: number, time: number, duration?: number): boolean {
    if (!this.voices.has(live)) return false;
    if (time < this.audioTime()) { this.missedDeadline(); this.disposeVoice(live); return false; }
    live.startTime = time;
    if (duration !== undefined) {
      live.synth.triggerAttackRelease(Tone.Frequency(midi, 'midi').toFrequency(), duration, time, velocity);
      live.releaseAt = time + duration;
      this.disposeLater(live, (time - Tone.immediate() + duration + live.releaseSeconds + .1) * 1000);
    } else live.synth.triggerAttack(Tone.Frequency(midi, 'midi').toFrequency(), time, velocity);
    if (this.audioTime() > time) this.lateSubmissions += 1;
    return true;
  }

  /** Construct the complete live chord before assigning its common onset. */
  attackBatch(notes: Array<{ id: string; midi: number; velocity: number; part: Part }>): void {
    if (this.disposed || !this.pageActive) return;
    const requests = notes.map(note => ({ ...note, token: ++this.serial }));
    for (const note of requests) {
      this.requested.set(note.id, note.token);
    }
    const play = () => {
      if (this.disposed || !this.pageActive) return;
      const current = requests.filter(note => this.requested.get(note.id) === note.token);
      const batch = current.map(note => ({ note, previous: this.currentById.get(note.id), live: this.createVoice(note.id, note.part) }));
      // Manual input needs only a short native submission margin. Keep the
      // larger timeline/arp preparation margin independent of pad response.
      const onset = this.audioTime() + Math.max(.003, 256 / this.liveContext!.sampleRate);
      for (const { note, previous, live } of batch) {
        if (previous && (previous.releaseAt === undefined || previous.releaseAt > onset)) this.releaseVoice(previous, onset);
        if (live) this.submitVoice(live, note.midi, note.velocity, onset);
      }
    };
    if (this.output && this.liveContext?.state === 'running' && !this.suspending) play();
    else void this.unlock().then(play).catch(() => this.onError('Sound could not start. Try playing a pad again.'));
  }

  release(id: string): void {
    this.requested.delete(id);
    const live = this.currentById.get(id);
    if (live) this.releaseVoice(live, Tone.immediate());
  }

  /** Cancel a pad source even if its short arp gate painted off before unlock. */
  releaseSource(source: string, includeBass = true, fade = false): void {
    for (const id of [...this.requested.keys()]) if (id.startsWith(`${source}:`) || (includeBass && id === `bass:${source}`)) this.release(id);
    if (fade) for (const live of [...this.voices]) if (live.id.startsWith(`${source}:`) || (includeBass && live.id === `bass:${source}`)) this.stopVoice(live, Tone.immediate());
  }

  stopNote(id: string): void {
    this.release(id);
    for (const live of [...this.voices]) if (live.id === id) this.stopVoice(live, Tone.immediate());
  }

  /** The audio clock is the single source of recording/playback positions. */
  playbackClock(): PlaybackClock | null {
    const state = this.loopState;
    if (!state) return null;
    const audioTime = Tone.immediate(), secondsPerTick = 60 / state.tempo / PPQ;
    const absoluteTick = Math.max(0, (audioTime - state.audioOrigin) / secondsPerTick);
    return { audioTime, origin: state.audioOrigin, absoluteTick, tick: absoluteTick % state.lengthTicks,
      cycle: Math.floor(absoluteTick / state.lengthTicks), secondsPerTick, lengthTicks: state.lengthTicks };
  }

  audioTime(): number { return this.liveContext?.immediate() ?? Tone.immediate(); }

  setRecordingOverride(suppressed: boolean): void {
    if (this.backingSuppressed === suppressed) return;
    this.backingSuppressed = suppressed;
    if (suppressed) {
      this.loopState?.seen.clear();
      const now = Tone.immediate();
      for (const live of [...this.voices]) if (live.id.startsWith('sequence:')) this.stopVoice(live, now);
    }
    if (this.loopState) this.pumpLoop(true);
  }

  startHeldArp(source: string, notes: readonly number[], settings: ArpSettings, tempo: number, onCell: HeldArp['onCell'], bass?: { id: string; midi: number }): void {
    if (this.disposed || !this.pageActive) return;
    this.stopHeldArp(source);
    const state: HeldArp = { notes: [...notes], settings: { ...settings, steps: [...settings.steps] }, tempo,
      step: 0, next: 0, ready: false, events: [], painted: '', onCell };
    this.heldArps.set(source, state);
    const begin = () => {
      if (this.disposed || !this.pageActive || this.heldArps.get(source) !== state) return;
      state.ready = true; state.next = this.audioTime() + .005;
      // The initial arp batch owns its bass onset too.
      const newBass = bass && !this.requested.has(bass.id) ? bass : undefined;
      if (newBass) this.requested.set(newBass.id, ++this.serial);
      this.pumpHeldArps(newBass);
      if (!this.heldArpTimer) this.heldArpTimer = setInterval(() => this.pumpHeldArps(), 8);
    };
    if (this.pageActive && !this.suspending && this.output && this.liveContext?.state === 'running') begin();
    else void this.unlock().then(begin).catch(() => this.onError('Sound could not start. Try playing a pad again.'));
  }

  /** Revise a silent queued envelope as a whole; cancelling just its old release
   * can erase a short Gate's truncated attack ramp. Near-onset events stay owned. */
  private reviseQueuedArp(live: LiveVoice, midi: number, velocity: number, start: number, duration: number, settings: ArpSettings, tempo: number): boolean {
    const now = this.audioTime();
    if (start <= now + BATCH_LEAD_SECONDS || !this.voices.has(live) || live.stopping) return false;
    live.synth.envelope.cancel(start);
    // Restart at the queued onset's preceding sample, after silent preparation.
    // Restarting in that preparation quantum can erase Tone's started state.
    live.synth.oscillator.restart(start - 1 / this.liveContext!.sampleRate);
    live.releaseSeconds = arpReleaseSeconds(patchFor(this.voice, this.sound).envelope.release, settings, tempo);
    live.synth.envelope.release = live.releaseSeconds;
    return this.submitVoice(live, midi, velocity, start, duration);
  }

  /** Keep the current attack/release and step boundary; replace only queued future steps. */
  updateHeldArp(source: string, notes: readonly number[], settings: ArpSettings, tempo: number): void {
    const state = this.heldArps.get(source);
    if (!state) return;
    const gateOnly = state.tempo === tempo && sameArpGrid(state.settings, settings) &&
      state.notes.length === notes.length && state.notes.every((note, index) => note === notes[index]);
    if (gateOnly) {
      if (state.settings.gate !== settings.gate) for (const event of state.events) {
        const duration = (event.next - event.start) * settings.gate;
        if (event.live && event.resolved && this.reviseQueuedArp(event.live, event.resolved.midi, .68, event.start, duration, settings, tempo)) event.end = event.start + duration;
      }
      state.settings = { ...settings, steps: [...settings.steps] };
      return;
    }
    const now = this.audioTime();
    if (state.tempo === tempo && state.settings.division === settings.division && state.settings.triplet === settings.triplet) {
      // Drawing changes future cells, never the voice already sounding or
      // an onset too close to safely replace. Reuse its prepared native source.
      for (const event of state.events) {
        if (event.start <= now + BATCH_LEAD_SECONDS) continue;
        const resolved = resolveArpStep(notes, event.step, settings);
        const duration = (event.next - event.start) * settings.gate;
        if (!resolved) {
          if (event.live) this.disposeVoice(event.live);
          event.live = undefined; event.resolved = null;
        } else if (event.live) {
          if ((event.resolved?.midi === resolved.midi && Math.abs(event.end - event.start - duration) < .00001) ||
            this.reviseQueuedArp(event.live, resolved.midi, .68, event.start, duration, settings, tempo)) {
            event.resolved = resolved; event.end = event.start + duration;
          }
        } else {
          event.live = this.createVoice(`${source}:arp:${++this.serial}`, 'chords', arpReleaseSeconds(patchFor(this.voice, this.sound).envelope.release, settings, tempo));
          if (event.live) this.submitVoice(event.live, resolved.midi, .68, event.start, duration);
          event.resolved = resolved; event.end = event.start + duration;
        }
      }
      state.notes = [...notes]; state.settings = { ...settings, steps: [...settings.steps] };
      return;
    }
    const future = state.events.filter(event => event.start > now + BATCH_LEAD_SECONDS);
    const reusable = future.flatMap(event => event.live ? [event.live] : []);
    // Silence superseded commands before allocation can cross their old onset.
    for (const live of reusable) {
      live.synth.envelope.cancel(live.startTime!); live.synth.frequency.cancelScheduledValues(live.startTime!);
      live.synth.oscillator.restart(live.startTime! - 1 / this.liveContext!.sampleRate);
    }
    if (future.length) {
      state.step = future[0].step; state.next = future[0].start;
      state.events = state.events.filter(event => event.start <= now + BATCH_LEAD_SECONDS);
    }
    state.notes = [...notes]; state.settings = { ...settings, steps: [...settings.steps] }; state.tempo = tempo;
    if (state.ready) this.pumpHeldArps(undefined, { source, voices: reusable });
    for (const live of reusable) this.disposeVoice(live);
  }

  stopHeldArp(source: string): void {
    const state = this.heldArps.get(source);
    if (!state) return;
    this.heldArps.delete(source);
    const now = Tone.immediate();
    for (const live of [...this.voices]) if (live.id.startsWith(`${source}:arp:`)) this.stopVoice(live, now);
    state.onCell(null);
    if (!this.heldArps.size && this.heldArpTimer) { clearInterval(this.heldArpTimer); this.heldArpTimer = null; }
  }

  private pumpHeldArps(bass?: { id: string; midi: number }, reusable?: { source: string; voices: LiveVoice[] }): void {
    const now = Tone.immediate();
    for (const [source, state] of this.heldArps) {
      if (!state.ready) continue;
      const interval = arpStepMs(state.tempo, state.settings.division, state.settings.triplet) / 1000;
      const firstBatch = state.step === 0;
      const batch: Array<{ event: HeldArpEvent; live: LiveVoice }> = [];
      const bassLive = bass ? this.createVoice(bass.id, 'bass') : undefined;
      while (state.next <= now + LOOKAHEAD_SECONDS) {
        const step = state.step++, start = state.next, next = start + interval;
        const resolved = resolveArpStep(state.notes, step, state.settings);
        const event: HeldArpEvent = { step, start, next, end: start + interval * state.settings.gate, resolved };
        if (resolved) {
          if (!firstBatch && start < now) this.missedDeadline();
          else {
            event.live = (reusable?.source === source ? reusable.voices.shift() : undefined) ??
              this.createVoice(`${source}:arp:${++this.serial}`, 'chords', arpReleaseSeconds(patchFor(this.voice, this.sound).envelope.release, state.settings, state.tempo));
            if (event.live) batch.push({ event, live: event.live });
          }
        }
        state.events.push(event); state.next = next;
      }
      const earliest = firstBatch ? state.events[0]?.start ?? state.next : batch[0]?.event.start ?? state.next;
      const shift = firstBatch ? Math.max(0, Tone.immediate() + BATCH_LEAD_SECONDS - earliest) : 0;
      if (shift) { for (const event of state.events) { event.start += shift; event.end += shift; event.next += shift; } state.next += shift; }
      if (bassLive && bass) this.submitVoice(bassLive, bass.midi, .58, earliest + shift);
      for (const { event, live } of batch) {
        if (live.startTime !== undefined) {
          live.releaseSeconds = arpReleaseSeconds(patchFor(this.voice, this.sound).envelope.release, state.settings, state.tempo);
          live.synth.envelope.release = live.releaseSeconds;
        }
        this.submitVoice(live, event.resolved!.midi, .68, event.start, interval * state.settings.gate);
      }
      const current = state.events.filter(event => event.start <= now).at(-1);
      const cell = current?.live && this.voices.has(current.live) && current.end > now ? current.resolved : null;
      const key = cell ? `${current!.step}:${cell.midi}` : 'off';
      if (key !== state.painted) { state.painted = key; state.onCell(cell); }
      state.events = state.events.filter(event => event.next > now || event.start > now);
    }
  }

  async loop(notes: TapeNote[], lengthTicks: number, tempo: number, onPosition: (tick: number) => void, onStop: () => void, startTick = 0, allowEmpty = false, arp?: ArpSettings): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    const pending = { events: performanceSequence(notes), lengthTicks, tempo, arp };
    this.pendingLoop = pending;
    try { await this.unlock(); } catch { if (this.pendingLoop === pending) this.pendingLoop = null; this.onError('Sound could not start.'); onStop(); return; }
    if (generation !== this.generation || this.disposed || !this.pageActive) return;
    this.pendingLoop = null;
    const { events } = pending;
    lengthTicks = pending.lengthTicks; tempo = pending.tempo; arp = pending.arp;
    startTick = Math.min(startTick, lengthTicks - 1);
    if (!events.length && !allowEmpty) { onStop(); return; }
    this.loopState = { events, lengthTicks, tempo,
      scheduled: new Map(), seen: new Set(), scannedTick: startTick, audioOrigin: Tone.immediate() - startTick * 60 / tempo / PPQ, startingTick: startTick, onPosition, onStop, arp };
    this.timer = setInterval(() => this.pumpLoop(false), 8);
    this.pumpLoop(false);
  }

  /** Swap the canonical event list at the current playhead without stopping common notes. */
  updateLoop(notes: TapeNote[], lengthTicks: number, tempo: number, arp?: ArpSettings): void {
    if (this.pendingLoop) {
      Object.assign(this.pendingLoop, { events: performanceSequence(notes), lengthTicks, tempo, arp });
      return;
    }
    const state = this.loopState;
    if (!state) return;
    const events = performanceSequence(notes);
    const sameTiming = state.lengthTicks === lengthTicks && state.tempo === tempo;
    const gateOnly = sameTiming && state.arp?.mode === 'arp' && arp?.mode === 'arp' &&
      sameArpGrid(state.arp, arp) &&
      events.length === state.events.length && events.every((note, index) => {
        const old = state.events[index];
        return note.id === old.id && note.tick === old.tick && note.midi === old.midi && note.part === old.part &&
          note.velocity === old.velocity && ((note.part === 'chords' && state.arp!.gate !== arp!.gate) || note.durationTicks === old.durationTicks);
      });
    if (gateOnly) {
      if (state.arp!.gate !== arp!.gate) for (const item of state.scheduled.values()) {
        if (item.note.part !== 'chords') continue;
        const note = events.find(note => note.tick === item.note.tick && note.part === 'chords');
        if (!note) continue;
        const duration = note.durationTicks * 60 / tempo / PPQ;
        // A pattern edit may leave this owned pitch different from the new
        // canonical cell. Gate edits must also leave its metadata/release alone.
        if (this.reviseQueuedArp(item.live, note.midi, note.velocity, item.start, duration, arp!, tempo)) {
          item.end = item.start + duration; item.note = note; item.nominalEnd = item.nominalStart + duration;
        }
      }
      state.events = events; state.arp = arp;
      this.pumpLoop(false);
      return;
    }
    const now = this.audioTime();
    const patternOnly = sameTiming && state.arp?.mode === 'arp' && arp?.mode === 'arp' && !sameArpGrid(state.arp, arp);
    if (patternOnly) {
      const secondsPerTick = 60 / tempo / PPQ;
      for (const [key, item] of state.scheduled) {
        if (item.note.part !== 'chords' || item.start <= now + BATCH_LEAD_SECONDS) continue;
        const note = events.find(note => note.tick === item.note.tick && note.part === 'chords');
        if (!note) {
          this.disposeVoice(item.live); state.scheduled.delete(key); state.seen.delete(key);
          continue;
        }
        const duration = note.durationTicks * secondsPerTick;
        if (note.midi !== item.note.midi || Math.abs(item.end - item.start - duration) > .00001) {
          if (!this.reviseQueuedArp(item.live, note.midi, note.velocity, item.start, duration, arp, tempo)) continue;
          item.end = item.start + duration;
        }
        item.note = note; item.nominalEnd = item.nominalStart + duration;
      }
      // A rest is a consumed step too. Newly drawn notes before this boundary
      // belong to the next occurrence, rather than a mid-step retrigger.
      const cutoff = (now + BATCH_LEAD_SECONDS - state.audioOrigin) / secondsPerTick;
      const cycle = Math.floor(Math.max(0, cutoff) / lengthTicks);
      if (!this.backingSuppressed) for (let pass = Math.max(0, cycle - 1); pass <= cycle; pass++) for (const note of events) {
        if (note.part === 'chords' && pass * lengthTicks + note.tick <= cutoff) state.seen.add(`${pass}:${note.tick}:chords`);
      }
      // A cancelled future Bass is eligible again if a later edit restores it.
      // Keep consumed arp/current keys; reconciliation reclaims retained Bass.
      for (const [key, item] of state.scheduled) if (item.note.part === 'bass' && item.start > now) state.seen.delete(key);
      state.events = events; state.arp = arp;
      this.pumpLoop(false, true);
      return;
    }
    const position = (Math.max(0, now - state.audioOrigin) * state.tempo / 60 * PPQ) % state.lengthTicks;
    state.events = events;
    state.lengthTicks = lengthTicks; state.tempo = tempo;
    if (!sameTiming) state.audioOrigin = now - Math.min(position, lengthTicks - 1) * 60 / tempo / PPQ;
    if (arp) state.arp = arp;
    // Consumed steps stay consumed. Only pending attacks may be cancelled and
    // reintroduced by a same-grid edit; a new clock needs fresh cycle keys.
    if (!sameTiming) state.seen.clear();
    else for (const [key, item] of state.scheduled) if (item.start > now) state.seen.delete(key);
    state.scannedTick = Math.max(0, (now - state.audioOrigin) * tempo / 60 * PPQ);
    this.pumpLoop(true);
  }

  private pumpLoop(preserveCommon: boolean, reconcileBass = false): void {
    this.pumpScheduledLoop(preserveCommon, reconcileBass);
  }

  private scheduleRelease(live: LiveVoice, end: number): void {
    const now = Tone.immediate();
    if (live.releaseAt !== undefined && Math.abs(live.releaseAt - end) < .00001) return;
    if (live.releaseAt !== undefined && live.releaseAt > now && end > live.releaseAt) {
      // Extending a held clip must also cancel the oscillator's previous stop.
      live.synth.envelope.cancel(live.releaseAt);
      live.synth.oscillator.restart(Math.max(now, live.startTime! - 1 / this.liveContext!.sampleRate));
    }
    live.synth.triggerRelease(end);
    live.releaseAt = end;
    this.disposeLater(live, (end - now + live.releaseSeconds + .1) * 1000);
  }

  /** Audio deadlines own attacks/releases; JS timers only refill the queue and paint. */
  private pumpScheduledLoop(preserveCommon: boolean, reconcileBass = false): void {
    const state = this.loopState;
    if (!state) return;
    const now = this.audioTime(), secondsPerTick = 60 / state.tempo / PPQ;
    const startingTick = state.startingTick;
    // Startup has not submitted its grid yet. Clock progress between unlock and
    // this first pump must not consume a short first Gate before batch preparation.
    if (startingTick !== undefined) state.audioOrigin = now - startingTick * secondsPerTick;
    const absoluteTick = startingTick ?? Math.max(0, (now - state.audioOrigin) / secondsPerTick);
    const horizon = absoluteTick + LOOKAHEAD_SECONDS / secondsPerTick;
    state.startingTick = undefined;
    const next = new Map<string, ScheduledNote>();
    const used = new Set<ScheduledNote>();
    const batch: Array<{ key: string; item: ScheduledNote; introducedNow: boolean; recoveringBass: boolean }> = [];
    if (!preserveCommon && !this.backingSuppressed && state.arp?.mode === 'arp') {
      for (const [key, item] of state.scheduled) if (item.note.part === 'chords' && item.start <= now + BATCH_LEAD_SECONDS &&
        item.end > now && this.voices.has(item.live) && !item.live.stopping) {
        next.set(key, item); used.add(item);
      }
    }
    for (let cycle = Math.floor(Math.min(absoluteTick, state.scannedTick) / state.lengthTicks); cycle <= Math.floor(horizon / state.lengthTicks); cycle++) {
      for (const note of state.events) {
        if (this.backingSuppressed) continue;
        const reconcile = preserveCommon || (reconcileBass && note.part === 'bass');
        const start = cycle * state.lengthTicks + note.tick, end = start + note.durationTicks;
        if (start > horizon) continue;
        const key = `${cycle}:${note.tick}:${note.part}${note.part === 'chords' && state.arp?.mode === 'arp' ? '' : `:${note.midi}`}`;
        let nominalStart = state.audioOrigin + start * secondsPerTick, nominalEnd = state.audioOrigin + end * secondsPerTick;
        const owned = state.scheduled.get(key);
        if (!reconcile && owned && owned.end > now && this.voices.has(owned.live) && !owned.live.stopping) {
          // Refills retain submitted automation, including a Gate edit that
          // shortened the canonical duration after this attack began.
          state.seen.add(key); next.set(key, owned); used.add(owned); continue;
        }
        // Tick conversion can round an exact release boundary just below end.
        // Compare the canonical audio deadline too; an ended note is not new.
        if (end <= absoluteTick || nominalEnd <= now + 1e-9) {
          if (startingTick === undefined && !reconcile && start > state.scannedTick && !state.seen.has(key)) this.missedDeadline();
          continue;
        }
        let existing = state.scheduled.get(key);
        if (existing && (existing.note.midi !== note.midi || existing.end <= now || !this.voices.has(existing.live) || existing.live.stopping || (existing.start > now && Math.abs(existing.nominalStart - nominalStart) > .00001))) existing = undefined;
        if (!existing && reconcile && start <= absoluteTick) existing = [...state.scheduled.values()].find(item =>
          !used.has(item) && this.voices.has(item.live) && !item.live.stopping && item.start <= now && item.end > now && item.note.part === note.part && item.note.midi === note.midi);
        if (existing && !used.has(existing)) {
          state.seen.add(key); used.add(existing);
          const endTime = Math.max(existing.live.startTime! + .001, state.audioOrigin + end * secondsPerTick);
          const revisedEnd = Math.abs(existing.nominalEnd - nominalEnd) > .00001 ? endTime : existing.end;
          this.scheduleRelease(existing.live, revisedEnd);
          next.set(key, { ...existing, note, end: revisedEnd, nominalStart, nominalEnd });
        } else {
          const id = `sequence:${++this.serial}`;
          // A live edit can introduce a currently-held note. Its new attack is
          // intentional now; future grid notes retain their strict deadlines.
          const introducedNow = reconcile && nominalStart <= now;
          if (state.seen.has(key) && !introducedNow) continue;
          state.seen.add(key);
          const missedStart = startingTick === undefined && !introducedNow && nominalStart < now;
          const recoveringBass = missedStart && note.part === 'bass';
          if (missedStart) { this.missedDeadline(); if (!recoveringBass) continue; }
          // A missed Bass still covers the remaining clip. Keep its original end
          // and the later grid; expired arp steps never burst after a refill gap.
          const time = Math.max(now + (introducedNow || recoveringBass ? BATCH_LEAD_SECONDS : 0), nominalStart);
          const release = note.part === 'chords' && state.arp ? arpReleaseSeconds(patchFor(this.voice, this.sound).envelope.release, state.arp, state.tempo) : undefined;
          const live = this.createVoice(id, note.part, release);
          if (!live) continue;

          const endTime = introducedNow || recoveringBass ? nominalEnd : Math.max(time + Math.min(note.durationTicks, end - absoluteTick) * secondsPerTick, nominalEnd);
          const item = { id, note, start: time, end: endTime, nominalStart, nominalEnd, live };
          next.set(key, item); batch.push({ key, item, introducedNow, recoveringBass });
        }
      }
    }
    // Startup moves the complete grid once. Intentional edits/restored backing
    // choose a shared onset after allocation, without moving later grid notes.
    if (batch.length) {
      const preparedAt = this.audioTime();
      const earliest = Math.min(...batch.map(({ item }) => item.start));
      const shift = startingTick !== undefined ? Math.max(0, preparedAt + BATCH_LEAD_SECONDS - earliest) : 0;
      if (shift) state.audioOrigin += shift;
      // Bass automation is submitted before the larger arp batch; its onset
      // remains the same absolute grid deadline when preparation finishes in time.
      batch.sort((a, b) => Number(b.item.note.part === 'bass') - Number(a.item.note.part === 'bass'));
      for (const { key, item, introducedNow, recoveringBass } of batch) {
        const missedBass = !introducedNow && !recoveringBass && startingTick === undefined && item.note.part === 'bass' && item.start < this.audioTime();
        if (missedBass) this.missedDeadline();
        if (introducedNow || recoveringBass || missedBass) {
          item.start = (introducedNow ? preparedAt : Math.max(preparedAt, this.audioTime())) + BATCH_LEAD_SECONDS;
          // Allocation can outlast a short Gate. Do not revive an expired note
          // or extend its release across the following grid boundary.
          if (item.end <= item.start) { this.disposeVoice(item.live); next.delete(key); continue; }
        } else {
          item.start += shift; item.end += shift; item.nominalStart += shift; item.nominalEnd += shift;
        }
        if (!this.submitVoice(item.live, item.note.midi, item.note.velocity, item.start)) { next.delete(key); continue; }
        this.scheduleRelease(item.live, item.end);
      }
    }
    const retained = new Set([...next.values()].map(item => item.live));
    for (const item of state.scheduled.values()) {
      if (retained.has(item.live) || item.end <= now) continue;
      this.releaseVoice(item.live, now);
    }
    state.scheduled = next;
    state.scannedTick = horizon;
    const currentCycle = Math.floor(absoluteTick / state.lengthTicks);
    for (const key of state.seen) if (Number(key.split(':', 1)[0]) < currentCycle) state.seen.delete(key);
    state.onPosition(absoluteTick % state.lengthTicks);
  }

  startMetronome(tempo: number, originMs: number, meter: Meter = { numerator: 4, denominator: 4 }): void {
    this.stopMetronome();
    const initialElapsed = Math.max(0, (performance.now() - originMs) / 1000);
    // When enabling the click while playback is already underway, begin at the
    // current beat. Replaying missed beats at 15 ms intervals sounds like a buzz.
    let beat = initialElapsed > 0.04 ? Math.ceil(initialElapsed * tempo / 60 * meter.denominator / 4) : 0;
    const pump = (): void => {
      const elapsed = (performance.now() - originMs) / 1000;
      const at = beat * 60 / tempo * 4 / meter.denominator;
      if (at > elapsed + 0.04) return;
      if (this.bus) {
        const id = `click:${++this.serial}`;
        const filter = new Tone.Filter(5000, 'lowpass').connect(this.bus);
        const synth = new Tone.Synth({ oscillator: { type: 'sine' }, envelope: { attack: 0.001, decay: 0.025, sustain: 0, release: 0.01 }, volume: -24 }).connect(filter);
        const live: LiveVoice = { id, synth, filter, part: 'chords', releaseSeconds: 0.01, released: false, stopping: false };
        this.voices.add(live);
        this.currentById.set(id, live);
        synth.triggerAttackRelease(beat % meter.numerator === 0 ? 1400 : 950, 0.03, Tone.immediate() + Math.max(0, at - elapsed), 0.5);
        this.disposeLater(live, 180);
      }
      beat += 1;
    };
    this.click = setInterval(pump, 15);
    pump();
  }

  stopMetronome(): void { if (this.click) clearInterval(this.click); this.click = null; }

  stop(): void {
    for (const source of [...this.heldArps.keys()]) this.stopHeldArp(source);
    this.backingSuppressed = false;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.loopState = null; this.pendingLoop = null;
    this.stopMetronome();
    this.requested.clear();
    if (this.voices.size) {
      const now = Tone.immediate();
      for (const live of [...this.voices]) this.stopVoice(live, now);
    }
  }

  private missedDeadline(): void {
    // Count genuine missed attacks without invalidating other queued sources.
    this.deadlineMisses += 1;
  }

  private clearGraph(): void {
    for (const live of [...this.voices]) this.disposeVoice(live);
    for (const idle of Object.values(this.idleVoices)) { for (const slot of idle) this.disposeSlot(slot); idle.length = 0; }
    if (this.reverbPrepareTimer) clearTimeout(this.reverbPrepareTimer);
    this.reverbPrepareTimer = null; this.reverbVersion++;
    if (this.pendingReverb) this.disposeReverb(this.pendingReverb);
    for (const path of [...this.retiringReverbs]) this.disposeReverb(path);
    this.bus?.dispose(); this.effect?.dispose(); this.wetGain?.dispose(); this.wetFilter?.dispose(); this.dryGain?.dispose();
    this.waveform?.dispose(); this.output?.dispose(); this.limiter?.dispose();
    this.liveContext?.off('statechange', this.contextStateChanged); this.liveContext?.dispose();
    this.liveContext = null; this.output = null; this.limiter = null; this.bus = null;
    this.effect = null; this.wetGain = null; this.wetFilter = null; this.dryGain = null; this.waveform = null;
    this.renderedReverbTime = -1;
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.reverbPrepareTimer) clearTimeout(this.reverbPrepareTimer);
    this.reverbPrepareTimer = null;
    this.stop();
    this.disposed = true;
    this.clearGraph();
  }
}
