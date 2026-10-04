import test from 'node:test';
import assert from 'node:assert/strict';
import register, { acquisitionLines, dockLines, metadataRequest, usageLines, observeAlerts } from '../tui/agy-usage.mjs';

const NOW = Date.parse('2026-01-01T00:00:30Z');
const payload = () => ({ ok: true, snapshot: { observed_at: '2026-01-01T00:00:00Z', age_seconds: 30,
  freshness_limit_seconds: 120, freshness: 'fresh', stale: false, health: { status: 'ok' },
  meters: ['3p-5h', '3p-weekly', 'gemini-5h', 'gemini-weekly'].map((id, i) => ({ id, remaining_fraction: [.75, .5, .25, .1][i], reset_time: '2026-01-01T01:00:00Z' })),
  pools: [{ pool: 'Claude and GPT models', available: true }, { pool: 'Gemini Models', available: true }] } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const flatten = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...((tree.children ?? []).flatMap(flatten))];
const textOf = tree => flatten(tree).flatMap(node => node.children ?? []).filter(value => typeof value === 'string').join('\n');
const linesText = lines => lines.map(([, text]) => text).join('\n');
const assertGeometry = (lines, width) => { for (const [, text] of lines) assert.equal(text.length, width); };

// Model public host semantics: ambient no-arg launch toggles; only modal gets keys.
function harness(options = {}) {
  const apps = new Map(), states = new Map(), instances = new Map();
  const requests = [], timers = new Map(), opens = [], composer = [];
  let now = NOW, nextTimer = 0, modal = null, rendering = null;
  function unmount(id) {
    const instance = instances.get(id);
    for (const effect of instance?.effects ?? []) effect?.cleanup?.();
    instances.delete(id);
  }
  const sdk = {
    Text: 'Text', Box: 'Box', Dialog: 'Dialog', Overlay: 'Overlay',
    h: (type, props, ...children) => ({ type, props, children }),
    React: {
      useState(initial) {
        const instance = rendering, i = instance.cursor++;
        if (!instance.hooks[i]) instance.hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
        return [instance.hooks[i].value, value => { instance.hooks[i].value = value; }];
      },
      useEffect(fn, deps) {
        const instance = rendering, i = instance.cursor++, old = instance.effects[i];
        if (!old || deps.some((v, j) => v !== old.deps[j])) instance.pending.push(() => {
          old?.cleanup?.(); instance.effects[i] = { deps, cleanup: fn() };
        });
      }
    },
    defineWidgetApp(app) { apps.set(app.id, app); return app; },
    openWidget(app, state) { opens.push(app.id); states.set(app.id, state); if (app.mode === 'modal') modal = app.id; },
    updateWidget(app, fn) { if (states.has(app.id)) states.set(app.id, fn(states.get(app.id))); }
  };
  register(sdk, { request: (args, options) => new Promise((resolve, reject) => requests.push({ args, options, resolve, reject })),
    clock: () => now, ...options, timers: {
      setInterval(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay, nextAt: now + delay }); return id; },
      clearInterval(id) { timers.delete(id); }
    } });
  return {
    apps, requests, timers, opens, composer, state: (id = 'agy-plus-usage') => states.get(id),
    launch(arg = '', id = 'agy-plus-usage') {
      const app = apps.get(id);
      if (app.mode === 'ambient' && !arg.trim() && states.has(id)) { states.delete(id); unmount(id); return null; }
      const state = app.init(arg); if (state === null) return null;
      states.set(id, state); if (app.mode === 'modal') modal = id; return state;
    },
    input(ch = '', key = {}) {
      if (!modal) { composer.push(ch); return; }
      const next = apps.get(modal).reduce(states.get(modal), { ch, key });
      if (next === null) { states.delete(modal); unmount(modal); modal = null; } else states.set(modal, next);
    },
    advance(ms) {
      const end = now + ms;
      while (timers.size) {
        const next = Math.min(...[...timers.values()].map(timer => timer.nextAt)); if (next > end) break;
        now = next;
        for (const timer of [...timers.values()]) if (timer.nextAt === next) { timer.nextAt += timer.delay; timer.callback(); }
      }
      now = end;
    },
    render(id = 'agy-plus-usage', cols = 80) {
      let instance = instances.get(id);
      if (!instance) { instance = { cursor: 0, hooks: [], effects: [], pending: [] }; instances.set(id, instance); }
      rendering = instance; instance.cursor = 0;
      const color = Object.fromEntries(['label', 'muted', 'ok', 'error', 'primary'].map(tone => [tone, `theme-${tone}`]));
      const component = apps.get(id).render({ state: states.get(id), cols, rows: 24, t: { color } });
      const tree = component.type(component.props);
      for (const fn of instance.pending.splice(0)) fn(); rendering = null; return tree;
    },
    dispose() { for (const id of [...instances.keys()]) unmount(id); }
  };
}

async function ready(h) { h.launch(); h.render(); await tick(); h.requests[0].resolve(payload()); await tick(); h.render(); }

test('two registered apps, inert registration/init, ambient host toggle and no key capture', async () => {
  const h = harness();
  try {
    assert.equal(h.apps.get('agy-plus-usage').mode, 'ambient'); assert.equal(h.apps.get('agy-plus-usage').zone, 'dock-top');
    assert.equal(h.apps.get('agy-plus-usage-details').mode, 'modal'); assert.deepEqual(h.opens, []);
    const state = h.launch(); assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0);
    for (const [ch, key] of [['R', {}], ['q', {}], ['hello', {}], ['', { escape: true }]]) {
      assert.strictEqual(h.apps.get('agy-plus-usage').reduce(state, { ch, key }), state);
      h.input(ch, key); assert.strictEqual(h.state(), state);
    }
    assert.deepEqual(h.composer, ['R', 'q', 'hello', '']);
    h.render(); await tick(); assert.equal(h.requests[0].args.action, 'status');
    assert.equal(h.launch(), null); assert.equal(h.state(), undefined);
    assert.equal(h.requests[0].options.signal.aborted, true); assert.equal(h.timers.size, 0);
    h.requests[0].resolve(payload()); await tick(); assert.equal(h.state(), undefined);
  } finally { h.dispose(); }
});

test('hot-reloaded dock dismisses only unmarked legacy modal states', () => {
  const h = harness();
  try {
    const app = h.apps.get('agy-plus-usage'), state = app.init();
    const { surface, ...legacy } = state;
    assert.equal(surface, 'quota-dock-v1');
    for (const [ch, key] of [['q', {}], ['Q', {}], ['', { escape: true }]]) {
      assert.equal(app.reduce(legacy, { ch, key }), null);
      assert.strictEqual(app.reduce(state, { ch, key }), state);
    }
    for (const [ch, key] of [['R', {}], ['r', {}], ['hello', {}], ['', { downArrow: true }]]) {
      assert.strictEqual(app.reduce(legacy, { ch, key }), legacy);
      assert.strictEqual(app.reduce(state, { ch, key }), state);
    }
    assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0);
  } finally { h.dispose(); }
});

test('80-column dock is four readable rows with four percentages and no modal chrome', async () => {
  const h = harness();
  try {
    await ready(h); const tree = h.render(), text = textOf(tree);
    assert.equal(tree.props.width, 76);
    assert.equal(flatten(tree).filter(n => n.type === 'Text').length, 4);
    assert.ok(!flatten(tree).some(n => ['Overlay', 'Dialog', 'ShimmerRows'].includes(n.type)));
    for (const value of ['75.0%', '50.0%', '25.0%', '10.0%']) assert.ok(text.includes(value));
    assert.match(text, /Claude\/GPT.*5h.*weekly/); assert.match(text, /Gemini.*5h.*weekly/);
    assert.match(text, /age 30s/); assert.match(text, /Next 5h reset: 59m/); assert.match(text, /\/agy-plus-usage details/);
    assert.doesNotMatch(text, /QUOTA CONTROL|SONNET|FIVE-HOUR LEFT|_\||#{3}/);
    for (const n of flatten(tree).filter(n => n.type === 'Text')) assert.match(n.props.color, /^theme-/);
    for (const width of [1, 16, 30, 70, 78, 100]) {
      const lines = dockLines(payload(), NOW, width); assert.equal(lines.length, 4); assertGeometry(lines, width);
    }
    assertGeometry(usageLines(payload(), NOW, 70), 70);
    assert.ok(usageLines(payload(), NOW, 70).length <= 16);
  } finally { h.dispose(); }
});

test('slash refresh replaces dock state, keeps prior observation, sanitizes failures', async () => {
  const h = harness();
  try {
    await ready(h); const saved = h.state().payload;
    h.launch('refresh --credits'); const tree = h.render(); await tick();
    assert.equal(h.requests[1].args.action, 'refresh'); assert.equal(h.requests[1].args.credits, true);
    assert.strictEqual(h.state().payload, saved); assert.match(textOf(tree), /Refreshing quota/);
    assert.match(textOf(tree), /last\/unverified/); assert.match(textOf(tree), /75.0%/);
    h.requests[1].reject(new Error('RAW SECRET')); await tick();
    const text = textOf(h.render()); assert.equal(h.state().phase, 'failed');
    assert.match(text, /metadata_unavailable/); assert.doesNotMatch(text, /SECRET/); assert.match(text, /unverified/);
    h.launch('refresh'); h.render(); await tick();
    h.requests[2].resolve({ ok: false, error: { code: 'process_exit', message: 'SECRET' } }); await tick();
    assert.strictEqual(h.state().payload, saved); assert.match(textOf(h.render()), /process_exit/);
  } finally { h.dispose(); }
});

test('explicit details opens supported modal, Esc/q close only details, dock remains', async () => {
  const h = harness();
  try {
    await ready(h); const dock = h.state();
    assert.strictEqual(h.launch('details'), dock); assert.deepEqual(h.opens, ['agy-plus-usage-details']);
    const tree = h.render('agy-plus-usage-details'); await tick();
    assert.ok(flatten(tree).some(n => n.type === 'Overlay'));
    assert.equal(flatten(tree).find(n => n.type === 'Dialog').props.title, 'Quota details');
    assert.match(textOf(tree), /Claude\/GPT.*75.0%/); assert.match(textOf(tree), /Gemini.*10.0%/);
    h.input('', { escape: true }); assert.strictEqual(h.state(), dock); assert.equal(h.state('agy-plus-usage-details'), undefined);
    assert.equal(h.requests[1].options.signal.aborted, true);
    h.launch('', 'agy-plus-usage-details'); h.render('agy-plus-usage-details'); await tick(); h.input('q');
    assert.strictEqual(h.state(), dock); assert.equal(h.state('agy-plus-usage-details'), undefined);
    h.input('R'); assert.equal(h.composer.at(-1), 'R');
  } finally { h.dispose(); }
});

test('details/history from hidden dock returns cached dock state; paging bounded, R refreshes modal only', async () => {
  const h = harness();
  try {
    h.launch('history 5'); assert.equal(h.state().action, 'status'); assert.equal(h.state('agy-plus-usage-details').limit, 5);
    h.render(); h.render('agy-plus-usage-details'); await tick();
    assert.deepEqual(h.requests.map(r => r.args.action), ['status', 'history']);
    h.requests[0].resolve(payload()); h.requests[1].resolve({ ok: true, observations: Array.from({ length: 5 }, () => ({ meters: payload().snapshot.meters })) }); await tick();
    h.render('agy-plus-usage-details'); h.input('', { downArrow: true }); assert.equal(h.state('agy-plus-usage-details').offset, 2);
    h.input('', { downArrow: true }); assert.equal(h.state('agy-plus-usage-details').offset, 3);
    h.input('', { downArrow: true }); assert.equal(h.state('agy-plus-usage-details').offset, 3);
    h.input('', { upArrow: true }); assert.equal(h.state('agy-plus-usage-details').offset, 1);
    const dock = h.state(); h.input('R'); h.render('agy-plus-usage-details'); await tick();
    assert.equal(h.requests[2].args.action, 'refresh'); assert.strictEqual(h.state(), dock);
    h.requests[2].resolve(payload()); await tick(); assert.doesNotMatch(textOf(h.render('agy-plus-usage-details')), /History:/);
  } finally { h.dispose(); }
});

test('cached reload is status only every 60 seconds, local ticking never polls backend API', async () => {
  const h = harness();
  try {
    await ready(h); assert.deepEqual([...h.timers.values()].map(t => t.delay).sort((a, b) => a - b), [1000, 60000]);
    h.advance(59999); h.render(); await tick(); assert.equal(h.requests.length, 1);
    h.advance(1); await tick(); assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[1].args, { action: 'status', credits: false, limit: 20 });
    h.requests[1].resolve(payload()); await tick(); h.render();
    h.advance(60000); await tick(); assert.equal(h.requests.length, 3);
    assert.ok(h.requests.every(r => r.args.action === 'status'));
    h.launch(); assert.equal(h.requests[2].options.signal.aborted, true); assert.equal(h.timers.size, 0);
  } finally { h.dispose(); }
});

test('cached reload can be disabled and is skipped/aborted during explicit refresh', async () => {
  const disabled = harness({ cachedReload: false });
  try { await ready(disabled); disabled.advance(180000); disabled.render(); await tick(); assert.equal(disabled.requests.length, 1); }
  finally { disabled.dispose(); }
  const h = harness();
  try {
    await ready(h); h.advance(60000); await tick(); const cache = h.requests[1];
    h.launch('refresh'); h.render(); await tick(); assert.equal(cache.options.signal.aborted, true);
    h.advance(120000); h.render(); await tick(); assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].args.action, 'refresh');
    cache.resolve(payload()); await tick(); assert.equal(h.state().phase, 'loading');
    h.requests[2].resolve(payload()); await tick(); h.render();
    h.advance(59999); await tick(); assert.equal(h.requests.length, 3);
    h.advance(1); await tick(); assert.equal(h.requests[3].args.action, 'status');
  } finally { h.dispose(); }
});

test('modal refresh also suspends ambient cache reload until it settles or closes', async () => {
  const h = harness();
  try {
    await ready(h); const dock = h.state();
    h.launch('refresh', 'agy-plus-usage-details'); h.render('agy-plus-usage-details'); await tick();
    assert.equal(h.requests[1].args.action, 'refresh');
    h.advance(120000); await tick(); assert.equal(h.requests.length, 2);
    h.input('q'); assert.strictEqual(h.state(), dock); assert.equal(h.requests[1].options.signal.aborted, true);
    h.advance(60000); await tick(); assert.equal(h.requests.length, 3); assert.equal(h.requests[2].args.action, 'status');
  } finally { h.dispose(); }
});

test('old cached status cannot erase a failed refresh; newer observation can recover', async () => {
  const h = harness();
  try {
    await ready(h); h.launch('refresh'); h.render(); await tick(); h.requests[1].reject(new Error('failure')); await tick(); h.render();
    h.advance(60000); await tick(); h.requests[2].resolve(payload()); await tick();
    assert.equal(h.state().phase, 'failed'); assert.equal(h.state().error, 'metadata_unavailable');
    h.advance(60000); await tick(); const newer = payload(); newer.snapshot.observed_at = '2026-01-01T00:02:30Z';
    h.requests[3].resolve(newer); await tick(); assert.equal(h.state().phase, 'ready'); assert.equal(h.state().error, null);
  } finally { h.dispose(); }
});

test('mount and request fences protect reopened/replaced state before old effect cleanup', async () => {
  const h = harness();
  try {
    h.launch(); h.render(); await tick(); const old = h.requests[0];
    const replaced = h.launch('refresh'); old.resolve(payload()); await tick(); assert.strictEqual(h.state(), replaced);
    h.render(); await tick(); assert.equal(old.options.signal.aborted, true);
    const superseded = h.requests[1]; h.launch('refresh'); superseded.resolve(payload()); await tick();
    assert.equal(h.state().phase, 'loading'); assert.equal(h.state().payload, null);
    h.render(); await tick(); h.launch(); assert.equal(h.requests[2].options.signal.aborted, true);
    h.launch(); const reopened = h.state(); h.requests[2].resolve(payload()); await tick(); assert.strictEqual(h.state(), reopened);
  } finally { h.dispose(); }
});

test('tiny signal uses honest real elapsed time; intervals stop and all owned work aborts', async () => {
  const h = harness();
  try {
    h.launch(); const first = textOf(h.render()); await tick(); assert.deepEqual([...h.timers.values()].map(t => t.delay), [250]);
    h.advance(1250); const next = textOf(h.render()); assert.notEqual(first, next); assert.match(next, /1.3s elapsed/);
    assert.equal(h.requests.length, 1); assert.equal(flatten(h.render()).filter(n => n.type === 'Text').length, 4);
    h.launch(); assert.equal(h.timers.size, 0); assert.equal(h.requests[0].options.signal.aborted, true);
    for (const width of [1, 16, 30, 70, 88]) {
      const a = acquisitionLines({ width }), b = acquisitionLines({ width, elapsedMs: 750 });
      assertGeometry(a, width); assertGeometry(b, width); assert.equal(a.length, 1); assert.notEqual(linesText(a), linesText(b));
      assert.doesNotMatch(linesText(b), /\d+(?:\.\d+)?%|complete|stage \d/i);
    }
    for (const [action, caption] of [['status', 'Reading cache'], ['refresh', 'Refreshing quota'], ['history', 'Reading history']]) {
      const text = linesText(acquisitionLines({ action, elapsedMs: 12350 })); assert.ok(text.includes(caption)); assert.match(text, /12.3s elapsed|12.4s elapsed/);
    }
  } finally { h.dispose(); }
});

test('Unknown is not zero; stale age and due resets never imply confirmed refill', () => {
  const result = payload(); result.snapshot.meters[0].remaining_fraction = null; result.snapshot.meters[0].reset_time = null;
  assert.match(linesText(dockLines(result, NOW, 78)), /Unknown/); assert.doesNotMatch(linesText(dockLines(result, NOW, 78)), /(?:^|\s)0\.0%/);
  assert.match(linesText(usageLines(result, NOW, 70)), /reset in Unknown/);
  const stale = linesText(usageLines(result, NOW + 3600000, 70));
  assert.match(stale, /stale\/unverified/); assert.match(stale, /due!/); assert.match(stale, /last available \(unverified\)/);
  for (const invalid of [undefined, NaN, Infinity, -.1, 1.1, '0']) {
    result.snapshot.meters.forEach(m => { m.remaining_fraction = invalid; });
    const text = linesText(dockLines(result, NOW, 78)); assert.match(text, /Unknown/); assert.doesNotMatch(text, /\d+\.\d+%/);
  }
  assert.match(linesText(dockLines(payload(), NOW, 78, { retained: true })), /last\/unverified/);
  assert.match(linesText(usageLines({ ok: true }, NOW, 70)), /Unknown/);
});

test('whitelisted slash arguments only, history bounds and no arbitrary commands', () => {
  const h = harness();
  for (const arg of ['refresh -p danger', 'status;whoami', 'history 0', 'history 1001', 'history 2 x', 'details x', 'refresh --credits x']) {
    assert.equal(h.apps.get('agy-plus-usage').init(arg), null); assert.equal(h.apps.get('agy-plus-usage-details').init(arg), null);
  }
  assert.equal(h.apps.get('agy-plus-usage-details').init('history 1000').limit, 1000);
  assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0); assert.deepEqual(h.opens, []);
});

test('direct bundled Node JSON transport inherits profile and bounds timeout/output', async () => {
  let calls = 0; const signal = new AbortController().signal;
  const execute = (bin, argv, options, done) => {
    calls++; assert.equal(bin, process.execPath); assert.match(argv[0], /backend\/bin\/agy-usage\.mjs$/);
    assert.deepEqual(argv.slice(1), ['history', '--json', '--envelope', '--limit', '3']);
    assert.equal(options.env, undefined); assert.equal(options.shell, false); assert.equal(options.timeout, 4500);
    assert.equal(options.maxBuffer, 2 * 1024 * 1024); assert.strictEqual(options.signal, signal);
    done(null, JSON.stringify({ ok: true, observations: [], count: 0 }));
  };
  assert.equal((await metadataRequest({ action: 'history', limit: 3 }, { signal, execute })).count, 0);
  for (const action of ['poll', 'run', '-p', 'status;whoami']) await assert.rejects(metadataRequest({ action }, { execute }));
  assert.equal(calls, 1);
  for (const [request, argv] of [[{}, ['status', '--json', '--envelope']], [{ action: 'refresh', credits: true }, ['refresh', '--json', '--envelope', '--credits']]]) {
    await metadataRequest(request, { execute: (bin, actual, options, done) => { assert.equal(bin, process.execPath); assert.deepEqual(actual.slice(1), argv); assert.equal(options.shell, false); assert.equal(options.timeout, request.action === 'refresh' ? 30000 : 4500); done(null, '{"ok":true}'); } });
  }
  const failure = { ok: false, error: { code: 'process_exit', message: 'raw backend failure' } };
  assert.deepEqual(await metadataRequest({}, { execute: (_, __, ___, done) => done(new Error('exit1'), JSON.stringify(failure)) }), failure);
  await assert.rejects(metadataRequest({}, { execute: (_, __, ___, done) => done(new Error('SECRET'), 'not json') }), /metadata_unavailable/);
});

test('weekly resets and exact reset timestamps remain visible with depleted-window blockers', () => {
  const p = payload(); p.snapshot.meters[1].reset_time = '2026-01-08T01:00:00Z';
  p.snapshot.meters[1].remaining_fraction = 0; p.snapshot.pools[0].available = false;
  const dock = linesText(dockLines(p, NOW, 74));
  assert.match(dock, /weekly.*0\.0%.*7d/); assert.match(dock, /weekly depleted/);
  p.snapshot.meters[1].remaining_fraction = .5; p.snapshot.meters[0].remaining_fraction = 0;
  assert.match(linesText(dockLines(p, NOW, 74)), /5h depleted/);
  assert.match(linesText(usageLines(p, NOW, 70)), /2026-01-08T01:00:00Z/);
  assert.match(linesText(usageLines(p, NOW, 70)), /age: 30s/);
  const due = linesText(dockLines(p, NOW + 3600000, 74));
  assert.match(due, /due!/); assert.match(due, /unverified/);
  assertGeometry(dockLines(p, NOW, 74), 74);
});

test('opt-in warnings are local, deduplicated crossings on new fresh observations only', async () => {
  const h = harness();
  try {
    await ready(h); const calls = h.requests.length;
    h.launch('alerts on'); h.render(); await tick(); assert.equal(h.requests.length, calls);
    assert.equal(h.state().alerts.enabled, true);
    function observed(seconds, fraction, extra = {}) {
      const p = payload(); p.snapshot.observed_at = new Date(NOW + seconds * 1000).toISOString();
      p.snapshot.freshness_limit_seconds = 3600;
      p.snapshot.meters[0].remaining_fraction = fraction; Object.assign(p.snapshot, extra); return p;
    }
    async function reload(p) { h.advance(60000); await tick(); h.requests.at(-1).resolve(p); await tick(); h.render(); }
    await reload(observed(60, .09));
    assert.equal(h.state().alerts.sequence, 1); assert.match(textOf(h.render()), /Low quota.*Claude\/GPT 5h.*9\.0%/);
    h.render(); assert.equal(h.state().alerts.sequence, 1);
    await reload(observed(60, .09)); assert.equal(h.state().alerts.sequence, 1);
    await reload(observed(120, .08)); assert.equal(h.state().alerts.sequence, 1);
    await reload(observed(180, .5, { stale: true })); assert.equal(h.state().alerts.sequence, 1);
    await reload(observed(240, .05)); assert.equal(h.state().alerts.sequence, 1);
    await reload(observed(300, .5)); await reload(observed(360, .1)); assert.equal(h.state().alerts.sequence, 2);
    h.launch('alerts off'); h.render(); assert.equal(h.state().alerts.enabled, false);
    await reload(observed(420, .5)); await reload(observed(480, .01)); assert.equal(h.state().alerts.sequence, 2);
    assert.ok(h.requests.every(r => r.args.action === 'status'));
    h.launch(); h.launch(); assert.equal(h.state().alerts.enabled, false);
  } finally { h.dispose(); }
});

test('actual bundled transport reads only a synthetic active-profile cache', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const home = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'agy-widget-fixture-'));
  const previous = process.env.HERMES_HOME; process.env.HERMES_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = previous; await rm(home, { recursive: true, force: true }); });
  const status = await metadataRequest({ action: 'status' });
  assert.equal(status.ok, true); assert.equal(status.snapshot.freshness, 'missing');
  assert.deepEqual(status.snapshot.meters, []);
  assert.deepEqual(await metadataRequest({ action: 'history' }), { ok: true, observations: [], count: 0 });
});

test('alert identity distinguishes new same-clock publications and suppresses unhealthy values', () => {
  const p = payload(); p.snapshot.observation_id = 'fixture-a';
  let alerts = observeAlerts({ enabled: true, levels: {}, notices: [], sequence: 0, lastObserved: null, lastObservationId: null }, p, NOW, true);
  p.snapshot.observation_id = 'fixture-b'; p.snapshot.meters[0].remaining_fraction = .05;
  alerts = observeAlerts(alerts, p, NOW); assert.equal(alerts.sequence, 1);
  assert.equal(observeAlerts(alerts, p, NOW).sequence, 1);
  for (const extra of [{ stale: true }, { freshness: 'error' }, { freshness: 'missing' }, { health: { status: 'error' } }]) {
    const next = payload(); next.snapshot.observation_id = 'fixture-c'; Object.assign(next.snapshot, extra);
    const suppressed = observeAlerts(alerts, next, NOW); assert.equal(suppressed.sequence, 1); assert.deepEqual(suppressed.notices, []);
  }
});
