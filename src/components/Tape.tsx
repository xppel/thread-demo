import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Performance } from '../hooks/usePerformance';
import { gridTicks, lengthTicks, ticksPerBar } from '../music/performanceTypes';
import type { LoopBlock, Meter } from '../music/performanceTypes';
import { snapTick, visibleLoop } from '../music/loop';
import { Menu, Stepper, Toggle } from './Controls';
import { accentPulse } from './accentPulse';
import { Icon } from './Icons';

const METER_OPTIONS = [4, 8].flatMap(denominator => Array.from({ length: 11 }, (_, i) => ({ value: `${i + 2}/${denominator}`, label: `${i + 2}/${denominator}` })));
const GRID_OPTIONS = [{ value: 'beat', label: 'Beat' }, { value: 'half', label: '½ beat' }, { value: 'quarter', label: '¼ beat' }] as const;
const QUANT_OPTIONS = [{ value: 'off', label: 'Off' }, ...GRID_OPTIONS] as const;
type Drag = { block: LoopBlock; kind: 'move' | 'left' | 'right'; startX: number; currentX: number };
type OpenPopover = 'recording' | 'timing' | 'clip' | null;

function TempoField({ value, set, disabled }: { value: number; set: (n: number) => void; disabled: boolean }) {
  const [draft, setDraft] = useState(String(value)); const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(String(value)); }, [value]);
  const commit = () => { focused.current = false; const n = Number(draft); if (/^\d{2,3}$/.test(draft) && n >= 40 && n <= 200) set(n); else setDraft(String(value)); };
  return <input className="tempo-input" aria-label="Tempo BPM" inputMode="numeric" value={draft} disabled={disabled} onFocus={() => { focused.current = true; }} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} data-shortcuts="off"/>;
}

function TapTempo({ set }: { set: (tempo: number) => void }) {
  const taps = useRef<number[]>([]);
  return <button type="button" className="tap-tempo" onClick={() => {
    const now = performance.now(), previous = taps.current.at(-1);
    taps.current = !previous || now - previous > 2000 ? [now] : [...taps.current.slice(-5), now];
    if (taps.current.length < 2) return;
    const intervals = taps.current.slice(1).map((tap, index) => tap - taps.current[index]).sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    set(Math.max(40, Math.min(200, Math.round(60000 / median))));
  }} aria-label="Tap tempo">Tap</button>;
}

export function Tape({ instrument: p }: { instrument: Performance }) {
  const loop = visibleLoop(p.session.loop), length = lengthTicks(loop), step = gridTicks(loop.meter, loop.grid);
  const taking = ['recording', 'armed', 'countIn'].includes(p.mode);
  const [drag, setDrag] = useState<Drag | null>(null), [external, setExternal] = useState<LoopBlock | null>(null), [marker, setMarker] = useState<number | null>(null);
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (p.transportFeedback && playButton.current) accentPulse(playButton.current, 'backgroundColor'); }, [p.transportFeedback]);
  const timeline = useRef<HTMLDivElement>(null), suppressClick = useRef(false);
  const selected = loop.blocks.find(block => block.id === p.selectedBlock) ?? null;
  const pxTick = (clientX: number) => { const rect = timeline.current?.getBoundingClientRect(); return rect ? (clientX - rect.left) / rect.width * length : 0; };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest('.sequence-section,.pad,.logo-button')) p.setSelectedBlock(null);
      if (!target.closest('.sequence-popover-anchor,.control-list')) setOpenPopover(null);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [p.setSelectedBlock]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenPopover(null); };
    const close = () => setOpenPopover(null);
    document.addEventListener('keydown', escape); window.addEventListener('thread-performance-shortcut', close);
    return () => { document.removeEventListener('keydown', escape); window.removeEventListener('thread-performance-shortcut', close); };
  }, []);
  useEffect(() => { if (!selected && openPopover === 'clip') setOpenPopover(null); }, [selected, openPopover]);
  useEffect(() => {
    const update = (event: Event) => {
      const { pad, x, y, active } = (event as CustomEvent<{ pad: number; x: number; y: number; active: boolean }>).detail;
      const rect = timeline.current?.getBoundingClientRect();
      const inside = Boolean(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
      setExternal(active && inside ? p.suggestedBlock(pad, pxTick(x)) : null);
    };
    window.addEventListener('thread-pad-drag', update);
    return () => window.removeEventListener('thread-pad-drag', update);
  }, [loop, p.suggestedBlock]);
  const delta = drag ? Math.round((pxTick(drag.currentX) - pxTick(drag.startX)) / step) * step : 0;
  const candidate = drag ? drag.kind === 'move' ? { ...drag.block, tick: Math.max(0, snapTick(drag.block.tick + delta, loop.meter, loop.grid)) }
    : drag.kind === 'left' ? { ...drag.block, tick: Math.max(0, Math.min(drag.block.tick + drag.block.durationTicks - step, drag.block.tick + delta)), durationTicks: drag.block.durationTicks + drag.block.tick - Math.max(0, Math.min(drag.block.tick + drag.block.durationTicks - step, drag.block.tick + delta)) }
      : { ...drag.block, durationTicks: Math.max(step, drag.block.durationTicks + delta) } : external;
  const preview = candidate ? p.previewLoopBlock(candidate, drag?.kind === 'left') : null;
  const display = drag && preview ? visibleLoop(preview) : loop;
  const begin = (event: ReactPointerEvent<HTMLElement>, block: LoopBlock, kind: Drag['kind']) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    timeline.current?.setPointerCapture(event.pointerId);
    p.setSelectedBlock(block.id); setMarker(null); setDrag({ block: kind === 'move' ? p.session.loop.blocks.find(item => item.id === block.id)! : block, kind, startX: event.clientX, currentX: event.clientX });
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    event.preventDefault();
    const moved = Math.abs(event.clientX - drag.startX) > 3;
    suppressClick.current = moved;
    if (moved && candidate && preview) p.setLoopBlock(candidate, drag.kind === 'left');
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const nudge = (difference: number, edge: 'move' | 'left' | 'right' = 'move') => {
    if (!selected) return;
    const full = p.session.loop.blocks.find(item => item.id === selected.id)!;
    const next = edge === 'move' ? { ...full, tick: Math.max(0, selected.tick + difference * step) }
      : edge === 'left' ? { ...selected, tick: Math.max(0, selected.tick + difference * step), durationTicks: selected.durationTicks - difference * step }
        : { ...selected, durationTicks: selected.durationTicks + difference * step };
    if (next.durationTicks >= step) p.setLoopBlock(next, edge === 'left');
  };
  const playable = loop.blocks.length > 0;
  const meter = `${loop.meter.numerator}/${loop.meter.denominator}`;
  return <section className="sequence-section" aria-label="Loop">
    <div className="loop-ruler-lines" aria-hidden="true">{Array.from({ length: Math.round(length / step) + 1 }, (_, index) => {
      const tick = index * step;
      const major = tick % ticksPerBar(loop.meter) === 0;
      const left = index === 0 ? '0px' : tick === length ? 'calc(100% - 1px)' : `calc((100% - 2px) * ${tick / length} + .5px)`;
      return <span key={tick} className={major ? 'bar-line' : 'subdivision-line'} style={{ left }}/>;
    })}</div>
    <div className="bar-ruler" aria-hidden="true">{Array.from({ length: loop.bars }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
    <div className="timeline-scroll" ref={timeline} data-testid="loop-timeline" onPointerMove={event => {
      if (drag) { event.preventDefault(); setDrag(current => current ? { ...current, currentX: event.clientX } : null); return; }
      if (event.target === event.currentTarget || (event.target as Element).classList.contains('timeline-track')) setMarker(snapTick(pxTick(event.clientX), loop.meter, loop.grid));
      else setMarker(null);
    }} onPointerLeave={() => { if (!drag) setMarker(null); }} onPointerUp={end} onPointerCancel={() => setDrag(null)} onClick={event => {
      if (suppressClick.current) { suppressClick.current = false; return; }
      if (event.target === event.currentTarget || (event.target as Element).classList.contains('timeline-track')) p.addLoopBlock(p.selected, pxTick(event.clientX), true);
    }}>
      <div className="timeline-track">
        {display.blocks.map(item => <div key={item.id} className={`timeline-block ${p.selectedBlock === item.id ? 'selected' : ''} ${drag?.block.id === item.id ? 'dragging' : ''}`} data-block-id={item.id} tabIndex={0} role="button" aria-label={`${p.session.bank[item.pad].symbol}, bar ${1 + Math.floor(item.tick / ticksPerBar(loop.meter))}`} style={{ left: `calc(${item.tick / length * 100}% + 2px)`, width: `max(5px, calc(${item.durationTicks / length * 100}% - 4px))`, '--clip-mix': `${25 + item.pad % 4 * 4}%` } as CSSProperties}
          onPointerDown={event => begin(event, item, 'move')} onFocus={() => p.setSelectedBlock(item.id)} onKeyDown={event => {
            if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); nudge(event.key === 'ArrowLeft' ? -1 : 1, event.shiftKey ? 'right' : 'move'); }
          }}><span className="resize-handle left" role="button" aria-label="Resize clip start" onPointerDown={event => begin(event, item, 'left')}/><span className="clip-label">{p.session.bank[item.pad].symbol}</span><span className="resize-handle right" role="button" aria-label="Resize clip end" onPointerDown={event => begin(event, item, 'right')}/></div>)}
        {p.recordedBlocks.map(item => <div key={item.id} className="timeline-ghost recording" style={{ left: `${item.tick / length * 100}%`, width: `${item.durationTicks / length * 100}%` }} aria-hidden="true"/>)}
        {candidate && !preview && <div className="timeline-ghost invalid" style={{ left: `${candidate.tick / length * 100}%`, width: `${candidate.durationTicks / length * 100}%` }} aria-hidden="true"/>}
        {external && preview && <div className="timeline-ghost external" style={{ left: `${(preview.blocks.find(block => block.id === external.id)?.tick ?? external.tick) / length * 100}%`, width: `${external.durationTicks / length * 100}%` }} aria-hidden="true"/>}
        {marker !== null && !candidate && <span className="timeline-insert" style={{ left: `${marker / length * 100}%` }} aria-hidden="true"/>}
        <span className="timeline-head" style={{ left: `${p.position / length * 100}%` }} hidden={!['playing', 'recording', 'armed'].includes(p.mode)}/>
      </div>
    </div>
    <div className="transport loop-toolbar">
      <div className="loop-playback">
        <button type="button" className="play-button key-action-button" ref={playButton} onClick={p.play} disabled={!playable || taking}><Icon name={p.mode === 'playing' ? 'stop' : 'play'}/>{p.mode === 'playing' ? 'Stop' : 'Play'}</button>
        <div className="sequence-popover-anchor"><div className="record-split" data-mode={p.mode}><button type="button" className="record-button" onClick={p.record}><Icon name={taking ? 'stop' : 'record'}/>{p.mode === 'countIn' ? 'Cancel' : p.mode === 'recording' ? 'Finish' : p.mode === 'armed' ? 'Armed' : 'Record'}</button><button type="button" className="record-settings-trigger" aria-label="Recording settings" aria-haspopup="true" aria-expanded={openPopover === 'recording'} onClick={() => setOpenPopover(openPopover === 'recording' ? null : 'recording')}>▾</button></div>
          {openPopover === 'recording' && <div className="sequence-popover recording-popover" role="group" aria-label="Recording settings"><label>Quantize <Menu label="Recording quantization" value={p.session.quantize} options={[...QUANT_OPTIONS]} onChange={p.setQuantize}/></label><div className="count-click-group"><Toggle label="Count-in" checked={p.session.countIn} onChange={p.setCountIn} compact/><Toggle label="Click" checked={p.metronome} onChange={p.setMetronome} compact/></div></div>}
        </div>
      </div>
      <div className="loop-timing">
        <div className="tempo-group"><label>BPM <TempoField value={loop.tempo} set={p.setTempo} disabled={taking}/></label><TapTempo set={p.setTempo}/></div>
        <div className="sequence-popover-anchor"><button type="button" className="timing-trigger" aria-label="Timing options" aria-haspopup="true" aria-expanded={openPopover === 'timing'} onClick={() => setOpenPopover(openPopover === 'timing' ? null : 'timing')}>Timing ▾</button>
          {openPopover === 'timing' && <div className="sequence-popover timing-popover" role="group" aria-label="Timing options"><label>Meter <Menu label="Meter" value={meter} options={METER_OPTIONS} onChange={value => { const [numerator, denominator] = value.split('/').map(Number); p.setMeter({ numerator, denominator } as Meter); }}/></label><label>Bars <Stepper label="Bars" value={loop.bars} min={1} max={16} onChange={p.setBars}/></label><label>Grid <Menu label="Block grid" value={loop.grid} options={[...GRID_OPTIONS]} onChange={p.setGrid}/></label><div className="speed-options" role="group" aria-label="Loop speed"><span>Speed</span>{([1, 2, 4] as const).map(divider => <button type="button" key={divider} aria-pressed={loop.divider === divider} onClick={() => p.setDivider(divider)}>{divider === 1 ? '1×' : `1/${divider}`}</button>)}</div></div>}
        </div>
      </div>
      <div className="loop-edit">
        <button type="button" className="quiet-button" onClick={p.restoreUndo} disabled={!p.undo || taking}><Icon name="undo"/>Undo</button><button type="button" className="quiet-button" onClick={p.restoreRedo} disabled={!p.redo || taking}>Redo</button><button type="button" className="quiet-button" onClick={p.clear} disabled={!p.session.loop.blocks.length || taking}>Clear</button>
        <div className="clip-actions-slot">{selected && <div className="sequence-popover-anchor"><button type="button" className="clip-actions-trigger" aria-label="Selected clip actions" aria-haspopup="true" aria-expanded={openPopover === 'clip'} onClick={() => setOpenPopover(openPopover === 'clip' ? null : 'clip')}>Clip ▾</button>
          {openPopover === 'clip' && <div className="sequence-popover clip-popover" role="group" aria-label="Selected clip actions"><strong>{p.session.bank[selected.pad].symbol}</strong><div><button type="button" aria-label="Move clip left" onClick={() => nudge(-1)}>←</button><button type="button" aria-label="Move clip right" onClick={() => nudge(1)}>→</button><button type="button" aria-label="Move clip start left" onClick={() => nudge(-1, 'left')}>Start −</button><button type="button" aria-label="Move clip start right" onClick={() => nudge(1, 'left')}>Start +</button><button type="button" aria-label="Shorten clip" onClick={() => nudge(-1, 'right')}>End −</button><button type="button" aria-label="Lengthen clip" onClick={() => nudge(1, 'right')}>End +</button><button type="button" onClick={() => { p.duplicateLoopBlock(selected.id); setOpenPopover(null); }}>Duplicate</button><button type="button" onClick={() => { p.removeLoopBlock(selected.id); setOpenPopover(null); }}>Delete</button></div></div>}
        </div>}</div>
      </div>
      <div className="loop-exports"><button type="button" className="export-button" onClick={p.download} disabled={!playable || taking}><Icon name="download"/>MIDI</button><button type="button" className="export-button" onClick={p.downloadAudio} disabled={!playable || taking || p.exporting}><Icon name="download"/>{p.exporting ? 'Rendering…' : 'WAV'}</button></div>
    </div>
  </section>;
}
