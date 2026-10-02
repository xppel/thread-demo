import { useLayoutEffect, useRef, useState } from 'react';

/** One normally kerned text run owns layout; independently moving glyphs only paint. */
export function Wordmark() {
  const measure = useRef<HTMLSpanElement>(null);
  const [positions, setPositions] = useState<number[]>([]);
  useLayoutEffect(() => {
    const update = () => {
      const element = measure.current, node = element?.firstChild;
      if (!element || !node) return;
      const instrument = element.closest<HTMLElement>('.instrument')!;
      const scale = instrument.getBoundingClientRect().width / instrument.offsetWidth || 1;
      const left = element.getBoundingClientRect().left;
      const range = document.createRange();
      setPositions([..."thread"].map((_, index) => {
        range.setStart(node, index); range.setEnd(node, index + 1);
        return (range.getBoundingClientRect().left - left) / scale;
      }));
    };
    const observer = new ResizeObserver(update);
    if (measure.current) observer.observe(measure.current);
    update(); window.addEventListener('resize', update);
    void document.fonts.ready.then(update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  return <span className="wordmark" aria-hidden="true"><span ref={measure} className="wordmark-measure">thread</span>{positions.map((left, index) => <span className="logo-letter" key={index} style={{ left }}>{'thread'[index]}</span>)}</span>;
}
