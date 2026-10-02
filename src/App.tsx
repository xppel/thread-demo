import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { usePerformance } from './hooks/usePerformance';
import { NOTE_NAMES } from './music/types';
import { SCALE_IDS } from './music/scale';
import type { ScaleId } from './music/performanceTypes';
import { ChordBank } from './components/ChordBank';
import { SoundControls } from './components/SoundControls';
import { Tape } from './components/Tape';
import { ColorField } from './components/ColorPicker';
import { Knob, Menu, Stepper } from './components/Controls';
import { Help, firstVisit, dismissIntroduction } from './components/Help';
import { accentPulse, logoBounce } from './components/accentPulse';
import { Icon } from './components/Icons';
import { Wordmark } from './components/Wordmark';
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, displayedColors, editDisplayedColor, savedAppearance } from './appearance/settings';
import type { Appearance, ColorKey } from './appearance/settings';

const INSTRUMENT_WIDTH = 1000;
const INSTRUMENT_HEIGHT = 668;
const FIT_MARGIN = 12;
function fitScale() {
  return Math.max(.01, Math.min(1.15,
    (window.innerWidth - FIT_MARGIN * 2) / INSTRUMENT_WIDTH,
    (window.innerHeight - FIT_MARGIN * 2) / INSTRUMENT_HEIGHT));
}
function luminance(hex: string) { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return (r * .2126 + g * .7152 + b * .0722) / 255; }
export default function App() {
  const [help, setHelp] = useState<number | 'info' | null>(() => firstVisit() ? 'info' : null);
  const [keyboardHelp, setKeyboardHelp] = useState(false);
  const infoButton = useRef<HTMLButtonElement>(null), previousFocus = useRef<HTMLElement | null>(null), restoreFocusPending = useRef(false);
  const p = usePerformance({ shortcutsBlocked: help === 'info' });
  const [appearance, setAppearance] = useState(() => { try { return savedAppearance(localStorage); } catch { return { ...DEFAULT_APPEARANCE }; } });
  const [systemLight, setSystemLight] = useState(() => matchMedia('(prefers-color-scheme: light)').matches);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scale, setScale] = useState(fitScale);
  const invert = appearance.invert ?? !systemLight;
  const effective = displayedColors(appearance, invert);
  const light = luminance(effective.background) > .5;
  const style = { '--bg': effective.background, '--surface': light ? `color-mix(in srgb, ${effective.background} 95%, ${effective.text})` : `color-mix(in srgb, ${effective.background} 91%, ${effective.text})`, '--text': effective.text, '--muted': `color-mix(in srgb, ${effective.text} 62%, ${effective.background})`, '--line': `color-mix(in srgb, ${effective.text} 16%, ${effective.background})`, '--accent': effective.accent, colorScheme: light ? 'light' : 'dark' } as CSSProperties;
  function openHelp(keyboard = false) { setKeyboardHelp(keyboard); previousFocus.current = document.activeElement as HTMLElement; setSettingsOpen(false); setHelp('info'); }
  function closeHelp(keyboard = false) { dismissIntroduction(); restoreFocusPending.current = keyboard; setHelp(null); }
  useLayoutEffect(() => {
    if (help !== null || !restoreFocusPending.current) return;
    restoreFocusPending.current = false;
    const target = previousFocus.current;
    if (target?.isConnected && target !== document.body) target.focus(); else infoButton.current?.focus();
  }, [help]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || target?.isContentEditable || target?.closest('input,textarea,select,[role="dialog"],[role="listbox"]')) return;
      if (event.key === '/' || event.key === '?') { event.preventDefault(); event.stopImmediatePropagation(); openHelp(true); }
    };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, []);
  function updateAppearance(value: Appearance) { setAppearance(value); try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(value)); } catch { /* optional */ } }
  function updateEffectiveColor(key: ColorKey, value: string) { updateAppearance(editDisplayedColor(appearance, invert, key, value)); }
  useLayoutEffect(() => {
    const update = () => setScale(fitScale());
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    update();
    return () => { window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update); };
  }, []);
  useEffect(() => { const query = matchMedia('(prefers-color-scheme: light)'); const update = () => setSystemLight(query.matches); query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, []);
  useEffect(() => { const outside = (event: PointerEvent) => { if (!(event.target as Element).closest('.settings-panel,.settings-trigger,.control-list,.color-editor')) setSettingsOpen(false); }; const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSettingsOpen(false); }; const close = () => setSettingsOpen(false); document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape); window.addEventListener('thread-performance-shortcut', close); return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('thread-performance-shortcut', close); }; }, []);
  return <main className="workspace" style={style} onPointerUpCapture={event => { if ((event.target as HTMLElement).matches('input[type="range"]')) (event.target as HTMLElement).blur(); }} onPointerDownCapture={event => {
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,select,[contenteditable="true"],[role="listbox"]')) return;
      if (target.closest('button,[role="slider"]')) { event.preventDefault(); (document.activeElement as HTMLElement)?.blur(); }
    }}>
    <div className="instrument-frame" style={{ width: INSTRUMENT_WIDTH * scale, height: INSTRUMENT_HEIGHT * scale }}>
    <div className="instrument" inert={help === 'info'} style={{ transform: `scale(${scale})` }}>
      <header className="instrument-header">
        <h1><button type="button" className="logo-button" aria-label="thread — play a random chord" title="Play a random chord" disabled={!p.auditionAvailable} onClick={event => {
          if (!p.auditionChord()) return;
          accentPulse(event.currentTarget); logoBounce(event.currentTarget);
        }}><Wordmark/></button></h1>
        <div className="header-key"><span className="control-name">Key</span><div className="key-stepper stepper"><button type="button" aria-label="Global key down" onClick={() => p.setKey((p.session.key + 11) % 12)}>−</button><Menu label="Key" value={p.session.key} options={NOTE_NAMES.map((label, value) => ({ value, label }))} onChange={p.setKey} className="key-menu"/><button type="button" aria-label="Global key up" onClick={() => p.setKey((p.session.key + 1) % 12)}>+</button></div><Menu label="Scale" value={p.session.scale} options={SCALE_IDS.map(value => ({ value, label: value === 'minor' ? 'Natural minor' : value === 'pentatonic' ? 'Major pentatonic' : value[0].toUpperCase() + value.slice(1) }))} onChange={(next: ScaleId) => p.setScale(next)}/><button type="button" className="header-toggle" aria-label="Lock key / scale" aria-pressed={p.session.keyLocked} title="Lock key and scale for New chords" onClick={() => p.setKeyLocked(!p.session.keyLocked)}><Icon name={p.session.keyLocked ? 'lock' : 'unlock'} size={17}/></button></div>
        <div className="header-pad-tools"><span className="control-name">Pads</span><Stepper label="Number of chords" value={p.session.padCount} min={1} max={6} onChange={p.setPadCount}/><button type="button" className="state-button" aria-label="Hold" aria-pressed={p.hold} title="Hold notes · Shift" onClick={p.toggleHold}>Hold</button></div>
        <div className="header-actions"><button className="header-button key-action-button" onClick={event => { p.randomize(); accentPulse(event.currentTarget, 'backgroundColor'); }}>New chords</button><button className="icon-button settings-trigger" aria-label="Settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="gear" size={16}/></button></div>
      </header>
      <ChordBank instrument={p}/><Tape instrument={p}/><SoundControls instrument={p}/>
      {p.notice && /interrupted|could not/.test(p.notice) && <p className="audio-notice" role="alert">{p.notice}</p>}
      <footer className="instrument-footer"><div className="footer-left"><button className="quiet-button" onClick={p.stop}><span>Silence</span><kbd>Esc</kbd></button></div><a className="copyright" href="https://xppel.com" target="_blank" rel="noopener noreferrer">© 2026 Andrew Appel</a><button type="button" className="footer-site quiet-button" ref={infoButton} aria-haspopup="dialog" aria-expanded={help !== null} onClick={event => openHelp(event.detail === 0)}>Info (?)</button></footer>
      {settingsOpen && <section className="popover settings-panel" role="dialog" aria-label="Settings"><div className="panel-header"><strong>Settings</strong><button aria-label="Close settings" onClick={() => setSettingsOpen(false)}><Icon name="close" size={16}/></button></div>
        <div className="settings-body"><div className="settings-section-heading">Sound</div><div className="sound-settings"><Knob label="Master volume" value={p.session.sound.masterVolume} onChange={masterVolume => p.setSound({ masterVolume })} onGestureStart={() => p.beginGesture('masterVolume')} onGestureEnd={p.endGesture}/></div><div className="settings-section-heading">Appearance <button className="standard-button theme-button" aria-label={invert ? 'Use light mode' : 'Use dark mode'} onClick={() => updateAppearance({ ...appearance, invert: !invert })}><Icon name={invert ? 'sun' : 'moon'} size={16}/>{invert ? 'Light' : 'Dark'}</button></div>
          {(['background', 'text', 'accent'] as ColorKey[]).map(key => <ColorField key={key} label={key[0].toUpperCase() + key.slice(1)} color={effective[key]} change={value => updateEffectiveColor(key, value)}/>)}
          <div className="settings-actions"><button className="standard-button" aria-pressed={appearance.invert === null} onClick={() => updateAppearance({ ...appearance, invert: null })}>Follow system</button><button className="standard-button" onClick={() => updateAppearance(DEFAULT_APPEARANCE)}>Reset colors</button></div>
        </div>
      </section>}
    </div>
    </div>
    {help !== null && <Help step={help} setStep={setHelp} close={closeHelp} silence={p.stop} colors={style} keyboardOpened={keyboardHelp}/>}
  </main>;
}
