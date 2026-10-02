import type { Page } from '@playwright/test';

export type NativeCommand = { method: string; args: number[]; submitted: number };
export type AttackTrace = {
  id?: string; midi?: number; time?: number; duration?: number; release?: number;
  frequency?: NativeCommand[]; frequencyChain?: NativeCommand[][]; automation?: NativeCommand[];
  sourceGain?: NativeCommand[]; volume?: NativeCommand[]; texture?: NativeCommand[]; resonance?: NativeCommand[];
  native?: { id: number; requested: number; submitted: number; stops: Array<{ requested: number; submitted: number }> };
  route?: number[]; routeIssue?: string;
  shared?: { bus: NativeCommand[]; dry: NativeCommand[]; master: NativeCommand[]; destination: NativeCommand[] };
  envelope?: number; disconnectedAt?: number; disposed?: string; now?: number; start?: number; end?: number; stopping?: boolean;
};

// Replay native commands, including later cancellation. Tone's predicted envelope
// alone cannot establish that an attack survived submission to Web Audio.
export function nativeValue(commands: NativeCommand[], time: number): number {
  type Event = { method: string; args: number[] };
  let timeline: Event[] = [];
  const valueAt = (at: number): number => {
    let value = 0, previousTime = 0, target: { value: number; from: number; time: number; constant: number } | undefined;
    for (const event of [...timeline].sort((a,b) => a.args[1] - b.args[1])) {
      const [next, end, constant] = event.args;
      if (event.method.includes('Ramp')) {
        if (at < end) {
          const fraction = Math.max(0, Math.min(1, (at - previousTime) / Math.max(1e-12, end - previousTime)));
          return event.method.startsWith('exponential') && value > 0 && next > 0 ? value * (next / value) ** fraction : value + (next - value) * fraction;
        }
      } else if (at < end) break;
      if (target) value = target.value + (target.from - target.value) * Math.exp(-(end - target.time) / target.constant);
      if (event.method === 'setTargetAtTime') target = { value: next, from: value, time: end, constant };
      else { value = next; target = undefined; }
      previousTime = end;
    }
    return target ? target.value + (target.from - target.value) * Math.exp(-(at - target.time) / target.constant) : value;
  };
  for (const command of commands) {
    if (command.submitted > time) continue;
    if (command.method.startsWith('cancel')) {
      const at = command.args[0], held = valueAt(at);
      timeline = timeline.filter(event => event.args[1] < at);
      if (command.method === 'cancelAndHoldAtTime') timeline.push({ method: 'setValueAtTime', args: [held, at] });
    } else timeline.push(command);
  }
  return valueAt(time);
}

export function nativeAttackIssue(attack: AttackTrace): string | undefined {
  if (!attack.native || attack.time === undefined || attack.midi === undefined) return 'missing native attack';
  const sample = attack.time + Math.min(.005, (attack.duration ?? .1) / 2);
  if (attack.disconnectedAt !== undefined && attack.disconnectedAt <= sample) return 'native source disconnected during attack';
  const hz = 440 * 2 ** ((attack.midi - 69) / 12);
  if (attack.native.submitted > attack.time) return 'late native start';
  if (attack.native.stops.some(stop => stop.submitted <= sample && stop.requested <= sample)) return 'native source stopped during attack';
  if (nativeValue(attack.frequency!, sample) < hz * .999 || nativeValue(attack.frequency!, sample) > hz * 1.001) return 'native pitch missing';
  if (attack.frequencyChain?.some(commands => Math.abs(nativeValue(commands, sample)) > .001)) return 'unexpected additive native pitch';
  const pitch = attack.frequency!.find(command => command.method === 'setValueAtTime' && Math.abs(command.args[0] - hz) < .001 && Math.abs(command.args[1] - attack.time!) < .000001);
  if (!pitch || pitch.submitted > attack.time) return 'late native pitch automation';
  if (!attack.automation!.some(command => command.method.includes('Ramp') && command.args[0] > 0 && command.args[1] > attack.time! && command.submitted <= attack.time!)) return 'late native attack automation';
  if (nativeValue(attack.automation!, sample) <= .00001) return 'native envelope cancelled or silent';
  if (nativeValue(attack.sourceGain!, sample) <= .00001) return 'native source muted';
  if (nativeValue(attack.volume!, sample) <= .0001) return 'native voice muted';
  if (nativeValue(attack.texture!, sample) <= .00001) return 'native Texture path muted';
  if (attack.routeIssue) return attack.routeIssue;
  if (attack.shared && Object.values(attack.shared).some(commands => nativeValue(commands, sample) <= .00001)) return 'shared output path muted';
  return undefined;
}

export async function attachEngine(page: Page) {
  await page.locator('.instrument').waitFor({ state: 'attached' });
  await page.evaluate(() => {
    const element = document.querySelector('.instrument') as any;
    let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))!];
    while (fiber && !fiber.memoizedState) fiber = fiber.return;
    let hook = fiber.memoizedState;
    while (hook && !hook.memoizedState?.current?.attackBatch) hook = hook.next;
    if (!hook) throw new Error('Production audio engine was not found');
    Object.assign(window, { __engine: hook.memoizedState.current, __events: [], __allocations: [], __nativeCounts: {}, __nativeActive: 0, __nativePeak: 0 });
  });
}

export async function traceEngine(page: Page) {
  await attachEngine(page);
  await page.evaluate(() => {
    const w = window as any, engine = w.__engine;
    const append = (event: unknown) => { if (w.__events.length >= 1024) throw new Error('Audio trace limit exceeded'); w.__events.push(event); };
    const automation = new WeakMap<object, Array<{ method: string; args: number[]; submitted: number }>>();
    const graphIds = new WeakMap<object, number>(); let serial = 0;
    const id = (node: object) => { if (!graphIds.has(node)) graphIds.set(node, ++serial); return graphIds.get(node); };
    let traced: any;
    const traceParam = (param: any) => {
      const commands = [{ method: 'setValueAtTime', args: [param.value, 0], submitted: traced.immediate() }]; automation.set(param, commands);
      for (const method of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime']) {
        const original = param[method].bind(param);
        param[method] = (...args: number[]) => { if (commands.length >= 512) commands.splice(0, 128); commands.push({ method, args, submitted: traced.immediate() }); return original(...args); };
      }
    };
    const raw = (param: any) => { while (param?._param) param = param._param; return param; };
    const commands = (param: any) => automation.get(raw(param));
    const starts = new WeakMap<object, { id: number; requested: number; submitted: number; stops: Array<{ requested: number; submitted: number }> }>();
    type RouteCommand = { method: 'connect' | 'disconnect'; to?: number; output?: number; input?: number; submitted: number };
    const routes = new Map<number, RouteCommand[]>(), tracedNodes = new WeakSet<object>();
    const traceNode = (node: any) => {
      if (tracedNodes.has(node)) return;
      tracedNodes.add(node); const source = id(node)!;
      const history: RouteCommand[] = []; routes.set(source, history);
      const connect = node.connect.bind(node), disconnect = node.disconnect.bind(node);
      node.connect = (...args: any[]) => {
        const result = connect(...args);
        if (typeof args[0]?.connect === 'function') history.push({ method: 'connect', to: id(args[0]), output: args[1] ?? 0, input: args[2] ?? 0, submitted: traced.immediate() });
        return result;
      };
      node.disconnect = (...args: any[]) => {
        const result = disconnect(...args);
        history.push({ method: 'disconnect', to: typeof args[0]?.connect === 'function' ? id(args[0]) : undefined,
          output: typeof args[0] === 'number' ? args[0] : args[1], input: args[2], submitted: traced.immediate() });
        return result;
      };
    };
    const nativeOutput = (node: any): any => {
      while (node && !node._gainNode && node.output && node.output !== node) node = node.output;
      return node?._gainNode ?? node;
    };
    const routeAt = (source: number, sink: number, time: number): number[] | undefined => {
      const queue = [[source]], visited = new Set<number>();
      while (queue.length) {
        const path = queue.shift()!, current = path.at(-1)!;
        if (current === sink) return path;
        if (visited.has(current)) continue;
        visited.add(current);
        let edges: RouteCommand[] = [];
        for (const command of routes.get(current) ?? []) {
          if (command.submitted > time) continue;
          if (command.method === 'connect') edges.push(command);
          else edges = edges.filter(edge => (command.to !== undefined && edge.to !== command.to) ||
            (command.output !== undefined && edge.output !== command.output) || (command.input !== undefined && edge.input !== command.input));
        }
        for (const edge of edges) if (!visited.has(edge.to!)) queue.push([...path, edge.to!]);
      }
      return undefined;
    };
    let sink: number;
    w.__routeAt = (source: number, time: number) => routeAt(source, sink, time);
    const traceContext = (context: any) => {
      if (traced === context) return;
      traced = context; sink = id(nativeOutput(context.destination.input))!;
      traceParam(raw(context.destination.volume));
      for (const [factory, fields] of [['createConstantSource', ['offset']], ['createGain', ['gain']], ['createBiquadFilter', ['frequency', 'Q']], ['createWaveShaper', []],
        ['createDynamicsCompressor', ['threshold', 'knee', 'ratio', 'attack', 'release']], ['createConvolver', []], ['createAnalyser', []], ['createChannelSplitter', []], ['createChannelMerger', []]] as const) {
        const original = context[factory].bind(context);
        context[factory] = (...args: any[]) => { const node = original(...args); traceNode(node); w.__nativeCounts[factory] = (w.__nativeCounts[factory] ?? 0) + 1; for (const field of fields) traceParam(node[field]); return node; };
      }
      const create = context.createOscillator.bind(context);
      context.createOscillator = function () {
        const node = create(), start = node.start.bind(node), stop = node.stop.bind(node); traceNode(node); traceParam(node.frequency);
        w.__nativeCounts.createOscillator = (w.__nativeCounts.createOscillator ?? 0) + 1;
        node.start = (time = 0) => { starts.set(node, { id: id(node)!, requested: time, submitted: context.immediate(), stops: [] }); w.__nativeActive++; w.__nativePeak = Math.max(w.__nativePeak, w.__nativeActive); start(time); };
        node.addEventListener('ended', () => { w.__nativeActive--; });
        node.stop = (time = 0) => { starts.get(node)?.stops.push({ requested: time, submitted: context.immediate() }); stop(time); };
        return node;
      };
    };
    if (engine.liveContext) throw new Error('Trace must attach before the first playing gesture');
    // Install before unlock builds the bus/master graph, so a positive envelope
    // cannot hide a disconnected or muted final output path.
    let ownedContext: any;
    Object.defineProperty(engine, 'liveContext', { configurable: true, get: () => ownedContext, set: context => { ownedContext = context; if (context) traceContext(context); } });
    const attacksByVoice = new WeakMap<object, any>();
    const missed = engine.missedDeadline;
    engine.missedDeadline = function () {
      append({ deadlineMiss: true, now: this.audioTime() });
      missed.call(this);
    };
    const create = engine.createVoice;
    engine.createVoice = function (...args: any[]) {
      const began = performance.now(), live = create.apply(this, args);
      if (w.__allocations.length >= 1024) throw new Error('Allocation trace limit exceeded');
      if (live) {
        const dispose = live.synth.dispose.bind(live.synth);
        live.synth.dispose = () => { const attack = attacksByVoice.get(live); if (attack) attack.disconnectedAt = this.audioTime(); return dispose(); };
      }
      if (live) w.__allocations.push({ ms: performance.now() - began, filter: id(live.filter), synth: id(live.synth), part: live.part, live: this.voices.size });
      return live;
    };
    const submit = engine.submitVoice;
    engine.submitVoice = function (live: any, midi: number, velocity: number, time: number, duration?: number) {
      const submitted = submit.call(this, live, midi, velocity, time, duration);
      if (!submitted) { append({ missed: live.id, now: this.audioTime(), start: time }); return false; }
      const inner = live.synth.oscillator._oscillator, source = inner._oscillator, node = source._oscillator;
      const attack = { id: live.id, midi, time, duration, release: live.releaseSeconds, native: starts.get(node), frequency: commands(live.synth.frequency), frequencyChain: [commands(inner.frequency), automation.get(node.frequency)], automation: commands(live.synth.envelope._sig), sourceGain: commands(source._gainNode.gain), volume: commands(live.synth.volume), texture: commands(live.textureGain.gain), resonance: [...commands(live.filter.Q)!], shared: { bus: commands(this.bus.gain), dry: commands(this.dryGain.gain), master: commands(this.output.gain), destination: commands(traced.destination.volume) }, envelope: live.synth.envelope.getValueAtTime(time + Math.min(.005, (duration ?? .1) / 2)) };
      const previous = attacksByVoice.get(live);
      if (previous) Object.assign(previous, attack);
      else { attacksByVoice.set(live, attack); append(attack); }
      return true;
    };
    const release = engine.scheduleRelease;
    engine.scheduleRelease = function (live: any, end: number) {
      release.call(this, live, end);
      const attack = attacksByVoice.get(live);
      if (attack) attack.duration = end - attack.time;
    };
    const dispose = engine.disposeVoice;
    engine.disposeVoice = function (live: any) {
      append({ disposed: live.id, now: this.audioTime(), start: live.startTime, end: live.releaseAt, stopping: live.stopping });
      dispose.call(this, live);
    };
  });
}

export async function events(page: Page): Promise<AttackTrace[]> {
  return page.evaluate(() => {
    const w = window as any;
    return w.__events.map((event: any) => {
      if (!event.native || event.time === undefined) return event;
      const route = w.__routeAt(event.native.id, event.time + Math.min(.005, (event.duration ?? .1) / 2));
      return { ...event, route, routeIssue: route ? undefined : 'native source has no destination path' };
    });
  });
}
