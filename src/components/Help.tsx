import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import { Icon } from './Icons';

const INTRO_KEY = 'thread.demo.intro.seen.v1';
export function firstVisit() { try { return localStorage.getItem(INTRO_KEY) !== '1'; } catch { return true; } }
export function dismissIntroduction() { try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* Optional storage. */ } }
const steps = [
  { title: 'Play the chords', target: '.chord-section', text: 'Press a pad or keys 1–6 to play. Select a chord to change its shape and voicing. The newest pad takes over. Release it to return to a pad you’re still pressing; Hold latches the newest chord.' },
  { title: 'Build a sequence', target: '.sequence-section', text: 'Drag pads into the sequence, then move or resize clips. Play or Space starts and stops the loop. Fewer Bars hides later material; increasing Bars brings it back.' },
  { title: 'Shape the sound', target: '.sound-pane', text: 'Choose a Voice, add Bass, and click or drag the sliders to shape the sound. Attack and Decay control the envelope; Color, Texture, Reverb, and Time change its character.' },
  { title: 'Make an arpeggio', target: '.arp-pane', text: 'Enable Arpeggiator and paint the grid. Rate and Octave snap to choices; Gate sets note length. Triplet, Reverse, and Mirror add variation. Randomize creates a new pattern and settings.' },
  { title: 'Take it with you', target: '.loop-exports', text: 'Download MIDI to edit the notes in your DAW, or WAV to keep the sound. Undo and Redo let you explore. Info and the / or ? key bring this guide back anytime.' },
];
export function Help({ step, setStep, close, silence, colors, keyboardOpened }: {
  step: number | 'info'; setStep: (step: number) => void; close: (keyboard?: boolean) => void; silence: () => void;
  colors: CSSProperties; keyboardOpened: boolean;
}) {
  const tour = step !== 'info';
  const panel = useRef<HTMLElement>(null);
  const keyboardInteraction = useRef(keyboardOpened);
  const [position, setPosition] = useState<CSSProperties>({});
  const [highlight, setHighlight] = useState<CSSProperties>({});
  const callbacks = useRef({ close, silence, step }); callbacks.current = { close, silence, step };
  useLayoutEffect(() => {
    if (tour ? keyboardInteraction.current : keyboardOpened) panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    else if (tour) (document.activeElement as HTMLElement)?.blur();
    else panel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (panel.current?.contains(event.target as Node)) keyboardInteraction.current = true;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); callbacks.current.silence(); callbacks.current.close(true); return; }
      if (event.key !== 'Tab' || callbacks.current.step !== 'info') return;
      const buttons = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') ?? [])];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [tour, keyboardOpened]);
  useLayoutEffect(() => {
    const update = () => {
      if (step === 'info') { setPosition({}); setHighlight({}); return; }
      const bounds = document.querySelector(steps[step].target)?.getBoundingClientRect();
      if (!bounds) return;
      const width = Math.min(380, innerWidth - 24), height = panel.current?.offsetHeight ?? 230;
      const padding = 12;
      const expanded = { left: Math.max(4, bounds.left - padding), top: Math.max(4, bounds.top - padding), right: Math.min(innerWidth - 4, bounds.right + padding), bottom: Math.min(innerHeight - 4, bounds.bottom + padding) };
      const below = expanded.bottom + 14;
      const top = below + height <= innerHeight - 12 ? below : Math.max(12, expanded.top - height - 14);
      const left = Math.max(12, Math.min(expanded.left, innerWidth - width - 12));
      setPosition({ width, left, top: Math.min(top, Math.max(12, innerHeight - height - 12)) });
      const instrument = document.querySelector<HTMLElement>('.instrument');
      if (!instrument) return;
      const frame = instrument.getBoundingClientRect(), scale = frame.width / instrument.offsetWidth;
      setHighlight({ left: (expanded.left - frame.left) / scale, top: (expanded.top - frame.top) / scale, width: (expanded.right - expanded.left) / scale, height: (expanded.bottom - expanded.top) / scale });
    };
    const observer = new ResizeObserver(update);
    if (panel.current) observer.observe(panel.current);
    const frame = document.querySelector('.instrument-frame'); if (frame) observer.observe(frame);
    update(); window.addEventListener('resize', update); window.visualViewport?.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update); };
  }, [step]);
  const instrument = document.querySelector('.instrument');
  return <>{tour && instrument && createPortal(<div className="tour-highlight" style={highlight} aria-hidden="true"/>, instrument)}{createPortal(<div className={`help-layer ${tour ? 'tour-layer' : ''}`} style={colors} onPointerDownCapture={event => { keyboardInteraction.current = false; if ((event.target as HTMLElement).closest('button')) { event.preventDefault(); (document.activeElement as HTMLElement)?.blur(); } }} onPointerDown={event => { if (!tour && event.target === event.currentTarget) close(false); }}>
    <section ref={panel} tabIndex={-1} className={`help-panel ${tour ? 'tour-panel' : ''}`} style={position} role="dialog" aria-modal={tour ? undefined : true} aria-labelledby="help-title" data-shortcuts="off">
      <div className="panel-header"><strong id="help-title">{tour ? steps[step].title : 'Welcome to thread'}</strong><button type="button" aria-label={tour ? 'Close tutorial' : 'Close Info'} onClick={event => close(event.detail === 0)}><Icon name="close" size={16}/></button></div>
      {tour ? <><p>{steps[step].text}</p><span className="tour-progress">{step + 1} / {steps.length}</span><div className="tour-actions"><button type="button" className="quiet-button" onClick={event => close(event.detail === 0)}>Skip</button><div><button type="button" className="standard-button" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button><button type="button" className="standard-button" onClick={event => step === steps.length - 1 ? close(event.detail === 0) : setStep(step + 1)}>{step === steps.length - 1 ? 'Done' : 'Next'}</button></div></div></> : <>
        <p>A small instrument for finding chords, shaping their sound, and building loops. Play a pad, make it your own, then take the MIDI or audio into your next piece.</p>
        <button type="button" className="standard-button tutorial-start" onClick={() => { dismissIntroduction(); setStep(0); }}>Start tutorial</button>
        <h2>Keyboard</h2><div className="keyboard-help"><p>Play pads <kbd>1–6</kbd> · Hold <kbd>Shift</kbd></p><p>Chord shape <kbd>Q W E R T Y U</kbd> · Root <kbd>[ ]</kbd></p><p>Voicing <kbd>↑ ↓</kbd> · Whole bank <kbd>G + ↑ ↓</kbd></p><p>Delete clip <kbd>Delete</kbd> · Play/Stop <kbd>Space</kbd></p><p>Silence <kbd>Esc</kbd> · Info <kbd>/</kbd> or <kbd>?</kbd></p></div>
      </>}
    </section>
  </div>, document.body)}</>;
}
