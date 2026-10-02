import { test, expect, type Page } from '@playwright/test';
import { attachEngine } from './audioProbe';
import { createSession } from '../src/state/session';

const sounding = (page: Page) => page.locator('.pad.sounding');
async function pointer(page: Page, pad: number) {
  const box = (await page.getByTestId(`pad-${pad}`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('thread.demo.intro.seen.v1', '1'));
  await page.goto('./');
});

test('newest physical input wins and restores through keyboard and pointer releases', async ({ page }) => {
  await page.keyboard.down('1'); await page.keyboard.down('2');
  await expect(sounding(page)).toHaveCount(1); await expect(page.getByTestId('pad-2')).toHaveClass(/sounding/);
  await pointer(page, 3); await expect(page.getByTestId('pad-3')).toHaveClass(/sounding/);
  await page.mouse.up(); await expect(page.getByTestId('pad-2')).toHaveClass(/sounding/);
  await page.keyboard.up('2'); await expect(page.getByTestId('pad-1')).toHaveClass(/sounding/);
  await page.keyboard.up('1'); await expect(sounding(page)).toHaveCount(0);
});

test('same-pad transfer preserves the chord and arp, Hold selects one input, cancel clears', async ({ page }) => {
  await page.getByRole('button', { name: 'Arpeggiator', exact: true }).click();
  await page.keyboard.down('1'); await pointer(page, 1); await page.keyboard.up('1');
  await expect(sounding(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'thread — play a random chord' }).isDisabled().then(value => expect(value).toBe(true));
  await page.mouse.up(); await expect(sounding(page)).toHaveCount(0);
  await page.keyboard.down('1'); await page.keyboard.down('2'); await page.keyboard.press('Shift');
  await page.keyboard.up('2'); await expect(page.getByTestId('pad-2')).toHaveClass(/sounding/);
  await page.keyboard.press('Shift'); await expect(page.getByTestId('pad-1')).toHaveClass(/sounding/);
  await page.keyboard.up('1'); await expect(sounding(page)).toHaveCount(0);
  await pointer(page, 2); await page.getByTestId('pad-2').dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up(); await expect(sounding(page)).toHaveCount(0);
  await page.keyboard.down('3'); await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.keyboard.up('3'); await expect(sounding(page)).toHaveCount(0);
});

test('pointer controls release focus, numpad plays, menus close, Tab sliders still adjust', async ({ page }) => {
  for (const control of [page.getByRole('slider', { name: 'Texture', exact: true }), page.getByRole('button', { name: 'Major Q', exact: true })]) {
    await control.click(); await expect(control).not.toBeFocused();
    await page.keyboard.down('Numpad2'); await expect(page.getByTestId('pad-2')).toHaveClass(/sounding/);
    await page.keyboard.up('Numpad2'); await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await page.keyboard.press('Space');
  }
  await page.getByRole('button', { name: 'Voice', exact: true }).click(); await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.down('1'); await expect(page.getByRole('listbox')).toHaveCount(0); await expect(page.getByTestId('pad-1')).toHaveClass(/sounding/); await page.keyboard.up('1');
  await page.getByRole('button', { name: 'Voice', exact: true }).click(); await page.keyboard.press('Space');
  await expect(page.getByRole('listbox')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible(); await page.keyboard.press('Space');
  const slider = page.getByRole('slider', { name: 'Gate', exact: true }); await slider.focus();
  const value = Number(await slider.getAttribute('aria-valuenow')); await page.keyboard.press('ArrowRight'); await expect(slider).toHaveAttribute('aria-valuenow', String(value + 1));
  const tempo = page.getByRole('textbox', { name: 'Tempo BPM' }); await tempo.focus(); await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});

test('logo guards playback, recording and pending unlock, actions invalidate auditions', async ({ page }) => {
  const logo = page.getByRole('button', { name: 'thread — play a random chord' });
  await expect(logo).toBeEnabled();
  await page.keyboard.press('Space'); await expect(logo).toBeDisabled(); await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Record', exact: true }).click(); await expect(logo).toBeDisabled(); await page.keyboard.press('Escape');
  await page.keyboard.down('1'); await expect(logo).toBeDisabled(); await page.keyboard.up('1'); await expect(logo).toBeEnabled();
  await page.reload(); await attachEngine(page);
  await page.evaluate(() => {
    const e = (window as any).__engine, unlock = e.unlock.bind(e);
    let resolve!: () => void; const waiting = new Promise<void>(done => { resolve = done; });
    Object.assign(window, { __releaseResume: resolve });
    e.unlock = () => waiting.then(unlock);
  });
  await logo.click(); await page.keyboard.down('2'); await expect(logo).toBeDisabled(); await page.keyboard.up('2');
  await page.evaluate(() => (window as unknown as { __releaseResume: () => void }).__releaseResume());
  await page.waitForTimeout(100); await expect(sounding(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__engine.voices.size)).toBe(0);
});

test('instrument keys close toolbar menus and atomic recording handoffs never restore backing between pads', async ({ page }) => {
  await page.getByRole('button', { name: 'Timing options', exact: true }).click();
  await page.keyboard.down('2'); await expect(page.locator('.timing-popover')).toHaveCount(0); await page.keyboard.up('2');
  await page.getByRole('button', { name: 'Recording settings', exact: true }).click();
  await page.getByRole('button', { name: 'Count-in', exact: true }).click();
  await page.keyboard.press('Space'); await expect(page.locator('.recording-popover')).toHaveCount(0); await page.keyboard.press('Space');
  await attachEngine(page);
  await page.evaluate(() => {
    const e = (window as any).__engine, original = e.setRecordingOverride;
    Object.assign(window, { __suppression: [] });
    e.setRecordingOverride = function (value: boolean) { if (value !== this.backingSuppressed) (window as any).__suppression.push(value); return original.call(this, value); };
  });
  await page.getByRole('button', { name: 'Record', exact: true }).click(); await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeVisible();
  await page.keyboard.down('1'); await page.waitForTimeout(50); await page.keyboard.down('2'); await page.waitForTimeout(50);
  expect(await page.evaluate(() => (window as any).__suppression)).toEqual([true]);
  await page.keyboard.up('2'); await expect(page.getByTestId('pad-1')).toHaveClass(/sounding/);
  expect(await page.evaluate(() => (window as any).__suppression)).toEqual([true]);
  await page.keyboard.up('1'); await page.getByRole('button', { name: 'Finish', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__suppression)).toEqual([true, false]);
});

async function quantizedRecording(page: Page) {
  const session = createSession(); session.countIn = false; session.quantize = 'beat'; session.loop.tempo = 200; session.loop.bars = 4;
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), session);
  await page.reload(); await attachEngine(page);
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeVisible();
  // Start just after a beat, leaving enough time to queue a complete tap/handoff.
  await page.evaluate(async () => {
    const clock = (window as any).__engine.playbackClock();
    const elapsed = (clock.audioTime - clock.origin) * 1000;
    await new Promise(resolve => setTimeout(resolve, 300 - elapsed % 300 + 30));
  });
}

test('duplicate pointer release cannot cancel a newer quantized winner', async ({ page }) => {
  await quantizedRecording(page);
  await pointer(page, 1); await page.mouse.up(); await page.keyboard.down('2');
  await expect(page.getByTestId('pad-2')).toHaveClass(/sounding/);
  await page.waitForTimeout(650);
  await expect(page.getByTestId('pad-2')).toHaveClass(/sounding/);
  await page.keyboard.up('2'); await page.getByRole('button', { name: 'Finish', exact: true }).click(); await page.keyboard.press('Escape');
});

for (const beforeAttack of [false, true]) test(`Hold cancels quantized release ${beforeAttack ? 'before' : 'after'} the attack without losing the chord`, async ({ page }) => {
  await quantizedRecording(page); await page.keyboard.down('1');
  if (!beforeAttack) { await expect(page.getByTestId('pad-1')).toHaveClass(/sounding/); await page.waitForTimeout(30); }
  await page.keyboard.up('1'); await page.keyboard.press('Shift');
  await expect(page.getByTestId('pad-1')).toHaveClass(/sounding/); await page.waitForTimeout(650);
  await expect(page.getByTestId('pad-1')).toHaveClass(/sounding/);
  await page.keyboard.press('Shift'); await expect(sounding(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Finish', exact: true }).click(); await page.keyboard.press('Escape');
});

for (const event of ['visibilitychange', 'pagehide']) test(`${event} alone preserves a partial recording and returns to idle`, async ({ page }) => {
  await quantizedRecording(page); await page.keyboard.down('1'); await expect(sounding(page)).toHaveCount(1); await page.waitForTimeout(80);
  await page.evaluate(event => {
    if (event === 'visibilitychange') { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event(event)); }
    else window.dispatchEvent(new Event(event));
  }, event);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); window.dispatchEvent(new Event('pageshow')); });
  await page.keyboard.up('1'); await page.keyboard.down('2'); await expect(page.getByTestId('pad-2')).toHaveClass(/sounding/); await page.keyboard.up('2');
  await page.getByRole('button', { name: 'Record', exact: true }).click(); await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
});

test('a canceled recording unlock cannot revive inside newer playback', async ({ page }) => {
  const session = createSession(); session.countIn = false;
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), session); await page.reload(); await attachEngine(page);
  await page.evaluate(() => {
    const e = (window as any).__engine, unlock = e.unlock.bind(e);
    let resolve!: () => void; const waiting = new Promise<void>(done => { resolve = done; });
    Object.assign(window, { __resume: resolve }); e.unlock = () => waiting.then(unlock);
  });
  await page.getByRole('button', { name: 'Record', exact: true }).click(); await page.keyboard.press('Escape'); await page.keyboard.press('Space');
  await page.evaluate(() => (window as any).__resume()); await page.waitForTimeout(150);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finish', exact: true })).toHaveCount(0); await page.keyboard.press('Escape');
});

for (const shift of ['ShiftLeft', 'ShiftRight']) test(`${shift} toggles Hold on press despite repeating a held digit`, async ({ page }) => {
  await page.keyboard.down('1');
  await expect(sounding(page)).toHaveCount(1);
  await page.keyboard.down(shift);
  await expect(page.getByRole('button', { name: 'Hold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down('1'); // Native repeat while Shift remains down.
  await page.keyboard.up('1');
  await expect(page.getByTestId('pad-1')).toHaveClass(/sounding/);
  await page.keyboard.up(shift);
  await expect(page.getByRole('button', { name: 'Hold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down(shift);
  await expect(sounding(page)).toHaveCount(0);
  await page.keyboard.up(shift);
});

test('bare Shift taps toggle once while Shift+Tab keeps keyboard navigation', async ({ page }) => {
  const hold = page.getByRole('button', { name: 'Hold', exact: true });
  await page.keyboard.down('ShiftLeft'); await expect(hold).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.up('ShiftLeft'); await expect(hold).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift'); await expect(hold).toHaveAttribute('aria-pressed', 'false');
  await hold.focus(); await page.keyboard.press('Shift+Tab'); await expect(hold).toHaveAttribute('aria-pressed', 'false');
});

test('pointer Info open and close avoid focus highlights, keyboard dismissal restores focus', async ({ page }) => {
  const info = page.getByRole('button', { name: 'Info (?)', exact: true });
  await info.click();
  const close = page.getByRole('button', { name: 'Close Info', exact: true });
  await expect(close).not.toBeFocused();
  await close.click(); await expect(info).not.toBeFocused();
  await info.focus(); await page.keyboard.press('Enter'); await expect(close).toBeFocused();
  await page.keyboard.press('Escape'); await expect(info).toBeFocused();
});

for (const arp of [false, true]) test(`held ${arp ? 'arp' : 'chord'} follows key, bank and Bass edits through Undo/Redo`, async ({ page }) => {
  await attachEngine(page);
  await page.getByRole('button', { name: 'Bass', exact: true }).click();
  if (arp) await page.getByRole('button', { name: 'Arpeggiator', exact: true }).click();
  await page.keyboard.down('1'); await page.keyboard.press('Shift'); await page.keyboard.up('1');
  const inspect = () => page.evaluate(() => {
    const engine = (window as any).__engine, session = JSON.parse(localStorage.getItem('thread.demo.session.v1')!);
    const chord = session.bank[0]; let bass = chord.root;
    while (bass + 12 <= Math.min(...chord.notes) - 12) bass += 12;
    while (bass > Math.min(...chord.notes) - 12 && bass >= 12) bass -= 12;
    const liveBass = engine.currentById.get('bass:live');
    return { notes: chord.notes, actual: session.arp.mode === 'arp' ? engine.heldArps.get('live')?.notes : [...engine.currentById.keys()].filter((id: string) => /^live:\d+$/.test(id)).map((id: string) => Number(id.split(':')[1])).sort((a: number,b: number)=>a-b),
      expectedBass: session.bass ? bass : null, actualBass: liveBass ? Math.round(69 + 12 * Math.log2(liveBass.synth.frequency.getValueAtTime(liveBass.startTime) / 440)) : null };
  });
  const matches = async () => { await expect.poll(async () => { const value = await inspect(); return { notesMatch: JSON.stringify(value.actual) === JSON.stringify(value.notes), bassMatch: value.actualBass === value.expectedBass }; }).toEqual({ notesMatch: true, bassMatch: true }); };
  await expect.poll(async () => (await inspect()).actual).toEqual((await inspect()).notes);
  await page.getByRole('button', { name: 'Global key up', exact: true }).click(); await matches();
  await page.getByRole('button', { name: 'New chords', exact: true }).click(); await matches();
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await matches();
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await matches();
  await page.getByRole('button', { name: 'Bass', exact: true }).click(); await matches();
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await matches();
  await page.keyboard.press('Escape');
});

test('Undo shrinking the bank clears a hidden held pad and restores a visible selection', async ({ page }) => {
  await page.getByRole('button', { name: 'Number of chords up' }).click();
  await page.getByRole('button', { name: 'Number of chords up' }).click();
  await page.keyboard.down('6'); await page.keyboard.press('Shift'); await page.keyboard.up('6');
  await expect(page.getByTestId('pad-6')).toHaveClass(/sounding/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(sounding(page)).toHaveCount(0); await expect(page.locator('.pad.selected')).toHaveCount(1);
  await attachEngine(page);
  expect(await page.evaluate(() => [...(window as any).__engine.currentById.keys()].filter((id: string) => id.startsWith('live:')))).toEqual([]);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await expect(sounding(page)).toHaveCount(0);
});
