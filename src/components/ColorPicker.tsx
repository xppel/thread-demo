import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

function hsvToHex(hue: number, saturation: number, value: number): string {
  const f = (n: number) => {
    const k = (n + hue / 60) % 6;
    return Math.round((value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return `#${[f(5), f(3), f(1)].map(n => n.toString(16).padStart(2, '0')).join('')}`;
}
function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  if (delta) hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [((hue * 60) + 360) % 360, max ? delta / max : 0, max];
}
export function ColorField({ label, color, change }: { label: string; color: string; change: (color: string) => void }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(color);
  const [hue, setHue] = useState(() => hexToHsv(color)[0]);
  const plane = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), editor = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties>({});
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !editor.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const element = trigger.current; if (!element) return;
      const rect = element.getBoundingClientRect(), width = 260, height = 190;
      const left = rect.left >= width + 16 ? rect.left - width - 8 : Math.min(rect.right + 8, innerWidth - width - 8);
      const top = Math.max(8, Math.min(rect.top, innerHeight - height - 8));
      const computed = getComputedStyle(element);
      const colors = Object.fromEntries(['--bg', '--surface', '--text', '--muted', '--line', '--accent'].map(name => [name, computed.getPropertyValue(name)]));
      setPlacement({ position: 'fixed', left, top, width, zIndex: 1000, ...colors } as CSSProperties);
    };
    position(); window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open]);
  useEffect(() => { setDraft(color); setHue(hexToHsv(color)[0]); }, [color]);
  const [, saturation, brightness] = hexToHsv(color);
  const update = (h: number, s: number, v: number) => change(hsvToHex(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, v))));
  const planeAt = (event: ReactPointerEvent<HTMLDivElement>) => { const rect = plane.current?.getBoundingClientRect(); if (!rect) return; update(hue, (event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height); };
  const commit = () => /^#[0-9a-f]{6}$/i.test(draft) ? change(draft.toLowerCase()) : setDraft(color);
  return <div className="color-field" ref={root}><span>{label}</span><button ref={trigger} type="button" className="color-swatch-trigger" aria-label={`Pick ${label.toLowerCase()} color`} aria-expanded={open} onClick={() => setOpen(!open)}><span style={{ background: color }}/></button><input aria-label={`${label} hex value`} data-shortcuts="off" value={draft} maxLength={7} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/>
    {open && createPortal(<div ref={editor} className="color-editor" style={placement} role="group" aria-label={`${label} color picker`}><div ref={plane} className="color-plane" style={{ backgroundColor: `hsl(${hue} 100% 50%)` }} role="slider" tabIndex={0} data-shortcuts="off" aria-label={`${label} saturation and brightness`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(saturation * 100)} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); planeAt(event); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) planeAt(event); }} onKeyDown={event => { if (event.key === 'ArrowLeft') update(hue, saturation - .02, brightness); else if (event.key === 'ArrowRight') update(hue, saturation + .02, brightness); else if (event.key === 'ArrowUp') update(hue, saturation, brightness + .02); else if (event.key === 'ArrowDown') update(hue, saturation, brightness - .02); else return; event.preventDefault(); }}><span className="color-cursor" style={{ left: `${saturation * 100}%`, top: `${(1 - brightness) * 100}%` }}/></div><div className="hue-row"><span>Hue</span><input type="range" aria-label={`${label} hue`} min={0} max={359} value={Math.round(hue)} onChange={event => { const next = Number(event.target.value); setHue(next); update(next, saturation, brightness); }}/></div></div>, document.body)}
  </div>;
}
