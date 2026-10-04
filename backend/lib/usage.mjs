import { constants } from 'node:fs';
import { mkdir, chmod, lstat, open, rename, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export function defaultStateDir() {
  return join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'plugin-data', 'antigravity-oauth-plus', 'quota');
}
// Compatibility export; public callers resolve defaultStateDir() at call time.
export const DEFAULT_STATE_DIR = defaultStateDir();
export const FRESHNESS_MS = 30 * 60 * 1000;
function runFile(bin, args, options) {
  return new Promise((resolve, reject) => {
    let child;
    const stop = () => { child?.kill('SIGKILL'); process.exit(1); };
    const cleanup = () => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); };
    child = execFile(bin, args, options, (error, stdout, stderr) => {
      cleanup(); if (error) reject(error); else resolve({ stdout, stderr });
    });
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  });
}
const GROUPS = { 'Gemini Models': ['gemini-5h', 'gemini-weekly'], 'Claude and GPT models': ['3p-5h', '3p-weekly'] };
const IDS = Object.values(GROUPS).flat();
const WARNINGS = ['UNKNOWN_GROUP_IGNORED', 'UNKNOWN_BUCKET_IGNORED'];
const TOKENS = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'];
const CODES = new Set(['BACKEND_FAILED', 'INVALID_JSON', 'INFERENCE_GUARD', 'INVALID_SCHEMA', 'STATE_INVALID', 'STATE_IO', 'LOCK_BUSY', 'CLOCK_REGRESSION']);
const KINDS = new Set(['initial', 'unavailable', 'reset_boundary_observed', 'anchor_change', 'meter_increase_drift', 'meter_decrease', 'unchanged']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fraction = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const codeOf = error => CODES.has(error?.code) ? error.code : 'STATE_IO';
function timestamp(value) {
  if (typeof value !== 'string') fail('INVALID_SCHEMA');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m || !Number.isFinite(Date.parse(value))) fail('INVALID_SCHEMA');
  const [, y, mo, d, h, mi, s, zone] = m;
  const date = new Date(0); date.setUTCFullYear(+y, +mo - 1, +d);
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59 || (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) fail('INVALID_SCHEMA');
  return Date.parse(value);
}
function guard(payload, name) {
  if (!record(payload) || payload.status !== 'SUCCESS' || payload.command?.name !== name || payload.num_turns !== 0 || !record(payload.usage)) fail('INFERENCE_GUARD');
  if (TOKENS.some(key => payload.usage[key] !== 0) || Object.entries(payload.usage).some(([key, value]) => /tokens/i.test(key) && value !== 0)) fail('INFERENCE_GUARD');
}
function disabledFlag(value) {
  for (const key of ['disabled', 'enabled']) if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') fail('INVALID_SCHEMA');
  return value.disabled === true || value.enabled === false;
}
export function validateUsage(payload) {
  guard(payload, 'usage');
  const groups = payload.command.data?.groups;
  if (!Array.isArray(groups)) fail('INVALID_SCHEMA');
  const buckets = [], seenGroups = new Set(), seenIDs = new Set(), warnings = new Set();
  for (const group of groups) {
    if (!record(group) || typeof group.name !== 'string' || seenGroups.has(group.name)) fail('INVALID_SCHEMA');
    seenGroups.add(group.name);
    const known = Object.hasOwn(GROUPS, group.name);
    const disabled = known ? disabledFlag(group) : false;
    if (!known) warnings.add('UNKNOWN_GROUP_IGNORED');
    if (group.buckets !== undefined && !Array.isArray(group.buckets)) fail('INVALID_SCHEMA');
    if (known && !disabled && !Array.isArray(group.buckets)) fail('INVALID_SCHEMA');
    for (const bucket of group.buckets ?? []) {
      if (!record(bucket) || typeof bucket.id !== 'string' || seenIDs.has(bucket.id)) fail('INVALID_SCHEMA');
      seenIDs.add(bucket.id);
      if (!IDS.includes(bucket.id)) { warnings.add('UNKNOWN_BUCKET_IGNORED'); continue; }
      if (!known || !GROUPS[group.name].includes(bucket.id)) fail('INVALID_SCHEMA');
      const bucketDisabled = disabledFlag(bucket) || disabled;
      const window = bucket.id.endsWith('5h') ? '5h' : 'weekly';
      if (bucket.window !== window && !(bucketDisabled && bucket.window === undefined)) fail('INVALID_SCHEMA');
      // Disabled meters may omit observations; supplied values must still be valid.
      const remaining = bucket.remaining_fraction ?? null, reset = bucket.reset_time ?? null;
      if ((!bucketDisabled || remaining !== null) && !fraction(remaining)) fail('INVALID_SCHEMA');
      if (!bucketDisabled || reset !== null) timestamp(reset);
      buckets.push({ id: bucket.id, group: group.name, window, remaining_fraction: remaining, reset_time: reset, ...(bucketDisabled ? { disabled: true } : {}) });
    }
    if (disabled) {
      for (const id of GROUPS[group.name]) if (!buckets.some(bucket => bucket.id === id)) {
        buckets.push({ id, group: group.name, window: id.endsWith('5h') ? '5h' : 'weekly', remaining_fraction: null, reset_time: null, disabled: true });
      }
    }
  }
  const result = IDS.map(id => buckets.find(bucket => bucket.id === id)).filter(Boolean);
  // Preserve the collector's array API; callers explicitly publish sanitized warnings.
  Object.defineProperty(result, 'warnings', { value: WARNINGS.filter(code => warnings.has(code)) });
  return result;
}
export function validateCredits(payload) {
  guard(payload, 'credits');
  const value = payload.command.data?.remaining_credits;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('INVALID_SCHEMA');
  return { remaining_credits: value };
}
export function classifyTransition(before, after, previousAt, observedAt) {
  if (after.disabled) return { kind: 'unavailable', remaining_delta_pp: null };
  if (!before || before.disabled) return { kind: 'initial', remaining_delta_pp: null };
  const oldReset = timestamp(before.reset_time), currentReset = timestamp(after.reset_time);
  const now = timestamp(observedAt), previous = timestamp(previousAt);
  const changed = oldReset !== currentReset;
  const delta = (after.remaining_fraction - before.remaining_fraction) * 100;
  const kind = changed && currentReset > oldReset && previous < oldReset && now >= oldReset ? 'reset_boundary_observed'
    : changed ? 'anchor_change' : delta > 0 ? 'meter_increase_drift' : delta < 0 ? 'meter_decrease' : 'unchanged';
  return { kind, remaining_delta_pp: delta, previous_reset_time: before.reset_time };
}
function sanitizeSnapshot(value) {
  if (!record(value) || value.schema_version !== 1 || !Array.isArray(value.buckets) || !/^[a-f0-9-]{36}$/.test(value.observation_id)) fail('STATE_INVALID');
  timestamp(value.observed_at);
  if (value.buckets.some(bucket => !record(bucket) || !IDS.includes(bucket.id) || !Object.hasOwn(GROUPS, bucket.group) || !GROUPS[bucket.group].includes(bucket.id))) fail('STATE_INVALID');
  const groups = Object.keys(GROUPS).map(name => ({ name, buckets: value.buckets.filter(b => b?.group === name) }));
  const buckets = validateUsage({ status: 'SUCCESS', num_turns: 0, usage: Object.fromEntries(TOKENS.map(key => [key, 0])), command: { name: 'usage', data: { groups } } });
  const seenTransitions = new Set();
  const transitions = (value.transitions ?? []).map(item => {
    if (!record(item) || seenTransitions.has(item.id) || !buckets.some(b => b.id === item.id) || !KINDS.has(item.kind) || (item.remaining_delta_pp !== null && !Number.isFinite(item.remaining_delta_pp))) fail('STATE_INVALID');
    seenTransitions.add(item.id);
    const clean = { id: item.id, kind: item.kind, remaining_delta_pp: item.remaining_delta_pp };
    if (item.previous_reset_time !== undefined) { timestamp(item.previous_reset_time); clean.previous_reset_time = item.previous_reset_time; }
    return clean;
  });
  const clean = { schema_version: 1, observation_id: value.observation_id, observed_at: value.observed_at, buckets, transitions };
  if (value.warnings !== undefined) {
    if (!Array.isArray(value.warnings) || value.warnings.some(code => !WARNINGS.includes(code))) fail('STATE_INVALID');
    clean.warnings = WARNINGS.filter(code => value.warnings.includes(code));
  }
  if (value.credits) clean.credits = validateCredits({ status: 'SUCCESS', num_turns: 0, usage: Object.fromEntries(TOKENS.map(key => [key, 0])), command: { name: 'credits', data: value.credits } });
  return clean;
}
function checkedNow(clock) {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('CLOCK_REGRESSION');
  return now;
}
async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('STATE_INVALID');
  await chmod(path, 0o700);
}
async function readableDir(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('STATE_INVALID');
}
// Check before open and again against the opened descriptor, even without O_NOFOLLOW.
// No data read, append or chmod occurs until these checks complete. State ancestors
// must remain private/trusted; this is not an adversarial filesystem sandbox.
export async function openStateFile(path, flags, mode, noFollow = constants.O_NOFOLLOW ?? 0) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let before;
    try { before = await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before && (!before.isFile() || before.isSymbolicLink())) fail('STATE_INVALID');
    const file = await open(path, flags | noFollow, mode);
    try {
      const opened = await file.stat(), after = await lstat(path);
      if (!opened.isFile() || !after.isFile() || after.isSymbolicLink()) fail('STATE_INVALID');
      const changed = opened.dev !== after.dev || opened.ino !== after.ino ||
        (before && (before.dev !== opened.dev || before.ino !== opened.ino));
      if (!changed) return file;
      // Atomic ticket/latest replacement is legitimate: retry read-only races.
      // Appending to a replaced inode remains an error; never write before checks.
      if (flags !== constants.O_RDONLY) fail('STATE_INVALID');
    } catch (error) { await file.close(); throw error; }
    await file.close();
  }
  fail('STATE_INVALID');
}
async function readText(path) {
  let file;
  try {
    file = await openStateFile(path, constants.O_RDONLY);
    return await file.readFile('utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await file?.close(); }
}
async function readJSON(path) {
  const text = await readText(path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { fail('STATE_INVALID'); }
}
async function atomicJSON(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); await file.close(); file = null;
    await rename(temp, path);
  } finally { await file?.close(); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

// Lamport bakery tickets avoid unsafe check-then-unlink reclamation of a shared lock.
// A unique filename is never reused: only that dead owner's ticket can be removed.
export async function withWriterLock(stateDir, action, { lockTimeoutMs = 10000 } = {}) {
  await privateDir(stateDir); const dir = join(stateDir, 'writers'); await privateDir(dir);
  const own = `writer-${process.pid}-${randomUUID()}.json`, path = join(dir, own);
  const deadline = performance.now() + lockTimeoutMs;
  const participants = async () => {
    const result = [];
    for (const name of await readdir(dir)) {
      const match = /^writer-(\d+)-[a-zA-Z0-9-]+\.json$/.exec(name); if (!match) continue;
      const pid = Number(match[1]), target = join(dir, name);
      if (!Number.isSafeInteger(pid) || pid <= 0) fail('STATE_INVALID');
      if (!alive(pid)) { await unlink(target).catch(e => { if (e.code !== 'ENOENT') throw e; }); continue; }
      const entry = await readJSON(target); if (entry === null) continue;
      if (entry.pid !== pid || typeof entry.choosing !== 'boolean' || !Number.isSafeInteger(entry.ticket) || entry.ticket < 0 || (!entry.choosing && entry.ticket === 0)) fail('STATE_INVALID');
      result.push({ name, pid, choosing: entry.choosing, ticket: entry.ticket });
    }
    return result;
  };
  try {
    await atomicJSON(path, { pid: process.pid, choosing: true, ticket: 0 });
    const ticket = 1 + Math.max(0, ...(await participants()).map(p => p.ticket));
    if (!Number.isSafeInteger(ticket)) fail('STATE_INVALID');
    await atomicJSON(path, { pid: process.pid, choosing: false, ticket });
    for (;;) {
      const waiting = (await participants()).some(p => p.name !== own && (p.choosing || p.ticket < ticket || (p.ticket === ticket && p.name < own)));
      if (!waiting) break;
      if (performance.now() >= deadline) fail('LOCK_BUSY');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return await action();
  } finally { await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function probe(agyBin, name, execute) {
  if (!['usage', 'credits'].includes(name)) fail('INFERENCE_GUARD');
  const args = ['--output-format', 'json', '--print-timeout', '11s', '-p', `/${name}`];
  let stdout;
  try { ({ stdout } = await execute(agyBin, args, { shell: false, timeout: 12000, maxBuffer: 1024 * 1024, encoding: 'utf8', killSignal: 'SIGKILL' })); }
  catch { fail('BACKEND_FAILED'); }
  try { return JSON.parse(stdout); } catch { fail('INVALID_JSON'); }
}
export async function poll({ stateDir = defaultStateDir(), agyBin = 'agy', execute = runFile, clock = () => new Date(), credits = false, lockTimeoutMs = 1500 } = {}) {
  try {
    return await withWriterLock(stateDir, async () => {
      try {
        const priorRaw = await readJSON(join(stateDir, 'latest.json'));
        const prior = priorRaw ? sanitizeSnapshot(priorRaw) : null;
        const buckets = validateUsage(await probe(agyBin, 'usage', execute));
        const creditData = credits ? validateCredits(await probe(agyBin, 'credits', execute)) : null;
        const observed_at = checkedNow(clock).toISOString();
        if (prior && timestamp(observed_at) < timestamp(prior.observed_at)) fail('CLOCK_REGRESSION');
        const snapshot = { schema_version: 1, observation_id: randomUUID(), observed_at, buckets, transitions: buckets.map(bucket => ({ id: bucket.id, ...classifyTransition(prior?.buckets.find(b => b.id === bucket.id), bucket, prior?.observed_at, observed_at) })) };
        if (buckets.warnings.length) snapshot.warnings = buckets.warnings;
        if (creditData) snapshot.credits = creditData;
        const historyDir = join(stateDir, 'history'); await privateDir(historyDir);
        const file = await openStateFile(join(historyDir, `${observed_at.slice(0, 10)}.jsonl`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
        try { await file.chmod(0o600); await file.writeFile(`${JSON.stringify(snapshot)}\n`); await file.sync(); } finally { await file.close(); }
        await atomicJSON(join(stateDir, 'health.json'), { status: 'ok', checked_at: observed_at, observation_id: snapshot.observation_id });
        await atomicJSON(join(stateDir, 'latest.json'), snapshot);
        return { ok: true, observed_at, ...(snapshot.warnings ? { warnings: snapshot.warnings } : {}) };
      } catch (error) {
        const code = codeOf(error);
        await atomicJSON(join(stateDir, 'health.json'), { status: 'error', checked_at: checkedNow(clock).toISOString(), code });
        return { ok: false, code };
      }
    }, { lockTimeoutMs });
  } catch (error) { return { ok: false, code: codeOf(error) }; }
}
export function buildStatus(snapshot, health, now = new Date()) {
  const observed_at = snapshot?.observed_at ?? null;
  const age = snapshot ? (now.getTime() - timestamp(observed_at)) / 1000 : null;
  const resetDue = snapshot?.buckets.some(b => !b.disabled && b.reset_time !== null && timestamp(b.reset_time) <= now.getTime()) ?? false;
  const healthMatches = health?.status === 'ok' && health.checked_at === observed_at && health.observation_id === snapshot?.observation_id;
  const cacheStale = !snapshot || !healthMatches || age < 0 || age >= FRESHNESS_MS / 1000;
  const stale = cacheStale || resetDue;
  const freshness = health?.status === 'error' ? 'error' : !snapshot ? 'missing' : stale ? 'stale' : 'fresh';
  const meters = (snapshot?.buckets ?? []).map(bucket => {
    const seconds = bucket.reset_time === null ? null : Math.max(0, (timestamp(bucket.reset_time) - now.getTime()) / 1000);
    return { ...bucket, used_percent: bucket.remaining_fraction === null ? null : (1 - bucket.remaining_fraction) * 100,
      remaining_percent: bucket.remaining_fraction === null ? null : bucket.remaining_fraction * 100,
      seconds_to_reset: seconds, reset_due: seconds === null ? null : seconds === 0,
      available: !cacheStale && !bucket.disabled && fraction(bucket.remaining_fraction) && bucket.remaining_fraction > 0 && seconds > 0,
      approx_remaining_pp_per_hour_to_reset: !bucket.disabled && fraction(bucket.remaining_fraction) && seconds > 0 ? bucket.remaining_fraction * 100 / (seconds / 3600) : null };
  });
  const pools = Object.entries(GROUPS).map(([pool, required_ids]) => {
    const missing_ids = required_ids.filter(id => !meters.some(meter => meter.id === id));
    const constrained_by = required_ids.filter(id => !meters.find(meter => meter.id === id)?.available);
    return { pool, available: constrained_by.length === 0, constrained_by, missing_ids, required_ids };
  });
  return { observed_at, observation_id: snapshot?.observation_id ?? null, age_seconds: age, freshness, stale, freshness_limit_seconds: FRESHNESS_MS / 1000,
    health: health ? { status: health.status === 'ok' ? 'ok' : 'error', checked_at: health.checked_at, ...(health.status !== 'ok' ? { code: CODES.has(health.code) ? health.code : 'STATE_INVALID' } : {}) } : null,
    meters, pools, transitions: snapshot?.transitions ?? [], credits: snapshot?.credits ?? null, warnings: snapshot?.warnings ?? [],
    policy: 'Both five-hour and weekly windows constrain availability; missing, disabled or reset-due data cannot establish refill. Approximate percentage-points/hour guidance is non-predictive. No automatic inference, jobs, quota burning or billing changes.' };
}
export async function readStatus(stateDir = defaultStateDir(), { clock = () => new Date() } = {}) {
  let snapshot = null, health = null;
  try {
    try { await readableDir(stateDir); } catch (error) { if (error.code === 'ENOENT') return buildStatus(null, null, checkedNow(clock)); throw error; }
    const raw = await readJSON(join(stateDir, 'latest.json')); snapshot = raw ? sanitizeSnapshot(raw) : null;
    health = await readJSON(join(stateDir, 'health.json'));
    if (health && (!['ok', 'error'].includes(health.status) || !Number.isFinite(timestamp(health.checked_at)))) fail('STATE_INVALID');
  } catch { health = { status: 'error', checked_at: checkedNow(clock).toISOString(), code: 'STATE_INVALID' }; }
  return buildStatus(snapshot, health, checkedNow(clock));
}
export async function readHistory(stateDir = defaultStateDir(), limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('INVALID_SCHEMA');
  const dir = join(stateDir, 'history'); let names;
  try { await readableDir(stateDir); await readableDir(dir); names = await readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const name of names.filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().reverse()) {
    const text = await readText(join(dir, name)); if (text === null) continue;
    const lines = text.trim().split('\n').filter(Boolean).reverse();
    for (const line of lines) { let raw; try { raw = JSON.parse(line); } catch { fail('STATE_INVALID'); } rows.push(sanitizeSnapshot(raw)); if (rows.length === limit) return rows; }
  }
  return rows;
}
export function formatStatus(view) {
  const lines = [`Quota status: ${view.freshness.toUpperCase()} | observed: ${view.observed_at ?? 'none'} | age: ${view.age_seconds === null ? 'unknown' : `${Math.round(view.age_seconds)}s`}`];
  if (view.health?.status === 'error') lines.push(`Health error: ${view.health.code}; last good values are retained, not refreshed.`);
  if (!view.meters.length) lines.push(view.observed_at ? 'No known quota meters were reported; allowances are unknown.' : 'Allowances unknown: no successful observation.');
  for (const warning of view.warnings) lines.push(`Schema warning: ${warning}`);
  for (const meter of view.meters) lines.push(`${meter.id}: used ${meter.used_percent?.toFixed(2) ?? 'unknown'}%, remaining ${meter.remaining_percent?.toFixed(2) ?? 'unknown'}% | reset ${meter.reset_time ?? 'unknown'} (${meter.seconds_to_reset === null ? 'unknown' : `${Math.round(meter.seconds_to_reset)}s`}; ${meter.reset_due === null ? 'unknown' : meter.reset_due ? 'due, unverified' : 'pending'}) | ${meter.available ? 'usable' : 'blocked/unverified'} | approximate pp/hour to reset (non-predictive): ${meter.approx_remaining_pp_per_hour_to_reset?.toFixed(2) ?? 'unknown'}`);
  for (const pool of view.pools) lines.push(`${pool.pool}: ${pool.available ? 'available' : 'blocked/unverified'}${pool.constrained_by.length ? `; constrained by ${pool.constrained_by.join(', ')}` : ''}`);
  if (view.credits) lines.push(`Observed credits: ${view.credits.remaining_credits} (not a billing action).`);
  lines.push('Approximate pp/hour guidance uses remaining quota and reset time; it is not a jobs/day, token or consumption forecast.', view.policy);
  return lines.join('\n');
}
