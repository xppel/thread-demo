import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import MidiPackage from '@tonejs/midi';
const { Midi } = MidiPackage;
const state = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('thread.demo.session.v1')!));
async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem('thread.demo.intro.seen.v1', '1'));
  await page.goto('./');
}
async function clickSlider(page: Page, label: string, fraction: number) {
  const slider = page.getByRole('slider', { name: label, exact: true }), box = (await slider.boundingBox())!;
  await page.mouse.click(box.x + Math.max(.1, Math.min(box.width - .1, box.width * fraction)), box.y + box.height / 2);
}

test('first visit, Info reopening, focused Space and guided tour preserve the session', async ({ page }) => {
  await page.goto('./');
  const dialog = page.getByRole('dialog', { name: 'Welcome to thread' });
  await expect(dialog).toBeVisible(); const original = await state(page);
  await expect(page.locator('.instrument')).toHaveAttribute('inert', '');
  await page.getByRole('button', { name: 'Start tutorial' }).focus(); await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Close tutorial' })).toBeFocused();
  const titles = ['Play the chords', 'Build a sequence', 'Shape the sound', 'Make an arpeggio', 'Take it with you'];
  for (let step = 0; step < titles.length; step++) {
    await expect(page.getByRole('dialog', { name: titles[step] })).toBeInViewport();
    expect(await state(page)).toEqual(original);
    await expect(page.locator('.tour-highlight')).toBeVisible();
    if (step === 1) {
      await page.getByRole('button', { name: 'Back', exact: true }).click(); await expect(page.getByRole('dialog', { name: titles[0] })).toBeVisible();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await page.getByRole('button', { name: step === 4 ? 'Done' : 'Next', exact: true }).focus(); await page.keyboard.press('Space');
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('dialog')).toHaveCount(0);
  const info = page.getByRole('button', { name: 'Info (?)', exact: true }); await info.click();
  await page.getByRole('button', { name: 'Start tutorial' }).focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close Info' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(info).toBeFocused();
  await page.keyboard.press('/'); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape');
  await page.keyboard.press('?'); await expect(dialog).toBeVisible(); await page.keyboard.press('Escape');
  const input = page.getByRole('textbox', { name: 'Tempo BPM' }); await input.focus(); await page.waitForTimeout(40); await expect(input).toBeFocused(); await page.keyboard.press('/'); await expect(dialog).toHaveCount(0);
  await info.focus(); await page.keyboard.press('Control+/'); await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('link', { name: '© 2026 Andrew Appel' })).toHaveAttribute('href', 'https://xppel.com');
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(page.locator('.settings-panel .keyboard-help')).toHaveCount(0);
});

test('help works without localStorage and dismissal lasts for the current visit', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } }); });
  await page.goto('./'); await expect(page.getByRole('dialog', { name: 'Welcome to thread' })).toBeVisible();
  await page.getByRole('button', { name: 'Close Info' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Info (?)', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible();
  expect(errors).toEqual([]);
});

test('sliders pick values directly, group gestures, respect Gate minimum and cancel cleanly', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 }); await open(page);
  await page.getByRole('textbox', { name: 'Tempo BPM' }).focus();
  await clickSlider(page, 'Color', .5);
  if ((await state(page)).sound.color !== .5) await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await clickSlider(page, 'Color', .25); const selectedColor = (await state(page)).sound.color; expect(Math.abs(selectedColor - .25)).toBeLessThanOrEqual(.011);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await state(page)).sound.color).toBe(.5);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); expect((await state(page)).sound.color).toBe(selectedColor);
  for (const [fraction, division] of [[0, 2], [.25, 4], [.5, 8], [.75, 16], [1, 32]]) { await clickSlider(page, 'Rate', fraction); expect((await state(page)).arp.division).toBe(division); }
  for (const [fraction, octave] of [[0, -1], [.5, 0], [1, 1]]) { await clickSlider(page, 'Octave', fraction); expect((await state(page)).arp.register).toBe(octave); }
  await clickSlider(page, 'Gate', 0); expect((await state(page)).arp.gate).toBe(.1);
  const gate = page.getByRole('slider', { name: 'Gate', exact: true }); await expect(gate).toHaveAttribute('aria-valuemin', '10');
  await gate.focus(); await page.keyboard.press('ArrowRight'); expect((await state(page)).arp.gate).toBe(.11);
  await clickSlider(page, 'Gate', .5); expect(Math.abs((await state(page)).arp.gate - .55)).toBeLessThanOrEqual(.011);
  const before = (await state(page)).sound.attack, attack = page.getByRole('slider', { name: 'Attack', exact: true }), box = (await attack.boundingBox())!;
  await page.mouse.move(box.x + box.width * .2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * .7, box.y + box.height / 2);
  await attack.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' }); await page.mouse.up();
  await expect(page.locator('html')).not.toHaveClass(/control-dragging/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await state(page)).sound.attack).toBe(before);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await clickSlider(page, 'Master volume', .8); expect(Math.abs((await state(page)).sound.masterVolume - .8)).toBeLessThanOrEqual(.011);
});

test('touch taps select a scaled slider value immediately', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 768, height: 1024 } });
  const page = await context.newPage(); await page.addInitScript(() => localStorage.setItem('thread.demo.intro.seen.v1', '1'));
  await page.goto(baseURL!); const rect = (await page.getByRole('slider', { name: 'Texture', exact: true }).boundingBox())!;
  await page.touchscreen.tap(rect.x + rect.width * .75, rect.y + rect.height / 2); expect(Math.abs((await state(page)).sound.texture - .75)).toBeLessThanOrEqual(.011);
  await expect(page.locator('html')).not.toHaveClass(/control-dragging/); await context.close();
});

test('shortened bars retain clips across edits, reload, exports and Undo', async ({ page }) => {
  await open(page); const fixture = await state(page);
  fixture.loop.blocks = [{ id: 10, pad: 0, tick: 0, durationTicks: 2880 }, { id: 30, pad: 1, tick: 3840, durationTicks: 1920 }, { id: 40, pad: 2, tick: 5760, durationTicks: 1920 }];
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), fixture); await page.reload(); expect((await state(page)).version).toBe(1);
  await page.getByRole('button', { name: 'Timing options' }).click(); for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Bars down' }).click();
  expect((await state(page)).loop.blocks).toEqual(fixture.loop.blocks);
  await expect(page.locator('.timeline-block')).toHaveCount(1);
  await page.getByRole('button', { name: 'Timing options' }).click();
  const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'MIDI', exact: true }).click(); const download = await downloadEvent;
  const midi = new Midi(await readFile((await download.path())!));
  expect(midi.tracks.flatMap(track => track.notes).every(note => note.ticks + note.durationTicks <= midi.header.ppq * 4)).toBe(true);
  expect(midi.tracks.flatMap(track => track.notes).map(note => note.midi).sort()).toEqual(fixture.bank[0].notes.sort());
  await page.reload(); expect((await state(page)).loop.blocks).toEqual(fixture.loop.blocks); await expect(page.locator('.timeline-block')).toHaveCount(1);
  await page.locator('.timeline-block').click(); await page.getByTestId('pad-3').click(); expect((await state(page)).loop.blocks[0]).toMatchObject({ pad: 2, durationTicks: 2880 });
  await page.getByRole('button', { name: 'Timing options' }).click(); for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Bars up' }).click();
  await expect(page.locator('.timeline-block')).toHaveCount(3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await state(page)).loop.bars).toBe(3);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); expect((await state(page)).loop.bars).toBe(4);
  await page.getByRole('button', { name: 'Clear', exact: true }).click(); expect((await state(page)).loop.blocks).toEqual([]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await state(page)).loop.blocks).toHaveLength(3);
});

test('both themes keep thicker controls, pad bars, help and tour inside supported viewports', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await open(page);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 1100, height: 650 }, { width: 900, height: 700 }, { width: 768, height: 1024 }]) {
      await page.setViewportSize(size);
      const headingOffsets = await page.evaluate(() => {
        const center = (element: Element) => { const box = element.getBoundingClientRect(); return box.x + box.width / 2; };
        const offset = (group: string, controls: string) => {
          const heading = document.querySelector(group)!, columns = document.querySelectorAll(controls);
          const first = columns[0].getBoundingClientRect(), second = columns[1].getBoundingClientRect();
          return Math.abs(center(heading) - (first.right + second.left) / 2);
        };
        return [offset('.voice-select', '.sound-parameters .knob-control'), offset('.arp-top-row .control-toggle', '.arp-rate-row .knob-control')];
      });
      expect(headingOffsets.every(offset => offset < .15)).toBe(true);
      await expect.poll(async () => { const slider = (await page.getByRole('slider', { name: 'Rate', exact: true }).boundingBox())!; const toggle = (await page.locator('.arp-top-row .toggle-track').boundingBox())!; return Math.abs(slider.height - toggle.height); }).toBeLessThan(.1);
      expect(await page.locator('.tempo-group label').evaluate(el => getComputedStyle(el).color)).toBe(await page.locator('.tempo-input').evaluate(el => getComputedStyle(el).color));
      const selected = page.locator('.pad.selected');
      const header = await selected.evaluate(el => {
        const row = el.querySelector('.pad-top')!, number = row.querySelector('kbd')!, dot = row.querySelector('.pad-light')!;
        const scale = el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth;
        const center = (node: Element) => { const rect = node.getBoundingClientRect(); return rect.y + rect.height / 2; };
        return { strip: getComputedStyle(el, '::before').height, row: getComputedStyle(row).height, number: Math.abs(center(row) - center(number)) / scale, dot: Math.abs(center(row) - center(dot)) / scale };
      });
      expect(header.strip).toBe('20px'); expect(header.row).toBe('20px'); expect(header.number).toBeLessThan(.1); expect(header.dot).toBeLessThan(.1);
      const footer = await page.locator('.footer-left .quiet-button').evaluate(el => {
        const text = el.querySelector('span')!, key = el.querySelector('kbd')!, a = text.getBoundingClientRect(), b = key.getBoundingClientRect();
        return { top: Math.abs(a.top - b.top), bottom: Math.abs(a.bottom - b.bottom), font: getComputedStyle(text).font === getComputedStyle(key).font, decoration: getComputedStyle(key).boxShadow };
      });
      expect(footer.top).toBeLessThan(.1); expect(footer.bottom).toBeLessThan(.1); expect(footer.font).toBe(true); expect(footer.decoration).toBe('none');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      expect(await page.locator('.settings-panel').evaluate(el => getComputedStyle(el).width)).toBe('300px');
      expect(await page.locator('.settings-trigger').evaluate(el => [getComputedStyle(el).width, getComputedStyle(el).height, getComputedStyle(el.querySelector('svg')!).width])).toEqual(['32px', '32px', '16px']);
      expect((await page.getByRole('slider', { name: 'Master volume' }).boundingBox())!.y).toBeLessThan((await page.getByRole('textbox', { name: 'Background hex value' }).boundingBox())!.y);
      await page.getByRole('button', { name: 'Pick accent color' }).click(); await expect(page.getByRole('group', { name: 'Accent color picker' })).toBeInViewport();
      await page.getByRole('button', { name: 'Close settings' }).click();
      await page.getByRole('button', { name: 'Info (?)', exact: true }).click(); await expect(page.getByRole('dialog')).toBeInViewport();
      await page.getByRole('button', { name: 'Start tutorial' }).click();
      expect(await page.locator('.tour-highlight').evaluate(el => getComputedStyle(el).boxShadow)).toContain('0.72');
      for (let step = 0; step < 5; step++) { await expect(page.getByRole('dialog')).toBeInViewport(); await page.getByRole('button', { name: step === 4 ? 'Done' : 'Next', exact: true }).click(); }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`help-${colorScheme}-${size.width}.png`) });
    }
  }
  expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('Space flashes fixed-width transport, logo letters bounce and reduced motion disables feedback', async ({ page }) => {
  await open(page); const play = page.locator('.play-button'), before = (await play.boundingBox())!;
  await page.keyboard.press('Space'); await expect(play).toHaveText('Stop'); expect((await play.boundingBox())!.width).toBe(before.width);
  expect(await play.evaluate(el => el.getAnimations().some(a => (a.effect as KeyframeEffect).getTiming().duration === 200))).toBe(true);
  await page.keyboard.press('Space'); await expect(play).toHaveText('Play'); expect((await play.boundingBox())!.width).toBe(before.width);
  await page.locator('.logo-button').click(); const timing = await page.locator('.logo-letter').evaluateAll(letters => letters.map(letter => letter.getAnimations()[0].effect!.getTiming()));
  expect(timing.map(t => t.delay)).toEqual([0, 20, 40, 60, 80, 100]); expect(timing.every(t => t.duration === 300)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const selector of ['.logo-button', '.header-button', '.arp-random', '.play-button']) { await page.locator(selector).click(); expect(await page.locator(selector).evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0); }
});

test('recording, meter changes and New chords preserve hidden spans and IDs; reload restores them', async ({ page }) => {
  await open(page); const fixture = await state(page);
  fixture.loop = { ...fixture.loop, bars: 1, tempo: 200, blocks: [{ id: 4, pad: 0, tick: 0, durationTicks: 2880 }, { id: 44, pad: 1, tick: 4000, durationTicks: 480 }] };
  fixture.countIn = false;
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), fixture); await page.reload();
  await page.getByRole('button', { name: 'Record', exact: true }).click(); await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeVisible();
  await page.keyboard.down('2'); await page.waitForTimeout(140); await page.keyboard.up('2'); await page.getByRole('button', { name: 'Finish', exact: true }).click();
  let saved = await state(page); expect(saved.loop.blocks.find((b: { id: number }) => b.id === 44)).toEqual(fixture.loop.blocks[1]);
  const tail = saved.loop.blocks.find((b: { tick: number; durationTicks: number }) => b.tick <= 1920 && b.tick + b.durationTicks === 2880);
  expect(tail).toBeTruthy();
  expect(new Set(saved.loop.blocks.map((b: { id: number }) => b.id)).size).toBe(saved.loop.blocks.length);
  await page.getByRole('button', { name: 'Timing options' }).click(); await page.getByRole('button', { name: 'Meter', exact: true }).click(); await page.getByRole('option', { name: '2/4', exact: true }).click();
  expect((await state(page)).loop.blocks).toEqual(saved.loop.blocks); await expect(page.locator('.play-button')).toHaveText('Stop');
  saved = await state(page); await page.getByRole('button', { name: 'New chords', exact: true }).click(); expect((await state(page)).loop).toEqual(saved.loop);
  await page.reload();
  expect((await state(page)).loop).toEqual(saved.loop);
  await page.getByRole('button', { name: 'Timing options' }).click(); for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Bars up' }).click();
  expect((await state(page)).loop.blocks.find((b: { id: number }) => b.id === 44)).toEqual(fixture.loop.blocks[1]);
});

test('Clear includes a sequence containing only hidden material', async ({ page }) => {
  await open(page); const fixture = await state(page); fixture.loop.bars = 1;
  fixture.loop.blocks = [{ id: 40, pad: 1, tick: 4000, durationTicks: 480 }];
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), fixture); await page.reload();
  await expect(page.locator('.timeline-block')).toHaveCount(0); await expect(page.locator('.play-button')).toBeDisabled();
  await page.getByRole('button', { name: 'Clear', exact: true }).click(); expect((await state(page)).loop.blocks).toEqual([]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await state(page)).loop.blocks).toEqual(fixture.loop.blocks);
});

test('interactive tutorial preserves instrument keys, pointer controls and native panel buttons', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  await page.getByRole('button', { name: 'Info (?)', exact: true }).click();
  await page.getByRole('button', { name: 'Start tutorial' }).click();
  const tutorial = page.locator('.tour-panel');
  await expect(tutorial).not.toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.instrument')).not.toHaveAttribute('inert', '');
  await expect(page.getByRole('button', { name: 'Close tutorial' })).not.toBeFocused();
  await page.keyboard.down('1'); await expect(page.getByTestId('pad-1')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift'); await page.keyboard.up('1');
  await expect(page.getByRole('button', { name: 'Hold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pad-1')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Hold', exact: true }).click();
  const pad = (await page.getByTestId('pad-2').boundingBox())!;
  await page.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2); await page.mouse.down();
  await expect(page.getByTestId('pad-2')).toHaveAttribute('aria-pressed', 'true'); await page.mouse.up();
  const originalChord = (await state(page)).bank[1]; await page.keyboard.press('q');
  expect((await state(page)).bank[1]).not.toEqual(originalChord);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await state(page)).bank[1]).toEqual(originalChord);
  await page.mouse.click(2, 2); await expect(tutorial).toHaveAttribute('aria-labelledby', 'help-title');
  await expect(page.getByRole('dialog', { name: 'Play the chords' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).focus(); await page.keyboard.press('Space');
  await expect(page.getByRole('dialog', { name: 'Build a sequence' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Build a sequence' })).toBeVisible();
  await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Timing options' }).click();
  await expect(page.locator('.timing-popover')).toBeVisible();
  await page.getByRole('button', { name: 'Bars down' }).click(); expect((await state(page)).loop.bars).toBe(3);
  await page.getByRole('button', { name: 'Timing options' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Shape the sound' })).toBeVisible();
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('option', { name: 'Glass', exact: true }).click(); expect((await state(page)).voice).toBe('Glass');
  await clickSlider(page, 'Color', .25); expect(Math.abs((await state(page)).sound.color - .25)).toBeLessThanOrEqual(.011);
  const color = page.getByRole('slider', { name: 'Color', exact: true }); await color.focus(); await page.keyboard.press('ArrowRight');
  expect((await state(page)).sound.color).toBe(.26); await expect(page.getByRole('dialog', { name: 'Shape the sound' })).toBeVisible();
  await page.getByRole('button', { name: 'Voice', exact: true }).focus(); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); expect((await state(page)).voice).toBe('Current');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Arpeggiator', exact: true }).click(); expect((await state(page)).arp.mode).toBe('arp');
  const cell = page.locator('.arp-matrix [data-column="0"][data-row="3"]'); await cell.click(); expect((await state(page)).arp.steps[0]).toBe(3);
  await clickSlider(page, 'Rate', 1); expect((await state(page)).arp.division).toBe(32);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'MIDI', exact: true }).click(); expect((await downloaded).suggestedFilename()).toMatch(/\.mid$/);
  await expect(page.getByRole('dialog', { name: 'Take it with you' })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close tutorial' })).not.toBeFocused();
  await page.keyboard.press('Escape'); await expect(tutorial).toHaveCount(0); await expect(page.locator('.pad.sounding')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('115 percent fit, gap-centered headings and tutorial outlines follow rendered bounds', async ({ page }, testInfo) => {
  await open(page);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 700 }, { width: 768, height: 1024 }, { width: 1100, height: 650 }]) {
    await page.setViewportSize(viewport);
    const expectedScale = Math.min(1.15, (viewport.width - 24) / 1000, (viewport.height - 24) / 668);
    await expect.poll(() => page.locator('.instrument').evaluate(el => el.getBoundingClientRect().width / 1000)).toBeCloseTo(expectedScale, 3);
    const dimensions = await page.locator('.logo-button').evaluate(el => {
      const plain = document.createElement('span'); plain.textContent = 'thread'; el.append(plain);
      const result = { reference: plain.getBoundingClientRect().width, actual: el.querySelector('.wordmark')!.getBoundingClientRect().width };
      plain.remove(); return result;
    });
    expect(Math.abs(dimensions.reference - dimensions.actual)).toBeLessThan(.1);
    await page.getByRole('button', { name: 'Info (?)', exact: true }).click(); await page.getByRole('button', { name: 'Start tutorial' }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click(); await page.getByRole('button', { name: 'Next', exact: true }).click();
    const target = (await page.locator('.sound-pane').boundingBox())!, highlight = (await page.locator('.tour-highlight').boundingBox())!;
    expect(target.x - highlight.x).toBeCloseTo(Math.min(12, target.x - 4), 0); expect(target.y - highlight.y).toBeCloseTo(12, 0);
    expect(highlight.width - target.width).toBeCloseTo(Math.min(12, target.x - 4) + Math.min(12, viewport.width - 4 - target.x - target.width), 0); expect(highlight.height - target.height).toBeCloseTo(24, 0);
    await page.getByRole('button', { name: 'Voice', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Voice', exact: true })).toBeInViewport();
    expect(await page.getByRole('option').evaluateAll(options => options.every(option => {
      const bounds = option.getBoundingClientRect();
      return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('[role="option"]') === option;
    }))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`tutorial-menu-${viewport.width}-${viewport.height}.png`) });
    await page.getByRole('option', { name: 'Felt', exact: true }).click();
    await page.getByRole('button', { name: 'Skip', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.tour-panel')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  }
  const styles = await page.locator('.key-action-button').evaluateAll(buttons => buttons.map(el => { const s = getComputedStyle(el); return [s.backgroundColor, s.color, s.borderRadius, s.height]; }));
  expect(styles.every(style => JSON.stringify(style) === JSON.stringify(styles[0]))).toBe(true);
  expect(await page.locator('.copyright').evaluate(el => getComputedStyle(el).textDecorationLine)).toBe('underline');
  expect(await page.locator('.footer-site').evaluate(el => getComputedStyle(el).textDecorationLine)).toBe('none');
});

test('Hold prioritizes latest input, keeps its latch, restores pressed pads and clears on cancel', async ({ page }) => {
  await open(page); await page.keyboard.down('1'); await page.keyboard.down('2');
  await expect(page.getByTestId('pad-1')).toHaveAttribute('aria-pressed', 'false'); await expect(page.getByTestId('pad-2')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Hold', exact: true }).click();
  await expect(page.getByTestId('pad-1')).toHaveAttribute('aria-pressed', 'false'); await expect(page.getByTestId('pad-2')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('2'); await expect(page.getByTestId('pad-2')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Hold', exact: true }).click();
  await expect(page.getByTestId('pad-1')).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByTestId('pad-2')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.down('2'); await page.keyboard.press('Shift'); await page.keyboard.press('Shift');
  await expect(page.getByTestId('pad-1')).toHaveAttribute('aria-pressed', 'false'); await expect(page.getByTestId('pad-2')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('1'); await page.keyboard.up('2');
  const rect = (await page.getByTestId('pad-3').boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
  await page.getByTestId('pad-3').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' }); await page.mouse.up();
  await expect(page.locator('.pad.sounding')).toHaveCount(0);
  await page.keyboard.down('1'); await page.keyboard.press('Shift'); await page.keyboard.press('Escape'); await page.keyboard.up('1');
  await page.keyboard.press('Shift'); await expect(page.locator('.pad.sounding')).toHaveCount(0);
});

test('mixed pointer and keyboard presses restore without restarting the surviving pad', async ({ page }) => {
  await open(page); const pad = page.getByTestId('pad-2'), box = (await pad.boundingBox())!;
  await page.keyboard.down('1'); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.keyboard.press('Shift'); await expect(page.getByTestId('pad-1')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Shift'); await expect(page.locator('.pad.sounding')).toHaveCount(1);
  await page.mouse.up(); await page.keyboard.up('1'); await expect(page.locator('.pad.sounding')).toHaveCount(0);
});


test('keyboard menu selection survives stationary pointer entry as the portal opens', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name:'Voice',exact:true }).click();
  await page.getByRole('option', { name:'Glass',exact:true }).click();
  await clickSlider(page,'Color',.25);
  const trigger = page.getByRole('button', { name:'Voice',exact:true }); await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const current = page.getByRole('option', { name:'Current',exact:true }), glass = page.getByRole('option', { name:'Glass',exact:true });
  await expect(glass).toHaveClass(/active/);
  await page.keyboard.press('ArrowDown'); await expect(current).toHaveClass(/active/);
  // Menu appearance can deliver an enter for a stationary pointer. Keyboard
  // ownership persists until the pointer actually moves.
  await glass.dispatchEvent('mouseover', { relatedTarget:null }); await expect(current).toHaveClass(/active/);
  await page.keyboard.press('Enter'); await expect(trigger).toContainText('Current');
  expect((await state(page)).voice).toBe('Current');
  await trigger.click(); await glass.hover(); await expect(glass).toHaveClass(/active/);
  await glass.click(); expect((await state(page)).voice).toBe('Glass');
});
