import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

interface MenuOption<T extends string | number> { value: T; label: string; disabled?: boolean }
export function Menu<T extends string | number>({ label, value, options, onChange, className = '', disabled = false, matchTriggerWidth = false }: {
  label: string; value: T; options: MenuOption<T>[]; onChange: (value: T) => void; className?: string; disabled?: boolean; matchTriggerWidth?: boolean;
}) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const id = useId();
  const selected = options.findIndex(option => option.value === value);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !list.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const element = trigger.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const scale = matchTriggerWidth ? rect.width / element.offsetWidth : 1;
      const width = matchTriggerWidth ? rect.width : Math.max(rect.width, 150);
      const height = Math.min(225, options.length * 30 + 8) * scale;
      const top = rect.bottom + height + 6 <= innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - height - 4);
      const left = Math.min(Math.max(8, rect.left), Math.max(8, innerWidth - width - 8));
      const computed = getComputedStyle(element);
      const colors = Object.fromEntries(['--bg', '--surface', '--text', '--muted', '--line', '--accent'].map(name => [name, computed.getPropertyValue(name)]));
      setPlacement({ position: 'fixed', top, left, minWidth: width, ...(matchTriggerWidth ? { width, '--menu-scale': scale } : {}), zIndex: 1000, ...colors } as CSSProperties);
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open, options.length, matchTriggerWidth]);
  useEffect(() => { if (open) list.current?.focus(); }, [open]);
  useEffect(() => { const close = () => { setOpen(false); list.current?.blur(); trigger.current?.blur(); }; window.addEventListener('thread-performance-shortcut', close); return () => window.removeEventListener('thread-performance-shortcut', close); }, []);
  const choose = (index: number, keyboard = false) => { const option = options[index]; if (!option || option.disabled) return; onChange(option.value); setOpen(false); if (keyboard) trigger.current?.focus(); else trigger.current?.blur(); };
  const move = (delta: number) => {
    let next = active;
    for (let attempt = 0; attempt < options.length; attempt++) { next = (next + delta + options.length) % options.length; if (!options[next].disabled) break; }
    setActive(next);
  };
  const openMenu = () => { setActive(Math.max(0, selected)); setOpen(true); };
  const key = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
    if (!open) { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); openMenu(); } return; }
    // Portaled list events also bubble through their React owner. Handle once.
    event.stopPropagation();
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Home') { event.preventDefault(); setActive(options.findIndex(option => !option.disabled)); }
    else if (event.key === 'End') { event.preventDefault(); setActive(options.map(option => !option.disabled).lastIndexOf(true)); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active, true); }
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const query = event.key.toLowerCase();
      const index = options.findIndex((option, i) => i > active && !option.disabled && option.label.toLowerCase().startsWith(query));
      const fallback = options.findIndex(option => !option.disabled && option.label.toLowerCase().startsWith(query));
      if (index >= 0 || fallback >= 0) setActive(index >= 0 ? index : fallback);
    }
  };
  return <div className={`control-menu ${open ? 'open' : ''} ${className}`} ref={root} data-shortcuts="off" onKeyDown={key}>
    <button ref={trigger} type="button" className="control-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => open ? setOpen(false) : openMenu()}>
      <span className="control-value">{options[selected]?.label ?? String(value)}</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4 3 3 3-3"/></svg>
    </button>
    {open && createPortal(<div ref={list} id={id} className={`control-list ${matchTriggerWidth ? 'trigger-width' : ''}`} role="listbox" tabIndex={-1} aria-label={label} aria-activedescendant={`${id}-${active}`} style={placement} onKeyDown={key} data-shortcuts="off">
      {options.map((option, index) => <button key={String(option.value)} id={`${id}-${index}`} type="button" role="option" aria-selected={option.value === value} className={`control-option ${index === active ? 'active' : ''}`} disabled={option.disabled} onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.value === value && <span className="option-check" aria-hidden="true">✓</span>}
      </button>)}
    </div>, document.body)}
  </div>;
}
export function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const change = (delta: number) => { const next = value + delta; onChange(Math.max(min, Math.min(max, next))); };
  return <div className="stepper" data-shortcuts="off" aria-label={label}><button type="button" aria-label={`${label} down`} onClick={() => change(-1)} disabled={value <= min}>−</button><span className="stepper-value">{value}</span><button type="button" aria-label={`${label} up`} onClick={() => change(1)} disabled={value >= max}>+</button></div>;
}
export function Toggle({ label, checked, onChange, compact = false }: { label: string; checked: boolean; onChange: (value: boolean) => void; compact?: boolean }) {
  return <button type="button" className={`control-toggle ${compact ? 'compact' : ''}`} aria-label={label} aria-pressed={checked} onClick={() => onChange(!checked)}><span className="toggle-track"><span/></span><span>{label}</span></button>;
}
export function Knob({ label, value, onChange, detail, onGestureStart, onGestureEnd, values, formatValue, min = 0, max = 1 }: { label: string; value: number; onChange: (value: number) => void; detail?: string; onGestureStart?: () => void; onGestureEnd?: () => void; values?: readonly number[]; formatValue?: (value: number) => string; min?: number; max?: number }) {
  const activePointer = useRef<number | null>(null);
  const endGesture = useRef(onGestureEnd); endGesture.current = onGestureEnd;
  const position = values ? Math.max(0, values.indexOf(value)) / (values.length - 1) : (value - min) / (max - min);
  const display = formatValue ? formatValue(value) : String(Math.round(value * 100));
  const finish = () => {
    if (activePointer.current === null) return;
    activePointer.current = null;
    document.documentElement.classList.remove('control-dragging');
    endGesture.current?.();
  };
  useEffect(() => () => {
    if (activePointer.current !== null) {
      activePointer.current = null;
      document.documentElement.classList.remove('control-dragging');
      endGesture.current?.();
    }
  }, []);
  const set = (number: number) => {
    const fraction = Math.max(0, Math.min(1, number));
    const next = values ? values[Math.round(fraction * (values.length - 1))] : Math.max(min, Math.min(max, Math.round((min + fraction * (max - min)) * 100) / 100));
    if (next !== value) onChange(next);
  };
  const atPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) set((event.clientX - rect.left) / rect.width);
  };
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    onGestureStart?.(); activePointer.current = event.pointerId;
    document.documentElement.classList.add('control-dragging');
    event.currentTarget.setPointerCapture(event.pointerId);
    atPointer(event);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointer.current === event.pointerId) { event.preventDefault(); atPointer(event); }
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) return;
    event.preventDefault(); finish();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = values ? 1 / (values.length - 1) : .01 / (max - min);
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') { event.preventDefault(); set(position + step); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); set(position - step); }
    else if (event.key === 'PageUp') { event.preventDefault(); set(position + (values ? step : .1 / (max - min))); }
    else if (event.key === 'PageDown') { event.preventDefault(); set(position - (values ? step : .1 / (max - min))); }
    else if (event.key === 'Home') { event.preventDefault(); set(0); }
    else if (event.key === 'End') { event.preventDefault(); set(1); }
  };
  return <div className="knob-control"><span className="control-name">{label}</span><div className="knob-face" role="slider" tabIndex={0} data-shortcuts="off" aria-label={label} aria-valuemin={values ? values[0] : min * 100} aria-valuemax={values ? values[values.length - 1] : max * 100} aria-valuenow={values ? value : Math.round(value * 100)} aria-valuetext={values ? display : `${display} percent${detail ? ` ${detail}` : ''}`} style={{ '--knob-fill': `${position * 100}%` } as CSSProperties} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={finish} onKeyDown={key}><span className="knob-index"/></div><span className="knob-value">{display}</span></div>;
}
