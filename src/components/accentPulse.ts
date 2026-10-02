const pulses = new WeakMap<HTMLElement, Animation>();
const bounces = new WeakMap<HTMLElement, Animation>();
function brightness(color: string) {
  const channels = color.startsWith('#') ? [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)) : color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
  const linear = channels.map(value => value / 255 <= .04045 ? value / 255 / 12.92 : ((value / 255 + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
function foreground(accent: string, background: string, text: string) {
  const light = brightness(accent);
  const contrast = (color: string) => (Math.max(light, brightness(color)) + .05) / (Math.min(light, brightness(color)) + .05);
  const preferred = contrast(background) >= contrast(text) ? background : text;
  return contrast(preferred) >= 4.5 ? preferred : light > .179 ? '#000000' : '#ffffff';
}
export function accentPulse(element: HTMLElement, property: 'color' | 'backgroundColor' = 'color') {
  const displayed = getComputedStyle(element);
  const current = displayed[property], currentColor = displayed.color;
  pulses.get(element)?.cancel(); pulses.delete(element);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const style = getComputedStyle(element);
  const base = style[property], accent = style.getPropertyValue('--accent').trim();
  const peak = property === 'backgroundColor' ? { backgroundColor: accent, color: foreground(accent, style.getPropertyValue('--bg').trim(), style.getPropertyValue('--text').trim()) } : { color: accent };
  const animation = element.animate([
    { [property]: current, ...(property === 'backgroundColor' ? { color: currentColor } : {}) },
    { ...peak, offset: .2 },
    { [property]: base, ...(property === 'backgroundColor' ? { color: style.color } : {}) },
  ], { duration: 200, easing: 'ease-out' });
  pulses.set(element, animation);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const changed = () => { if (motion.matches) animation.cancel(); };
  const cleanup = () => { motion.removeEventListener('change', changed); if (pulses.get(element) === animation) pulses.delete(element); };
  motion.addEventListener('change', changed); animation.onfinish = cleanup; animation.oncancel = cleanup;
}
export function logoBounce(element: HTMLElement) {
  element.querySelectorAll<HTMLElement>('.logo-letter').forEach((letter, index) => {
    const current = getComputedStyle(letter).transform;
    bounces.get(letter)?.cancel(); bounces.delete(letter);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animation = letter.animate([
      { transform: current }, { transform: 'translateY(-3px)', offset: .3 },
      { transform: 'translateY(1px)', offset: .7 }, { transform: 'translateY(0)' },
    ], { duration: 300, delay: index * 20, easing: 'ease-out', fill: 'backwards' });
    bounces.set(letter, animation);
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => { if (motion.matches) animation.cancel(); };
    const cleanup = () => { motion.removeEventListener('change', changed); if (bounces.get(letter) === animation) bounces.delete(letter); };
    motion.addEventListener('change', changed); animation.oncancel = cleanup;
    animation.onfinish = () => { cleanup(); animation.cancel(); };
  });
}
