import { useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { noteName } from '../music/types';
import { alterChord, hasNinth, hasSeventh, isMinor } from '../music/chordControls';
import type { ChordAction } from '../music/chordControls';
import type { Performance } from '../hooks/usePerformance';
import { lengthTicks } from '../music/performanceTypes';
export function ChordBank({ instrument: p }: { instrument: Performance }) {
  const drag = useRef<{ pointerId: number; pad: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const dragEvent = (pad: number, x: number, y: number, active: boolean) => window.dispatchEvent(new CustomEvent('thread-pad-drag', { detail: { pad, x, y, active } }));
  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
    current.moved = true;
    event.preventDefault();
    dragEvent(current.pad, event.clientX, event.clientY, true);
  };
  const pointerEnd = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const current = drag.current;
    if (current?.pointerId === event.pointerId) {
      if (current.moved) {
        suppressClick.current = true;
        window.setTimeout(() => { suppressClick.current = false; }, 0);
        if (!cancelled) {
          const timeline = document.querySelector<HTMLElement>('[data-testid="loop-timeline"]');
          const rect = timeline?.getBoundingClientRect();
          if (rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
            const loop = p.session.loop;
            const tick = (event.clientX - rect.left) / rect.width * lengthTicks(loop);
            p.addLoopBlock(current.pad, tick);
          }
        }
      }
      dragEvent(current.pad, event.clientX, event.clientY, false);
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }
    p.releasePad(`pointer:${event.pointerId}`, cancelled);
  };
  const chord = p.session.bank[p.selected];
  const pitches = p.session.bank.slice(0, p.session.padCount).flatMap(c => c.notes);
  const low = Math.min(...pitches) - 4, high = Math.max(...pitches) + 4;
  const command = (key: string, label: string, action: ChordAction, pressed?: boolean) => <button className="modifier" key={action} onClick={() => p.modify(action)} aria-pressed={pressed} title={`${label} · ${key}`}><span>{label}</span><kbd>{key}</kbd></button>;
  return <section className="chord-section" aria-label="Chord instrument">
    <div className="chord-bank" style={{ '--pads': p.session.padCount } as CSSProperties}>
      {p.session.bank.slice(0, p.session.padCount).map((c, i) => {
        const playing = p.held.includes(i);
        return <button key={i} className={`pad ${p.selected === i ? 'selected' : ''} ${playing ? 'sounding' : ''}`} aria-label={`Chord ${i + 1}, ${c.symbol}`} aria-pressed={playing} data-testid={`pad-${i + 1}`}
          onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } p.select(i); p.relinkSelectedBlock(i); }}
          onPointerDown={e => { if (e.pointerType === 'mouse' && e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { pointerId: e.pointerId, pad: i, x: e.clientX, y: e.clientY, moved: false }; p.pressPad(i, `pointer:${e.pointerId}`, false); }}
          onPointerMove={pointerMove} onPointerUp={e => pointerEnd(e)} onPointerCancel={e => pointerEnd(e, true)}
          onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); if (!e.repeat) p.pressPad(i, `button:${i}`); } }}
          onKeyUp={e => { if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); p.releasePad(`button:${i}`); } }}>
          <span className="pad-top"><kbd>{i + 1}</kbd><span className="pad-light"/></span>
          <svg className="chord-shape" viewBox="0 0 100 100" aria-hidden="true">{c.notes.map(n => <line key={n} x1="18" x2="82" y1={90 - (n - low) / (high - low) * 80} y2={90 - (n - low) / (high - low) * 80} className={playing && (p.session.arp.mode !== 'arp' || p.arpPitch === n) ? 'note-lit' : ''}/>)}</svg>
          <span className="chord-name">{c.symbol}</span><span className="pad-notes">{c.notes.map(n => noteName(n).replace(/-?\d+$/, '')).join(' · ')}</span>
        </button>;
      })}
    </div>
    <div className="modifiers" aria-label="Chord controls">
      <div className="modifier-row" aria-label="Chord quality and extensions">{command('Q', 'Major', 'major', !isMinor(chord) && !['sus2', 'sus4', 'dim'].includes(chord.quality))}{command('W', 'Minor', 'minor', isMinor(chord))}{command('E', 'Sus', 'sus', chord.quality.startsWith('sus'))}{command('R', 'Dim', 'dim', chord.quality === 'dim')}{command('T', '7', 'seventh', hasSeventh(chord) && !chord.quality.startsWith('maj'))}{command('Y', 'maj7', 'majorSeventh', chord.quality === 'maj7' || chord.quality === 'maj9')}{command('U', '9', 'ninth', hasNinth(chord))}</div>
      <div className="voicing-controls"><span className="control-name">Voicing <kbd>G + ↑/↓ all</kbd></span><div><button onClick={() => p.modify('invertDown')} disabled={alterChord(chord, 'invertDown') === chord} aria-label="Lower voicing">↓</button><button onClick={() => p.modify('invertUp')} disabled={alterChord(chord, 'invertUp') === chord} aria-label="Higher voicing">↑</button></div></div>
      <div className="root-controls"><span className="control-name">Root</span>{command('[', '−', 'rootDown')}{command(']', '+', 'rootUp')}</div>
    </div>
  </section>;
}
