import { test, expect } from '@playwright/test';
import { createSession } from '../src/state/session';
import { patchFor } from '../src/audio/patches';
import { resolveArpStep, arpStepMs } from '../src/music/arpeggiator';
import { events, traceEngine, nativeAttackIssue, nativeValue } from './audioProbe';

// Short-Gate regression configuration.
function fixture(voice: 'Current' | 'Felt' = 'Current') {
  const session = createSession();
  session.voice = voice; session.bass = true;
  session.sound = { attack: 0, decay: 1, color: .81, texture: 1, reverbAmount: 1, reverbTime: 1, masterVolume: 1 };
  session.arp = { ...session.arp, mode: 'arp', division: 16, register: 1, gate: .1, mirror: true, steps: [4,2,6,0,4,2,6,3] };
  session.loop.tempo = voice === 'Felt' ? 100 : 96;
  if (voice === 'Felt') session.sound = { attack: 0, decay: 1, color: .35, texture: .5, reverbAmount: .52, reverbTime: .46, masterVolume: .75 };
  return session;
}

for (const voice of ['Current', 'Felt'] as const) for (const timeline of [false, true]) for (const extreme of [false, true]) test(`${voice} ${timeline ? 'timeline' : 'held'} short Gates reach native nodes through ${extreme ? 'fast repeated pitches and transformations' : 'Safari settings'}`, async ({ page }) => {
  const session = fixture(voice);
  if (extreme) { session.loop.tempo = 200; session.arp.division = 32; session.arp.triplet = true; session.arp.reverse = true; session.arp.steps = [0,0,0,0,0,0,0,0]; }
  if (timeline) { session.loop.bars = 1; session.loop.blocks = [{ id: 0, pad: 0, tick: 0, durationTicks: 1920 }]; }
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page);
  if (timeline) await page.keyboard.press('Space'); else await page.keyboard.down('1');
  await expect.poll(async () => (await events(page)).filter(event => event.midi !== undefined && !event.id?.startsWith('bass:') && event.midi! >= 48).length).toBeGreaterThan(12);
  // Fast case crosses a loop boundary; check expected pitches and exact spacing.
  if (timeline && extreme) await page.waitForTimeout(1400);
  const trace = await events(page), attacks = trace.filter(event => event.midi !== undefined);
  const arp = attacks.filter(event => !event.id!.startsWith('bass:') && event.midi! >= 48);
  const interval = arpStepMs(session.loop.tempo, session.arp.division, session.arp.triplet) / 1000;
  for (let step = 0; step < arp.length; step++) {
    expect(nativeAttackIssue(arp[step]), JSON.stringify(arp[step])).toBeUndefined();
    expect(nativeValue(arp[step].resonance!, arp[step].time!)).toBeCloseTo(.65, 5);
    expect(arp[step].midi).toBe(resolveArpStep(session.bank[0].notes, step, session.arp)!.midi);
    if (step) expect(arp[step].time! - arp[step-1].time!).toBeCloseTo(interval, 4);
    expect(arp[step].native!.requested).toBeLessThan(arp[step].time!);
    expect(arp[step].native!.submitted).toBeLessThanOrEqual(arp[step].time!);
    expect(arp[step].automation!.some(command => command.method === 'linearRampToValueAtTime' && command.args[0] > 0 && Math.abs(command.args[1] - arp[step].time! - .001) < .00001)).toBe(true);
    expect(arp[step].native!.stops.every(stop => stop.requested >= arp[step].time! + arp[step].duration!)).toBe(true);
    expect(arp[step].automation!.some(command => command.method === 'setTargetAtTime' && command.args[0] === 0 && Math.abs(command.args[1] - arp[step].time! - arp[step].duration!) < .00001)).toBe(true);
  }
  const firstBass = attacks.find(event => event.midi! < 48)!;
  expect(firstBass.time).toBeCloseTo(arp[0].time!, 5);
  expect(trace.filter(event => event.disposed && !event.stopping && event.end! > event.now!)).toEqual([]);
  if (!timeline) { await page.mouse.click(10,10); await page.keyboard.up('1'); }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('same-pad inputs do not create another bass or reset arp phase; different pad cancels queued attacks', async ({ page }) => {
  const session = fixture(); session.sound.reverbAmount = 0;
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page); await page.keyboard.down('1');
  await expect.poll(async () => (await events(page)).filter(event => event.id?.includes(':arp:')).length).toBeGreaterThan(0);
  const before = await events(page);
  const box = (await page.getByTestId('pad-1').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.keyboard.up('1');
  expect((await events(page)).filter(event => event.id?.startsWith('bass:'))).toHaveLength(1);
  await page.keyboard.down('2');
  const next = await events(page);
  expect(next.filter(event => event.id?.startsWith('bass:'))).toHaveLength(2);
  expect(next.filter(event => event.disposed && event.start! > event.now!).length).toBeGreaterThan(0);
  expect(before.some(event => event.id?.includes(':arp:'))).toBe(true);
  await page.keyboard.up('2'); await page.mouse.up(); await page.keyboard.press('Escape');
});

test('all construction precedes simultaneous startup, and ongoing missed deadlines are exposed', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('thread.demo.intro.seen.v1', '1'));
  await page.goto('./'); await traceEngine(page);
  await page.evaluate(() => {
    const e = (window as any).__engine, create = e.createVoice;
    e.createVoice = function (...args: any[]) { const until = performance.now() + 15; while (performance.now() < until) {} return create.apply(this, args); };
  });
  await page.keyboard.press('Space');
  await expect.poll(async () => (await events(page)).filter(event => event.midi !== undefined).length).toBeGreaterThan(1);
  const first = (await events(page)).filter(event => event.midi !== undefined);
  expect(new Set(first.map(event => event.time)).size).toBe(1);
  expect(first.every(event => event.native!.submitted <= event.time!)).toBe(true);
  await page.keyboard.press('Escape');
  const session = fixture(); session.sound.reverbAmount = 0;
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), session);
  await page.reload(); await traceEngine(page); await page.keyboard.down('1');
  await expect.poll(async () => (await events(page)).filter(event => event.midi !== undefined).length).toBeGreaterThan(1);
  await page.evaluate(() => {
    const e = (window as any).__engine, create = e.createVoice;
    e.createVoice = function (...args: any[]) { const until = performance.now() + 400; while (performance.now() < until) {} return create.apply(this, args); };
  });
  await expect.poll(() => page.evaluate(() => (window as any).__engine.deadlineMisses)).toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.keyboard.up('1'); await page.keyboard.press('Escape');
});

for (const timeline of [false, true]) test(`${timeline ? 'timeline' : 'held'} slowest rate and tempo retain the native grid`, async ({ page }) => {
  const session = fixture(); session.loop.tempo = 40; session.arp.division = 2; session.sound.reverbAmount = 0;
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page);
  if (timeline) await page.keyboard.press('Space'); else await page.keyboard.down('1');
  await expect.poll(async () => (await events(page)).filter(event => event.midi! >= 48).length).toBeGreaterThan(1);
  const attacks = (await events(page)).filter(event => event.midi! >= 48);
  expect(attacks[1].time! - attacks[0].time!).toBeCloseTo(3, 5);
  expect(attacks.slice(0,2).every(event => event.native!.submitted < event.time! && event.envelope! > 0)).toBe(true);
  await page.keyboard.up('1'); await page.keyboard.press('Escape'); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('an initial arp rest keeps Bass at the chord onset and the first pitch at the next step', async ({ page }) => {
  const session = fixture(); session.sound.reverbAmount = 0; session.arp.steps[0] = null;
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page); await page.keyboard.down('1');
  await expect.poll(async () => (await events(page)).filter(event => event.midi !== undefined).length).toBeGreaterThan(1);
  const trace = (await events(page)).filter(event => event.midi !== undefined);
  expect(trace[1].time! - trace[0].time!).toBeCloseTo(.15625, 5);
  expect(trace[0].id).toBe('bass:live');
  await page.keyboard.up('1'); await page.keyboard.press('Escape');
});

test('silent preparation holds phase until the exact short-Gate attack', async ({ page }) => {
  const session = fixture(); session.voice = 'Felt'; session.loop.tempo = 100;
  session.sound = { attack: 0, decay: 1, color: .35, texture: .5, reverbAmount: .52, reverbTime: .46, masterVolume: 1 };
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page); await page.keyboard.down('1');
  await expect.poll(async () => (await events(page)).filter(event => event.duration !== undefined).length).toBeGreaterThan(10);
  for (const attack of (await events(page)).filter(event => event.duration !== undefined)) {
    const frequency = attack.frequency!;
    expect(frequency.some(command => command.method === 'setValueAtTime' && command.args[0] === 0 && command.args[1] <= attack.native!.requested)).toBe(true);
    const hz = 440 * 2 ** ((attack.midi! - 69) / 12);
    expect(frequency.some(command => command.method === 'setValueAtTime' && Math.abs(command.args[0] - hz) < .0001 && command.args[1] === attack.time)).toBe(true);
    expect(attack.automation!.some(command => command.method === 'linearRampToValueAtTime' && command.args[0] > 0 && Math.abs(command.args[1] - attack.time! - .001) < .00001)).toBe(true);
    expect(attack.automation!.some(command => command.method === 'setTargetAtTime' && command.args[0] === 0 && Math.abs(command.args[1] - attack.time! - attack.duration!) < .00001)).toBe(true);
  }
  await page.keyboard.up('1'); await page.keyboard.press('Escape');
});

test('logo chord and Bass share one onset after delayed batch construction', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('thread.demo.intro.seen.v1', '1'));
  await page.goto('./'); await traceEngine(page);
  await page.getByRole('button', { name: 'Bass', exact: true }).click();
  await page.evaluate(() => { const engine = (window as any).__engine, create = engine.createVoice; engine.createVoice = function (...args: any[]) { const until = performance.now() + 15; while (performance.now() < until) {} return create.apply(this, args); }; });
  await page.locator('.logo-button').click();
  await expect.poll(async () => (await events(page)).filter(event => event.midi !== undefined).length).toBeGreaterThan(3);
  const attacks = (await events(page)).filter(event => event.midi !== undefined);
  expect(new Set(attacks.map(event => event.time)).size).toBe(1);
  expect(attacks.every(event => event.native!.submitted < event.time!)).toBe(true);
  await page.keyboard.press('Escape');
});

test('restored backing chooses one current onset after construction and keeps the grid', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('thread.demo.intro.seen.v1', '1'));
  await page.goto('./'); await traceEngine(page); await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => { const engine = (window as any).__engine, clock = engine.playbackClock(); return Boolean(clock && engine.audioTime() >= clock.origin + .05); })).toBe(true);
  const outcome = await page.evaluate(() => {
    const e = (window as any).__engine, origin = e.playbackClock().origin, create = e.createVoice;
    e.setRecordingOverride(true);
    const offset = (window as any).__events.length;
    e.createVoice = function (...args: any[]) { const until = performance.now() + 15; while (performance.now() < until) {} return create.apply(this, args); };
    e.setRecordingOverride(false);
    return { origin, after: e.playbackClock()?.origin, submitted: e.audioTime(), attacks: (window as any).__events.slice(offset).filter((event: any) => event.midi !== undefined) };
  });
  expect(outcome.after).toBe(outcome.origin);
  expect(outcome.attacks).toHaveLength(3);
  expect(new Set(outcome.attacks.map((event: any) => event.time)).size).toBe(1);
  expect(outcome.attacks.every((event: any) => event.time >= outcome.submitted && event.native.submitted <= event.time)).toBe(true);
  expect(outcome.attacks.every((event: any) => Math.abs(event.time + event.duration - outcome.origin - 2.4) < .001)).toBe(true);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0); await page.keyboard.press('Escape');
});

test('extending a clip after its release submits a fresh native attack', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('thread.demo.intro.seen.v1', '1'));
  await page.goto('./'); await traceEngine(page); await page.keyboard.press('Space');
  const result = await page.evaluate(async () => {
    const e = (window as any).__engine;
    const note = { id: 1, midi: 60, tick: 0, durationTicks: 480, velocity: .68, part: 'chords' };
    await e.loop([note], 1920, 200, () => {}, () => {});
    clearInterval(e.timer); // Keep the ended keyed item until the explicit edit.
    const origin = e.playbackClock().origin, offset = (window as any).__events.length;
    while (e.audioTime() < origin + .32) await new Promise(resolve => setTimeout(resolve, 5));
    e.updateLoop([{ ...note, durationTicks: 960 }], 1920, 200);
    return { origin, attacks: (window as any).__events.slice(offset).filter((event: any) => event.midi !== undefined) };
  });
  expect(result.attacks).toHaveLength(1);
  const attack = result.attacks[0];
  expect(attack.native.submitted).toBeLessThanOrEqual(attack.time);
  expect(attack.time).toBeGreaterThan(result.origin + .31);
  expect(attack.time + attack.duration).toBeCloseTo(result.origin + .6, 4);
  expect(attack.automation.some((command: any) => command.method === 'linearRampToValueAtTime' && command.args[0] > 0 && Math.abs(command.args[1] - attack.time - .001) < .00001)).toBe(true);
  await page.keyboard.press('Escape');
});


test('native checks reject cancelled, muted, faded and disconnected attacks', async ({ page }) => {
  const session = fixture('Felt'); session.sound.reverbAmount = 0;
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page);
  await page.evaluate(() => {
    const engine = (window as any).__engine, submit = engine.submitVoice;
    let index = 0;
    engine.submitVoice = function (...args: any[]) {
      const result = submit.apply(this, args), live = args[0], time = args[3];
      if (index++ === 1) live.synth.envelope.cancel(time);
      else if (index === 3) live.synth.volume.setValueAtTime(-Infinity, time);
      else if (index === 4) live.synth.volume.setValueAtTime(-96, time);
      else if (index === 5) this.disposeVoice(live);
      return result;
    };
  });
  await page.keyboard.down('1');
  await expect.poll(async () => (await events(page)).filter(event => event.midi !== undefined).length).toBeGreaterThan(4);
  const attacks = (await events(page)).filter(event => event.midi !== undefined);
  expect(nativeAttackIssue(attacks[0])).toBeUndefined();
  expect(nativeAttackIssue(attacks[1])).toBe('native envelope cancelled or silent');
  expect(nativeAttackIssue(attacks[2])).toBe('native voice muted');
  expect(nativeAttackIssue(attacks[3])).toBe('native voice muted');
  expect(nativeAttackIssue(attacks[4])).toBe('native source disconnected during attack');
  await page.keyboard.up('1'); await page.keyboard.press('Escape');
});

function currentSafariFixture() {
  const session = fixture();
  session.loop.tempo = 80;
  session.sound.color = 0;
  session.arp = { ...session.arp, division: 32, gate: 1, register: 0, reverse: true, mirror: false, steps: [5,1,7,3,4,0,6,2] };
  session.bank[0] = { root: 3, quality: 'maj7', symbol: 'E♭maj7', notes: [51,55,58,62], voicing: { base: [51,55,58,62], inversion: 0 } };
  return session;
}

function latestFixture() {
  const session = fixture('Felt');
  session.sound = { attack: 0, decay: 1, color: .5, texture: .5, reverbAmount: .5, reverbTime: .5, masterVolume: .75 };
  session.arp = { ...session.arp, division: 32, gate: .5, mirror: false, steps: [3,4,4,2,1,1,2,6] };
  return session;
}

for (const config of ['latest', 'current-80'] as const) for (const timeline of [false, true]) test(`${timeline ? 'timeline' : 'held'} ${config} Safari settings retain every attack while reusing downstream graphs`, async ({ page }, info) => {
  const session = config === 'latest' ? latestFixture() : currentSafariFixture();
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page);
  if (timeline) await page.keyboard.press('Space'); else await page.keyboard.down('1');
  await page.waitForTimeout(18000);
  const attacks = (await events(page)).filter(event => event.midi !== undefined);
  for (const attack of attacks) expect(nativeAttackIssue(attack), JSON.stringify(attack)).toBeUndefined();
  expect(new Set(attacks.map(attack => attack.native!.id)).size).toBe(attacks.length);
  const metrics = await page.evaluate(() => {
    const w = window as any, costs = w.__allocations.map((allocation: any) => allocation.ms).sort((a: number,b: number) => a-b), engine = w.__engine;
    return { attacks: w.__events.filter((event: any) => event.midi !== undefined).length, graphs: new Set(w.__allocations.map((allocation: any) => allocation.filter)).size, constructionMedianMs: costs[Math.floor(costs.length / 2)], constructionP95Ms: costs[Math.floor(costs.length * .95)], constructionMaxMs: Math.max(...costs), peakLive: Math.max(...w.__allocations.map((allocation: any) => allocation.live)), nativePeak: w.__nativePeak, nativeActive: w.__nativeActive, cachedChordGraphs: engine.idleVoices.chords.length, cachedBassGraphs: engine.idleVoices.bass.length, misses: engine.deadlineMisses, late: engine.lateSubmissions, nodes: w.__nativeCounts };
  });
  const margins = attacks.map(attack => attack.time! - attack.native!.submitted);
  const summary = { browser: info.project.name, mode: timeline ? 'timeline' : 'held', ...metrics, minimumNativeLeadMs: Math.min(...margins) * 1000 };
  console.log(JSON.stringify(summary));
  await info.attach('native-allocation-summary', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
  expect(metrics.graphs).toBeLessThan(metrics.attacks / 4);
  expect(metrics.misses).toBe(0); expect(metrics.late).toBe(0);
  const interval = arpStepMs(session.loop.tempo, session.arp.division, session.arp.triplet) / 1000;
  const arp = attacks.filter(attack => attack.midi! >= 48);
  for (let step = 0; step < arp.length; step++) {
    if (step) expect(arp[step].time! - arp[step-1].time!).toBeCloseTo(interval, 5);
    const pad = timeline ? Math.floor(step / 32) % 4 : 0;
    expect(arp[step].midi).toBe(resolveArpStep(session.bank[pad].notes, timeline ? step % 32 : step, session.arp)!.midi);
  }
  await page.keyboard.up('1'); await page.keyboard.press('Escape'); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('wet WAV export yields to short arp and Bass playback with an isolated context', async ({ page }) => {
  test.setTimeout(60000);
  const session = latestFixture(); session.loop.bars = 16;
  session.loop.blocks = Array.from({ length: 16 }, (_, bar) => ({ id: bar, pad: bar % 4, tick: bar * 1920, durationTicks: 1920 }));
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page); await page.keyboard.press('Space');
  await expect.poll(async () => (await events(page)).filter(event => event.midi !== undefined).length).toBeGreaterThan(10);
  const before = await page.evaluate(() => { const w = window as any; w.__originalContext = w.__engine.liveContext; return w.__events.length; });
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'WAV', exact: true }).click(); await download;
  const attacks = (await events(page)).slice(before).filter(event => event.midi !== undefined);
  expect(attacks.length).toBeGreaterThan(10);
  for (const attack of attacks) expect(nativeAttackIssue(attack), JSON.stringify(attack)).toBeUndefined();
  const result = await page.evaluate(() => { const w = window as any; return { same: w.__originalContext === w.__engine.liveContext, misses: w.__engine.deadlineMisses, state: w.__engine.liveContext.state }; });
  expect(result).toEqual({ same: true, misses: 0, state: 'running' });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('alert')).toHaveCount(0);
});


test('the currently selected F minor pad retains native attacks through live timing edits and backing restoration', async ({ page }) => {
  const session = latestFixture();
  session.bank[2] = { ...session.bank[2], quality: 'min', symbol: 'Fm', notes: [53,56,60], voicing: { base: [41,44,48], inversion: 3 } };
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page); await page.keyboard.down('3');
  await page.waitForTimeout(1000);
  let attacks = (await events(page)).filter(event => event.midi !== undefined);
  for (const attack of attacks) expect(nativeAttackIssue(attack), JSON.stringify(attack)).toBeUndefined();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.up('3'); await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  const restored = await page.evaluate(() => {
    const w = window as any, e = w.__engine; e.setRecordingOverride(true);
    const before = w.__events.length; e.setRecordingOverride(false);
    return w.__events.slice(before).filter((event: any) => event.midi !== undefined);
  });
  expect(restored.length).toBeGreaterThan(3);
  for (const attack of restored) expect(nativeAttackIssue(attack), JSON.stringify(attack)).toBeUndefined();
  await page.keyboard.press('Escape'); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('native checks reject pitch and attack ramps submitted after onset', () => {
  const onTime = (value: number, at = 1) => [{ method: 'setValueAtTime', args: [value, at], submitted: .9 }];
  const attack = { id: 'synthetic', midi: 69, time: 1, duration: .02, native: { id: 1, requested: .9, submitted: .9, stops: [] }, frequency: onTime(440), automation: [{ method: 'linearRampToValueAtTime', args: [.68,1.001], submitted: .9 }], sourceGain: onTime(1), volume: onTime(.1), texture: onTime(.8) };
  expect(nativeAttackIssue(attack)).toBeUndefined();
  expect(nativeAttackIssue({ ...attack, frequency: [{ method: 'setValueAtTime', args: [440,1], submitted: 1.004 }] })).toBe('late native pitch automation');
  expect(nativeAttackIssue({ ...attack, automation: [{ method: 'linearRampToValueAtTime', args: [.68,1.001], submitted: 1.004 }] })).toBe('late native attack automation');
});


for (const config of ['latest', 'felt-short', 'current-short', 'slow-attack', 'current-80'] as const) for (const timeline of [false,true]) test(`${config} ${timeline ? 'timeline' : 'held'} Gate dragging keeps every native attack and Bass`, async ({ page }, info) => {
  const session = config === 'latest' ? latestFixture() : config === 'current-80' ? currentSafariFixture() : fixture(config === 'felt-short' ? 'Felt' : 'Current');
  if (config === 'slow-attack') session.sound.attack = .15;
  // Repeat pitches, rests and a loop boundary while editing the actual control.
  if (config !== 'current-80') session.arp.steps = [4,4,null,0,4,4,6,3];
  if (timeline) { session.loop.bars = 1; session.loop.blocks = [{ id: 0, pad: 0, tick: 0, durationTicks: 1920 }]; }
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page);
  if (timeline) await page.keyboard.press('Space'); else await page.keyboard.down('1');
  await page.waitForTimeout(350);
  const slider = page.getByRole('slider', { name: 'Gate', exact: true });
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  for (let pass = 0; pass < 4; pass++) for (let step = 0; step <= 12; step++) {
    const fraction = pass % 2 ? 1 - step / 12 : step / 12;
    await page.mouse.move(box.x + 2 + fraction * (box.width - 4), box.y + box.height / 2);
    await page.waitForTimeout(25);
  }
  await page.mouse.up(); await page.waitForTimeout(2800);
  const windowEnd = await page.evaluate(() => {
    const e = (window as any).__engine;
    const result = { now: e.audioTime(), misses: e.deadlineMisses, late: e.lateSubmissions };
    // End the measured refill window before transferring the large command trace.
    // Native attacks/releases already submitted remain connected and scheduled.
    clearInterval(e.timer); clearInterval(e.heldArpTimer);
    return result;
  });
  const trace = await events(page), attacks = trace.filter(event => event.midi !== undefined);
  await info.attach('gate-window', { body: JSON.stringify({ ...windowEnd, attacks: attacks.length, deadlines: trace.filter(event => 'deadlineMiss' in event) }, null, 2), contentType: 'application/json' });
  expect(trace.filter(event => event.disposed && event.start! > event.now!)).toEqual([]);
  for (const attack of attacks) expect(nativeAttackIssue(attack), JSON.stringify(attack)).toBeUndefined();
  const arp = attacks.filter(attack => attack.midi! >= 48);
  const interval = arpStepMs(session.loop.tempo, session.arp.division, session.arp.triplet) / 1000;
  for (let step = 0, index = 0; index < arp.length; step++) {
    const within = timeline ? step % session.arp.division : step;
    const resolved = resolveArpStep(session.bank[0].notes, within, session.arp);
    if (!resolved) continue;
    expect(arp[index].midi).toBe(resolved.midi);
    expect(arp[index++].time!).toBeCloseTo(arp[0].time! + step * interval, 4);
  }
  expect(attacks.filter(attack => attack.midi! < 48).length).toBeGreaterThanOrEqual(timeline ? 2 : 1);
  expect({ misses: windowEnd.misses, late: windowEnd.late }).toEqual({ misses: 0, late: 0 });
  await page.keyboard.up('1'); await page.keyboard.press('Escape');
});


test('lengthening a queued Gate restores its truncated native attack ramp', async ({ page }) => {
  const session = fixture('Felt'); session.sound.attack = .5; session.arp.division = 32;
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page);
  await page.evaluate(async settings => {
    const e = (window as any).__engine;
    const notes = (gate: number) => [
      { id: 0, midi: 36, tick: 0, durationTicks: 1920, velocity: .58, part: 'bass' },
      { id: 1, midi: 60, tick: 120, durationTicks: 60 * gate, velocity: .68, part: 'chords' },
    ];
    await e.loop(notes(.1), 1920, 100, () => {}, () => {}, 0, false, settings);
    await new Promise(resolve => setTimeout(resolve, 25));
    e.updateLoop(notes(1), 1920, 100, { ...settings, gate: 1 });
  }, session.arp);
  await page.waitForTimeout(350);
  const attack = (await events(page)).find(event => event.midi === 60)!;
  expect(nativeAttackIssue(attack), JSON.stringify(attack)).toBeUndefined();
  expect(nativeValue(attack.automation!, attack.time! - .001)).toBe(0);
  expect(nativeValue(attack.automation!, attack.time! + .005)).toBeCloseTo(.68 * .005 / patchFor('Felt', session.sound).envelope.attack, 5);
  await page.keyboard.press('Escape');
});


for (const config of ['current-80','felt-short','fast'] as const) for (const timeline of [false,true]) test(`${config} ${timeline ? 'timeline' : 'held'} live pattern drawing preserves owned notes and the native grid`, async ({ page }, info) => {
  const session = config === 'current-80' ? currentSafariFixture() : fixture('Felt');
  if (config === 'fast') { session.loop.tempo = 200; session.arp.division = 32; session.arp.triplet = true; session.arp.register = 0; }
  session.arp.steps = [0,0,0,0,0,0,0,0]; session.arp.gate = config === 'felt-short' ? .1 : 1;
  if (timeline) { session.loop.bars = 1; session.loop.blocks = [{ id: 0, pad: 0, tick: 0, durationTicks: 1920 }]; }
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await expect(page).toHaveTitle('thread — chord loop demo'); await traceEngine(page);
  await page.evaluate(timeline => {
    const w = window as any, e = w.__engine, method = timeline ? 'updateLoop' : 'updateHeldArp', original = e[method];
    w.__patternChanges = [];
    e[method] = function (...args: any[]) {
      const settings = args[timeline ? 3 : 2], at = this.audioTime();
      const edit = { at, completedAt: at, settings: structuredClone(settings) };
      w.__patternChanges.push(edit);
      const result = original.apply(this,args); edit.completedAt = this.audioTime();
      return result;
    };
  }, timeline);
  if (timeline) await page.keyboard.press('Space'); else await page.keyboard.down('1');
  await page.waitForTimeout(230);
  // Draw pitches, erase them, and restore them through the actual pointer UI.
  for (const row of [7,3,3,6,0]) {
    for (let column = 0; column < 8; column++) {
      await page.locator(`.arp-matrix button[data-column="${column}"][data-row="${row}"]`).click();
      await page.waitForTimeout(12);
    }
    const gate = page.getByRole('slider', { name: 'Gate', exact: true }), bounds = (await gate.boundingBox())!;
    await gate.click({ position: { x: row % 2 ? bounds.width - 3 : 3, y: bounds.height / 2 } });
  }
  await page.waitForTimeout(2700);
  const windowEnd = await page.evaluate(() => {
    const w = window as any, e = w.__engine;
    const value = { now: e.audioTime(), misses: e.deadlineMisses, late: e.lateSubmissions, edits: w.__patternChanges };
    clearInterval(e.timer); clearInterval(e.heldArpTimer); return value;
  });
  const trace = await events(page), all = trace.filter(event => event.midi !== undefined);
  await info.attach('pattern-window', { body: JSON.stringify(windowEnd,null,2), contentType: 'application/json' });
  await info.attach('pattern-errors', { body: JSON.stringify(errors),contentType:'application/json' });
  expect(errors, 'pattern revisions must finish native pitch and envelope submission').toEqual([]);
  const cancelled = new Set(trace.filter(event => event.disposed && event.start! > event.now!).map(event => event.disposed));
  const sounding = all.filter(event => !cancelled.has(event.id!) && event.time! <= windowEnd.now);
  for (const attack of sounding) expect(nativeAttackIssue(attack), JSON.stringify(attack)).toBeUndefined();
  const bass = sounding.filter(attack => attack.midi! < 48), arp = sounding.filter(attack => attack.midi! >= 48);
  const origin = bass[0].time!, interval = arpStepMs(session.loop.tempo, session.arp.division, session.arp.triplet) / 1000;
  for (const attack of arp) expect((attack.time! - origin) / interval).toBeCloseTo(Math.round((attack.time! - origin) / interval),4);
  for (let step = 0; origin + step * interval <= windowEnd.now - .01; step++) {
    const at = origin + step * interval;
    let candidates = [session.arp];
    for (const edit of windowEnd.edits) {
      if (edit.completedAt < at - .01) candidates = [edit.settings];
      else if (edit.at < at - .01) candidates.push(edit.settings);
    }
    // The audio clock advances inside an edit. A step crossing the protected
    // margin can retain either the old or new pitch/rest; it must never double,
    // disappear outside that measured boundary, or leave the original grid.
    const expected = candidates.map(settings => {
      const cell = resolveArpStep(session.bank[0].notes, timeline ? step % (session.arp.division * (session.arp.triplet ? 1.5 : 1)) : step, settings);
      return cell ? [cell.midi] : [];
    });
    const actual = arp.filter(attack => Math.abs(attack.time! - at) < .00001).map(attack => attack.midi);
    const matches = expected.some(notes => notes.length === actual.length && notes.every((midi,index) => midi === actual[index]));
    if (!matches) await info.attach('pattern-attacks', { body: JSON.stringify(sounding,null,2), contentType: 'application/json' });
    expect(matches, `step ${step} at ${at}: ${JSON.stringify({actual,expected})}`).toBe(true);
  }
  expect(windowEnd.edits.length).toBeGreaterThan(20);
  expect(bass.length).toBeGreaterThanOrEqual(timeline ? 2 : 1);
  expect({ misses: windowEnd.misses, late: windowEnd.late }).toEqual({ misses: 0, late: 0 });
  expect(errors).toEqual([]); await expect(page.getByRole('alert')).toHaveCount(0);
  if (config === 'current-80') await info.attach('live-pattern-ui', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.up('1'); await page.keyboard.press('Escape');
});


for (const timeline of [false,true]) test(`${timeline ? 'timeline' : 'held'} queued pattern replacement keeps native sources and the sounding envelope`, async ({ page }) => {
  const session = fixture('Felt'); session.sound.reverbAmount = 0;
  session.arp = { ...session.arp, division: 8, register: 0, mirror: false, gate: 1, steps: [0,0,0,0,0,0,0,0] };
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page);
  const windowEnd = await page.evaluate(async ({ timeline, settings }) => {
    const e = (window as any).__engine;
    const notes = (midi: number) => [
      { id: 99, midi: 36, tick: 0, durationTicks: 1920, velocity: .58, part: 'bass' },
      ...Array.from({ length: 8 }, (_, id) => ({ id, midi, tick: id * 240, durationTicks: 240, velocity: .68, part: 'chords' })),
    ];
    if (timeline) await e.loop(notes(60),1920,100,() => {},() => {},0,false,settings);
    else { e.startHeldArp('diagnostic',[60,64,67],settings,100,() => {},{ id:'bass:diagnostic',midi:36 }); await e.unlock(); }
    await new Promise(resolve => setTimeout(resolve,35));
    const before = (window as any).__events.filter((v: any) => v.midi !== undefined).map((v: any) => ({ id:v.id,native:v.native.id,time:v.time }));
    const changed = { ...settings, steps: [7,7,7,7,7,7,7,7] };
    if (timeline) e.updateLoop(notes(67),1920,100,changed);
    else e.updateHeldArp('diagnostic',[60,64,67],changed,100);
    await new Promise(resolve => setTimeout(resolve,330));
    clearInterval(e.timer); clearInterval(e.heldArpTimer);
    return { before, misses:e.deadlineMisses,late:e.lateSubmissions };
  }, { timeline, settings:session.arp });
  const trace = await events(page), attacks = trace.filter(v => v.midi !== undefined);
  expect(trace.filter(v => v.disposed && v.start! > v.now!)).toEqual([]);
  for (const attack of attacks) expect(nativeAttackIssue(attack),JSON.stringify(attack)).toBeUndefined();
  for (const owned of windowEnd.before) {
    const attack = attacks.find(v => v.id === owned.id)!;
    expect(attack.native!.id).toBe(owned.native); expect(attack.time).toBe(owned.time);
  }
  const arp = attacks.filter(v => v.midi! >= 48).sort((a,b) => a.time! - b.time!);
  expect(arp[0].midi).toBe(60); expect(arp[1].midi).toBe(67);
  for (let step=1;step<arp.length;step++) expect(arp[step].time! - arp[step-1].time!).toBeCloseTo(.3,5);
  expect({misses:windowEnd.misses,late:windowEnd.late}).toEqual({misses:0,late:0});
  await page.keyboard.press('Escape');
});


for (const timeline of [false,true]) test(`${timeline ? 'timeline' : 'held'} Randomize keeps current native arp and Bass while replacing future timing`, async ({ page }) => {
  const session = currentSafariFixture(); session.arp.steps = [0,0,0,0,0,0,0,0];
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1', '1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page);
  await page.evaluate(timeline => {
    const w=window as any, e=w.__engine, method=timeline?'updateLoop':'updateHeldArp', original=e[method];
    const random=crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues=((values: Uint32Array) => { if(values.length===1){ values[0]=123; return values; } return random(values); }) as typeof crypto.getRandomValues;
    e[method]=function(...args:any[]) {
      const at=this.audioTime(), settings=args[timeline?3:2];
      const items=timeline?[...this.loopState.scheduled.values()]:this.heldArps.get('live').events;
      const owned=items.filter((v:any)=>v.start<=at+.01 && v.end>at).map((v:any)=>({id:v.live?.id,time:v.start}));
      const next=items.filter((v:any)=>v.start>at+.01).map((v:any)=>v.start).sort((a:number,b:number)=>a-b)[0];
      const result=original.apply(this,args);
      w.__randomize={at,owned,next,settings:structuredClone(settings)};return result;
    };
  },timeline);
  if(timeline)await page.keyboard.press('Space');else await page.keyboard.down('1');
  await page.waitForTimeout(130);await page.getByRole('button',{name:'Randomize arpeggiator',exact:true}).click();
  await page.waitForTimeout(1100);
  const result=await page.evaluate(()=>{
    const w=window as any,e=w.__engine;clearInterval(e.timer);clearInterval(e.heldArpTimer);
    return {...w.__randomize,now:e.audioTime(),misses:e.deadlineMisses,late:e.lateSubmissions};
  });
  const trace=await events(page),cancelled=new Set(trace.filter(v=>v.disposed&&v.start!>v.now!).map(v=>v.disposed));
  const attacks=trace.filter(v=>v.midi!==undefined&&!cancelled.has(v.id!)&&v.time!<=result.now);
  for(const attack of attacks)expect(nativeAttackIssue(attack),JSON.stringify(attack)).toBeUndefined();
  for(const owned of result.owned)expect(attacks.find(v=>v.id===owned.id)?.time).toBe(owned.time);
  expect(result.settings.division).not.toBe(session.arp.division);
  const interval=arpStepMs(session.loop.tempo,result.settings.division,result.settings.triplet)/1000;
  const origin=timeline?attacks.find(v=>v.midi!<48)!.time!:result.next;
  for(const attack of attacks.filter(v=>v.midi!>=48&&v.time!>result.at+.01))
    expect((attack.time!-origin)/interval).toBeCloseTo(Math.round((attack.time!-origin)/interval),4);
  expect({misses:result.misses,late:result.late}).toEqual({misses:0,late:0});
  await page.keyboard.up('1');await page.keyboard.press('Escape');
});


test('pattern drawing during pending unlock becomes the first native timeline attack', async ({ page }) => {
  const session = fixture('Felt'); session.arp = { ...session.arp, division: 8, register: 0, mirror: false, gate: .5, steps: Array(8).fill(0) };
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1','1'); localStorage.setItem('thread.demo.session.v1',JSON.stringify(value)); },session);
  await page.goto('./'); await traceEngine(page);
  await page.evaluate(() => {
    const w=window as any,e=w.__engine,unlock=e.unlock.bind(e);
    const waiting=new Promise<void>(resolve=>{w.__resumePattern=resolve;});e.unlock=()=>waiting.then(unlock);
  });
  await page.keyboard.press('Space');
  await page.locator('.arp-matrix button[data-column="0"][data-row="7"]').click();
  await page.evaluate(() => (window as any).__resumePattern());
  await expect.poll(async()=>(await events(page)).filter(v=>v.midi!>=48).length).toBeGreaterThan(0);
  const first=(await events(page)).find(v=>v.midi!>=48)!;
  expect(first.midi).toBe(65);expect(nativeAttackIssue(first),JSON.stringify(first)).toBeUndefined();
  await page.keyboard.press('Escape');
});


test('a combined pattern and Bass edit preserves the current native arp and starts the new Bass', async ({ page }) => {
  const session=fixture('Felt');session.arp={...session.arp,division:8,register:0,mirror:false,gate:1,steps:Array(8).fill(0)};
  await page.addInitScript(value=>{localStorage.setItem('thread.demo.intro.seen.v1','1');localStorage.setItem('thread.demo.session.v1',JSON.stringify(value));},session);
  await page.goto('./');await traceEngine(page);
  const result=await page.evaluate(async settings=>{
    const w=window as any,e=w.__engine;
    const notes=(midi:number,bass:number)=>[
      {id:99,midi:bass,tick:0,durationTicks:1920,velocity:.58,part:'bass'},
      ...Array.from({length:8},(_,id)=>({id,midi,tick:id*240,durationTicks:240,velocity:.68,part:'chords'})),
    ];
    await e.loop(notes(60,46),1920,100,()=>{},()=>{},0,false,settings);
    const original=w.__events.find((v:any)=>v.midi===60),owned={id:original.id,time:original.time,native:original.native.id,duration:original.duration};
    await new Promise(resolve=>setTimeout(resolve,35));
    e.updateLoop(notes(67,34),1920,100,{...settings,steps:Array(8).fill(7)});
    await new Promise(resolve=>setTimeout(resolve,80));clearInterval(e.timer);
    return{owned,misses:e.deadlineMisses,late:e.lateSubmissions};
  },session.arp);
  const attacks=(await events(page)).filter(v=>v.midi!==undefined),current=attacks.find(v=>v.id===result.owned.id)!;
  expect({time:current.time,native:current.native!.id,duration:current.duration}).toEqual({time:result.owned.time,native:result.owned.native,duration:result.owned.duration});
  expect(current.midi).toBe(60);expect(attacks.filter(v=>v.midi!<48).map(v=>v.midi)).toEqual([46,34]);
  for(const attack of attacks)expect(nativeAttackIssue(attack),JSON.stringify(attack)).toBeUndefined();
  expect({misses:result.misses,late:result.late}).toEqual({misses:0,late:0});await page.keyboard.press('Escape');
});


test('combined pattern edits restore cancelled next-loop Bass without replaying arp', async ({ page }) => {
  const session=fixture('Felt');session.arp={...session.arp,division:8,register:0,mirror:false,gate:1,steps:Array(8).fill(0)};
  await page.addInitScript(value=>{localStorage.setItem('thread.demo.intro.seen.v1','1');localStorage.setItem('thread.demo.session.v1',JSON.stringify(value));},session);
  await page.goto('./');await traceEngine(page);
  const result=await page.evaluate(async settings=>{
    const w=window as any,e=w.__engine;
    const notes=(midi:number,bass:boolean)=>[
      ...(bass?[{id:99,midi:46,tick:0,durationTicks:1920,velocity:.58,part:'bass'}]:[]),
      ...Array.from({length:8},(_,id)=>({id,midi,tick:id*240,durationTicks:240,velocity:.68,part:'chords'})),
    ];
    await e.loop(notes(60,true),1920,200,()=>{},()=>{},0,false,settings);const origin=e.playbackClock().origin;
    while(e.audioTime()<origin+1.08)await new Promise(resolve=>setTimeout(resolve,16));
    e.updateLoop(notes(67,false),1920,200,{...settings,steps:Array(8).fill(7)});
    e.updateLoop(notes(60,true),1920,200,settings);
    await new Promise(resolve=>setTimeout(resolve,230));clearInterval(e.timer);
    return{origin,misses:e.deadlineMisses,late:e.lateSubmissions};
  },session.arp);
  const trace=await events(page),cancelled=new Set(trace.filter(v=>v.disposed&&v.start!>v.now!).map(v=>v.disposed));
  const attacks=trace.filter(v=>v.midi!==undefined&&!cancelled.has(v.id));
  expect(attacks.filter(v=>v.midi===46&&Math.abs(v.time!-result.origin-1.2)<.00001)).toHaveLength(1);
  const arp=attacks.filter(v=>v.midi!>=48);for(const attack of arp)expect((attack.time!-result.origin)/.15).toBeCloseTo(Math.round((attack.time!-result.origin)/.15),4);
  for(const attack of attacks)expect(nativeAttackIssue(attack),JSON.stringify(attack)).toBeUndefined();
  expect({misses:result.misses,late:result.late}).toEqual({misses:0,late:0});await page.keyboard.press('Escape');
});


for (const delay of ['refill', 'construction'] as const) test(`active Bass survives a ${delay} deadline gap with its absolute end and future grid intact`, async ({ page }) => {
  const session = fixture('Current'); session.sound.reverbAmount = 0;
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1','1'); localStorage.setItem('thread.demo.session.v1',JSON.stringify(value)); },session);
  await page.goto('./'); await traceEngine(page);
  const clock = await page.evaluate(async delay => {
    const e = (window as any).__engine;
    const notes = delay === 'refill' ? [
      { id:0,midi:39,tick:0,durationTicks:480,velocity:.58,part:'bass' },
      { id:1,midi:37,tick:480,durationTicks:960,velocity:.58,part:'bass' },
      { id:2,midi:41,tick:1440,durationTicks:480,velocity:.58,part:'bass' },
    ] : [37,60,64].map((midi,id) => ({ id,midi,tick:480,durationTicks:960,velocity:.58,part:id ? 'chords' : 'bass' }));
    await e.loop(notes,1920,120,() => {},() => {});
    clearInterval(e.timer); e.timer = null;
    const origin = e.playbackClock().origin;
    while (e.audioTime() < origin + (delay === 'refill' ? .65 : .25)) await new Promise(r => setTimeout(r,4));
    if (delay === 'construction') {
      const create = e.createVoice;
      e.createVoice = function(...args: any[]) {
        const live = create.apply(this,args), limit = performance.now() + 1000;
        while (this.audioTime() < origin + .56 && performance.now() < limit) { /* foreground work outlasts an unsubmitted onset */ }
        return live;
      };
    }
    const began = e.audioTime(); e.pumpLoop(false);
    if (delay === 'refill') {
      while (e.audioTime() < origin + 1.2) await new Promise(r => setTimeout(r,4));
      e.pumpLoop(false);
    }
    return { origin,began,misses:e.deadlineMisses,afterOrigin:e.playbackClock().origin };
  },delay);
  const attacks = (await events(page)).filter(event => event.midi !== undefined);
  const bass = attacks.find(attack => attack.midi === 37);
  expect(bass,'the active Bass must cover the remaining clip after the gap').toBeDefined();
  expect(nativeAttackIssue(bass!),JSON.stringify(bass)).toBeUndefined();
  expect(bass!.time).toBeGreaterThan(clock.began);
  expect(bass!.time! + bass!.duration!).toBeCloseTo(clock.origin + 1.5,5);
  expect(clock.afterOrigin).toBe(clock.origin); expect(clock.misses).toBe(delay === 'refill' ? 1 : 3);
  expect(attacks.filter(attack => attack.midi === 37)).toHaveLength(1);
  if (delay === 'refill') {
    const next = attacks.find(attack => attack.midi === 41)!;
    expect(next.time).toBeCloseTo(clock.origin + 1.5,5);
    expect(nativeAttackIssue(next)).toBeUndefined();
  } else expect(attacks).toHaveLength(1);
  await page.keyboard.press('Escape');
});


for (const fault of ['disconnect', 'dry-mute', 'master-mute'] as const) test(`native checks reject a ${fault} in the shared output despite a valid Bass envelope`, async ({ page }) => {
  const session = fixture('Felt'); session.sound.reverbAmount = 0;
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1','1'); localStorage.setItem('thread.demo.session.v1',JSON.stringify(value)); },session);
  await page.goto('./'); await traceEngine(page);
  await page.evaluate(fault => {
    const e = (window as any).__engine, submit = e.submitVoice; let applied = false;
    e.submitVoice = function(...args: any[]) {
      const result = submit.apply(this,args);
      if (!applied) {
        applied = true;
        if (fault === 'disconnect') this.dryGain.disconnect(this.limiter);
        else (fault === 'dry-mute' ? this.dryGain : this.output).gain.setValueAtTime(0,args[3]);
      }
      return result;
    };
  },fault);
  await page.keyboard.down('1');
  await expect.poll(async () => (await events(page)).filter(attack => attack.midi !== undefined && attack.id?.startsWith('bass:')).length).toBe(1);
  const bass = (await events(page)).find(attack => attack.midi !== undefined && attack.id?.startsWith('bass:'))!;
  expect(nativeValue(bass.automation!,bass.time! + .005)).toBeGreaterThan(0);
  expect(nativeValue(bass.sourceGain!,bass.time! + .005)).toBeGreaterThan(0);
  expect(nativeAttackIssue(bass)).toBe(fault === 'disconnect' ? 'native source has no destination path' : 'shared output path muted');
  await page.keyboard.up('1'); await page.keyboard.press('Escape');
});

test('unrelated Sound edits prepare only one native reverb graph while its impulse is pending', async ({ page }) => {
  const session = fixture('Current'); session.sound.reverbTime = 1;
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1','1'); localStorage.setItem('thread.demo.session.v1',JSON.stringify(value)); },session);
  await page.goto('./'); await traceEngine(page);
  const result = await page.evaluate(async sound => {
    const w = window as any, e = w.__engine; await e.unlock();
    const before = w.__nativeCounts.createConvolver ?? 0;
    e.commitReverbTime();
    for (const color of [.1,.2,.3]) { e.setSound({ ...sound,color }); e.commitReverbTime(); }
    e.attackBatch([{ id:'bass:diagnostic',midi:39,velocity:.58,part:'bass' }]);
    return { preparations:w.__nativeCounts.createConvolver - before,misses:e.deadlineMisses };
  },session.sound);
  expect(result.preparations).toBe(1); expect(result.misses).toBe(0);
  const bass = (await events(page)).find(attack => attack.midi === 39)!;
  expect(nativeAttackIssue(bass),JSON.stringify(bass)).toBeUndefined();
  await page.keyboard.press('Escape');
});

for (const arp of [false,true]) test(`Current100 four-bar Bass keeps each native route with arp ${arp ? 'on' : 'off'}`, async ({ page }) => {
  const session = fixture('Current');
  session.sound = { attack:0,decay:1,color:0,texture:1,reverbAmount:1,reverbTime:1,masterVolume:.75 };
  session.loop.tempo = 100;
  session.arp = { mode:arp ? 'arp' : 'off',division:32,triplet:true,steps:[1,2,6,0,6,4,1,2],register:1,gate:1,reverse:true,mirror:false };
  session.bank.splice(0,4,
    { root:3,quality:'maj7',symbol:'E♭maj7',notes:[51,55,58,62],voicing:{base:[50,51,55,58],inversion:1} },
    { root:1,quality:'add9',symbol:'C♯add9',notes:[53,56,61,63],voicing:{base:[49,51,53,56],inversion:2} },
    { root:5,quality:'min7',symbol:'Fm7',notes:[53,56,60,63],voicing:{base:[39,41,44,48],inversion:5} },
    { root:5,quality:'add9',symbol:'Fadd9',notes:[53,55,57,60],voicing:{base:[53,55,57,60],inversion:0} });
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1','1'); localStorage.setItem('thread.demo.session.v1',JSON.stringify(value)); },session);
  await page.goto('./'); await traceEngine(page); await page.keyboard.press('Space'); await page.waitForTimeout(17200);
  const trace = await events(page), bass = trace.filter(attack => attack.midi !== undefined && attack.midi < 48);
  const clock = await page.evaluate(() => { const e = (window as any).__engine; return { ...e.playbackClock(),misses:e.deadlineMisses,late:e.lateSubmissions }; });
  const expected = Math.floor((clock.audioTime - clock.origin) / 2.4) + 1;
  for (let index = 0; index < expected; index++) {
    const matches = bass.filter(attack => Math.abs(attack.time! - clock.origin - index * 2.4) < .00001);
    expect(matches).toHaveLength(1);
    expect(matches[0].midi).toBe([39,37,41,41][index % 4]);
    expect(nativeAttackIssue(matches[0]),JSON.stringify(matches[0])).toBeUndefined();
    expect(matches[0].route!.length).toBeGreaterThan(8);
  }
  expect(clock.misses).toBe(0); expect(clock.late).toBe(0);
  await page.keyboard.press('Escape'); await expect(page.getByRole('alert')).toHaveCount(0);
});


test('clock progress before the first timeline pump cannot consume a short first Gate', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('thread.demo.intro.seen.v1','1'));
  await page.goto('./'); await traceEngine(page);
  const clock = await page.evaluate(async () => {
    const e = (window as any).__engine; e.setSound({ attack:0,decay:1,color:.35,texture:.5,reverbAmount:0,reverbTime:.46,masterVolume:.75 });
    const pump = e.pumpLoop; let delayed = false;
    e.pumpLoop = function(...args: any[]) {
      if (!delayed) {
        delayed = true; const target = this.audioTime() + .006, limit = performance.now() + 1000;
        while (this.audioTime() < target && performance.now() < limit) { /* first pump crosses a short Gate before any submission */ }
      }
      return pump.apply(this,args);
    };
    await e.loop([
      { id:0,midi:36,tick:0,durationTicks:1920,velocity:.58,part:'bass' },
      { id:1,midi:60,tick:0,durationTicks:2,velocity:.68,part:'chords' },
      { id:2,midi:64,tick:40,durationTicks:2,velocity:.68,part:'chords' },
    ],1920,200,() => {},() => {});
    return { origin:e.playbackClock().origin,misses:e.deadlineMisses };
  });
  const attacks = (await events(page)).filter(event => event.midi !== undefined);
  const first = attacks.find(attack => attack.midi === 60), bass = attacks.find(attack => attack.midi === 36)!;
  expect(first,'startup preparation must retain the first short Gate').toBeDefined();
  expect(first!.time).toBe(bass.time); expect(first!.time).toBeCloseTo(clock.origin,5);
  expect(first!.duration).toBeCloseTo(.00125,5);
  expect(attacks.find(attack => attack.midi === 64)!.time! - first!.time!).toBeCloseTo(.025,5);
  for (const attack of attacks) expect(nativeAttackIssue(attack),JSON.stringify(attack)).toBeUndefined();
  expect(clock.misses).toBe(0); await page.keyboard.press('Escape');
});


test('same-quantum Gate revision preserves the prepared oscillator through a later pitch edit', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('thread.demo.intro.seen.v1','1'));
  await page.goto('./'); await traceEngine(page);
  const result = await page.evaluate(async () => {
    const w = window as any,e=w.__engine; e.setSound({ attack:0,decay:1,color:.35,texture:.5,reverbAmount:0,reverbTime:.46,masterVolume:.75 }); await e.unlock();
    const context=e.liveContext,immediate=context.immediate.bind(context),fixed=immediate();
    context.immediate=() => fixed; Object.defineProperty(context,'currentTime',{ configurable:true,get:() => fixed });
    const settings={ mode:'arp',division:32,triplet:true,steps:Array(8).fill(0),register:0,gate:1,reverse:false,mirror:false };
    const live=e.createVoice('live:arp:queued','chords',.003),start=fixed+.2;
    e.submitVoice(live,58,.68,start,.025);
    const native=live.synth.oscillator._oscillator._oscillator._oscillator;
    const first=e.reviseQueuedArp(live,58,.68,start,.0035,{ ...settings,gate:.14 },200);
    context.immediate=() => fixed+.05; Object.defineProperty(context,'currentTime',{ configurable:true,get:() => fixed+.05 });
    let second=false,error;
    try { second=e.reviseQueuedArp(live,65,.68,start,.0035,{ ...settings,gate:.14 },200); } catch (cause) { error=String(cause); }
    const unchanged=native===live.synth.oscillator._oscillator._oscillator._oscillator;
    context.immediate=immediate; delete context.currentTime;
    return { first,second,error,unchanged,start,oscillators:w.__nativeCounts.createOscillator };
  });
  expect(result.error).toBeUndefined(); expect(result.first).toBe(true); expect(result.second).toBe(true);
  expect(result.unchanged).toBe(true); expect(result.oscillators).toBe(1);
  const attack=(await events(page)).find(event => event.id==='live:arp:queued')!;
  expect(attack.midi).toBe(65); expect(attack.time).toBe(result.start);
  expect(attack.duration).toBeCloseTo(.0035,5); expect(nativeAttackIssue(attack),JSON.stringify(attack)).toBeUndefined();
  await page.keyboard.press('Escape');
});


test('manual pad attacks reuse retired effects with fresh sources and a short shared onset', async ({ page }) => {
  const session = fixture('Current'); session.arp.mode = 'off'; session.sound.reverbAmount = 0;
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1','1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page);
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.evaluate(() => { const e=(window as any).__engine,create=e.createVoice; e.createVoice=function(...args:any[]) { const live=create.apply(this,args); (window as any).__preparedAt=this.audioTime(); return live; }; });
  await page.keyboard.down('1');
  await expect.poll(async () => (await events(page)).filter(event => event.midi !== undefined).length).toBe(session.bank[0].notes.length + 1);
  const first = (await events(page)).filter(event => event.midi !== undefined);
  const prepared = await page.evaluate(() => (window as any).__allocations.map((item: any) => ({ filter: item.filter, synth: item.synth, part: item.part })));
  expect(first).toHaveLength(session.bank[0].notes.length + 1);
  await page.keyboard.up('1');
  await expect.poll(() => page.evaluate(() => (window as any).__engine.voices.size)).toBe(0);
  await page.keyboard.down('1');
  const all = (await events(page)).filter(event => event.midi !== undefined), next = all.slice(first.length);
  const reused = await page.evaluate(() => (window as any).__allocations.slice((window as any).__allocations.length / 2));
  for (const part of ['chords','bass']) {
    expect(reused.filter((item:any) => item.part === part).map((item:any) => item.filter).sort()).toEqual(prepared.filter((item:any) => item.part === part).map((item:any) => item.filter).sort());
  }
  expect(reused.every((item:any) => !prepared.some((old:any) => old.synth === item.synth))).toBe(true);
  expect(next[0].time! - await page.evaluate(() => (window as any).__preparedAt)).toBeLessThan(.009);
  expect(new Set(next.map(event => event.time)).size).toBe(1);
  for (let i=0;i<next.length;i++) {
    expect(nativeAttackIssue(next[i]),JSON.stringify(next[i])).toBeUndefined();
    expect(next[i].native!.id).not.toBe(first[i].native!.id);
    expect(next[i].native!.requested).toBeLessThan(next[i].time!);
  }
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => [(window as any).__engine.deadlineMisses,(window as any).__engine.lateSubmissions])).toEqual([0,0]);
  await page.keyboard.up('1'); await page.keyboard.press('Escape');
});


test('cold and rapid manual chord handoffs retain every native command before their shared onset', async ({ page }) => {
  const session = fixture('Current'); session.arp.mode = 'off';
  await page.addInitScript(value => { localStorage.setItem('thread.demo.intro.seen.v1','1'); localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)); }, session);
  await page.goto('./'); await traceEngine(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (let press=0;press<12;press++) {
    const key=String(press%4+1), count=(await events(page)).filter(event => event.midi !== undefined).length;
    await page.keyboard.down(key);
    await expect.poll(async () => (await events(page)).filter(event => event.midi !== undefined).length).toBe(count + session.bank[press%4].notes.length + 1);
    const attacks=(await events(page)).filter(event => event.midi !== undefined).slice(count);
    expect(new Set(attacks.map(event => event.time)).size).toBe(1);
    for(const attack of attacks) expect(nativeAttackIssue(attack),JSON.stringify(attack)).toBeUndefined();
    await page.waitForTimeout(15); await page.keyboard.up(key);
    if(press%3===2) await expect.poll(() => page.evaluate(() => (window as any).__engine.voices.size)).toBe(0);
  }
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => [(window as any).__engine.deadlineMisses,(window as any).__engine.lateSubmissions])).toEqual([0,0]);
  await page.keyboard.press('Escape');
});
