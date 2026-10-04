#!/usr/bin/env node
import { resolve } from 'node:path';
import { defaultStateDir, poll, readStatus, readHistory, formatStatus } from '../lib/usage.mjs';
import { resolveAgyBin } from '../lib/executable.mjs';

const HELP = `agy-usage [status|refresh|poll|history] [options]
status/history: cached private observations only; no remote requests.
refresh/poll: explicit guarded /usage collection, optional read-only /credits.
  --json              Structured output
  --envelope          Public metadata payload (requires --json)
  --state-dir PATH    Private state (default: active Hermes profile plugin-data)
  --agy-bin PATH      Explicit official CLI path, argv-only (otherwise discover agy)
  --credits           Also read /credits (refresh/poll only)
  --limit N           History rows, 1..1000 (history only; default 20)
  -h, --help          Show help without collecting
No automatic model calls, prompts, billing actions or scheduling. Node >=20.
`;
function parse(args) {
  const options = { command: 'status', stateDir: defaultStateDir(), agyBin: null, json: false, envelope: false, credits: false, limit: 20 };
  let commandSeen = false, limitSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (['status', 'refresh', 'poll', 'history'].includes(arg) && !commandSeen) { options.command = arg; commandSeen = true; }
    else if (arg === '--json') options.json = true;
    else if (arg === '--envelope') options.envelope = true;
    else if (arg === '--credits') options.credits = true;
    else if (['--state-dir', '--agy-bin', '--limit'].includes(arg)) {
      const value = args[++i]; if (!value || value.startsWith('-')) throw new Error('Option requires a value');
      if (arg === '--state-dir') options.stateDir = resolve(value);
      else if (arg === '--agy-bin') options.agyBin = value;
      else { if (!/^\d+$/.test(value)) throw new Error('Invalid limit'); options.limit = Number(value); limitSeen = true; }
    } else throw new Error('Unknown command or option');
  }
  if (options.limit < 1 || options.limit > 1000 || (limitSeen && options.command !== 'history') ||
      (options.credits && !['poll', 'refresh'].includes(options.command)) || (options.envelope && !options.json)) throw new Error('Invalid option for command');
  return options;
}
const failure = code => ({ ok: false, error: { code, message: 'Quota metadata unavailable; prior observations were not refreshed.' } });
async function main() {
  let options;
  try { options = parse(process.argv.slice(2)); } catch { console.error('Invalid arguments. Use agy-usage --help.'); process.exitCode = 2; return; }
  if (options.help) { console.log(HELP); return; }
  if (Number(process.versions.node.split('.')[0]) < 20) {
    console.log(options.envelope ? JSON.stringify(failure('NODE_VERSION')) : 'Node >=20 required.'); process.exitCode = 1; return;
  }
  try {
    if (options.command === 'history') {
      const rows = await readHistory(options.stateDir, options.limit);
      console.log(options.json ? JSON.stringify(options.envelope ? { ok: true, observations: rows, count: rows.length } : rows) :
        rows.map(row => `${row.observed_at} | ${row.buckets.map(b => `${b.id}: ${b.remaining_fraction === null ? 'unknown' : `${(b.remaining_fraction * 100).toFixed(2)}%`} remaining, reset ${b.reset_time ?? 'unknown'}${b.disabled ? ' (disabled)' : ''}`).join(' | ')}${row.warnings?.length ? ` | warnings: ${row.warnings.join(', ')}` : ''}`).join('\n') || 'No collected observations.');
      return;
    }
    let result;
    if (['poll', 'refresh'].includes(options.command)) {
      try { options.agyBin ??= await resolveAgyBin(); }
      catch {
        result = await poll({ ...options, agyBin: 'agy', execute: async () => { throw new Error('BACKEND_FAILED'); } });
      }
      if (!result) result = await poll(options);
    }
    if (options.command === 'poll') {
      console.log(options.json ? JSON.stringify(result) : result.ok ? `Collected ${result.observed_at}` : `Collection failed: ${result.code}; prior values retained.`);
    } else {
      const view = await readStatus(options.stateDir);
      if (result && !result.ok) {
        view.freshness = 'error'; view.stale = true; view.health = { status: 'error', checked_at: null, code: result.code };
        view.meters.forEach(meter => { meter.available = false; });
        view.pools.forEach(pool => { pool.available = false; pool.constrained_by = [...pool.required_ids]; });
      }
      const error = result && !result.ok ? result.code : view.health?.status === 'error' ? view.health.code : null;
      const payload = error ? { ...failure(error), snapshot: view } : { ok: true, snapshot: view };
      console.log(options.json ? JSON.stringify(options.envelope ? payload : view) : formatStatus(view));
      if (options.envelope && error) process.exitCode = 1;
    }
    if (result && !result.ok) process.exitCode = 1;
  } catch {
    if (options.envelope) console.log(JSON.stringify(failure('STATE_IO')));
    else console.error('State read/write failed (STATE_IO). No backend details or credentials were printed.');
    process.exitCode = 1;
  }
}
await main();
