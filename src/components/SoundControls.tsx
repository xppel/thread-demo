import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Performance } from '../hooks/usePerformance';
import type { Voice } from '../music/types';
import { noteName } from '../music/types';
import { arpNotes, randomArpSettings, resolveArpStep } from '../music/arpeggiator';
import { accentPulse } from './accentPulse';
import { Knob, Menu, Toggle } from './Controls';

const VOICES: Voice[] = ['Felt', 'Glass', 'Current', 'Pluck', 'Reed', 'Air'];
const RATES = [2, 4, 8, 16, 32] as const;
function Scope({ instrument: p }: { instrument: Performance }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const redraw = useRef<() => void>(() => {});
  const waveform = useRef(p.getWaveform);
  waveform.current = p.getWaveform;
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    let frame = 0;
    const draw = () => {
      const element = canvas.current;
      if (!element || document.hidden) return;
      const width = element.clientWidth, height = element.clientHeight;
      const bounds = element.getBoundingClientRect();
      const pixelWidth = Math.max(1, Math.round(bounds.width * devicePixelRatio));
      const pixelHeight = Math.max(1, Math.round(bounds.height * devicePixelRatio));
      if (element.width !== pixelWidth || element.height !== pixelHeight) { element.width = pixelWidth; element.height = pixelHeight; }
      context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const values = reduced ? new Float32Array(256) : waveform.current();
      const peak = values.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
      const gain = peak > .0002 ? Math.min(64, .7 / peak) : 0;
      context.clearRect(0, 0, width, height);
      context.strokeStyle = getComputedStyle(element).color;
      context.lineWidth = .65;
      context.beginPath();
      for (let i = 0; i < width; i++) {
        const y = height / 2 - (values[Math.floor(i / width * values.length)] ?? 0) * gain * height * .4;
        if (i === 0) context.moveTo(i, y); else context.lineTo(i, y);
      }
      context.stroke();
      if (!reduced) frame = requestAnimationFrame(draw);
    };
    const visibility = () => { cancelAnimationFrame(frame); if (!document.hidden) frame = requestAnimationFrame(draw); };
    redraw.current = visibility;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    motion.addEventListener('change', visibility);
    window.addEventListener('resize', visibility);
    document.addEventListener('visibilitychange', visibility);
    draw();
    return () => { redraw.current = () => {}; cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('resize', visibility); motion.removeEventListener('change', visibility); };
  }, []);
  // Theme and fit changes still repaint the stationary reduced-motion scope.
  useEffect(() => { if (matchMedia('(prefers-reduced-motion: reduce)').matches) redraw.current(); });
  return <canvas ref={canvas} className="scope" width="174" height="174" aria-label="Audio waveform" role="img"/>;
}

type Paint = { pointerId: number; erase: boolean; steps: Array<number | null> };
function ArpMatrix({ instrument: p }: { instrument: Performance }) {
  const notes = p.session.bank[p.selected].notes;
  const pitches = arpNotes(notes);
  const ghosts = new Set<string>();
  if (p.session.arp.reverse || p.session.arp.mirror) {
    for (let column = 0; column < 8; column++) {
      const cell = resolveArpStep(notes, 8 + column, p.session.arp);
      if (cell) ghosts.add(`${cell.column}:${cell.row}`);
    }
  }
  const sounding = new Set(p.activeArpCells.map(cell => `${cell.column}:${cell.row}`));
  const grid = useRef<HTMLDivElement>(null);
  const paint = useRef<Paint | null>(null);
  const draw = (column: number, row: number) => {
    const gesture = paint.current;
    if (!gesture) return;
    const value = gesture.erase ? null : row;
    if (gesture.steps[column] === value) return;
    gesture.steps[column] = value;
    p.setArp({ steps: [...gesture.steps] });
  };
  const begin = (event: ReactPointerEvent<HTMLButtonElement>, column: number, row: number) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    p.beginGesture('arp-pattern');
    paint.current = { pointerId: event.pointerId, erase: p.session.arp.steps[column] === row, steps: [...p.session.arp.steps] };
    grid.current?.setPointerCapture(event.pointerId);
    draw(column, row);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!paint.current || paint.current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>('.arp-matrix [data-column]');
    if (cell && grid.current?.contains(cell)) draw(Number(cell.dataset.column), Number(cell.dataset.row));
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!paint.current || paint.current.pointerId !== event.pointerId) return;
    event.preventDefault(); paint.current = null;
    if (grid.current?.hasPointerCapture(event.pointerId)) grid.current.releasePointerCapture(event.pointerId);
    p.endGesture();
  };
  return <div className="arp-matrix" ref={grid} role="group" aria-label="Eight step arpeggiator pattern" data-shortcuts="off" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
    {Array.from({ length: 8 }, (_, index) => 7 - index).map(row => <div className="arp-matrix-row" key={row}>
      {Array.from({ length: 8 }, (_, column) => <button type="button" key={column} data-column={column} data-row={row}
        aria-label={`Step ${column + 1}, chord tone ${row + 1}, ${noteName(pitches[row])}`}
        aria-pressed={p.session.arp.steps[column] === row}
        className={[p.session.arp.steps[column] === row ? 'active' : '', ghosts.has(`${column}:${row}`) ? 'ghost' : '', sounding.has(`${column}:${row}`) ? 'sounding' : ''].filter(Boolean).join(' ')}
        onPointerDown={event => begin(event, column, row)}
        onClick={event => { if (event.detail !== 0) return; const steps = [...p.session.arp.steps]; steps[column] = steps[column] === row ? null : row; p.setArp({ steps }); }}/>)}</div>)}
  </div>;
}

export function SoundControls({ instrument: p }: { instrument: Performance }) {
  const arp = p.session.arp, sound = p.session.sound;
  const knob = (label: string, key: keyof typeof sound) => <Knob label={label} value={sound[key]} onChange={value => p.setSound({ [key]: value })}
    onGestureStart={() => p.beginGesture(key)} onGestureEnd={p.endGesture}/>;
  return <section className="sound-controls" aria-label="Sound and arpeggiator">
    <div className="sound-pane" role="group" aria-label="Sound"><div className="sound-pane-body"><div className="scope-tile"><Scope instrument={p}/></div>
      <div className="sound-main"><div className="sound-voice"><div className="voice-select"><span className="control-name">Voice</span><Menu label="Voice" value={p.session.voice} options={VOICES.map(value => ({ value, label: value }))} onChange={p.setVoice} matchTriggerWidth/></div><Toggle label="Bass" checked={p.session.bass} onChange={p.setBass} compact/></div>
        <div className="sound-parameters">{knob('Attack', 'attack')}{knob('Color', 'color')}{knob('Reverb', 'reverbAmount')}{knob('Decay', 'decay')}{knob('Texture', 'texture')}{knob('Time', 'reverbTime')}</div></div>
    </div></div>
    <div className="arp-pane" role="group" aria-label="Arpeggiator">
      <div className="arp-pane-body">
        <ArpMatrix instrument={p}/>
        <div className="arp-options">
          <div className="arp-top-row"><Toggle label="Arpeggiator" checked={arp.mode === 'arp'} onChange={checked => p.setArp({ mode: checked ? 'arp' : 'off' })}/><button className="standard-button arp-random key-action-button" aria-label="Randomize arpeggiator" onClick={event => { p.setArp(randomArpSettings(arp, crypto.getRandomValues(new Uint32Array(1))[0])); accentPulse(event.currentTarget, 'backgroundColor'); }}>Randomize</button></div>
          <div className="arp-rate-row"><Knob label="Rate" value={arp.division} values={RATES} formatValue={value => `/${value}`} onChange={division => p.setArp({ division: division as typeof RATES[number] })} onGestureStart={() => p.beginGesture('arp-rate')} onGestureEnd={p.endGesture}/><Knob label="Octave" value={arp.register} values={[-1, 0, 1]} formatValue={value => value > 0 ? `+${value}` : String(value)} onChange={register => p.setArp({ register: register as -1 | 0 | 1 })} onGestureStart={() => p.beginGesture('arp-octave')} onGestureEnd={p.endGesture}/><Knob label="Gate" min={.1} value={arp.gate} onChange={gate => p.setArp({ gate: Math.max(.1, gate) })} onGestureStart={() => p.beginGesture('gate')} onGestureEnd={p.endGesture}/></div>
          <div className="arp-shape-row"><Toggle label="Triplet" checked={arp.triplet} onChange={triplet => p.setArp({ triplet })} compact/><Toggle label="Reverse" checked={arp.reverse} onChange={reverse => p.setArp({ reverse })} compact/><Toggle label="Mirror" checked={arp.mirror} onChange={mirror => p.setArp({ mirror })} compact/></div>
        </div>
      </div>
    </div>
  </section>;
}
