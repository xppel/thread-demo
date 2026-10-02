import { useEffect, useRef, useState } from 'react';
import { PerformanceAudio } from '../audio/performanceAudio';
import { arpStepTicks, resolveArpStep } from '../music/arpeggiator';
import { alterChord } from '../music/chordControls';
import { ChordAudition } from '../audio/chordAudition';
import type { AuditionNote } from '../audio/chordAudition';
import type { ChordAction } from '../music/chordControls';
import { createSession, SESSION_KEY, validateSession } from '../state/session';
import { downloadTape } from '../midi/tapeFile';
import { activeTiming, gridTicks, lengthTicks, ticksPerBar } from '../music/performanceTypes';
import type { ArpSettings, LoopBlock, Meter, Quantize, ScaleId, Session, SoundSettings } from '../music/performanceTypes';
import { activeSequence, bassPitch, blockInGap, editRetainedBlock, replaceRecordedSpans, visibleLoop } from '../music/loop';
import { newChords } from '../music/randomize';
import { retuneSession } from '../music/scale';
import type { Voice } from '../music/types';

type Mode = 'idle' | 'countIn' | 'armed' | 'recording' | 'playing';
type Hit = { pad: number; notes: Set<number>; bassNote?: number };
type Pending = { pad: number; onAt: number; onTimer: ReturnType<typeof setTimeout>; offTimer?: ReturnType<typeof setTimeout> };
type ArpCell = { column: number; row: number };
function activeLoopArpCell(session: Session, mode: Mode, tick: number): ArpCell | null {
  const { arp, loop } = session;
  if (mode !== 'playing' || arp.mode !== 'arp') return null;
  const block = loop.blocks.find(item => tick >= item.tick && tick < item.tick + item.durationTicks);
  if (!block) return null;
  const relative = tick - block.tick, stepTicks = arpStepTicks(arp);
  const withinStep = relative % stepTicks;
  if (withinStep >= stepTicks * arp.gate) return null;
  const resolved = resolveArpStep(session.bank[block.pad]?.notes ?? [], Math.floor(relative / stepTicks), arp);
  return resolved ? { column: resolved.column, row: resolved.row } : null;
}
function restore(): Session {
  try { const raw = localStorage.getItem(SESSION_KEY); if (raw) { const value = validateSession(JSON.parse(raw)); if (value) return value; } } catch { /* Optional storage. */ }
  return createSession();
}
const KEY_ACTIONS: Record<string, ChordAction> = {
  KeyQ: 'major', KeyW: 'minor', KeyE: 'sus', KeyR: 'dim',
  KeyT: 'seventh', KeyY: 'majorSeventh', KeyU: 'ninth',
  ArrowUp: 'invertUp', ArrowDown: 'invertDown',
  BracketLeft: 'rootDown', BracketRight: 'rootUp',
};
export function usePerformance({ shortcutsBlocked = false }: { shortcutsBlocked?: boolean } = {}) {
  const blocked = useRef(shortcutsBlocked); blocked.current = shortcutsBlocked;
  const [transportFeedback, setTransportFeedback] = useState(0);
  const [session, setSession] = useState(restore), ref = useRef(session);
  const [mode, setMode] = useState<Mode>('idle'), modeRef = useRef<Mode>('idle');
  const [selected, setSelected] = useState(0), selectedRef = useRef(0);
  const [selectedBlock, setSelectedBlockState] = useState<number | null>(null), selectedBlockRef = useRef<number | null>(null);
  const clipLength = useRef(gridTicks(session.loop.meter, session.loop.grid));
  const winner = useRef<string | null>(null);
  const [inputBusy, setInputBusy] = useState(false);
  const [held, setHeld] = useState<number[]>([]);
  const [hold, setHold] = useState(false), holdRef = useRef(false);
  const [arpPitch, setArpPitch] = useState<number | null>(null);
  const liveArpCells = useRef(new Map<string, ArpCell>());
  const [activeLiveArpCells, setActiveLiveArpCells] = useState<ArpCell[]>([]);
  const pressed = useRef(new Map<string, { pad: number; order: number }>()), pressOrder = useRef(0);
  const active = useRef(new Map<string, Hit>()), pending = useRef(new Map<string, Pending>());
  const [position, setPosition] = useState(0), positionRef = useRef(0);
  const [recordedBlocks, setRecordedBlocks] = useState<LoopBlock[]>([]);
  const padHolds = useRef(new Map<string, { pad: number; tick: number; order: number }>());
  const completedPads = useRef<Array<Omit<LoopBlock, 'id'> & { order: number }>>([]);
  const padOrder = useRef(0);
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const [metronome, setMetronome] = useState(false), metro = useRef(false);
  const history = useRef<{ past: Session[]; future: Session[] }>({ past: [], future: [] });
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 });
  const gesture = useRef<string | null>(null), gestureSaved = useRef(false);
  const audio = useRef<PerformanceAudio | null>(null);
  const audition = useRef<ChordAudition | null>(null);
  const monitor = useRef<ReturnType<typeof setInterval> | null>(null);
  const countTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preCountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordToken = useRef(0);
  const playToken = useRef(0), originMs = useRef(0), globalHeld = useRef(false);
  function phase(next: Mode) { modeRef.current = next; setMode(next); }
  function apply(next: Session) {
    const previous = ref.current; ref.current = next; setSession(next);
    if (previous.voice !== next.voice) audio.current?.setVoice(next.voice);
    if (previous.sound !== next.sound) audio.current?.setSound(next.sound, gesture.current === 'reverbTime');
    if (next.padCount < previous.padCount) {
      for (const [source, input] of pressed.current) if (input.pad >= next.padCount) pressed.current.delete(source);
      const invalid = [...active.current.values(), ...pending.current.values()].some(input => input.pad >= next.padCount);
      if (invalid) {
        cancelPending(); releaseAll(false, recordTime(), false);
        const latest = newestInput();
        if (latest) pressImmediate(latest[1].pad, latest[0]);
        else { winner.current = null; syncOverride(); }
      }
      setInputBusy(pressed.current.size > 0);
      if (selectedRef.current >= next.padCount) select(next.padCount - 1);
    }
    if (previous.arp !== next.arp || previous.bank !== next.bank || previous.bass !== next.bass || previous.loop.tempo !== next.loop.tempo || previous.loop.divider !== next.loop.divider) {
      for (const [source, hit] of active.current) {
        const chord = next.bank[hit.pad];
        const attacks: Array<{ id: string; midi: number; velocity: number; part: 'chords' | 'bass' }> = [];
        const bass = next.bass ? bassPitch(chord.root, chord.notes) : undefined;
        if (bass !== hit.bassNote) {
          if (hit.bassNote !== undefined) offNote(`bass:${source}`);
          hit.bassNote = bass;
          if (bass !== undefined && !(next.arp.mode === 'arp' && previous.arp.mode !== 'arp'))
            attacks.push({ id: `bass:${source}`, midi: bass, velocity: .58, part: 'bass' });
        }
        if (next.arp.mode === 'arp') {
          if (previous.arp.mode === 'arp') audio.current?.updateHeldArp(source, chord.notes, next.arp, activeTiming(next).tempo);
          else { for (const note of hit.notes) offNote(`${source}:${note}`); hit.notes.clear(); startArp(source, hit); }
        } else {
          if (previous.arp.mode === 'arp') { audio.current?.stopHeldArp(source); hit.notes.clear(); }
          const notes = new Set(chord.notes);
          for (const note of hit.notes) if (!notes.has(note)) offNote(`${source}:${note}`);
          for (const midi of notes) if (!hit.notes.has(midi)) attacks.push({ id: `${source}:${midi}`, midi, velocity: .68, part: 'chords' });
          hit.notes = notes;
        }
        if (attacks.length) audio.current?.attackBatch(attacks);
      }
    }
    if (['playing', 'recording', 'armed'].includes(modeRef.current) && (previous.bank !== next.bank || previous.loop !== next.loop || previous.arp !== next.arp || previous.bass !== next.bass)) {
      const timing = activeTiming(next);
      audio.current?.updateLoop(activeSequence(next), lengthTicks(timing), timing.tempo, next.arp);
      if (metro.current && (previous.loop.tempo !== next.loop.tempo || previous.loop.divider !== next.loop.divider || previous.loop.meter.numerator !== next.loop.meter.numerator || previous.loop.meter.denominator !== next.loop.meter.denominator))
        audio.current?.startMetronome(timing.tempo, performance.now() - positionRef.current * 60000 / timing.tempo / 480, timing.meter);
    }
  }
  function remember() {
    if (gesture.current && gestureSaved.current) return;
    history.current.past.push(ref.current);
    if (history.current.past.length > 32) history.current.past.shift();
    history.current.future = [];
    if (gesture.current) gestureSaved.current = true;
    setHistoryState({ undo: history.current.past.length, redo: 0 });
  }
  function beginGesture(name: string) { gesture.current = name; gestureSaved.current = false; }
  function endGesture() { if (gesture.current === 'reverbTime') audio.current?.commitReverbTime(); gesture.current = null; gestureSaved.current = false; }
  function select(index: number) { selectedRef.current = index; setSelected(index); }
  function setSelectedBlock(id: number | null) { selectedBlockRef.current = id; setSelectedBlockState(id); const block = ref.current.loop.blocks.find(item => item.id === id); if (block) clipLength.current = block.durationTicks; }
  function relinkSelectedBlock(pad: number) {
    const id = selectedBlockRef.current;
    if (id === null) return;
    const old = ref.current.loop.blocks.find(block => block.id === id);
    if (!old || old.pad === pad) return;
    remember(); apply({ ...ref.current, loop: { ...ref.current.loop, blocks: ref.current.loop.blocks.map(block => block.id === id ? { ...block, pad } : block) } });
  }
  function syncHeld() { setHeld([...new Set([...active.current.values()].map(value => value.pad))]); }
  function setLiveArpCell(source: string, cell: ArpCell | null) {
    if (cell) liveArpCells.current.set(source, cell);
    else liveArpCells.current.delete(source);
    setActiveLiveArpCells([...liveArpCells.current.values()].map(value => ({ ...value })));
  }
  function offNote(id: string) { audio.current?.release(id); }
  function recordTime() { return modeRef.current === 'recording' ? (audio.current?.audioTime() ?? 0) * 1000 : performance.now(); }
  function recordTick(at = recordTime()) {
    const timing = activeTiming(ref.current);
    return Math.max(0, Math.min(lengthTicks(timing), Math.round((at - originMs.current) * timing.tempo * 480 / 60000)));
  }
  function syncOverride() { audio.current?.setRecordingOverride(modeRef.current === 'recording' && active.current.size > 0); }
  function startArp(source: string, hit: Hit) {
    audio.current?.startHeldArp(source, ref.current.bank[hit.pad].notes, ref.current.arp, activeTiming(ref.current).tempo, cell => {
      if (active.current.get(source) !== hit) return;
      hit.notes = new Set(cell ? [cell.midi] : []);
      if (cell) setArpPitch(cell.midi);
      setLiveArpCell(source, cell ? { column: cell.column, row: cell.row } : null);
    }, hit.bassNote === undefined ? undefined : { id: `bass:${source}`, midi: hit.bassNote });
  }
  function pressImmediate(index: number, source: string, at = recordTime()) {
    if (index >= ref.current.padCount) return;
    winner.current = source; source = 'live';
    // Physical inputs share this one audio source. Same-pad transfers preserve arp phase.
    if (active.current.get(source)?.pad === index) { syncHeld(); return; }
    releaseAll(false, at, false);
    select(index);
    const chord = ref.current.bank[index];
    const notes = new Set(ref.current.arp.mode === 'arp' ? [] : chord.notes);
    const bassNote = ref.current.bass ? bassPitch(chord.root, chord.notes) : undefined;
    const hit: Hit = { pad: index, notes, bassNote };
    active.current.set(source, hit); syncOverride();

    if (modeRef.current === 'recording') {
      const timing = activeTiming(ref.current);
      padHolds.current.set(source, { pad: index, tick: Math.min(lengthTicks(timing) - 1, recordTick(at)), order: ++padOrder.current });
    }
    if (ref.current.arp.mode === 'arp') startArp(source, hit);
    else audio.current?.attackBatch([
      ...[...notes].map(midi => ({ id: `${source}:${midi}`, midi, velocity: .68, part: 'chords' as const })),
      ...(bassNote === undefined ? [] : [{ id: `bass:${source}`, midi: bassNote, velocity: .58, part: 'bass' as const }]),
    ]);
    syncHeld();
  }
  function releaseImmediate(source: string, force = false, at = recordTime(), reconcileBacking = true) {
    if (holdRef.current && !force) return;
    const hit = active.current.get(source); if (!hit) return;
    audio.current?.stopHeldArp(source);
    audio.current?.releaseSource(source, true, true);
    const captured = padHolds.current.get(source);
    if (captured) {
      const timing = activeTiming(ref.current);
      const end = Math.max(captured.tick + 1, Math.min(lengthTicks(timing), recordTick(at)));
      completedPads.current.push({ pad: captured.pad, tick: captured.tick, durationTicks: end - captured.tick, order: captured.order });
      padHolds.current.delete(source);
      setRecordedBlocks(completedPads.current.map((block, id) => ({ ...block, id })));
    }
    for (const note of hit.notes) offNote(`${source}:${note}`);
    if (hit.bassNote !== undefined) offNote(`bass:${source}`);
    active.current.delete(source); if (reconcileBacking) syncOverride(); setLiveArpCell(source, null); syncHeld(); if (!active.current.size) setArpPitch(null);
  }
  function releaseAll(clearPressed = true, at = recordTime(), reconcileBacking = true) {
    if (clearPressed) {
      pressed.current.clear(); winner.current = null; setInputBusy(false);
      for (const waiting of pending.current.values()) { clearTimeout(waiting.onTimer); if (waiting.offTimer) clearTimeout(waiting.offTimer); }
      pending.current.clear();
    }
    for (const source of [...active.current.keys()]) releaseImmediate(source, true, at, false);
    if (reconcileBacking) syncOverride();
  }
  function quantizedAt(now: number): number {
    const state = ref.current;
    if (modeRef.current !== 'recording' || state.quantize === 'off') return now;
    const timing = activeTiming(state);
    const stepMs = gridTicks(timing.meter, state.quantize) * 60000 / timing.tempo / 480;
    return originMs.current + Math.ceil(Math.max(0, now - originMs.current) / stepMs) * stepMs;
  }
  function cancelPending() {
    for (const item of pending.current.values()) { clearTimeout(item.onTimer); if (item.offTimer) clearTimeout(item.offTimer); }
    pending.current.clear();
  }
  function newestInput() { return [...pressed.current.entries()].sort((a, b) => b[1].order - a[1].order)[0]; }
  function queueInput(index: number, source: string, at = recordTime()) {
    cancelPending(); winner.current = source;
    if (active.current.get('live')?.pad === index) return;
    const onAt = quantizedAt(at);
    if (onAt <= at) { pressImmediate(index, source, at); return; }
    const onTimer = setTimeout(() => {
      if (modeRef.current !== 'recording' || !pending.current.has(source)) return;
      pressImmediate(index, source, onAt);
      const waiting = pending.current.get(source);
      if (!waiting?.offTimer) pending.current.delete(source);
    }, onAt - at);
    pending.current.set(source, { pad: index, onAt, onTimer });
  }
  function pressPad(index: number, source: string, relink = true) {
    if (index >= ref.current.padCount) return;
    select(index);
    if (relink && modeRef.current !== 'recording') relinkSelectedBlock(index);
    if (['playing', 'countIn', 'armed'].includes(modeRef.current) || pressed.current.has(source)) return;
    audition.current?.cancel(); setNotice('');
    pressed.current.set(source, { pad: index, order: ++pressOrder.current }); setInputBusy(true);
    queueInput(index, source);
  }
  function releasePad(source: string, force = false) {
    // Component and window pointerup can both see a queued release. Do not
    // orphan its timer or allow that stale callback to stop a later winner.
    if (!pressed.current.has(source) && (!pending.current.has(source) || (pending.current.get(source)?.offTimer && !force))) return;
    pressed.current.delete(source); setInputBusy(pressed.current.size > 0);
    if (winner.current !== source) return;
    if (holdRef.current && !force) {
      const waiting = pending.current.get(source);
      if (!waiting) winner.current = null;
      return;
    }
    const next = newestInput();
    if (next) { queueInput(next[1].pad, next[0]); return; }
    const waiting = pending.current.get(source);
    const at = recordTime();
    const offAt = force ? at : Math.max(quantizedAt(at), waiting ? waiting.onAt + gridTicks(activeTiming(ref.current).meter, ref.current.quantize === 'off' ? 'beat' : ref.current.quantize) * 60000 / activeTiming(ref.current).tempo / 480 : at);
    const release = () => { cancelPending(); winner.current = null; releaseImmediate('live', true, offAt); };
    if (offAt > at) {
      const offTimer = setTimeout(release, offAt - at);
      pending.current.set(source, { pad: waiting?.pad ?? active.current.get('live')?.pad ?? 0, onAt: waiting?.onAt ?? offAt, onTimer: waiting?.onTimer ?? offTimer, offTimer });
    } else release();
  }
  function toggleHold() {
    holdRef.current = !holdRef.current; setHold(holdRef.current);
    if (holdRef.current) {
      for (const [source, waiting] of pending.current) {
        if (!waiting.offTimer) continue;
        clearTimeout(waiting.offTimer);
        if (waiting.onTimer === waiting.offTimer) pending.current.delete(source);
        else delete waiting.offTimer; // Preserve a genuine future attack.
      }
      return;
    }
    cancelPending();
    const next = newestInput();
    if (next) pressImmediate(next[1].pad, next[0]);
    else { winner.current = null; releaseImmediate('live', true); }
  }
  function setArp(update: Partial<ArpSettings>) {
    if (Object.entries(update).every(([key, value]) => ref.current.arp[key as keyof ArpSettings] === value)) return;
    remember(); apply({ ...ref.current, arp: { ...ref.current.arp, ...update } });
  }
  function modify(action: ChordAction, global = false) {
    const focus = selectedRef.current;
    const bank = ref.current.bank.map((chord, index) => global && index < ref.current.padCount || index === focus ? alterChord(chord, action) : chord);
    if (bank.every((chord, index) => chord === ref.current.bank[index])) return;
    const next = { ...ref.current, bank };
    remember();
    apply(next); select(focus);
  }
  function stopMonitor() { if (monitor.current) clearInterval(monitor.current); monitor.current = null; }
  function halt(preserveRecordRequest = false) {
    if (!preserveRecordRequest) recordToken.current++;
    audition.current?.cancel();
    playToken.current++;
    if (countTimer.current) clearTimeout(countTimer.current); countTimer.current = null;
    if (preCountTimer.current) clearTimeout(preCountTimer.current); preCountTimer.current = null;
    for (const item of pending.current.values()) { clearTimeout(item.onTimer); if (item.offTimer) clearTimeout(item.offTimer); }
    pending.current.clear(); releaseAll(); audio.current?.stop(); stopMonitor(); positionRef.current = 0; setPosition(0); setRecordedBlocks([]); phase('idle');
  }
  function pauseForAudio() {
    if (modeRef.current === 'recording') finish();
    halt();
  }
  async function play(take = ref.current, startTick = 0, allowEmpty = false, recordingRequest?: number) {
    if (recordingRequest !== undefined && recordingRequest !== recordToken.current) return;
    const events = activeSequence(take);
    if (!events.length && !allowEmpty) { setNotice('Add a block or record a take first.'); return; }
    setNotice(''); halt(recordingRequest !== undefined); const token = ++playToken.current; phase('playing');
    audio.current?.setVoice(take.voice); audio.current?.setSound(take.sound);
    const timing = activeTiming(take);
    await audio.current?.loop(events, lengthTicks(timing), timing.tempo, tick => { positionRef.current = tick; setPosition(tick); }, () => { if (token === playToken.current) phase('idle'); }, startTick, allowEmpty, take.arp);
    if (metro.current && token === playToken.current && modeRef.current === 'playing') {
      const origin = performance.now() - startTick * 60000 / timing.tempo / 480;
      audio.current?.startMetronome(timing.tempo, origin, timing.meter);
    }
  }
  function finish() {
    recordToken.current++;
    const now = recordTime(), timing = activeTiming(ref.current), end = lengthTicks(timing);
    for (const item of pending.current.values()) { clearTimeout(item.onTimer); if (item.offTimer) clearTimeout(item.offTimer); }
    pending.current.clear();
    for (const [source, hold] of padHolds.current) {
      const stopTick = Math.max(hold.tick + 1, Math.min(end, recordTick(now)));
      completedPads.current.push({ pad: hold.pad, tick: hold.tick, durationTicks: stopTick - hold.tick, order: hold.order });
      padHolds.current.delete(source);
    }
    const step = ref.current.quantize === 'off' ? 0 : gridTicks(timing.meter, ref.current.quantize);
    const pads = completedPads.current.sort((a, b) => a.tick - b.tick || a.order - b.order)
      .map(({ pad, tick, durationTicks }) => {
        if (!step) return { pad, tick, durationTicks };
        const start = Math.min(end - 1, Math.round(tick / step) * step);
        const stop = Math.min(end, Math.max(start + step, Math.round((tick + durationTicks) / step) * step));
        return { pad, tick: start, durationTicks: stop - start };
      });
    completedPads.current = [];
    releaseAll(); stopMonitor(); setRecordedBlocks([]);
    phase('playing');
    if (!pads.length) { setNotice('No notes recorded.'); return; }
    const nextLoop = replaceRecordedSpans(ref.current.loop, pads, ref.current.padCount, step ? 0 : Math.min(.02 * timing.tempo * 480 / 60, gridTicks(timing.meter, ref.current.loop.grid) / 16));
    if (!nextLoop) { setNotice('The take could not fit in the loop.'); return; }
    remember(); apply({ ...ref.current, loop: nextLoop }); setNotice('Take added to loop.');
  }

  function stop() { audition.current?.cancel(); if (modeRef.current === 'recording') finish(); else halt(); }
  function transportAction() {
    setTransportFeedback(value => value + 1);
    if (['playing', 'countIn', 'armed'].includes(modeRef.current)) stop();
    else if (modeRef.current === 'recording') finish();
    else void play();
  }
  function auditionChord() {
    if (modeRef.current !== 'idle' || pressed.current.size || active.current.size || pending.current.size) return false;
    setNotice('');
    const current = ref.current;
    const pads = current.bank.slice(0, current.padCount);
    void audition.current?.play(pads.length, index => {
      const chord = pads[index];
      const notes: AuditionNote[] = chord.notes.map(midi => ({ midi, velocity: .68, part: 'chords' }));
      if (current.bass) notes.push({ midi: bassPitch(chord.root, chord.notes), velocity: .58, part: 'bass' as const });
      return notes;
    });
    return true;
  }
  function record() {
    audition.current?.cancel();
    if (modeRef.current === 'recording') { finish(); return; }
    if (modeRef.current === 'armed' || modeRef.current === 'countIn') { stop(); return; }
    const wasPlaying = modeRef.current === 'playing';
    if (!wasPlaying) halt();
    const request = ++recordToken.current;
    const timing = activeTiming(ref.current), length = lengthTicks(timing);
    const beatMs = 60000 / timing.tempo, barMs = ticksPerBar(timing.meter) / 480 * beatMs;
    let targetOrigin: number | null = null;
    const begin = async () => {
      countTimer.current = null;
      if (request !== recordToken.current || !['armed', 'countIn'].includes(modeRef.current)) return;
      if (!wasPlaying) await play(ref.current, 0, true, request);
      if (request !== recordToken.current || !['playing', 'armed', 'countIn'].includes(modeRef.current)) return;
      const clock = audio.current?.playbackClock();
      if (!clock) return;
      if (targetOrigin !== null && clock.audioTime < targetOrigin) {
        countTimer.current = setTimeout(() => { void begin(); }, (targetOrigin - clock.audioTime) * 1000); return;
      }
      const now = (targetOrigin ?? clock.origin) * 1000;
      completedPads.current = []; padHolds.current.clear(); originMs.current = now; phase('recording'); syncOverride();
      setNotice('Recording into loop…');
      monitor.current = setInterval(() => {
        const at = recordTime();
        if (modeRef.current !== 'recording') return;
        if (recordTick(at) >= length) finish();
      }, 25);
    };
    if (wasPlaying) {
      phase('armed'); setNotice('Recording at next loop start…');
      const clock = audio.current?.playbackClock();
      const untilWrap = clock ? (length - clock.tick) * clock.secondsPerTick * 1000 : (length - positionRef.current) * beatMs / 480;
      const delay = untilWrap < (ref.current.countIn ? barMs : 0) ? untilWrap + length * beatMs / 480 : untilWrap;
      targetOrigin = clock ? clock.audioTime + delay / 1000 : null;
      if (ref.current.countIn) preCountTimer.current = setTimeout(() => { if (request === recordToken.current && modeRef.current === 'armed') audio.current?.startMetronome(timing.tempo, performance.now(), timing.meter); }, delay - barMs);
      countTimer.current = setTimeout(() => { audio.current?.stopMetronome(); void begin(); }, delay);
    } else {
      if (ref.current.countIn) {
        phase('countIn'); setNotice('Count in…');
        void audio.current?.unlock().then(() => { if (request === recordToken.current && modeRef.current === 'countIn') audio.current?.startMetronome(timing.tempo, performance.now(), timing.meter); });
        countTimer.current = setTimeout(() => { audio.current?.stopMetronome(); void begin(); }, barMs);
      } else { phase('armed'); void begin(); }
    }
  }
  useEffect(() => {
    const engine = new PerformanceAudio(message => setNotice(message), pauseForAudio); audio.current = engine;
    audition.current = new ChordAudition(
      () => engine.unlock(),
      notes => engine.attackBatch(notes),
      id => engine.stopNote(id),
    );
    engine.setVoice(ref.current.voice); engine.setSound(ref.current.sound);
    const editing = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      return target?.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName);
    };
    const navigation = (event: KeyboardEvent) => Boolean((event.target as HTMLElement)?.closest('[role="slider"],[role="listbox"],.control-menu')) && /^(Arrow|Home|End|Page)/.test(event.code);
    const tutorialButton = (event: KeyboardEvent) => Boolean((event.target as HTMLElement)?.closest('.tour-panel button,.tour-panel a'));
    const instrumentKey = () => window.dispatchEvent(new Event('thread-performance-shortcut'));
    const digit = (code: string) => /^(Digit|Numpad)[1-6]$/.test(code);
    const shifts = new Map<string, { used: boolean; toggled: boolean }>();
    const keydown = (event: KeyboardEvent) => {
      if (blocked.current || editing(event) || (event.code === 'Space' && tutorialButton(event))) return;
      if (event.code === 'Space') { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) { instrumentKey(); transportAction(); } return; }
      if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
        if (event.repeat || shifts.has(event.code)) return;
        const toggled = pressed.current.size > 0 || active.current.size > 0 || pending.current.size > 0;
        shifts.set(event.code, { used: false, toggled });
        if (toggled) toggleHold();
        return;
      }
      if (!event.repeat) for (const shift of shifts.values()) shift.used = true;
      if (event.code === 'Escape') { if (!editing(event)) { event.preventDefault(); stop(); } return; }
      if (navigation(event) || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.code === 'Delete' || event.code === 'Backspace') && selectedBlockRef.current !== null) { event.preventDefault(); removeLoopBlock(selectedBlockRef.current); return; }
      if (event.code === 'KeyG') { globalHeld.current = true; return; }
      if (digit(event.code)) { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) { instrumentKey(); pressPad(Number(event.code.slice(-1)) - 1, `key:${event.code}`); } return; }
      if (event.code === 'Equal' || event.code === 'NumpadAdd') { event.preventDefault(); if (!event.repeat) setKey((ref.current.key + 1) % 12); return; }
      if (event.code === 'Minus' || event.code === 'NumpadSubtract') { event.preventDefault(); if (!event.repeat) setKey((ref.current.key + 11) % 12); return; }
      const action = KEY_ACTIONS[event.code];
      if (action) { event.preventDefault(); if (!event.repeat || event.code.startsWith('Arrow')) modify(action, globalHeld.current && event.code.startsWith('Arrow')); }
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.code === 'Space') { if (!blocked.current && !editing(event) && !tutorialButton(event)) { event.preventDefault(); event.stopImmediatePropagation(); } return; }
      if (event.code === 'KeyG') globalHeld.current = false;
      if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
        const shift = shifts.get(event.code); shifts.delete(event.code);
        if (shift && !shift.used && !shift.toggled && !blocked.current && !editing(event)) toggleHold();
      }
      if (digit(event.code)) releasePad(`key:${event.code}`);
    };
    const blur = () => { shifts.clear(); audition.current?.cancel(); globalHeld.current = false; if (modeRef.current === 'recording') finish(); else if (modeRef.current === 'armed' || modeRef.current === 'countIn') stop(); else releaseAll(); };
    const leavePage = () => {
      if (modeRef.current === 'recording') finish(); // Preserve the partial take.
      halt();
    };
    const hidden = () => { if (document.hidden) leavePage(); engine.setPageActive(!document.hidden); };
    const pageHide = () => { leavePage(); engine.setPageActive(false); };
    hidden();
    const pointerUp = (event: PointerEvent) => releasePad(`pointer:${event.pointerId}`);
    const pointerCancel = (event: PointerEvent) => releasePad(`pointer:${event.pointerId}`, true);
    window.addEventListener('keydown', keydown, true); window.addEventListener('keyup', keyup, true); window.addEventListener('pointerup', pointerUp); window.addEventListener('pointercancel', pointerCancel); window.addEventListener('blur', blur); window.addEventListener('pagehide', pageHide); window.addEventListener('pageshow', hidden);
    document.addEventListener('visibilitychange', hidden);
    return () => { audition.current?.cancel(); audition.current = null; releaseAll(); stopMonitor(); engine.dispose();
      window.removeEventListener('keydown', keydown, true); window.removeEventListener('keyup', keyup, true); window.removeEventListener('pointerup', pointerUp); window.removeEventListener('pointercancel', pointerCancel); window.removeEventListener('blur', blur);
      window.removeEventListener('pagehide', pageHide); window.removeEventListener('pageshow', hidden); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* Storage optional. */ } }, [session]);
  function setTempo(tempo: number) {
    if (modeRef.current === 'recording' || modeRef.current === 'armed' || modeRef.current === 'countIn') return;
    const value = Math.max(40, Math.min(200, Math.round(tempo)));
    if (value === ref.current.loop.tempo) return;
    const next = { ...ref.current, loop: { ...ref.current.loop, tempo: value } };
    remember(); apply(next);
  }
  function setBars(bars: number) {
    if (modeRef.current === 'recording' || modeRef.current === 'armed' || modeRef.current === 'countIn') return;
    const value = Math.max(1, Math.min(16, Math.round(bars)));
    if (value === ref.current.loop.bars) return;
    remember();
    apply({ ...ref.current, loop: { ...ref.current.loop, bars: value } });
    if (!visibleLoop(ref.current.loop).blocks.some(block => block.id === selectedBlockRef.current)) setSelectedBlock(null);
  }
  function setMeter(meter: Meter) {
    if (modeRef.current === 'recording' || modeRef.current === 'armed' || modeRef.current === 'countIn') return;
    remember();
    apply({ ...ref.current, loop: { ...ref.current.loop, meter } });
    if (!visibleLoop(ref.current.loop).blocks.some(block => block.id === selectedBlockRef.current)) setSelectedBlock(null);
  }
  function previewLoopBlock(block: LoopBlock, strict = false) { return editRetainedBlock(ref.current.loop, block, ref.current.padCount, strict); }
  function setLoopBlock(block: LoopBlock, strict = false) { const loop = previewLoopBlock(block, strict); if (!loop) { setNotice('That clip will not fit or would overlap retained content.'); return false; } if (JSON.stringify(loop.blocks) === JSON.stringify(ref.current.loop.blocks)) return true; const original = ref.current.loop.blocks.find(item => item.id === block.id); remember(); apply({ ...ref.current, loop }); if (!original || original.durationTicks !== block.durationTicks) clipLength.current = block.durationTicks; return true; }
  function suggestedBlock(pad: number, tick: number, gapOnly = false) {
    const current = ref.current;
    return gapOnly ? blockInGap(current.loop, pad, tick, clipLength.current)
      : { id: Math.max(0, ...current.loop.blocks.map(block => block.id + 1)), pad, tick, durationTicks: clipLength.current };
  }
  function addLoopBlock(pad: number, tick: number, gapOnly = false) {
    const candidate = suggestedBlock(pad, tick, gapOnly);
    if (!candidate || !setLoopBlock(candidate)) return null;
    setSelectedBlock(candidate.id); return candidate.id;
  }
  function removeLoopBlock(id: number) { if (!ref.current.loop.blocks.some(block => block.id === id)) return; remember(); apply({ ...ref.current, loop: { ...ref.current.loop, blocks: ref.current.loop.blocks.filter(block => block.id !== id) } }); if (selectedBlockRef.current === id) setSelectedBlock(null); }
  function duplicateLoopBlock(id: number) {
    const current = ref.current, original = current.loop.blocks.find(block => block.id === id);
    if (!original) return false;
    const sorted = [...current.loop.blocks].sort((a, b) => a.tick - b.tick);
    let tick = original.tick + original.durationTicks;
    for (const block of sorted) {
      if (tick + original.durationTicks <= block.tick) break;
      if (tick < block.tick + block.durationTicks && tick + original.durationTicks > block.tick) tick = block.tick + block.durationTicks;
    }
    const loop = editRetainedBlock(current.loop, { ...original, id: Math.max(0, ...sorted.map(block => block.id + 1)), tick }, current.padCount);
    if (!loop) { setNotice('That clip will not fit or would overlap retained content.'); return false; }
    remember(); apply({ ...current, loop }); return true;
  }

  function setGrid(grid: Session['loop']['grid']) { if (grid === ref.current.loop.grid) return; remember(); apply({ ...ref.current, loop: { ...ref.current.loop, grid } }); }
  function setDivider(divider: Session['loop']['divider']) { if (divider === ref.current.loop.divider) return; remember(); apply({ ...ref.current, loop: { ...ref.current.loop, divider } }); }
  function setVoice(voice: Voice) { if (voice === ref.current.voice) return; remember(); apply({ ...ref.current, voice }); }
  function setSound(update: Partial<SoundSettings>) { if (Object.entries(update).every(([key, value]) => ref.current.sound[key as keyof SoundSettings] === value)) return; remember(); apply({ ...ref.current, sound: { ...ref.current.sound, ...update } }); }
  function setBass(bass: boolean) { if (bass === ref.current.bass) return; remember(); apply({ ...ref.current, bass }); }
  function setPadCount(padCount: number) {
    const value = Math.max(1, Math.min(6, Math.round(padCount)));
    if (value === ref.current.padCount) return;
    remember(); releaseAll(); select(Math.min(selectedRef.current, value - 1));
    const blocks = ref.current.loop.blocks.filter(block => block.pad < value);
    apply({ ...ref.current, padCount: value, loop: { ...ref.current.loop, blocks } });
    if (selectedBlockRef.current !== null && !blocks.some(block => block.id === selectedBlockRef.current)) setSelectedBlock(null);
  }
  function setKey(key: number) { const next = retuneSession(ref.current, (key + 12) % 12, ref.current.scale); if (next === ref.current) { if (!ref.current.keyLocked) setKeyLocked(true); return; } remember(); apply({ ...next, keyLocked: true }); }
  function setScale(scale: ScaleId) { const next = retuneSession(ref.current, ref.current.key, scale); if (next === ref.current) { if (!ref.current.keyLocked) setKeyLocked(true); return; } remember(); apply({ ...next, keyLocked: true }); }
  function setKeyLocked(keyLocked: boolean) { if (keyLocked === ref.current.keyLocked) return; remember(); apply({ ...ref.current, keyLocked }); }
  function randomize() {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const next = newChords(ref.current, seed); remember(); apply(next); setNotice('New chords ready.');
  }
  function restoreUndo() { const previous = history.current.past.pop(); if (!previous) return; history.current.future.push(ref.current); apply(previous); if (selectedBlockRef.current !== null && !previous.loop.blocks.some(block => block.id === selectedBlockRef.current)) setSelectedBlock(null); setHistoryState({ undo: history.current.past.length, redo: history.current.future.length }); }
  function restoreRedo() { const next = history.current.future.pop(); if (!next) return; history.current.past.push(ref.current); apply(next); if (selectedBlockRef.current !== null && !next.loop.blocks.some(block => block.id === selectedBlockRef.current)) setSelectedBlock(null); setHistoryState({ undo: history.current.past.length, redo: history.current.future.length }); }
  function clear() { remember(); apply({ ...ref.current, loop: { ...ref.current.loop, blocks: [] } }); setSelectedBlock(null); }
  async function downloadAudio() { if (!activeSequence(ref.current).length || exporting) return; setExporting(true); try { const { downloadWav } = await import('../audio/wav'); await downloadWav(ref.current); setNotice('WAV downloaded.'); } catch { setNotice('Audio export could not finish. MIDI remains available.'); } finally { setExporting(false); } }
  const loopCell = activeLoopArpCell(session, mode, position);
  const activeArpCells = [...new Map([...activeLiveArpCells, ...(loopCell ? [loopCell] : [])]
    .map(cell => [`${cell.column}:${cell.row}`, cell] as const)).values()];
  return {
    session, mode, selected, selectedBlock, recordedBlocks, held, hold, arpPitch,
    activeArpCells,
    position, notice, exporting, metronome, undo: historyState.undo, redo: historyState.redo,
    pressPad, releasePad, select, setSelectedBlock, relinkSelectedBlock, suggestedBlock, addLoopBlock, modify, toggleHold, setArp, setTempo, setBars, setMeter, setLoopBlock, previewLoopBlock, removeLoopBlock, duplicateLoopBlock, setGrid, setDivider,
    setVoice, setSound, setBass, setPadCount, setKey, setScale, setKeyLocked, randomize, restoreUndo, restoreRedo, clear, beginGesture, endGesture,
    setQuantize: (quantize: Quantize) => { remember(); apply({ ...ref.current, quantize }); }, setCountIn: (countIn: boolean) => { remember(); apply({ ...ref.current, countIn }); },
    play: transportAction, transportFeedback, stop, record, auditionChord, auditionAvailable: mode === 'idle' && !inputBusy && held.length === 0 && pending.current.size === 0, downloadAudio,
    getWaveform: () => audio.current?.getWaveform() ?? new Float32Array(256),
    setMetronome: (value: boolean) => { metro.current = value; setMetronome(value); if (!value) audio.current?.stopMetronome(); else if (modeRef.current === 'playing') { const timing = activeTiming(ref.current); audio.current?.startMetronome(timing.tempo, performance.now() - positionRef.current * 60000 / timing.tempo / 480, timing.meter); } },
    download: () => { if (activeSequence(ref.current).length) { downloadTape(ref.current); setNotice('MIDI downloaded.'); } },
  };
}
export type Performance = ReturnType<typeof usePerformance>;
