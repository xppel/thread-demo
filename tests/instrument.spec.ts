import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import MidiPackage from '@tonejs/midi';
const { Midi } = MidiPackage;
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem('thread.demo.intro.seen.v1', '1')); });
async function state(page: Page) { return page.evaluate(() => JSON.parse(localStorage.getItem('thread.demo.session.v1')!)); }
async function selectClip(page: Page, id = 0) { await page.locator(`.timeline-block[data-block-id="${id}"]`).click(); }
async function fourBarFixture(page: Page, bars = 4, lastPad = 3) {
  await page.goto('./');
  const session = await state(page);
  session.padCount = 5;
  session.loop.bars = bars;
  session.loop.blocks = [0, 1, 2, 3].map(id => ({ id, pad: id, tick: id * 1920, durationTicks: 1920 }));
  session.loop.blocks[3].pad = lastPad;
  await page.addInitScript(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), session);
  await page.reload();
}

test('fresh loop, focused Space, and silent pad selection', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./'); await expect(page).toHaveTitle('thread — chord loop demo');
  await expect(page.getByTestId('loop-timeline')).toBeVisible();
  expect((await state(page)).loop.bars).toBe(4);
  expect((await state(page)).loop.blocks.length).toBeGreaterThanOrEqual(4);
  expect((await state(page)).padCount).toBe(4);
  const key = page.getByRole('button', { name: 'Key', exact: true }); await key.focus();
  await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: /^Stop$/ })).toBeVisible();
  const before = await state(page); await page.getByTestId('pad-2').click();
  expect((await state(page)).bank).toEqual(before.bank); await expect(page.getByTestId('pad-2')).toHaveClass(/selected/);
  await expect(page.getByText('EDITING 2')).toHaveCount(0);
  await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: /^Play$/ })).toBeVisible();
  const field = page.getByRole('textbox', { name: 'Tempo BPM' }); await field.focus(); await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: /^Play$/ })).toBeVisible();
  await key.click(); await expect(page.getByRole('listbox', { name: 'Key' })).toBeVisible();
  await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: /^Stop$/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('chord keys, up and down voicing, and Undo/Redo', async ({ page }) => {
  await page.goto('./'); await page.keyboard.press('2');
  await page.keyboard.press('y'); const seventh = (await state(page)).bank[1];
  await page.keyboard.press('t'); const dominant = (await state(page)).bank[1];
  expect(dominant.quality).not.toBe(seventh.quality);
  await page.keyboard.press('ArrowUp'); const up = (await state(page)).bank[1].notes;
  expect(up).not.toEqual(dominant.notes);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
  expect((await state(page)).bank[1].notes).toEqual(up);
  await page.getByRole('button', { name: 'Undo' }).click(); expect((await state(page)).bank[1].notes).toEqual(dominant.notes);
  await page.getByRole('button', { name: 'Redo' }).click(); expect((await state(page)).bank[1].notes).toEqual(up);
  await page.keyboard.press('BracketRight'); expect((await state(page)).bank[1].root).not.toBe(dominant.root);
  const other = (await state(page)).bank[0].notes; await page.keyboard.down('g'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('g'); expect((await state(page)).bank[0].notes).not.toEqual(other);
  await expect(page.getByRole('button', { name: 'Narrow voicing' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Widen voicing' })).toHaveCount(0);
});

test('clip insertion respects fixed length, toolbar edits, and playback continues', async ({ page }) => {
  await fourBarFixture(page, 5); await selectClip(page);
  await page.getByRole('button', { name: 'Selected clip actions' }).click(); await page.getByRole('button', { name: 'Duplicate' }).click();
  let loop = (await state(page)).loop; expect(loop.blocks).toHaveLength(5); expect(loop.bars).toBe(5);
  const duplicate = loop.blocks.find((block: { id: number }) => block.id > 3);
  await selectClip(page, duplicate.id); await page.getByRole('button', { name: 'Selected clip actions' }).click(); await page.getByRole('button', { name: 'Delete' }).click();
  await selectClip(page, 1); const before = (await state(page)).loop.blocks.find((block: { id: number }) => block.id === 1);
  await page.getByRole('button', { name: 'Selected clip actions' }).click(); await page.getByRole('button', { name: 'Lengthen clip' }).click();
  loop = (await state(page)).loop; expect(loop.blocks.find((block: { id: number }) => block.id === 1).durationTicks).toBeGreaterThan(before.durationTicks);
  expect(loop.blocks.find((block: { id: number }) => block.id === 2).tick).toBeGreaterThan(3840);
  await page.getByRole('button', { name: /^Play$/ }).click();
  await page.getByRole('button', { name: 'Selected clip actions' }).click(); await page.getByRole('button', { name: 'Move clip left' }).click();
  await expect(page.getByRole('button', { name: /^Stop$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click(); await expect(page.getByRole('button', { name: /^Stop$/ })).toBeVisible();
});

test('dragging a bank chord into an occupied bar shifts later clips only within Bars', async ({ page }) => {
  await fourBarFixture(page, 5);
  expect((await state(page)).loop.blocks).toHaveLength(4);
  const timeline = page.getByTestId('loop-timeline');
  const rect = await timeline.boundingBox();
  await page.getByTestId('pad-5').dragTo(timeline, { targetPosition: { x: rect!.width * .2, y: rect!.height / 2 } });
  const loop = (await state(page)).loop;
  expect(loop.blocks).toHaveLength(5);
  expect(loop.bars).toBe(5);
  expect(loop.blocks.find((block: { pad: number }) => block.pad === 4).tick).toBe(1920);
  expect(loop.blocks.find((block: { id: number }) => block.id === 1).tick).toBe(2400);
});

test('overflow is rejected and reducing pads removes linked clips in one Undo', async ({ page }) => {
  await fourBarFixture(page, 4, 4);
  const timeline = page.getByTestId('loop-timeline');
  const rect = await timeline.boundingBox();
  const pad = await page.getByTestId('pad-5').boundingBox();
  await page.mouse.move(pad!.x + pad!.width / 2, pad!.y + pad!.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect!.x + rect!.width * .25, rect!.y + rect!.height / 2, { steps: 12 });
  await expect(page.locator('.timeline-ghost.invalid')).toBeVisible();
  await page.mouse.up();
  expect((await state(page)).loop.bars).toBe(4);
  expect((await state(page)).loop.blocks).toHaveLength(4);
  await page.getByTestId('pad-5').click();
  await page.getByRole('button', { name: 'Number of chords down' }).click();
  expect((await state(page)).padCount).toBe(4);
  expect((await state(page)).loop.blocks.some((item: { pad: number }) => item.pad === 4)).toBe(false);
  await page.getByRole('button', { name: 'Undo' }).click();
  expect((await state(page)).padCount).toBe(5);
  expect((await state(page)).loop.blocks.some((item: { pad: number }) => item.pad === 4)).toBe(true);
});

test('pointer gestures move and resize clips as one undo step', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await fourBarFixture(page, 5);
  const first = page.locator('.timeline-block[data-block-id="0"]');
  let rect = await first.boundingBox();
  await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  await page.mouse.down(); await page.mouse.move(rect!.x + rect!.width * 2, rect!.y + rect!.height / 2, { steps: 8 }); await page.mouse.up();
  let loop = (await state(page)).loop;
  expect(loop.blocks.find((item: { id: number }) => item.id === 0).tick).toBe(1920);
  expect(loop.blocks.find((item: { id: number }) => item.id === 1).tick).toBe(0);
  rect = await first.locator('.resize-handle.right').boundingBox();
  await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  await page.mouse.down(); await page.mouse.move(rect!.x + rect!.width / 2 + 40, rect!.y + rect!.height / 2, { steps: 8 }); await page.mouse.up();
  loop = (await state(page)).loop;
  expect(loop.blocks.find((item: { id: number }) => item.id === 0).durationTicks).toBeGreaterThan(1920);
  await page.getByRole('button', { name: 'Undo' }).click();
  expect((await state(page)).loop.blocks.find((item: { id: number }) => item.id === 0).durationTicks).toBe(1920);
  await page.getByRole('button', { name: 'Undo' }).click();
  expect((await state(page)).loop.blocks.find((item: { id: number }) => item.id === 0).tick).toBe(0);
});

test('one tempo, speed divider, persistence', async ({ page }) => {
  await page.goto('./'); const initial = await state(page);
  await page.getByRole('button', { name: 'Timing options' }).click(); await page.getByRole('group', { name: 'Loop speed' }).getByRole('button', { name: '1/4' }).click();
  expect((await state(page)).loop.divider).toBe(4); expect((await state(page)).loop.tempo).toBe(initial.loop.tempo);
  await page.getByRole('button', { name: 'Bars up' }).click(); expect((await state(page)).loop.bars).toBe(5);
  const tempo = page.getByRole('textbox', { name: 'Tempo BPM' }); await tempo.fill('1'); await tempo.blur(); expect((await state(page)).loop.tempo).toBe(initial.loop.tempo);
  await tempo.fill('128'); await tempo.press('Enter'); expect((await state(page)).loop.tempo).toBe(128);
  const edited = await state(page); await page.reload(); expect(await state(page)).toEqual(edited);

});

test('custom menus, portaled Settings menu, and arbitrary color picker', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('./'); expect(await page.locator('select,input[type=color]').count()).toBe(0);
  for (const label of ['Key', 'Scale', 'Voice', 'Meter']) {
    if (label === 'Meter') await page.getByRole('button', { name: 'Timing options' }).click();
    const trigger = page.getByRole('button', { name: label, exact: true }); await trigger.focus(); await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('listbox', { name: label })).toBeVisible(); await page.keyboard.press('End'); await page.keyboard.press('Home'); await page.keyboard.press('Enter'); await expect(trigger).toBeFocused();
    await trigger.click(); await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    await trigger.click(); await page.getByRole('listbox', { name: label }).getByRole('option').first().click();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const before = await page.locator('.chord-section').boundingBox();
  for (const label of ['Background', 'Text', 'Accent']) {
    await page.getByRole('button', { name: `Pick ${label.toLowerCase()} color` }).click();
    const picker = page.getByRole('group', { name: `${label} color picker` }); await expect(picker).toBeVisible();
    await picker.getByRole('slider', { name: `${label} saturation and brightness` }).focus(); await page.keyboard.press('ArrowRight');
  }
  const after = await page.locator('.chord-section').boundingBox(); expect(after?.x).toBe(before?.x); expect(after?.y).toBe(before?.y);
  await page.getByRole('textbox', { name: 'Accent hex value' }).fill('#ff7700'); await page.getByRole('textbox', { name: 'Accent hex value' }).blur();
  await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'Accent hex value' })).toHaveValue('#ff7700');
  await expect(page.getByRole('slider', { name: 'Master volume' })).toBeVisible();
  await expect(page.locator('.settings-panel .keyboard-help')).toHaveCount(0);
  await page.getByRole('button', { name: 'Info (?)', exact: true }).click(); await expect(page.getByText('Keyboard', { exact: true })).toBeVisible();
});

test('arp grid, rate, triplet, and transforms', async ({ page }) => {
  await page.goto('./'); const grid = page.getByRole('group', { name: 'Eight step arpeggiator pattern' });
  await grid.getByRole('button', { name: /Step 1, chord tone 5/ }).click(); expect((await state(page)).arp.steps[0]).toBe(4);
  await grid.getByRole('button', { name: /Step 1, chord tone 5/ }).click(); expect((await state(page)).arp.steps[0]).toBeNull();
  await page.getByRole('slider', { name: 'Rate', exact: true }).focus(); await page.keyboard.press('End'); expect((await state(page)).arp.division).toBe(32);
  await page.getByRole('button', { name: 'Triplet' }).click(); expect((await state(page)).arp.triplet).toBe(true);
  await page.getByRole('button', { name: 'Reverse' }).click(); expect((await state(page)).arp.reverse).toBe(true);
  await page.getByRole('button', { name: 'Mirror' }).click(); expect((await state(page)).arp.mirror).toBe(true);
  await page.getByRole('button', { name: 'Randomize arpeggiator' }).click(); expect((await state(page)).arp.steps).toHaveLength(8);
});

test('arp drag paints multiple columns as one Undo and knob drag cannot select text', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('./');
  const before = await state(page);
  const grid = page.getByRole('group', { name: 'Eight step arpeggiator pattern' });
  const start = await grid.locator('[data-column="0"][data-row="4"]').boundingBox();
  const end = await grid.locator('[data-column="3"][data-row="4"]').boundingBox();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
  await page.mouse.down(); await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, { steps: 14 }); await page.mouse.up();
  expect((await state(page)).arp.steps.slice(0, 4)).toEqual([4, 4, 4, 4]);
  await page.getByRole('button', { name: 'Undo' }).click();
  expect((await state(page)).arp.steps).toEqual(before.arp.steps);
  const knob = page.getByRole('slider', { name: 'Color' });
  const rect = await knob.boundingBox();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  await page.mouse.down(); await page.mouse.move(rect!.x + rect!.width / 2 + 35, rect!.y + rect!.height / 2, { steps: 8 }); await page.mouse.up();
  expect((await state(page)).sound.color).not.toBe(before.sound.color);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await page.getByRole('button', { name: 'Undo' }).click();
  expect((await state(page)).sound.color).toBe(before.sound.color);
});

test('record count-in, quantization, and exports', async ({ page }) => {
  await page.goto('./');
  const tempo = page.getByRole('textbox', { name: 'Tempo BPM' }); await tempo.fill('200'); await tempo.press('Enter');
  await page.getByRole('button', { name: 'Record', exact: true }).click(); await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  expect(await page.getByRole('button', { name: 'Cancel' }).evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await expect(page.locator('.instrument-footer')).not.toContainText('Count in');
  await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recording settings', exact: true }).click();
  await page.getByRole('button', { name: 'Recording quantization' }).click(); await page.getByRole('option', { name: 'Beat', exact: true }).click();
  await page.getByRole('button', { name: 'Count-in' }).click(); await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish' })).toBeVisible(); await page.keyboard.down('1'); await page.waitForTimeout(400); await page.keyboard.up('1'); await page.waitForTimeout(350); await page.keyboard.press('Space');
  const blocks = (await state(page)).loop.blocks; expect(blocks.length).toBeGreaterThan(0); expect(blocks.some((block: { tick: number }) => block.tick % 480 === 0)).toBe(true);
  const midiEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'MIDI', exact: true }).click(); const midi = new Midi(await readFile((await (await midiEvent).path())!)); expect(midi.tracks[0].notes.length).toBeGreaterThan(0);
  const wavEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'WAV' }).click(); const wav = await readFile((await (await wavEvent).path())!); expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
});

test('Space owns transport across focused settings, clips, and pads', async ({ page }) => {
  await page.goto('./'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const volume = page.getByRole('slider', { name: 'Master volume' }); const beforeVolume = (await state(page)).sound.masterVolume;
  await volume.focus(); await page.keyboard.press('Space'); expect((await state(page)).sound.masterVolume).toBe(beforeVolume);
  await expect(page.getByRole('button', { name: /^Stop$/ })).toBeVisible();
  await expect(page.locator('.settings-panel')).toHaveCount(0);
  await page.locator('.timeline-block').first().focus(); await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: /^Play$/ })).toBeVisible();
  await page.getByTestId('pad-2').focus(); await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: /^Stop$/ })).toBeVisible();
});

test('a fresh interactive audio context replaces Tone startup context on first play', async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    (window as Window & { __threadContextCreations: number }).__threadContextCreations = 0;
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: new Proxy(Original, {
      construct(target, args) {
        (window as Window & { __threadContextCreations: number }).__threadContextCreations += 1;
        return Reflect.construct(target, args);
      },
    }) });
  });
  await page.goto('./');
  const count = () => page.evaluate(() => (window as Window & { __threadContextCreations: number }).__threadContextCreations);
  expect(await count()).toBe(1);
  await page.keyboard.down('1');
  await expect.poll(count).toBe(2);
  await page.keyboard.up('1');
  await page.keyboard.down('2');
  expect(await count()).toBe(2);
  await page.keyboard.up('2');
});

test('oscilloscope draws internal sound and returns to a silent baseline', async ({ page }) => {
  await page.goto('./');
  const offCenter = () => page.locator('canvas.scope').evaluate(canvas => { const context = (canvas as HTMLCanvasElement).getContext('2d')!; const { data, width, height } = context.getImageData(0, 0, (canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height); let count = 0; for (let y = 0; y < height; y++) if (Math.abs(y - height / 2) > 2) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 0) count++; return count; });
  await page.waitForTimeout(100); expect(await offCenter()).toBe(0);
  await page.keyboard.down('1'); await page.waitForTimeout(250); expect(await offCenter()).toBeGreaterThan(0);
  await page.keyboard.up('1'); await page.keyboard.press('Escape'); await page.waitForTimeout(1200); expect(await offCenter()).toBe(0);
});

test('fixed instrument fits desktop and tablet viewports without scrolling or rearranging', async ({ page }) => {
  const sizes = [
    { width: 1440, height: 900, scaled: false },
    { width: 1024, height: 768, scaled: false },
    { width: 1100, height: 650, scaled: true },
    { width: 900, height: 700, scaled: true },
    { width: 768, height: 1024, scaled: true },
  ];
  for (const size of sizes) {
    await page.setViewportSize(size); await page.goto('./');
    await expect(page.locator('.instrument')).toBeVisible();
    await expect(page.locator('.viewport-message')).toHaveCount(0);
    const labels = await page.locator('.chord-name,.pad-notes').evaluateAll(elements => elements.map(el => ({ height: el.clientHeight, content: el.scrollHeight, font: getComputedStyle(el).fontSize })));
    for (const label of labels) expect(label.content).toBeLessThanOrEqual(label.height);
    expect(labels[0].font).toBe('20px');
    const layout = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.instrument')!;
      const box = el.getBoundingClientRect();
      const logicalWidth = parseFloat(getComputedStyle(el).width);
      const logicalHeight = parseFloat(getComputedStyle(el).height);
      return {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        x: box.x, y: box.y, right: box.right, bottom: box.bottom,
        scaleX: box.width / logicalWidth, scaleY: box.height / logicalHeight,
      };
    });
    expect(layout.scrollWidth, `${size.width}×${size.height} horizontal overflow`).toBeLessThanOrEqual(size.width + 1);
    expect(layout.scrollHeight, `${size.width}×${size.height} vertical overflow`).toBeLessThanOrEqual(size.height + 1);
    expect(layout.x).toBeGreaterThanOrEqual(11); expect(layout.y).toBeGreaterThanOrEqual(11);
    expect(layout.right).toBeLessThanOrEqual(size.width - 11); expect(layout.bottom).toBeLessThanOrEqual(size.height - 11);
    expect(Math.abs(layout.scaleX - layout.scaleY)).toBeLessThan(.005);
    if (size.scaled) expect(layout.scaleX).toBeLessThan(.999);
    else expect(layout.scaleX).toBeCloseTo(size.width === 1440 ? 1.15 : 1, 2);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height + 1);
    await page.getByRole('button', { name: 'Close settings' }).click();
  }
});

test('compact controls keep their intended pairs and square arp cells', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 }); await page.goto('./');
  for (const section of ['.chord-section', '.sequence-section', '.sound-pane', '.arp-pane']) {
    await expect(page.locator(`${section} h2`)).toHaveCount(0);
  }
  const header = page.locator('.instrument-header');
  for (const name of ['Global key down', 'Global key up', 'Number of chords down', 'Number of chords up', 'Hold', 'Lock key / scale']) {
    await expect(header.getByRole('button', { name })).toBeVisible();
  }
  const keyDown = await header.getByRole('button', { name: 'Global key down' }).boundingBox();
  const padDown = await header.getByRole('button', { name: 'Number of chords down' }).boundingBox();
  expect(keyDown!.height).toBe(padDown!.height);
  expect(keyDown!.width).toBe(padDown!.width);
  const keyStepper = (await header.locator('.key-stepper').boundingBox())!;
  const padStepper = (await header.locator('.header-pad-tools .stepper').boundingBox())!;
  expect(keyStepper.height).toBe(32); expect(keyStepper.width).toBe(110);
  expect(padStepper.height).toBe(keyStepper.height); expect(padStepper.width).toBe(keyStepper.width);
  expect(padStepper.y).toBe(keyStepper.y);
  const keyValue = (await header.locator('.key-stepper .control-value').boundingBox())!;
  const keyField = (await header.getByRole('button', { name: 'Key', exact: true }).boundingBox())!;
  expect(Math.abs(keyValue.x + keyValue.width / 2 - keyField.x - keyField.width / 2)).toBeLessThanOrEqual(1);
  await expect(header.getByRole('button', { name: /Use (dark|light) mode/ })).toHaveCount(0);
  const modifiers = page.locator('.modifier-row .modifier');
  await expect(modifiers).toHaveCount(7);
  for (const modifier of await modifiers.all()) await expect(modifier.locator('kbd')).toHaveCount(1);
  const box = async (name: string) => (await page.getByRole('button', { name, exact: true }).boundingBox())!;
  const near = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => {
    expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThanOrEqual(5);
    expect(b.x - a.x - a.width).toBeGreaterThanOrEqual(0);
    expect(b.x - a.x - a.width).toBeLessThanOrEqual(20);
  };
  const tempo = (await page.getByRole('textbox', { name: 'Tempo BPM' }).boundingBox())!;
  near(tempo, await box('Tap tempo'));
  await page.getByRole('button', { name: 'Recording settings', exact: true }).click();
  near(await box('Count-in'), await box('Click'));
  await page.getByRole('button', { name: 'Recording settings', exact: true }).click();
  const mode = (await page.getByRole('button', { name: 'Arpeggiator', exact: true }).boundingBox())!;
  const rate = (await page.getByRole('slider', { name: 'Rate', exact: true }).locator('..').boundingBox())!;
  const triplet = await box('Triplet');
  const matrix = (await page.locator('.arp-matrix').boundingBox())!;
  const scope = (await page.locator('.scope-tile').boundingBox())!;
  expect(scope.width).toBe(174); expect(scope.height).toBe(174);
  expect(matrix.width).toBe(scope.width); expect(matrix.height).toBe(scope.height); expect(matrix.y).toBe(scope.y);
  expect(mode.x).toBeGreaterThan(matrix.x + matrix.width);
  expect(rate.x).toBeGreaterThan(matrix.x + matrix.width);
  expect(rate.y).toBeGreaterThan(mode.y + mode.height);
  expect(triplet.y).toBeGreaterThan(rate.y + rate.height);
  const timelineBox = (await page.getByTestId('loop-timeline').boundingBox())!;
  expect(timelineBox.height).toBe(70);
  const toolbar = (await page.locator('.loop-toolbar').boundingBox())!;
  expect(toolbar.y).toBeGreaterThan(timelineBox.y + timelineBox.height);
  const groups = await page.locator('.loop-toolbar > div').evaluateAll(elements => elements.map(el => { const r=el.getBoundingClientRect(); return { x:r.x, y:r.y+r.height/2, right:r.right }; }));
  for (let i=0; i<groups.length; i++) {
    expect(Math.abs(groups[i].y-groups[0].y)).toBeLessThanOrEqual(2);
    if (i) expect(groups[i].x).toBeGreaterThanOrEqual(groups[i-1].right);
  }
  await selectClip(page);
  const selectedGroups = await page.locator('.loop-toolbar > div').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().x));
  expect(selectedGroups).toEqual(groups.map(group => group.x));
  const cell = (await page.locator('.arp-matrix-row button').first().boundingBox())!;
  expect(Math.abs(cell.width - cell.height)).toBeLessThanOrEqual(1);
  const track = (await page.locator('.timeline-track').boundingBox())!;
  const clip = (await page.locator('.timeline-block').first().boundingBox())!;
  const top = clip.y - track.y, bottom = track.y + track.height - clip.y - clip.height;
  expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
  expect(top).toBeGreaterThanOrEqual(7); expect(top).toBeLessThanOrEqual(9);
  const footer = page.locator('.instrument-footer');
  const silence = (await footer.getByRole('button', { name: /Silence/ }).boundingBox())!;
  const copyright = (await footer.locator('.copyright').boundingBox())!;
  const website = (await footer.getByRole('button', { name: 'Info (?)', exact: true }).boundingBox())!;
  const instrument = (await page.locator('.instrument').boundingBox())!;
  expect(silence.x + silence.width).toBeLessThan(copyright.x);
  expect(website.x).toBeGreaterThan(copyright.x + copyright.width);
  expect(Math.abs(copyright.x + copyright.width / 2 - instrument.x - instrument.width / 2)).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: /Use (dark|light) mode/ })).toBeVisible();
});

test('blank gap, pad relinking, outside deselection, and Delete', async ({ page }) => {
  await page.goto('./');
  const session = await state(page);
  session.loop.blocks = [{ id: 0, pad: 0, tick: 0, durationTicks: 960 }, { id: 1, pad: 1, tick: 1920, durationTicks: 960 }];
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), session);
  await page.reload();
  await selectClip(page, 0);
  const timeline = page.getByTestId('loop-timeline'), bounds = await timeline.boundingBox();
  await timeline.click({ position: { x: bounds!.width * 960 / 7680 + 4, y: 4 } });
  let blocks = (await state(page)).loop.blocks;
  const inserted = blocks.find((block: { id: number }) => block.id > 1);
  expect(inserted).toMatchObject({ tick: 960, durationTicks: 960 });
  await page.getByTestId('pad-3').click();
  blocks = (await state(page)).loop.blocks;
  expect(blocks.find((block: { id: number }) => block.id === inserted.id).pad).toBe(2);
  await expect(page.locator(`.timeline-block[data-block-id="${inserted.id}"]`)).toHaveClass(/selected/);
  await page.locator('.copyright').click();
  await expect(page.locator('.timeline-block.selected')).toHaveCount(0);
  await selectClip(page, inserted.id);
  await page.keyboard.press('4');
  expect((await state(page)).loop.blocks.find((block: { id: number }) => block.id === inserted.id).pad).toBe(3);
  await page.keyboard.press('Delete');
  expect((await state(page)).loop.blocks.some((block: { id: number }) => block.id === inserted.id)).toBe(false);
  await page.getByRole('button', { name: 'Undo' }).click();
  expect((await state(page)).loop.blocks.some((block: { id: number }) => block.id === inserted.id)).toBe(true);
});

test('left resize handle grows into a gap and one Undo restores it', async ({ page }) => {
  await page.goto('./');
  const session = await state(page);
  session.loop.blocks = [{ id: 0, pad: 0, tick: 0, durationTicks: 960 }, { id: 1, pad: 1, tick: 1920, durationTicks: 960 }];
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), session);
  await page.reload();
  const clip = page.locator('.timeline-block[data-block-id="1"]');
  await clip.hover();
  const handle = clip.locator('.resize-handle.left');
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down(); await page.mouse.move(box!.x - 35, box!.y + box!.height / 2, { steps: 10 }); await page.mouse.up();
  const changed = (await state(page)).loop.blocks.find((block: { id: number }) => block.id === 1);
  expect(changed.tick).toBeLessThan(1920);
  expect(changed.durationTicks).toBeGreaterThan(960);
  await page.getByRole('button', { name: 'Undo' }).click();
  expect((await state(page)).loop.blocks.find((block: { id: number }) => block.id === 1)).toMatchObject({ tick: 1920, durationTicks: 960 });
});

test('live recording replaces its chord span and Undo restores backing', async ({ page }) => {
  await page.goto('./');
  const session = await state(page);
  session.loop = { ...session.loop, bars: 1, tempo: 200, blocks: [{ id: 0, pad: 0, tick: 0, durationTicks: 1920 }] };
  session.countIn = false; session.quantize = 'off';
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), session);
  await page.reload();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish' })).toBeVisible();
  await page.waitForTimeout(170);
  await page.keyboard.down('2'); await page.waitForTimeout(180); await page.keyboard.up('2');
  await page.keyboard.press('Space');
  const blocks = (await state(page)).loop.blocks;
  expect(blocks.some((block: { pad: number }) => block.pad === 1)).toBe(true);
  expect(blocks.some((block: { pad: number; tick: number }) => block.pad === 0 && block.tick === 0)).toBe(true);
  expect(blocks.some((block: { pad: number; tick: number }) => block.pad === 0 && block.tick > 0)).toBe(true);
  await page.getByRole('button', { name: 'Undo' }).click();
  expect((await state(page)).loop.blocks).toEqual(session.loop.blocks);
});

test('Tap tempo and New chords preserve settings and Undo the whole idea', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Tap tempo' }).click(); await page.waitForTimeout(330);
  await page.getByRole('button', { name: 'Tap tempo' }).click();
  expect((await state(page)).loop.tempo).toBeGreaterThan(150);
  await page.evaluate(() => {
    Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: (array: Uint32Array) => { array[0] = 42; return array; } });
  });
  const lock = page.getByRole('button', { name: 'Lock key / scale' });
  await expect(lock).toHaveAttribute('aria-pressed', 'true');
  const before = await state(page);
  await page.getByRole('button', { name: 'New chords' }).click();
  const after = await state(page);
  expect(after.bank).not.toEqual(before.bank); expect(after.loop).toEqual(before.loop); expect(after.padCount).toBe(before.padCount);
  expect(after.key).toBe(before.key); expect(after.scale).toBe(before.scale);
  expect(after.loop.tempo).toBe(before.loop.tempo); expect(after.loop.meter).toEqual(before.loop.meter);
  expect(after.sound).toEqual(before.sound); expect(after.arp).toEqual(before.arp);
  await page.getByRole('button', { name: 'Undo' }).click(); expect(await state(page)).toEqual(before);
  await page.getByRole('button', { name: 'Redo' }).click(); expect(await state(page)).toEqual(after);
  await lock.click();
  const unlocked = await state(page);
  await page.getByRole('button', { name: 'New chords' }).click();
  const reroll = await state(page);
  expect(reroll.key).not.toBe(unlocked.key);
  expect(reroll.keyLocked).toBe(false);
  expect(reroll.loop.tempo).toBe(unlocked.loop.tempo);
  await page.getByRole('button', { name: 'Undo' }).click(); expect(await state(page)).toEqual(unlocked);
});

test('Record while playing waits for the next loop start', async ({ page }) => {
  await page.goto('./');
  const session = await state(page);
  session.loop = { ...session.loop, bars: 1, tempo: 200, blocks: [{ id: 0, pad: 0, tick: 0, durationTicks: 1920 }] };
  session.countIn = false;
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), session);
  await page.reload();
  await page.getByRole('button', { name: /^Play$/ }).click();
  await expect(page.getByRole('button', { name: /^Stop$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Armed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finish' })).toBeVisible({ timeout: 2500 });
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
});

test('single-track arp MIDI download', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Gate', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Arpeggiator', exact: true }).click();
  const midiEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'MIDI', exact: true }).click();
  const midi = new Midi(await readFile((await (await midiEvent).path())!));
  expect(midi.tracks).toHaveLength(1); expect(midi.tracks[0].notes.length).toBeGreaterThan(0);
  const wavEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'WAV' }).click();
  const wav = await readFile((await (await wavEvent).path())!); expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
});

test('fresh music reveals the reserved pads without replacing the bank or loop', async ({ page }) => {
  await page.goto('./'); const before = await state(page);
  expect(before.padCount).toBe(4); await expect(page.locator('.pad')).toHaveCount(4);
  await page.getByRole('button', { name: 'Number of chords up', exact: true }).click();
  await expect(page.getByTestId('pad-5')).toContainText('Dm');
  await page.getByRole('button', { name: 'Number of chords up', exact: true }).click();
  await expect(page.getByTestId('pad-6')).toContainText('B♭ shape');
  await expect(page.getByRole('button', { name: 'Number of chords up', exact: true })).toBeDisabled();
  expect((await state(page)).bank).toEqual(before.bank); expect((await state(page)).loop).toEqual(before.loop);
  await page.reload(); expect((await state(page)).padCount).toBe(6);
});

test('split recording and timing menus keep settings and header icons independent when scaled', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 }); await page.goto('./');
  const initial = await state(page);
  const arrow = page.getByRole('button', { name: 'Recording settings', exact: true });
  await arrow.click();
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
  expect((await state(page)).loop).toEqual(initial.loop);
  await page.getByRole('button', { name: 'Count-in', exact: true }).click();
  await page.getByRole('button', { name: 'Click', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Click', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Recording quantization' }).click();
  await page.getByRole('option', { name: 'Beat', exact: true }).click();
  expect((await state(page)).quantize).toBe('beat');
  expect((await state(page)).countIn).toBe(false);
  await expect(page.getByRole('group', { name: 'Recording settings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Timing options' }).click();
  await expect(page.getByRole('group', { name: 'Recording settings', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Meter', exact: true }).click();
  await page.getByRole('option', { name: '3/4', exact: true }).click();
  expect((await state(page)).loop.meter).toEqual({ numerator: 3, denominator: 4 });
  await expect(page.getByRole('button', { name: 'Timing options' })).toHaveText('Timing ▾');
  await expect(page.getByRole('button', { name: 'Meter', exact: true })).toContainText('3/4');
  await page.getByRole('button', { name: 'Timing options' }).focus(); await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Timing options', exact: true })).toHaveCount(0);
  const lock = page.getByRole('button', { name: 'Lock key / scale' });
  const hold = page.getByRole('button', { name: 'Hold', exact: true });
  await lock.click(); await lock.focus(); await page.keyboard.press('Enter');
  await expect(lock).toHaveAttribute('aria-pressed', 'true');
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
  await hold.click(); await expect(hold).toHaveAttribute('aria-pressed', 'true');
  expect((await state(page)).keyLocked).toBe(true);
  await lock.click(); await expect(lock).toHaveAttribute('aria-pressed', 'false');
  await expect(hold).toHaveAttribute('aria-pressed', 'true');
  await hold.click();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
});

test('refined arp controls, footer, and Settings keep shared styles when scaled', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 }); await page.goto('./');
  const hold = page.getByRole('button', { name: 'Hold', exact: true });
  const arp = page.getByRole('button', { name: 'Arpeggiator', exact: true });
  await expect(hold).toHaveText('Hold'); await expect(hold.locator('svg')).toHaveCount(0);
  const style = (selector: string) => page.locator(selector).evaluate(el => {
    const s = getComputedStyle(el); return [s.fontFamily, s.fontSize, s.fontWeight, s.color];
  });
  expect(await style('.sound-voice .control-toggle')).toEqual(await style('.arp-top-row .control-toggle'));
  await arp.click(); expect((await state(page)).arp.mode).toBe('arp');
  await expect(arp).toHaveAttribute('aria-pressed', 'true');
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
  const before = (await state(page)).arp.gate;
  const gate = page.getByRole('slider', { name: 'Gate', exact: true });
  const rect = (await gate.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 - 20, rect.y + rect.height / 2, { steps: 4 }); await page.mouse.up();
  expect((await state(page)).arp.gate).toBeLessThan(before);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await state(page)).arp.gate).toBe(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); expect((await state(page)).arp.gate).toBeLessThan(before);
  const attack = (await page.getByRole('slider', { name: 'Attack', exact: true }).boundingBox())!;
  expect(rect.width).toBeCloseTo(attack.width, 1); expect(rect.height).toBeCloseTo(attack.height, 2);
  const ruler = (await page.locator('.bar-ruler').boundingBox())!, loop = (await page.locator('.timeline-scroll').boundingBox())!;
  expect(ruler.y + ruler.height).toBeLessThan(loop.y);
  await expect(page.locator('.play-button kbd')).toHaveCount(0);
  await expect(page.locator('.instrument-footer [role=status]')).toHaveCount(0);
  expect(await style('.footer-left button')).toEqual(await style('.copyright'));
  expect(await style('.footer-site')).toEqual(await style('.copyright'));
  for (const selector of ['.tap-tempo', '.export-button']) expect(await page.locator(selector).first().evaluate(el => getComputedStyle(el).borderWidth)).toBe('0px');
  await expect(page.getByRole('slider', { name: 'Octave', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const mode = settings.getByRole('button', { name: /Use (dark|light) mode/ });
  const oldText = await mode.innerText(); await mode.click(); expect(await mode.innerText()).not.toBe(oldText);
  await expect(mode).toHaveText(/Light|Dark/); await expect(mode.locator('svg')).toHaveCount(1);
  await settings.getByRole('button', { name: 'Follow system' }).click();
  await expect(settings.getByRole('button', { name: 'Follow system' })).toHaveAttribute('aria-pressed', 'true');
  await settings.getByRole('textbox', { name: 'Accent hex value' }).fill('#123456');
  await settings.getByRole('textbox', { name: 'Accent hex value' }).blur();
  await settings.getByRole('button', { name: 'Reset colors' }).click();
  await expect(settings.getByRole('textbox', { name: 'Accent hex value' })).not.toHaveValue('#123456');
});

async function scopeActivity(page: Page) {
  return page.locator('canvas.scope').evaluate(canvas => {
    const el = canvas as HTMLCanvasElement;
    const { data, width, height } = el.getContext('2d')!.getImageData(0, 0, el.width, el.height);
    let pixels = 0;
    for (let y = 0; y < height; y++) if (Math.abs(y - height / 2) > 2) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 0) pixels++;
    return pixels;
  });
}

async function silentArpFixture(page: Page) {
  await page.goto('./'); const session = await state(page);
  session.arp.mode = 'arp'; session.arp.steps = Array(8).fill(null); session.bass = false;
  session.sound.attack = 0; session.sound.decay = .1; session.sound.reverbAmount = 0;
  session.countIn = false; session.quantize = 'off';
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), session);
  await page.reload();
}

test('logo auditions preserve idle session and are disabled during playback', async ({ page }) => {
  await silentArpFixture(page);
  await page.getByRole('button', { name: 'Hold', exact: true }).click();
  await selectClip(page);
  const before = await state(page);
  const selected = await page.locator('.pad.selected').getAttribute('data-testid');
  const logo = page.getByRole('button', { name: 'thread — play a random chord' });
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await logo.click();
  await expect.poll(() => scopeActivity(page)).toBeGreaterThan(0);
  await expect(page.locator('.timeline-block.selected')).toHaveCount(1);
  expect(await page.locator('.pad.selected').getAttribute('data-testid')).toBe(selected);
  expect(await state(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Hold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => scopeActivity(page), { timeout: 4000 }).toBe(0);
  await logo.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => scopeActivity(page)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Arpeggiator', exact: true }).click();
  const beforePlay = await state(page);
  await logo.focus(); await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  const position = await page.locator('.timeline-head').getAttribute('style');
  await expect(logo).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.waitForTimeout(40);
  expect(await page.locator('.timeline-head').getAttribute('style')).not.toBe(position);
  expect(await state(page)).toEqual(beforePlay);
  await expect(logo).toBeDisabled();
  await page.getByRole('button', { name: /Silence/ }).click();
  await expect.poll(() => scopeActivity(page), { timeout: 4000 }).toBe(0);
  await logo.click(); await expect.poll(() => scopeActivity(page)).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(() => scopeActivity(page), { timeout: 4000 }).toBe(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await state(page)).toEqual(before);
});

test('logo is excluded from recording and recording feedback respects reduced motion', async ({ page }) => {
  await silentArpFixture(page); const before = await state(page);
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  const finish = page.getByRole('button', { name: 'Finish', exact: true }); await expect(finish).toBeVisible();
  expect(await finish.evaluate(el => getComputedStyle(el).animationName)).toBe('recording-pulse');
  await expect(page.getByRole('button', { name: 'thread — play a random chord' })).toBeDisabled();
  await expect(page.locator('.timeline-ghost.recording')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await finish.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  const logo = page.getByRole('button', { name: 'thread — play a random chord' });
  await expect(logo).toBeDisabled();
  const transforms = await logo.evaluate(el => el.getAnimations().flatMap(animation => (animation.effect as KeyframeEffect).getKeyframes().map(frame => frame.transform)).filter(Boolean));
  expect(transforms).toEqual([]);
  await finish.click(); expect(await state(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /Silence/ }).click();
  await expect(page.locator('.instrument-footer')).not.toContainText(/Count in|Recording|No notes recorded/);
});

test('separate accents retain displayed values and survive mode changes, reload, and reset', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => { if (!localStorage.getItem('thread.demo.appearance.v2')) localStorage.setItem('thread.demo.appearance.v2', JSON.stringify({ version: 2, background: '#f2f2f2', text: '#17191e', accentLight: '#125678', accentDark: '#eda987', invert: null })); });
  await page.goto('./');
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.click();
  const accent = page.getByRole('textbox', { name: 'Accent hex value' });
  await expect(accent).toHaveValue('#125678');
  await accent.fill('#2244cc'); await accent.blur();
  await page.getByRole('button', { name: 'Use dark mode' }).click();
  await expect(accent).toHaveValue('#eda987');
  await accent.fill('#ddaa33'); await accent.blur();
  await page.getByRole('button', { name: 'Use light mode' }).click();
  await expect(accent).toHaveValue('#2244cc');
  await page.reload(); await settings.click(); await expect(accent).toHaveValue('#2244cc');
  await page.getByRole('button', { name: 'Follow system' }).click();
  await page.emulateMedia({ colorScheme: 'dark' }); await expect(accent).toHaveValue('#ddaa33');
  await page.emulateMedia({ colorScheme: 'light' }); await expect(accent).toHaveValue('#2244cc');
  await page.getByRole('button', { name: 'Reset colors' }).click(); await expect(accent).toHaveValue('#245bef');
  await page.emulateMedia({ colorScheme: 'dark' }); await expect(accent).toHaveValue('#dba410');
});

test('control insets, sound columns, and ruler subdivisions retain fixed geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 }); await page.goto('./');
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  const slider = async (name: string) => (await page.getByRole('slider', { name, exact: true }).boundingBox())!;
  const attack = await slider('Attack'), decay = await slider('Decay'), color = await slider('Color'), texture = await slider('Texture'), reverb = await slider('Reverb'), time = await slider('Time');
  expect(attack.x).toBe(decay.x); expect(color.x).toBe(texture.x); expect(reverb.x).toBe(time.x);
  expect(attack.y).toBe(color.y); expect(color.y).toBe(reverb.y);
  const scope = await box('.scope-tile'), sound = await box('.sound-voice'), arp = await box('.arp-top-row');
  expect(sound.y - scope.y).toBe(10); expect(arp.y).toBe(sound.y);
  const tap = await box('.tap-tempo'), timing = await box('.timing-trigger');
  expect(timing.x - tap.x - tap.width).toBe(36);
  const track = await box('.timeline-scroll'), major = await box('.bar-line:first-child');
  expect(track.y - major.y).toBe(22); expect(major.width).toBe(1);
  for (const line of await page.locator('.bar-line').all()) expect((await line.boundingBox())!.width).toBe(1);
  const subdivision = (await page.locator('.subdivision-line').first().boundingBox())!;
  expect(track.y - subdivision.y).toBe(4);
  expect(await page.locator('.loop-ruler-lines').evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
  const count = await page.locator('.loop-ruler-lines span').count();
  await page.getByRole('button', { name: 'Timing options' }).click();
  await page.getByRole('button', { name: 'Block grid' }).click();
  await page.getByRole('option', { name: '¼ beat', exact: true }).click();
  expect(await page.locator('.loop-ruler-lines span').count()).toBeGreaterThan(count);
  const dimensions = await page.locator('canvas.scope').evaluate(el => { const c=el as HTMLCanvasElement; return [c.width,c.height,Math.round(c.getBoundingClientRect().width*devicePixelRatio),Math.round(c.getBoundingClientRect().height*devicePixelRatio)]; });
  expect(dimensions.slice(0,2)).toEqual(dimensions.slice(2));
});

test('arp ghost and sounding cells follow transformations, rests, gate, and release', async ({ page }) => {
  await page.goto('./'); const session = await state(page);
  session.arp = { ...session.arp, mode: 'arp', division: 16, triplet: false, gate: .4, register: 1, reverse: true, mirror: true, steps: [0,null,2,null,4,null,6,7] };
  session.loop.tempo = 120; session.loop.blocks = [{ id: 0, pad: 0, tick: 0, durationTicks: 3840 }]; session.loop.bars = 2;
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1',JSON.stringify(value)),session); await page.reload();
  const ghostCoordinates = await page.locator('.arp-matrix .ghost').evaluateAll(cells => cells.map(c => `${(c as HTMLElement).dataset.column}:${(c as HTMLElement).dataset.row}`).sort());
  expect(ghostCoordinates).toEqual(['0:0','1:1','3:3','5:5','7:7']);
  const before = await state(page);
  const sampleCells = () => page.evaluate(() => new Promise<string[]>(resolve => {
    const cells = new Set<string>(), end = performance.now() + 1550;
    const sample = () => {
      const active = [...document.querySelectorAll<HTMLElement>('.arp-matrix .sounding')];
      if (!active.length) cells.add('rest');
      active.forEach(cell => cells.add(`${cell.dataset.column}:${cell.dataset.row}`));
      if (performance.now() < end) requestAnimationFrame(sample); else resolve([...cells]);
    }; sample();
  }));
  await page.keyboard.down('1');
  const liveCells = await sampleCells();
  expect(liveCells).toEqual(expect.arrayContaining(['0:0','2:2','4:4','6:6','7:7','1:1','3:3','rest']));
  expect(liveCells).not.toContain('0:1'); // Repeated-pitch rows are not extra sounding cells.

  await expect.poll(async () => page.locator('.arp-matrix .sounding').count()).toBe(0);
  await page.keyboard.up('1'); await expect(page.locator('.arp-matrix .sounding')).toHaveCount(0);
  expect(await state(page)).toEqual(before);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const loopCells = await sampleCells();
  expect(loopCells).toEqual(expect.arrayContaining(['0:0','2:2','4:4','6:6','7:7','1:1','3:3','rest']));
  expect(loopCells).not.toContain('0:1');
  await page.getByRole('button', { name: 'Silence Esc' }).click();
  await expect(page.locator('.arp-matrix .sounding')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.down('1');
  await expect(page.locator('.arp-matrix .sounding')).toHaveCount(1);
  expect(await page.locator('.arp-matrix .sounding').evaluate(el => getComputedStyle(el).boxShadow)).toBe('none');
  await page.keyboard.up('1'); await expect(page.locator('.arp-matrix .sounding')).toHaveCount(0);
});

test('stepped arp sliders snap, support keyboard endpoints, and group each drag into one Undo', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 }); await page.goto('./');
  const rate = page.getByRole('slider', { name: 'Rate', exact: true });
  await rate.focus(); await page.keyboard.press('Home'); expect((await state(page)).arp.division).toBe(2);
  for (const division of [4, 8, 16, 32]) {
    await page.keyboard.press('ArrowRight'); expect((await state(page)).arp.division).toBe(division);
    await expect(rate).toHaveAttribute('aria-valuetext', `/${division}`);
  }
  await page.keyboard.press('ArrowRight'); expect((await state(page)).arp.division).toBe(32);
  await page.keyboard.press('PageDown'); expect((await state(page)).arp.division).toBe(16);
  await page.keyboard.press('Home');
  const drag = async (label: string, moves: number[]) => {
    const rect = (await page.getByRole('slider', { name: label, exact: true }).boundingBox())!;
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    for (const dx of moves) {
      await page.mouse.move(x + dx, y);
      const arp = (await state(page)).arp;
      expect([2, 4, 8, 16, 32]).toContain(arp.division); expect([-1, 0, 1]).toContain(arp.register);
    }
    await page.mouse.up();
  };
  await drag('Rate', [15, 30, 45, 60, 75, 90]); expect((await state(page)).arp.division).toBe(32);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await state(page)).arp.division).toBe(2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); expect((await state(page)).arp.division).toBe(32);
  const octave = page.getByRole('slider', { name: 'Octave', exact: true });
  await octave.focus(); await page.keyboard.press('Home'); expect((await state(page)).arp.register).toBe(-1);
  await page.keyboard.press('ArrowRight'); expect((await state(page)).arp.register).toBe(0);
  await page.keyboard.press('End'); expect((await state(page)).arp.register).toBe(1);
  await expect(octave).toHaveAttribute('aria-valuetext', '+1');
  await page.keyboard.press('Home'); await drag('Octave', [20, 40, 60, 80, 90]);
  expect((await state(page)).arp.register).toBe(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await state(page)).arp.register).toBe(-1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.reload(); expect((await state(page)).arp).toMatchObject({ division: 32, register: 1 });
});

test('arp rows, centered square toggles, and Voice menu retain their widths when scaled', async ({ page }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const viewport of [{ width: 1024, height: 768 }, { width: 900, height: 700 }, { width: 768, height: 1024 }]) {
      await page.setViewportSize(viewport); await page.goto('./');
      const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
      const left = await box('.arp-rate-row .knob-control:first-child'), center = await box('.arp-rate-row .knob-control:nth-child(2)'), right = await box('.arp-rate-row .knob-control:last-child');
      expect(left.x + left.width).toBeLessThan(center.x); expect(center.x + center.width).toBeLessThan(right.x);
      expect(left.width).toBeCloseTo(right.width, 1);
      const row = await box('.arp-rate-row');
      expect(Math.abs(center.x + center.width / 2 - row.x - row.width / 2)).toBeLessThan(1);
      const top = await box('.arp-top-row'), bottom = await box('.arp-shape-row');
      const voiceRow = await box('.sound-voice'); expect(voiceRow.y).toBeCloseTo(top.y,1); expect(voiceRow.height).toBeCloseTo(top.height,1);
      await expect(page.locator('.arp-rate-row .knob-control')).toHaveCount(3);
      await expect(page.locator('.arp-shape-row .control-toggle')).toHaveCount(3);
      expect(top.y + top.height).toBeLessThan(row.y); expect(row.y + row.height).toBeLessThan(bottom.y);
      await expect(page.locator('.arp-top-row .control-toggle')).toHaveText('Arpeggiator');
      for (const toggle of await page.locator('.control-toggle').all()) {
        const track = (await toggle.locator('.toggle-track').boundingBox())!, text = (await toggle.locator('> span:last-child').boundingBox())!;
        expect(Math.abs(track.y + track.height / 2 - text.y - text.height / 2)).toBeLessThan(1);
        expect(await toggle.locator('.toggle-track > span').evaluate(el => getComputedStyle(el).borderRadius)).toBe('3px');
      }
      const voice = page.getByRole('button', { name: 'Voice', exact: true }); await voice.click();
      const menu = page.getByRole('listbox', { name: 'Voice', exact: true });
      expect((await menu.boundingBox())!.width).toBeCloseTo((await voice.boundingBox())!.width, 1);
      expect(await menu.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await menu.getByRole('option', { name: 'Current', exact: true }).click(); expect((await state(page)).voice).toBe('Current');
      await voice.click(); expect(await menu.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.keyboard.press('Escape'); await expect(voice).toBeFocused();
    }
  }
});

test('ghost circles brighten without lighting their square in either theme and reduce their halo', async ({ page }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' }); await page.goto('./');
    const session = await state(page); session.arp = { ...session.arp, reverse: true, mirror: true, steps: [0,null,2,null,4,null,6,7] };
    await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), session); await page.reload();
    for (const selector of ['.ghost:not(.active)', '.ghost.active']) {
      const cell = page.locator(`.arp-matrix ${selector}`).first();
      const appearance = () => cell.evaluate(el => {
        const circle = getComputedStyle(el, '::after'), square = getComputedStyle(el);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!; ctx.fillStyle = circle.backgroundColor; ctx.fillRect(0, 0, 1, 1);
        const [r,g,b] = ctx.getImageData(0,0,1,1).data;
        return { brightness: .2126*r + .7152*g + .0722*b, background: square.backgroundColor, shadow: square.boxShadow, circleShadow: circle.boxShadow, radius: circle.borderRadius, inset: circle.inset, border: circle.borderWidth };
      });
      const resting = await appearance(); expect(resting.radius).toBe('50%'); expect(resting.inset).toBe('0px'); expect(resting.border).toBe('0px');
      await cell.evaluate(el => el.classList.add('sounding'));
      const lit = await appearance(); expect(lit.brightness).toBeGreaterThan(resting.brightness); expect(lit.background).toBe(resting.background); expect(lit.shadow).toBe('none'); expect(lit.circleShadow).toContain('3px');
      await page.emulateMedia({ reducedMotion: 'reduce' }); expect((await appearance()).circleShadow).toBe('none');
      await cell.evaluate(el => el.classList.remove('sounding')); await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
  }
});

test('fresh defaults, full arp randomization, and exact Undo/Redo persistence', async ({ page }) => {
  await page.goto('./');
  const fresh=await state(page);
  expect(fresh).toMatchObject({ voice:'Felt',bass:false, sound:{attack:0,decay:1,color:.5,texture:.5,reverbAmount:.5,reverbTime:.5,masterVolume:.75},
    arp:{mode:'off',division:16,gate:.5,register:0,triplet:false,reverse:false,mirror:false} });
  await page.evaluate(() => Object.defineProperty(crypto,'getRandomValues',{configurable:true,value:(array:Uint32Array)=>{array[0]=42;return array;}}));
  await page.getByRole('button',{name:'Randomize arpeggiator'}).click();
  const changed=await state(page);
  expect(changed.arp.mode).toBe('off'); expect(changed.arp.steps.some((step:number|null)=>step!==null)).toBe(true);
  expect(changed.arp).not.toEqual(fresh.arp); expect(changed.loop).toEqual(fresh.loop);
  await page.getByRole('button',{name:'Undo',exact:true}).click(); expect(await state(page)).toEqual(fresh);
  await page.getByRole('button',{name:'Redo',exact:true}).click(); expect(await state(page)).toEqual(changed);
  await page.getByRole('button',{name:'Arpeggiator',exact:true}).click();
  await page.getByRole('button',{name:'Randomize arpeggiator'}).click(); expect((await state(page)).arp.mode).toBe('arp');
  // Previously saved controls are not reset by the fresh-session defaults.
  const saved=await state(page); saved.voice='Reed'; saved.sound.attack=.33; saved.sound.masterVolume=.7;
  await page.evaluate(value=>localStorage.setItem('thread.demo.session.v1',JSON.stringify(value)),saved);
  await page.reload(); expect(await state(page)).toEqual(saved);
});

test('click pulses interpolate and restart smoothly without delaying controls or reduced-motion effects', async ({ page }) => {
  await page.goto('./');
  for (const selector of ['.logo-button','.header-button','.play-button','.arp-random']) {
    const button=page.locator(selector);
    const base=await button.evaluate((el,selector)=>getComputedStyle(el)[selector==='.logo-button'?'color':'backgroundColor'],selector);
    await button.click();
    if(selector==='.play-button') await expect(button).toHaveText('Stop');
    const middle=await button.evaluate((el,selector)=>{
      const animation=el.getAnimations()[0]; animation.pause(); animation.currentTime=40;
      return getComputedStyle(el)[selector==='.logo-button'?'color':'backgroundColor'];
    },selector);
    expect(middle).not.toBe(base);
    const beforeRestart=await button.evaluate((el,selector)=>getComputedStyle(el)[selector==='.logo-button'?'color':'backgroundColor'],selector);
    await button.click();
    const restart=await button.evaluate((el,selector)=>{
      const property=selector==='.logo-button'?'color':'backgroundColor';
      const animations=el.getAnimations(); animations[0].pause(); animations[0].currentTime=0;
      return {after:getComputedStyle(el)[property],count:animations.length};
    },selector);
    expect(restart.after,selector).toBe(beforeRestart); expect(restart.count).toBe(1);
    await button.evaluate(el=>{const animation=el.getAnimations()[0];animation.currentTime=200;animation.finish();});
    expect(await button.evaluate((el,selector)=>getComputedStyle(el)[selector==='.logo-button'?'color':'backgroundColor'],selector)).toBe(base);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  for(const selector of ['.logo-button','.header-button','.play-button','.arp-random']) {
    await page.locator(selector).click(); expect(await page.locator(selector).evaluate(el=>el.getAnimations().length)).toBe(0);
  }
});
