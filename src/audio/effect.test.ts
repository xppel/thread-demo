import { describe, expect, it } from 'vitest';
import { reverbDecaySeconds, reverbWet } from './effect';

describe('reverb controls', () => {
  it('reserves the low Amount range for subtle wet levels and extends the Time range', () => {
    expect(reverbWet(0)).toBe(0);
    expect(reverbWet(.08)).toBeLessThan(.01);
    expect(reverbWet(.5)).toBeLessThan(.12);
    expect(reverbWet(1)).toBeCloseTo(.32);
    expect(reverbDecaySeconds(0)).toBeCloseTo(.35);
    expect(reverbDecaySeconds(1)).toBeCloseTo(6);
  });
});
