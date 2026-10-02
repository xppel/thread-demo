import { test, expect, type Page } from '@playwright/test';

// Observe the node feeding the native destination. This verifies software PCM,
// not the browser's physical speaker output; native Safari listening is a separate gate.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('thread.demo.intro.seen.v1', '1');
    const probe = { contexts: [] as AudioContext[], outputs: [] as AnalyserNode[] };
    Object.assign(window, { __threadOutputProbe: probe });
    const Original = window.AudioContext;
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: new Proxy(Original, {
      construct(target, args) {
        const context = Reflect.construct(target, args) as AudioContext;
        probe.contexts.push(context);
        return context;
      },
    }) });
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (...args: Parameters<AudioNode['connect']>) {
      const destination = args[0];
      if (destination instanceof AudioDestinationNode) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 2048;
        connect.call(this, analyser);
        probe.outputs.push(analyser);
      }
      return Reflect.apply(connect, this, args);
    } as AudioNode['connect'];
  });
});

async function output(page: Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as { __threadOutputProbe: { contexts: AudioContext[]; outputs: AnalyserNode[] } }).__threadOutputProbe;
    return {
      states: probe.contexts.map(context => context.state),
      times: probe.contexts.map(context => context.currentTime),
      peak: Math.max(0, ...probe.outputs.filter(analyser => probe.contexts.some(context => context === analyser.context && context.state === 'running')).map(analyser => {
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.max(...samples.map(Math.abs));
      })),
    };
  });
}
async function expectSound(page: Page) {
  const start = await output(page);
  await expect.poll(async () => {
    const sample = await output(page);
    const active = sample.states.findIndex(state => state === 'running');
    return active >= 0 && sample.times[active] > (start.times[active] ?? 0) + .07 ? sample.peak : 0;
  }).toBeGreaterThan(.001);
}

test('native destination has PCM on cold pointer and keyboard play with default Reverb', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  const pad = await page.getByTestId('pad-1').boundingBox();
  await page.mouse.move(pad!.x + pad!.width / 2, pad!.y + pad!.height / 2);
  await page.mouse.down(); await expectSound(page); await page.mouse.up();
  await page.keyboard.down('2'); await expectSound(page); await page.keyboard.up('2');
  await expect.poll(async () => (await output(page)).states).toEqual(['closed', 'running']);
  expect(errors).toEqual([]);
});

test('destination recovers after suspension and another native context closes', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./'); await page.keyboard.down('1'); await expectSound(page); await page.keyboard.up('1');
  await page.evaluate(async () => {
    const probe = (window as unknown as { __threadOutputProbe: { contexts: AudioContext[] } }).__threadOutputProbe;
    await probe.contexts.at(-1)!.suspend();
  });
  await page.keyboard.down('2'); await expectSound(page); await page.keyboard.up('2');
  await page.evaluate(async () => {
    const other = new AudioContext();
    await other.close();
  });
  await page.keyboard.down('3'); await expectSound(page); await page.keyboard.up('3');
  const before = await output(page); await page.waitForTimeout(150); const after = await output(page);
  expect(after.times[1]).toBeGreaterThan(before.times[1]);
  expect(after.states).toEqual(['closed', 'running', 'closed']);
  expect(errors).toEqual([]);
});

test('reload preserves settings and reopens a working destination without live-context growth', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.keyboard.down('1'); await expectSound(page); await page.keyboard.up('1');
    await expect.poll(async () => (await output(page)).states).toEqual(['closed', 'running']);
    const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('thread.demo.session.v1')!).sound);
    expect(settings.masterVolume).toBe(.75); expect(settings.reverbAmount).toBe(.5);
    if (cycle < 2) await page.reload();
  }
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await output(page)).peak, { timeout: 5000 }).toBeLessThan(.001);
  expect(errors).toEqual([]);
});

test('destination still produces PCM after returning from an audio tab that closes', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./'); await page.keyboard.down('1'); await expectSound(page); await page.keyboard.up('1');
  const other = await context.newPage();
  await other.setContent('<button>Play bare tone</button>');
  await other.evaluate(() => {
    document.querySelector('button')!.onclick = () => {
      const audio = new AudioContext();
      Object.assign(window, { __bareAudio: audio });
      const oscillator = audio.createOscillator();
      const gain = audio.createGain(); gain.gain.value = .05;
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(); oscillator.stop(audio.currentTime + .1);
    };
  });
  await other.bringToFront(); await other.getByRole('button').click();
  await expect.poll(() => other.evaluate(() => (window as unknown as { __bareAudio: AudioContext }).__bareAudio.currentTime)).toBeGreaterThan(.15);
  await other.close(); await page.bringToFront();
  await page.keyboard.down('2'); await expectSound(page); await page.keyboard.up('2');
  expect(errors).toEqual([]);
});

// Headless engines do not consistently dispatch real tab visibility. Drive the
// application's visibility/page-cache events; native Safari background listening
// remains a separate owner check.
test('background pauses the owned context and only the next gesture resumes it', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.keyboard.down('1'); await expectSound(page); await page.keyboard.up('1');
  const saved = await page.evaluate(() => localStorage.getItem('thread.demo.session.v1'));
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expectSound(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    await expect.poll(async () => (await output(page)).states).toEqual(['closed', 'suspended']);
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.waitForTimeout(100);
    expect((await output(page)).states).toEqual(['closed', 'suspended']);
    if (cycle === 1) {
      const pad = await page.getByTestId('pad-1').boundingBox();
      await page.mouse.move(pad!.x + pad!.width / 2, pad!.y + pad!.height / 2);
      await page.mouse.down(); await expectSound(page); await page.mouse.up();
    } else {
      await page.keyboard.down('2'); await expectSound(page); await page.keyboard.up('2');
    }
    expect((await output(page)).states).toEqual(['closed', 'running']);
    expect(await page.evaluate(() => localStorage.getItem('thread.demo.session.v1'))).toBe(saved);
  }
  expect(errors).toEqual([]);
});

for (const warm of [false, true]) test(`${warm ? 'warm' : 'first'} play during a wet WAV export keeps the live destination working`, async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const original = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function () {
      return original.call(this).then(async buffer => {
        if ((window as unknown as { __delayExport?: boolean }).__delayExport) await new Promise(resolve => setTimeout(resolve, 600));
        return buffer;
      });
    };
  });
  await page.goto('./');
  if (warm) {
    await page.keyboard.down('1'); await expectSound(page); await page.keyboard.up('1');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await output(page)).peak, { timeout: 5000 }).toBeLessThan(.001);
  }
  await page.evaluate(() => Object.assign(window, { __delayExport: true }));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'WAV', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rendering…' })).toBeVisible();
  await page.keyboard.down('3'); await expectSound(page); await page.keyboard.up('3');
  await download;
  expect(errors).toEqual([]);
  await page.keyboard.down('2'); await expectSound(page); await page.keyboard.up('2');
});

test('foreground interruption clears Hold and resumes only fresh input with a visible notice', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.keyboard.down('1'); await page.keyboard.press('Shift'); await page.keyboard.up('1');
  await expect(page.locator('.pad.sounding')).toHaveCount(1);
  await expectSound(page);
  await page.evaluate(async () => {
    const probe = (window as unknown as { __threadOutputProbe: { contexts: AudioContext[] } }).__threadOutputProbe;
    await probe.contexts.at(-1)!.suspend();
  });
  await expect(page.getByRole('alert')).toHaveText('Sound was interrupted. Play again to resume.');
  await expect(page.locator('.arp-matrix .sounding')).toHaveCount(0);
  await expect(page.locator('.pad.sounding')).toHaveCount(0);
  await page.keyboard.down('2'); await expectSound(page); await page.keyboard.up('2');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await output(page)).peak).toBeLessThan(.001);
  expect(errors).toEqual([]);
});

test('a delayed refill preserves queued chord playback without a pause notice', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expectSound(page);
  // This deliberately delays JavaScript; no audio recording is involved.
  await page.evaluate(() => {
    const until = performance.now() + 450;
    while (performance.now() < until) { /* deterministic busy main thread */ }
  });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectSound(page);
  expect(errors).toEqual([]);
});

test('interruption preserves a partial take and its Undo before stopping', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('thread.demo.session.v1')!));
  session.countIn = false; session.quantize = 'off';
  await page.evaluate(value => localStorage.setItem('thread.demo.session.v1', JSON.stringify(value)), session);
  await page.reload();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeVisible();
  await page.keyboard.down('2'); await page.waitForTimeout(120);
  await page.evaluate(async () => {
    const probe = (window as unknown as { __threadOutputProbe: { contexts: AudioContext[] } }).__threadOutputProbe;
    await probe.contexts.at(-1)!.suspend();
  });
  await page.keyboard.up('2');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Sound was interrupted. Play again to resume.');
  const blocks = await page.evaluate(() => JSON.parse(localStorage.getItem('thread.demo.session.v1')!).loop.blocks);
  expect(blocks.some((block: { pad: number; tick: number }) => block.pad === 1 && block.tick < 1920)).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('thread.demo.session.v1')!).loop.blocks)).toEqual(session.loop.blocks);
  expect(errors).toEqual([]);
});

test('a closed owned context is replaced on fresh input without changing the saved session', async ({ page }) => {
  await page.goto('./'); await page.keyboard.down('1'); await expectSound(page); await page.keyboard.up('1');
  const saved = await page.evaluate(() => localStorage.getItem('thread.demo.session.v1'));
  await page.evaluate(async () => {
    const probe = (window as unknown as { __threadOutputProbe: { contexts: AudioContext[] } }).__threadOutputProbe;
    await probe.contexts.at(-1)!.close();
  });
  await expect(page.getByRole('alert')).toHaveText('Sound was interrupted. Play again to resume.');
  await page.keyboard.down('2'); await expectSound(page); await page.keyboard.up('2');
  expect((await output(page)).states).toEqual(['closed', 'closed', 'running']);
  expect(await page.evaluate(() => localStorage.getItem('thread.demo.session.v1'))).toBe(saved);
});
