import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat, writeFile, mkdir, chmod, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const BACKEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateUsage, validateCredits, classifyTransition, buildStatus, poll, readStatus, readHistory, withWriterLock } from '../lib/usage.mjs';

// Every quota value, date, and adapter in this suite is synthetic, not account evidence.
const NOW = '2026-01-01T12:00:00Z';
const clock = () => new Date(NOW);
const ids = ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly'];
function fixture() {
  const bucket = (id, window) => ({ id, window, remaining_fraction: 0.75, reset_time: window === '5h' ? '2026-01-01T17:00:00Z' : '2026-01-08T12:00:00Z' });
  return { status: 'SUCCESS', num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [bucket(ids[0], '5h'), bucket(ids[1], 'weekly')] },
    { name: 'Claude and GPT models', buckets: [bucket(ids[2], '5h'), bucket(ids[3], 'weekly')] },
  ] } } };
}
const adapter = () => async () => ({ stdout: JSON.stringify(fixture()) });
async function scratch(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR || join(BACKEND_ROOT, 'test'), '.fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const snapshot = () => ({ schema_version: 1, observation_id: '11111111-1111-4111-8111-111111111111', observed_at: NOW, buckets: validateUsage(fixture()), transitions: [] });

test('valid complete payload preserves fractions/reset strings and strips identity', () => {
  const payload = fixture(); payload.account = { email: 'synthetic-private-value' };
  const buckets = validateUsage(payload);
  assert.deepEqual(buckets.map(b => b.id), ids);
  assert.equal(buckets[0].remaining_fraction, 0.75);
  assert.equal(buckets[0].reset_time, '2026-01-01T17:00:00Z');
  assert.ok(!JSON.stringify(buckets).includes('synthetic-private-value'));
});

test('inference guard rejects turns, tokens, missing counters, wrong commands/status', () => {
  const mutations = [p => p.num_turns = 1, p => p.usage.input_tokens = 1, p => p.usage.total_tokens = 1,
    p => delete p.usage.thinking_tokens, p => p.usage.extra_tokens = 1, p => p.command.name = 'chat', p => p.status = 'ERROR'];
  for (const mutate of mutations) { const p = fixture(); mutate(p); assert.throws(() => validateUsage(p)); }
});

test('schema rejects duplicate, wrong known pool/window and invalid meters', () => {
  const mutations = [p => p.command.data.groups.push(p.command.data.groups[0]),
    p => p.command.data.groups[0].buckets.push(p.command.data.groups[0].buckets[0]),
    p => p.command.data.groups[0].buckets[0].id = '3p-5h', p => p.command.data.groups[0].buckets[0].window = 'weekly',
    ...[-0.1, 1.1, NaN, Infinity, '0.5', null].map(v => p => p.command.data.groups[0].buckets[0].remaining_fraction = v),
    ...['bad', '2026-02-30T17:00:00Z', '2026-01-01'].map(v => p => p.command.data.groups[0].buckets[0].reset_time = v)];
  for (const mutate of mutations) { const p = fixture(); mutate(p); assert.throws(() => validateUsage(p)); }
});

test('credits accepts observed zero, rejects inference and invented negative credits', () => {
  const p = fixture(); p.command = { name: 'credits', data: { remaining_credits: 0 } };
  assert.deepEqual(validateCredits(p), { remaining_credits: 0 });
  p.command.data.remaining_credits = -1; assert.throws(() => validateCredits(p));
  p.command.data.remaining_credits = 0; p.num_turns = 1; assert.throws(() => validateCredits(p));
});

test('two windows constrain pool eligibility and expired resets require observation', () => {
  const s = snapshot(); s.buckets[1].remaining_fraction = 0;
  const view = buildStatus(s, { status: 'ok', checked_at: NOW, observation_id: s.observation_id }, clock());
  assert.equal(view.pools[0].available, false);
  assert.equal(view.pools[1].available, true);
  assert.equal(view.meters[0].used_percent, 25);
  assert.equal(view.meters[0].approx_remaining_pp_per_hour_to_reset, 15);
  assert.equal(view.meters[1].available, false);
  const expired = buildStatus(s, { status: 'ok', checked_at: NOW, observation_id: s.observation_id }, new Date('2026-01-01T17:00:00Z'));
  assert.equal(expired.stale, true); assert.equal(expired.pools[1].available, false);
  assert.equal(expired.meters[0].reset_due, true);
});

test('cached status labels age, staleness, error and backwards clocks honestly', () => {
  const s = snapshot();
  assert.equal(buildStatus(s, null, clock()).stale, true);
  assert.equal(buildStatus(s, { status: 'ok', checked_at: NOW, observation_id: s.observation_id }, clock()).freshness, 'fresh');
  assert.equal(buildStatus(s, { status: 'ok', checked_at: NOW, observation_id: s.observation_id }, new Date('2026-01-01T12:30:00Z')).freshness, 'stale');
  const failed = buildStatus(s, { status: 'error', checked_at: NOW, code: 'BACKEND_FAILED' }, clock());
  assert.equal(failed.freshness, 'error'); assert.equal(failed.meters[0].remaining_percent, 75);
  assert.equal(failed.pools[0].available, false);
  assert.equal(buildStatus(s, { status: 'ok', checked_at: NOW, observation_id: s.observation_id }, new Date('2026-01-01T11:59:00Z')).stale, true);
});

test('reset boundaries are distinct from meter increases and early anchor changes', () => {
  const before = { remaining_fraction: 0.2, reset_time: '2026-01-01T17:00:00Z' };
  const increased = { ...before, remaining_fraction: 0.3 };
  assert.equal(classifyTransition(before, increased, NOW, '2026-01-01T13:00:00Z').kind, 'meter_increase_drift');
  const changed = { ...increased, reset_time: '2026-01-01T22:00:00Z' };
  assert.equal(classifyTransition(before, changed, NOW, '2026-01-01T16:59:59Z').kind, 'anchor_change');
  assert.equal(classifyTransition(before, changed, NOW, '2026-01-01T17:00:00Z').kind, 'reset_boundary_observed');
  assert.equal(classifyTransition(before, before, NOW, '2026-01-01T17:00:00Z').kind, 'unchanged');
});

test('poll uses only guarded literal arguments and publishes private sanitized history/latest', async t => {
  const dir = await scratch(t); const calls = [];
  const execute = async (bin, args, opts) => { calls.push({ bin, args, opts }); const p = fixture(); p.secret = 'synthetic-secret'; return { stdout: JSON.stringify(p) }; };
  const result = await poll({ stateDir: dir, agyBin: '/synthetic/fake-agy', execute, clock });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, ['--output-format', 'json', '--print-timeout', '11s', '-p', '/usage']);
  assert.equal(calls[0].opts.shell, false); assert.equal(calls[0].opts.timeout, 12000); assert.equal(calls[0].opts.maxBuffer, 1024 * 1024);
  const latest = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8'));
  assert.ok(!JSON.stringify(latest).includes('synthetic-secret'));
  const history = await readHistory(dir, 10); assert.equal(history.length, 1); assert.deepEqual(history[0], latest);
  for (const path of [dir, join(dir, 'history'), join(dir, 'writers')]) assert.equal((await stat(path)).mode & 0o777, 0o700);
  for (const path of [join(dir, 'latest.json'), join(dir, 'health.json'), join(dir, 'history/2026-01-01.jsonl')]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readStatus(dir, { clock })).freshness, 'fresh');
});

test('failed polls retain last good snapshot without persisting backend secrets', async t => {
  const dir = await scratch(t); await poll({ stateDir: dir, execute: adapter(), clock });
  const before = await readFile(join(dir, 'latest.json'), 'utf8');
  for (const execute of [async () => { throw new Error('synthetic-password'); }, async () => ({ stdout: 'synthetic-password' }), async () => { const p = fixture(); p.num_turns = 1; return { stdout: JSON.stringify(p) }; }]) {
    const failure = await poll({ stateDir: dir, execute, clock }); assert.equal(failure.ok, false);
    assert.equal(await readFile(join(dir, 'latest.json'), 'utf8'), before);
    const health = await readFile(join(dir, 'health.json'), 'utf8'); assert.ok(!health.includes('synthetic-password'));
    assert.equal((await readStatus(dir, { clock })).freshness, 'error');
  }
  assert.equal((await readHistory(dir, 10)).length, 1);
});

test('first failure reports unknown allowances, not invented zeros', async t => {
  const dir = await scratch(t); await poll({ stateDir: dir, execute: async () => { throw new Error('offline'); }, clock });
  const view = await readStatus(dir, { clock }); assert.equal(view.freshness, 'error'); assert.equal(view.observed_at, null); assert.deepEqual(view.meters, []);
});

test('optional credits probe must also pass zero-inference guard', async t => {
  const dir = await scratch(t); let count = 0;
  const execute = async (_bin, args) => { count++; const p = fixture(); if (args.at(-1) === '/credits') p.command = { name: 'credits', data: { remaining_credits: 0 } }; return { stdout: JSON.stringify(p) }; };
  assert.equal((await poll({ stateDir: dir, execute, clock, credits: true })).ok, true);
  assert.equal(count, 2); assert.equal((await readStatus(dir, { clock })).credits.remaining_credits, 0);
});

test('live writers serialize; dead unique writer tickets recover without stealing a live ticket', async t => {
  const dir = await scratch(t); await mkdir(join(dir, 'writers'), { mode: 0o700 });
  await writeFile(join(dir, 'writers/writer-99999999-dead.json'), JSON.stringify({ pid: 99999999, choosing: true, ticket: 0 }), { mode: 0o600 });
  let active = 0, peak = 0;
  const execute = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 15)); active--; return { stdout: JSON.stringify(fixture()) }; };
  const results = await Promise.all(Array.from({ length: 5 }, () => poll({ stateDir: dir, execute, clock })));
  assert.ok(results.every(r => r.ok)); assert.equal(peak, 1); assert.equal((await readHistory(dir, 20)).length, 5);
  assert.deepEqual(await readdir(join(dir, 'writers')), []);
  await withWriterLock(dir, async () => {
    await assert.rejects(withWriterLock(dir, async () => assert.fail('stole live writer'), { lockTimeoutMs: 50 }), /LOCK_BUSY/);
    assert.equal((await readdir(join(dir, 'writers'))).filter(n => n.endsWith('.json')).length, 1);
  });
});

test('history spans daily files, is newest first and contains only collected observations', async t => {
  const dir = await scratch(t);
  await poll({ stateDir: dir, execute: adapter(), clock });
  await poll({ stateDir: dir, execute: adapter(), clock: () => new Date('2026-01-02T12:00:00Z') });
  const rows = await readHistory(dir, 1); assert.equal(rows.length, 1); assert.equal(rows[0].observed_at, '2026-01-02T12:00:00.000Z');
  assert.equal((await readHistory(dir, 20)).length, 2);
});

test('one pool reset deadline does not idle the other independent pool', () => {
  const s = snapshot(); s.buckets[2].reset_time = '2026-01-01T12:00:00Z';
  const view = buildStatus(s, { status: 'ok', checked_at: NOW, observation_id: s.observation_id }, clock());
  assert.equal(view.freshness, 'stale'); assert.equal(view.pools[0].available, true); assert.equal(view.pools[1].available, false);
});

test('equivalent timestamp formatting is not an anchor change', () => {
  const before = { remaining_fraction: 0.2, reset_time: '2026-01-01T17:00:00Z' };
  assert.equal(classifyTransition(before, { ...before, reset_time: '2026-01-01T18:00:00+01:00' }, NOW, NOW).kind, 'unchanged');
});

test('clock regression fails collection and keeps the prior snapshot', async t => {
  const dir = await scratch(t); await poll({ stateDir: dir, execute: adapter(), clock });
  const before = await readFile(join(dir, 'latest.json'), 'utf8');
  const result = await poll({ stateDir: dir, execute: adapter(), clock: () => new Date('2026-01-01T11:59:00Z') });
  assert.equal(result.code, 'CLOCK_REGRESSION'); assert.equal(await readFile(join(dir, 'latest.json'), 'utf8'), before);
  assert.equal((await readHistory(dir)).length, 1);
});

test('state-directory and latest-file symlinks are refused without following targets', async t => {
  const dir = await scratch(t); const target = join(dir, 'target'), link = join(dir, 'link'); await mkdir(target);
  await poll({ stateDir: target, execute: adapter(), clock }); await symlink(target, link);
  assert.equal((await readStatus(link, { clock })).freshness, 'error');
  let called = false;
  assert.equal((await poll({ stateDir: link, clock, execute: async () => { called = true; return adapter()(); } })).ok, false);
  assert.equal(called, false);
  await symlink(join(target, 'latest.json'), join(dir, 'latest.json'));
  assert.equal((await readStatus(dir, { clock })).freshness, 'error');
});

test('actual process exit leaves a reclaimable dead writer ticket', async t => {
  const dir = await scratch(t); const run = promisify(execFile); const moduleURL = new URL('../lib/usage.mjs', import.meta.url).href;
  await run(process.execPath, ['--input-type=module', '-e', `import { withWriterLock } from ${JSON.stringify(moduleURL)}; await withWriterLock(${JSON.stringify(dir)}, async () => process.exit(0));`]);
  assert.equal((await readdir(join(dir, 'writers'))).filter(n => n.endsWith('.json')).length, 1);
  assert.equal((await poll({ stateDir: dir, execute: adapter(), clock })).ok, true);
  assert.deepEqual(await readdir(join(dir, 'writers')), []);
});

test('CLI subprocess refresh/credits and concurrent collectors use a synthetic executable safely', async t => {
  const dir = await scratch(t), stateDir = join(dir, 'state'), fake = join(dir, 'synthetic agy.mjs'), calls = join(dir, 'calls.jsonl'), active = join(dir, 'active');
  const p = fixture(); p.command.data.groups.forEach(g => g.buckets.forEach(b => { b.reset_time = '2099-01-01T12:00:00Z'; }));
  await writeFile(fake, `#!${process.execPath}\nimport { open, unlink, appendFile } from 'node:fs/promises';\nconst active = ${JSON.stringify(active)};\nconst lock = await open(active, 'wx');\nawait appendFile(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');\nawait new Promise(r => setTimeout(r, 30));\nconst p = ${JSON.stringify(p)};\nif(process.argv.at(-1)==='/credits') p.command={name:'credits',data:{remaining_credits:0}};\nawait lock.close(); await unlink(active); console.log(JSON.stringify(p));\n`); await chmod(fake, 0o700);
  const run = promisify(execFile), cli = join(BACKEND_ROOT, 'bin/agy-usage.mjs');
  const invoke = command => run(process.execPath, [cli, command, '--json', '--state-dir', stateDir, '--agy-bin', fake]);
  const first = await run(process.execPath, [cli, 'refresh', '--credits', '--json', '--state-dir', stateDir, '--agy-bin', fake]);
  const view = JSON.parse(first.stdout); assert.equal(view.freshness, 'fresh'); assert.equal(view.credits.remaining_credits, 0);
  const results = await Promise.all(Array.from({ length: 4 }, () => invoke('poll'))); assert.ok(results.every(r => JSON.parse(r.stdout).ok));
  assert.equal((await readHistory(stateDir, 20)).length, 5);
  const invocations = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(invocations.length, 6);
  assert.ok(invocations.every(args => args.slice(0, -1).join(' ') === '--output-format json --print-timeout 11s -p'));
  const last = await readFile(join(stateDir, 'latest.json'), 'utf8');
  await writeFile(fake, `#!${process.execPath}\nconsole.error('synthetic-private-error'); process.exit(3);\n`); await chmod(fake, 0o700);
  await assert.rejects(invoke('refresh'), error => { const failed = JSON.parse(error.stdout); assert.equal(failed.freshness, 'error'); assert.ok(!error.stdout.includes('synthetic-private-error')); return error.code === 1; });
  assert.equal(await readFile(join(stateDir, 'latest.json'), 'utf8'), last);
});

test('publication IDs prevent same-timestamp mismatches from appearing fresh', async t => {
  const dir = await scratch(t); await poll({ stateDir: dir, execute: adapter(), clock });
  const first = JSON.parse(await readFile(join(dir, 'health.json'), 'utf8'));
  await poll({ stateDir: dir, execute: adapter(), clock });
  const second = JSON.parse(await readFile(join(dir, 'health.json'), 'utf8'));
  assert.equal(first.checked_at, second.checked_at); assert.notEqual(first.observation_id, second.observation_id);
  await writeFile(join(dir, 'health.json'), JSON.stringify(first));
  const view = await readStatus(dir, { clock }); assert.equal(view.freshness, 'stale'); assert.ok(view.pools.every(p => !p.available));
});

test('invalid optional credits cannot publish a partial successful usage observation', async t => {
  const dir = await scratch(t); await poll({ stateDir: dir, execute: adapter(), clock });
  const before = await readFile(join(dir, 'latest.json'), 'utf8');
  const execute = async (_bin, args) => { const p = fixture(); if (args.at(-1) === '/credits') { p.command = { name: 'credits', data: { remaining_credits: 2 } }; p.usage.output_tokens = 1; } return { stdout: JSON.stringify(p) }; };
  const result = await poll({ stateDir: dir, execute, clock, credits: true });
  assert.equal(result.code, 'INFERENCE_GUARD'); assert.equal(await readFile(join(dir, 'latest.json'), 'utf8'), before);
  assert.equal((await readHistory(dir)).length, 1); assert.equal((await readStatus(dir, { clock })).freshness, 'error');
});

test('corrupt persisted state produces a sanitized error, never false fresh allowances', async t => {
  const dir = await scratch(t); await poll({ stateDir: dir, execute: adapter(), clock });
  const latest = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')); latest.buckets[0].remaining_fraction = 'malformed'; latest.account = 'synthetic-private-value';
  await writeFile(join(dir, 'latest.json'), JSON.stringify(latest));
  const view = await readStatus(dir, { clock }); assert.equal(view.freshness, 'error'); assert.deepEqual(view.meters, []);
  assert.ok(!JSON.stringify(view).includes('synthetic-private-value'));
  assert.equal((await poll({ stateDir: dir, execute: adapter(), clock })).ok, false);
  await writeFile(join(dir, 'history/2026-01-01.jsonl'), 'synthetic-invalid-json\n');
  await assert.rejects(readHistory(dir), /STATE_INVALID/);
});

test('CLI help/status/history do not invoke backend; unknown flags cannot become prompts', async t => {
  const dir = await scratch(t); const run = promisify(execFile); const cli = join(BACKEND_ROOT, 'bin/agy-usage.mjs');
  const invoke = args => run(process.execPath, [cli, ...args], { cwd: resolve('.') });
  assert.match((await invoke(['--help'])).stdout, /refresh/);
  const view = JSON.parse((await invoke(['status', '--json', '--state-dir', dir, '--agy-bin', '/synthetic/missing'])).stdout);
  assert.equal(view.freshness, 'missing'); assert.deepEqual(view.meters, []);
  assert.deepEqual(JSON.parse((await invoke(['history', '--json', '--state-dir', dir])).stdout), []);
  await assert.rejects(invoke(['--dangerously-skip-permissions']), e => e.code === 2);
});

test('partial pools publish unknown missing IDs without blocking an independent pool', async t => {
  const dir = await scratch(t);
  for (const mutate of [p => p.command.data.groups.pop(), p => p.command.data.groups[1].buckets.pop()]) {
    const p = fixture(); mutate(p);
    assert.equal((await poll({ stateDir: dir, execute: async () => ({ stdout: JSON.stringify(p) }), clock })).ok, true);
    const view = await readStatus(dir, { clock });
    assert.equal(view.pools[0].available, true); assert.equal(view.pools[1].available, false);
    assert.ok(view.pools[1].missing_ids.includes('3p-weekly'));
    assert.ok(view.pools[1].constrained_by.includes('3p-weekly'));
    assert.equal(view.meters.find(m => m.id === '3p-weekly'), undefined);
    assert.equal(view.freshness, 'fresh');
    assert.ok(view.pools.every(pool => !Object.hasOwn(pool, 'model')));
  }
  assert.equal((await readHistory(dir)).length, 2);
});

test('empty known observations are unknown rather than fabricated zero quotas', async t => {
  const dir = await scratch(t), p = fixture(); p.command.data.groups = [];
  assert.equal((await poll({ stateDir: dir, execute: async () => ({ stdout: JSON.stringify(p) }), clock })).ok, true);
  const view = await readStatus(dir, { clock });
  assert.deepEqual(view.meters, []); assert.ok(view.pools.every(pool => !pool.available));
  assert.deepEqual(view.pools.flatMap(pool => pool.missing_ids), ids);
});

test('disabled group or bucket is unavailable, preserves reported values and roundtrips privately', async t => {
  const dir = await scratch(t), p = fixture();
  p.command.data.groups[0].buckets[1].enabled = false;
  delete p.command.data.groups[0].buckets[1].remaining_fraction;
  delete p.command.data.groups[0].buckets[1].reset_time;
  const execute = async () => ({ stdout: JSON.stringify(p) });
  assert.equal((await poll({ stateDir: dir, execute, clock })).ok, true);
  const view = await readStatus(dir, { clock });
  const disabled = view.meters.find(m => m.id === 'gemini-weekly');
  assert.equal(disabled.remaining_fraction, null); assert.equal(disabled.reset_time, null);
  assert.equal(disabled.available, false); assert.equal(disabled.disabled, true);
  assert.equal(view.pools[0].available, false); assert.equal(view.pools[1].available, true);
  assert.deepEqual((await readHistory(dir))[0].buckets, JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')).buckets);
  p.command.data.groups[0].disabled = true;
  assert.equal((await poll({ stateDir: dir, execute, clock })).ok, true);
  assert.equal((await readStatus(dir, { clock })).meters[0].remaining_fraction, 0.75);
  p.command.data.groups[0] = { name: 'Gemini Models', disabled: true };
  assert.equal((await poll({ stateDir: dir, execute, clock })).ok, true);
  const groupView = await readStatus(dir, { clock });
  assert.equal(groupView.pools[1].available, true); assert.equal(groupView.pools[0].available, false);
  assert.ok(groupView.meters.filter(m => m.group === 'Gemini Models').every(m => m.remaining_fraction === null && !m.available));
});

test('unknown extras are ignored with explicit sanitized warnings, not missing independent quotas', async t => {
  const dir = await scratch(t), p = fixture();
  p.command.data.groups.push({ name: 'synthetic-private-extra', buckets: [{ id: 'synthetic-private-id', remaining_fraction: 'ignored' }] });
  p.command.data.groups[0].buckets.push({ id: 'synthetic-extra-window' });
  const result = await poll({ stateDir: dir, execute: async () => ({ stdout: JSON.stringify(p) }), clock });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, ['UNKNOWN_GROUP_IGNORED', 'UNKNOWN_BUCKET_IGNORED']);
  const view = await readStatus(dir, { clock });
  assert.deepEqual(view.meters.map(m => m.id), ids); assert.ok(view.pools.every(pool => pool.available));
  assert.deepEqual(view.warnings, ['UNKNOWN_GROUP_IGNORED', 'UNKNOWN_BUCKET_IGNORED']);
  assert.ok(!JSON.stringify(await readHistory(dir)).includes('synthetic-private'));
});

test('disabled known meters cannot hide malformed supplied values or duplicate identities', () => {
  const mutations = [p => p.command.data.groups[0].buckets[0].remaining_fraction = '0.5',
    p => p.command.data.groups[0].buckets[0].reset_time = 'bad',
    p => p.command.data.groups[0].buckets[0].disabled = 'true',
    p => p.command.data.groups[1].buckets.push(p.command.data.groups[0].buckets[0]),
    p => p.command.data.groups.push({ name: 'synthetic-extra', buckets: [p.command.data.groups[0].buckets[0]] })];
  for (const mutate of mutations) { const p = fixture(); p.command.data.groups[0].disabled = true; mutate(p); assert.throws(() => validateUsage(p)); }
});

test('re-enabled quota readings start a new transition without inventing a refill', async t => {
  const dir = await scratch(t), p = fixture(); p.command.data.groups[0].buckets[0] = { id: 'gemini-5h', window: '5h', disabled: true };
  assert.equal((await poll({ stateDir: dir, execute: async () => ({ stdout: JSON.stringify(p) }), clock })).ok, true);
  assert.equal((await poll({ stateDir: dir, execute: adapter(), clock })).ok, true);
  const view = await readStatus(dir, { clock });
  assert.equal(view.transitions.find(item => item.id === 'gemini-5h').kind, 'initial');
});

test('no-O_NOFOLLOW fallback checks regular files and refuses read/append symlinks before I/O', async t => {
  const { openStateFile } = await import('../lib/usage.mjs');
  const { constants } = await import('node:fs');
  const dir = await scratch(t), target = join(dir, 'target'), link = join(dir, 'link');
  await writeFile(target, 'synthetic-protected'); await symlink(target, link);
  const file = await openStateFile(target, constants.O_RDONLY, undefined, 0);
  try { assert.equal(await file.readFile('utf8'), 'synthetic-protected'); } finally { await file.close(); }
  await assert.rejects(openStateFile(link, constants.O_RDONLY, undefined, 0), /STATE_INVALID/);
  await assert.rejects(openStateFile(link, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600, 0), /STATE_INVALID/);
  assert.equal(await readFile(target, 'utf8'), 'synthetic-protected');
});

test('rapid live ticket publications do not cause false corrupt-state failures', async t => {
  const dir = await scratch(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => poll({ stateDir: dir, execute: adapter(), clock })));
  assert.ok(results.every(result => result.ok), JSON.stringify(results));
  assert.equal((await readHistory(dir, 100)).length, 20);
  assert.deepEqual(await readdir(join(dir, 'writers')), []);
});

test('text status/history keep disabled missing observations unknown, not zero', async t => {
  const { formatStatus } = await import('../lib/usage.mjs');
  const dir = await scratch(t), p = fixture(); p.command.data.groups[0] = { name: 'Gemini Models', enabled: false };
  assert.equal((await poll({ stateDir: dir, execute: async () => ({ stdout: JSON.stringify(p) }), clock })).ok, true);
  const text = formatStatus(await readStatus(dir, { clock }));
  assert.match(text, /gemini-5h: used unknown%, remaining unknown%/);
  assert.match(text, /non-predictive/);
  const run = promisify(execFile);
  const history = await run(process.execPath, [join(BACKEND_ROOT, 'bin/agy-usage.mjs'), 'history', '--state-dir', dir]);
  assert.match(history.stdout, /gemini-5h: unknown remaining, reset unknown \(disabled\)/);
});

test('call-time default profile and public metadata envelopes do not collect', async t => {
  const { defaultStateDir } = await import('../lib/usage.mjs');
  const dir = await scratch(t), run = promisify(execFile), cli = join(BACKEND_ROOT, 'bin/agy-usage.mjs');
  const previous = process.env.HERMES_HOME;
  try {
    process.env.HERMES_HOME = join(dir, 'profile-a');
    assert.equal(defaultStateDir(), join(dir, 'profile-a', 'plugin-data', 'antigravity-oauth-plus', 'quota'));
    process.env.HERMES_HOME = join(dir, 'profile-b');
    assert.equal(defaultStateDir(), join(dir, 'profile-b', 'plugin-data', 'antigravity-oauth-plus', 'quota'));
    const status = JSON.parse((await run(process.execPath, [cli, 'status', '--json', '--envelope'])).stdout);
    assert.equal(status.ok, true); assert.equal(status.snapshot.freshness, 'missing');
    assert.deepEqual(JSON.parse((await run(process.execPath, [cli, 'history', '--json', '--envelope'])).stdout), { ok: true, observations: [], count: 0 });
  } finally { if (previous === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = previous; }
});
