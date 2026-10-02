import { randomArpSettings } from './arpeggiator';
import { DEFAULT_ARP } from '../state/session';
import { describe, expect, it } from 'vitest';
import { arpNotes, arpStepMs, arpStepTicks, resolveArpStep } from './arpeggiator';
import type { ArpSettings } from './performanceTypes';
const arp: ArpSettings = { mode: 'arp', division: 8, triplet: false, steps: [0, 1, 2, 1, 0, null, 2, null], register: 0, gate: .75, reverse: false, mirror: false };
describe('drawn arpeggiator', () => {
  it('maps the eight rows across unique sorted chord tones and treats empty columns as rests', () => {
    expect(arpNotes([55, 48, 52, 48])).toEqual([48, 48, 52, 52, 52, 52, 55, 55]);
    expect(arpNotes([48, 52, 55, 59])).toEqual([48, 48, 52, 52, 55, 55, 59, 59]);
    expect(arpNotes([48, 52, 55, 59, 62])).toEqual([48, 52, 52, 55, 55, 59, 59, 62]);
    expect(Array.from({ length: 8 }, (_, i) => (resolveArpStep([48, 52, 55], i, arp)?.midi ?? null))).toEqual([48, 48, 52, 48, 48, null, 52, null]);
  });
  it('resolves the base pass unchanged, then alternates configured octave passes', () => {
    const steps = [0, 1, 2, 3, 4, 5, 6, 7];
    const settings = { ...arp, steps, register: 1 as const };
    expect(Array.from({ length: 24 }, (_, i) => (resolveArpStep([48, 52, 55], i, settings)?.midi ?? null))).toEqual([
      48, 48, 52, 52, 52, 52, 55, 55,
      60, 60, 64, 64, 64, 64, 67, 67,
      48, 48, 52, 52, 52, 52, 55, 55,
    ]);
    expect(resolveArpStep([48, 52, 55], 9, settings)).toEqual({ column: 1, sourceColumn: 1, row: 1, midi: 60, pass: 1 });
  });
  it('folds octave-shifted output into MIDI range and resolves rests as null', () => {
    expect((resolveArpStep([0, 4, 7], 8, { ...arp, steps: [0, 1, 2, 3, 4, 5, 6, 7], register: -1 })?.midi ?? null)).toBe(0);
    expect((resolveArpStep([120, 124, 127], 8, { ...arp, steps: [0, 1, 2, 3, 4, 5, 6, 7], register: 1 })?.midi ?? null)).toBe(120);
    expect(resolveArpStep([48, 52, 55], 5, arp)).toBeNull();
  });
  it('reverses time and mirrors pitch on alternate passes independently', () => {
    const steps = [0, 1, 2, 3, 4, 5, 6, 7];
    expect((resolveArpStep([48, 52, 55], 8, { ...arp, steps, reverse: true })?.midi ?? null)).toBe(55);
    expect((resolveArpStep([48, 52, 55], 8, { ...arp, steps, mirror: true })?.midi ?? null)).toBe(55);
    expect((resolveArpStep([48, 52, 55], 8, { ...arp, steps, reverse: true, mirror: true })?.midi ?? null)).toBe(48);
    expect(resolveArpStep([48, 52, 55], 8, { ...arp, steps, reverse: true, mirror: true })).toMatchObject({ column: 0, sourceColumn: 7, row: 0, pass: 1 });
  });

});

it('randomizes every visible arp setting reproducibly without switching mode', () => {
  const variants = Array.from({ length: 128 }, (_, seed) => randomArpSettings(DEFAULT_ARP,seed));
  for (const [seed, arp] of variants.entries()) {
    expect(arp).toEqual(randomArpSettings(DEFAULT_ARP,seed));
    expect(arp.mode).toBe('off');
    expect(randomArpSettings({ ...DEFAULT_ARP, mode: 'arp' },seed).mode).toBe('arp');
    expect(arp.gate).toBeGreaterThanOrEqual(.1); expect(arp.gate).toBeLessThanOrEqual(1);
    expect(arp.steps.some(step => step !== null)).toBe(true);
  }
  for (const key of ['division','register','triplet','reverse','mirror','gate'] as const) expect(new Set(variants.map(arp => arp[key])).size).toBeGreaterThan(1);
});

it('uses one step clock for held audio, timeline and export at rate extremes', () => {
  expect(arpStepMs(100,16)).toBe(150); expect(arpStepTicks({division:16,triplet:false})).toBe(120);
  expect(arpStepMs(200,32,true)).toBe(25); expect(arpStepTicks({division:32,triplet:true})).toBe(40);
  expect(arpStepMs(40,2)).toBe(3000);
});
