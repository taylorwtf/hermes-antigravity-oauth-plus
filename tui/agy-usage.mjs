// Optional public Hermes widgets. No core imports, API polling or inference.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const METERS = [
  ['3p-5h', 'Claude/GPT 5h'], ['3p-weekly', 'Claude/GPT weekly'],
  ['gemini-5h', 'Gemini 5h'], ['gemini-weekly', 'Gemini weekly']
];
const LANES = [
  { pool: 'Claude/GPT', ids: ['3p-5h', '3p-weekly'], aliases: ['Claude and GPT models', 'claude_gpt', 'claude-gpt'], tone: 'primary' },
  { pool: 'Gemini', ids: ['gemini-5h', 'gemini-weekly'], aliases: ['Gemini Models', 'gemini'], tone: 'ok' }
];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fraction = value => finite(value) && value >= 0 && value <= 1;
const array = value => Array.isArray(value) ? value : [];
const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'Unknown';
export function duration(value) {
  if (!finite(value) || value < 0) return 'Unknown';
  const seconds = Math.floor(value);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}
const availability = value => value === true ? 'available' : value === false ? 'blocked/unverified' : 'Unknown';
const health = value => value === 'ok' || value === 'healthy' || value?.ok === true || value?.status === 'ok'
  ? 'ok' : value === 'error' || value?.ok === false || value?.status === 'error' ? 'error' : 'Unknown';
const errorCode = payload => /^[A-Za-z0-9_-]{1,64}$/.test(payload?.error?.code ?? '') ? payload.error.code : 'metadata_unavailable';

export function metadataRequest(request, { signal, execute = execFile } = {}) {
  const { action = 'status', credits = false, limit = 20 } = request;
  if (!['status', 'refresh', 'history'].includes(action) || typeof credits !== 'boolean' ||
      (credits && action !== 'refresh') || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return Promise.reject(new Error('invalid_arguments'));
  }
  const argv = [fileURLToPath(new URL('../backend/bin/agy-usage.mjs', import.meta.url)), action, '--json', '--envelope'];
  if (credits) argv.push('--credits');
  if (action === 'history') argv.push('--limit', String(limit));
  // Inherit active HERMES_HOME; cached status/history never call the official CLI.
  return new Promise((resolve, reject) => {
    execute(process.execPath, argv, { encoding: 'utf8', shell: false, timeout: action === 'refresh' ? 30000 : 4500,
      maxBuffer: 2 * 1024 * 1024, killSignal: 'SIGTERM', windowsHide: true, signal }, (error, stdout) => {
      if (signal?.aborted) return reject(new Error('cancelled'));
      try {
        const payload = JSON.parse(stdout);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.ok !== 'boolean') throw new Error();
        if (error && payload.ok) throw new Error();
        resolve(payload); // Structured failures may accompany a nonzero exit.
      } catch { reject(new Error('metadata_unavailable')); }
    });
  });
}

const fit = (text, width) => String(text).slice(0, width).padEnd(width);
const row = (tone, text, width) => [tone, fit(text, width)];
const percent = value => fraction(value) ? `${(value * 100).toFixed(1)}%` : 'Unknown';
const resetIn = (meter, now) => {
  if (stamp(meter?.reset_time) === 'Unknown') return 'Unknown';
  const seconds = (Date.parse(meter.reset_time) - now) / 1000;
  return seconds <= 0 ? 'due!' : duration(seconds);
};
const meterFor = (snapshot, id) => array(snapshot.meters).find(m => m?.id === id) ?? {};
function observation(payload, now, retained) {
  const snapshot = payload?.ok === true ? payload.snapshot ?? {} : {};
  const freshness = ['fresh', 'stale', 'error', 'missing'].includes(snapshot.freshness) ? snapshot.freshness : 'Unknown';
  const observed = stamp(snapshot.observed_at);
  const age = observed !== 'Unknown' ? (now - Date.parse(snapshot.observed_at)) / 1000 : snapshot.age_seconds;
  const expired = finite(snapshot.freshness_limit_seconds) && finite(age) && age >= snapshot.freshness_limit_seconds;
  const resetDue = array(snapshot.meters).some(m => stamp(m?.reset_time) !== 'Unknown' && Date.parse(m.reset_time) <= now);
  const stale = retained || snapshot.stale === true || expired || resetDue || (finite(age) && age < 0) || ['stale', 'error', 'missing', 'Unknown'].includes(freshness);
  return { snapshot, freshness, observed, age, stale };
}
function nextFiveReset(snapshot, now) {
  const times = LANES.map(lane => meterFor(snapshot, lane.ids[0])).filter(m => stamp(m.reset_time) !== 'Unknown').map(m => Date.parse(m.reset_time));
  if (!times.length) return 'Unknown';
  return resetIn({ reset_time: new Date(Math.min(...times)).toISOString() }, now);
}
const acquisitionCaption = action => action === 'status' ? 'Reading cache' : action === 'history' ? 'Reading history' : 'Refreshing quota';

// A six-cell travelling signal, not a progress bar or fullscreen sweep.
export function acquisitionLines({ action = 'status', elapsedMs = 0, width = 70 } = {}) {
  width = Math.max(1, Math.floor(width));
  const elapsed = finite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const head = Math.floor(elapsed / 250) % 6;
  const signal = Array.from({ length: 6 }, (_, i) => i === head ? '>' : '.').join('');
  return [row('primary', `${signal} ${acquisitionCaption(action)} | ${(elapsed / 1000).toFixed(1)}s elapsed`, width)];
}

const compactDuration = seconds => !finite(seconds) || seconds < 0 ? 'Unknown' : seconds >= 86400 ? `${Math.floor(seconds / 86400)}d${Math.floor(seconds % 86400 / 3600)}h` : seconds >= 3600 ? `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m` : duration(seconds);
const compactReset = (meter, now) => stamp(meter?.reset_time) === 'Unknown' ? 'Unknown' : Date.parse(meter.reset_time) <= now ? 'due!' : compactDuration((Date.parse(meter.reset_time) - now) / 1000);
export function poolBlocker(snapshot, lane, now) {
  const meters = lane.ids.map(id => meterFor(snapshot, id));
  for (const [i, meter] of meters.entries()) if (fraction(meter.remaining_fraction) && meter.remaining_fraction === 0) return `${i ? 'weekly' : '5h'} depleted`;
  for (const [i, meter] of meters.entries()) {
    const window = i ? 'weekly' : '5h';
    if (meter.disabled) return `${window} disabled`;
    if (!fraction(meter.remaining_fraction) || stamp(meter.reset_time) === 'Unknown') return `${window} unknown`;
    if (Date.parse(meter.reset_time) <= now) return `${window} due/unconfirmed`;
  }
  const pool = array(snapshot.pools).find(p => lane.aliases.includes(p?.pool));
  return pool?.available === true ? 'available' : 'unverified';
}

// Four-row ambient design; countdowns for both windows, no oversized telemetry.
export function dockLines(payload, now = Date.now(), width = 78,
  { retained = false, loading = false, action = 'status', elapsedMs = 0, error = null } = {}) {
  width = Math.max(1, Math.floor(width));
  const { snapshot, freshness, age, stale } = observation(payload, now, retained);
  let header = `Quota | ${stale ? 'last/unverified' : freshness} | age ${duration(age)} | health ${health(snapshot.health)}`;
  if (loading) header = acquisitionLines({ action, elapsedMs, width: Math.max(width, 70) })[0][1].trimEnd() + (payload ? ' | last/unverified' : ' | Unknown');
  else if (error || payload?.ok === false) header = `Quota | ${error ?? errorCode(payload)} | last/unverified | age ${duration(age)}`;
  const lines = [row(error || payload?.ok === false ? 'error' : loading ? 'primary' : 'label', header, width)];
  for (const lane of LANES) {
    const [five, weekly] = lane.ids.map(id => meterFor(snapshot, id));
    const blocker = poolBlocker(snapshot, lane, now);
    const status = stale && blocker === 'available' ? 'unverified' : blocker;
    lines.push(row(lane.tone, `${lane.pool.padEnd(10)} 5h ${percent(five.remaining_fraction).padStart(6)} ${compactReset(five, now)} | weekly ${percent(weekly.remaining_fraction).padStart(6)} ${compactReset(weekly, now)} | ${status}`, width));
  }
  lines.push(row('muted', `Next 5h reset: ${nextFiveReset(snapshot, now)} | /agy-plus-usage details`, width));
  return lines;
}

// Clean details table: ordinary digits, four meters, countdowns and health.
export function usageLines(payload, now = Date.now(), width = 70, { retained = false } = {}) {
  width = Math.max(1, Math.floor(width));
  if (!payload || payload.ok !== true) return [row('error', `Metadata unavailable (${errorCode(payload)}). R to retry.`, width)];
  const { snapshot, freshness, observed, age, stale } = observation(payload, now, retained);
  const lines = [
    row('label', `Cached: ${stale ? 'stale/unverified' : freshness} | health: ${health(snapshot.health)} | age: ${duration(age)}`, width),
    row('muted', `Observed: ${observed}`, width),
    row(stale ? 'error' : 'muted', stale ? 'LAST OBSERVATION / UNVERIFIED - no confirmed refill. R to recheck.' : 'Observed remaining quota / metadata only / no inference', width)
  ];
  for (const [id, label] of METERS) {
    const meter = meterFor(snapshot, id);
    lines.push(row(id.startsWith('3p') ? 'primary' : 'ok', `${label.padEnd(19)} ${percent(meter.remaining_fraction).padStart(7)} remaining | reset in ${resetIn(meter, now)}`, width));
    lines.push(row('muted', `  Reset: ${stamp(meter.reset_time) === 'Unknown' ? 'Unknown' : meter.reset_time}${resetIn(meter, now) === 'due!' ? ' (due/unconfirmed)' : ''}`, width));
  }
  for (const lane of LANES) {
    const pool = array(snapshot.pools).find(p => lane.aliases.includes(p?.pool)) ?? {};
    const constraints = lane.ids.filter(id => array(pool.constrained_by).includes(id));
    const available = stale && pool.available === true ? 'last available (unverified)' : availability(pool.available);
    lines.push(row(stale ? 'error' : 'muted', `${lane.pool} pool: ${available} / ${poolBlocker(snapshot, lane, now)}${constraints.length ? ' / ' + constraints.map(id => id.endsWith('5h') ? '5h' : 'weekly').join('+') : ''}`, width));
  }
  lines.push(row('muted', finite(snapshot.credits?.remaining_credits) && snapshot.credits.remaining_credits >= 0
    ? `Observed credits: ${snapshot.credits.remaining_credits} (read-only)` : 'Credits: not observed / read-only', width));
  return lines;
}
function parseArguments(arg) {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  let action = 'status', credits = false, limit = 20;
  if (!tokens.length || tokens.join(' ') === 'status' || tokens.join(' ') === 'details') { /* cached */ }
  else if (tokens.join(' ') === 'alerts on' || tokens.join(' ') === 'alerts off') return { action: 'status', credits: false, limit: 20, alerts: tokens[1] === 'on' };
  else if (tokens.join(' ') === 'refresh' || tokens.join(' ') === 'refresh --credits') { action = 'refresh'; credits = tokens.length === 2; }
  else if (tokens[0] === 'history' && tokens.length <= 2 && (tokens.length === 1 || /^[0-9]+$/.test(tokens[1]) && Number(tokens[1]) >= 1 && Number(tokens[1]) <= 1000)) {
    action = 'history'; limit = tokens.length === 2 ? Number(tokens[1]) : 20;
  } else return null;
  return { action, credits, limit, details: tokens[0] === 'details' };
}

const emptyAlerts = () => ({ enabled: false, lastObserved: null, lastObservationId: null, levels: {}, notices: [], sequence: 0 });
export function observeAlerts(alerts, payload, now, baseline = false) {
  if (!alerts.enabled || payload?.ok !== true) return alerts;
  const { snapshot, stale, age } = observation(payload, now, false);
  const observed = Date.parse(snapshot.observed_at);
  const observationId = typeof snapshot.observation_id === 'string' ? snapshot.observation_id : null;
  if (stale || snapshot.freshness !== 'fresh' || health(snapshot.health) !== 'ok' || !finite(age) || age < 0 || !finite(observed) ||
      (alerts.lastObserved !== null && observed < alerts.lastObserved)) return { ...alerts, notices: [] };
  if (alerts.lastObserved !== null && observed === alerts.lastObserved && (!observationId || observationId === alerts.lastObservationId)) return alerts;
  const levels = { ...alerts.levels }, notices = [];
  for (const [id, label] of METERS) {
    const meter = meterFor(snapshot, id), value = meter.remaining_fraction;
    if (meter.disabled || !fraction(value) || stamp(meter.reset_time) === 'Unknown') continue;
    if (!baseline && fraction(levels[id]) && levels[id] > .1 && value <= .1) notices.push({ id, label, value });
    levels[id] = value;
  }
  return { ...alerts, lastObserved: observed, lastObservationId: observationId, levels, notices, sequence: alerts.sequence + notices.length };
}

export default function register(sdk, { request = metadataRequest, clock = Date.now, cachedReload = true,
  timers = { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: id => clearInterval(id) } } = {}) {
  const { h, React, Text, Box, Dialog, Overlay } = sdk;
  let generation = 0, dockApp, detailsApp, dockState = null, alerts = emptyAlerts();
  const explicitRefreshes = new Set();
  const initial = (args, previous = null) => ({ surface: 'quota-dock-v1', mount: ++generation, request: 0,
    action: args.action, credits: args.credits, limit: args.limit,
    payload: previous?.payload?.ok === true ? previous.payload : null,
    phase: 'loading', error: null, offset: 0, startedAt: clock(), alerts });
  const remember = (app, state) => {
    if (app === dockApp) {
      if (state.phase === 'ready') alerts = observeAlerts(alerts, state.payload, clock());
      state = { ...state, alerts }; dockState = state;
    }
    return state;
  };
  const result = (current, payload) => payload?.ok === true
    ? { ...current, payload, phase: 'ready', error: null, receivedAt: clock() }
    : { ...current, payload: current.payload?.ok === true ? current.payload : payload, phase: 'failed', error: errorCode(payload) };

  function Viewer({ state, cols, t, ambient }) {
    const app = ambient ? dockApp : detailsApp;
    if (ambient) dockState = state;
    const [now, setNow] = React.useState(clock);
    React.useEffect(() => {
      // No backend calls: request elapsed, observed age and reset countdowns.
      const timer = timers.setInterval(() => setNow(clock()), state.phase === 'loading' ? 250 : 1000);
      return () => timers.clearInterval(timer);
    }, [state.mount, state.request, state.phase]);
    React.useEffect(() => () => {
      if (ambient && dockState?.mount === state.mount) { dockState = null; alerts = emptyAlerts(); }
    }, [state.mount]);
    React.useEffect(() => {
      if (state.phase !== 'loading') return;
      const controller = new AbortController();
      let mounted = true;
      const refreshToken = `${app.id}:${state.mount}:${state.request}`;
      if (state.action === 'refresh') explicitRefreshes.add(refreshToken);
      const land = fn => {
        explicitRefreshes.delete(refreshToken);
        if (!mounted || controller.signal.aborted) return;
        sdk.updateWidget(app, current => current.mount === state.mount && current.request === state.request
          ? remember(app, fn(current)) : current);
      };
      Promise.resolve().then(() => controller.signal.aborted ? Promise.reject(new Error('cancelled')) : request({ action: state.action, credits: state.credits, limit: state.limit }, { signal: controller.signal }))
        .then(payload => land(current => result(current, payload)),
          () => land(current => ({ ...current, phase: 'failed', error: 'metadata_unavailable' })));
      return () => { mounted = false; explicitRefreshes.delete(refreshToken); controller.abort(); };
    }, [state.mount, state.request]);
    React.useEffect(() => {
      if (!ambient || !cachedReload || state.phase === 'loading') return;
      let mounted = true, controller = null;
      const land = fn => {
        if (!mounted || controller?.signal.aborted) return;
        sdk.updateWidget(app, current => current.mount === state.mount && current.request === state.request && current.phase !== 'loading' && !explicitRefreshes.size
          ? remember(app, fn(current)) : current);
      };
      // Reload the existing collector's cache only; never action=refresh/poll.
      const timer = timers.setInterval(() => {
        if (!mounted || controller || explicitRefreshes.size) return; // no overlap or cache reads during explicit refresh
        controller = new AbortController();
        const signal = controller.signal;
        Promise.resolve().then(() => signal.aborted ? Promise.reject(new Error('cancelled'))
          : request({ action: 'status', credits: false, limit: 20 }, { signal }))
          .then(payload => land(current => {
            if (payload?.ok !== true) return result(current, payload);
            const oldTime = current.payload?.snapshot?.observed_at, newTime = payload.snapshot?.observed_at;
            const newer = stamp(newTime) !== 'Unknown' && (stamp(oldTime) === 'Unknown' || Date.parse(newTime) > Date.parse(oldTime));
            // An old cache cannot hide a failed explicit refresh or relabel it fresh.
            if (current.phase === 'failed' && current.payload?.ok === true && !newer) return current;
            return result(current, payload);
          }), () => land(current => ({ ...current, phase: 'failed', error: 'metadata_unavailable' })))
          .finally(() => { controller = null; });
      }, 60000);
      return () => { mounted = false; timers.clearInterval(timer); controller?.abort(); };
    }, [state.mount, state.request, state.phase]);

    const width = Math.max(1, ambient ? cols - 4 : Math.min(92, cols - 4));
    const inner = Math.max(1, width - (ambient ? 2 : 6));
    const line = ([tone, text], key) => h(Text, { key, color: t.color[tone], wrap: 'truncate-end' }, fit(text, inner));
    let lines;
    if (ambient) {
      lines = dockLines(state.payload, now, inner, { retained: state.phase !== 'ready', loading: state.phase === 'loading',
        action: state.action, elapsedMs: now - state.startedAt, error: state.error });
      if (state.alerts?.enabled) {
        lines[3] = row('muted', '/agy-plus-usage details | alerts on (<=10%, new observations)', inner);
        if (state.phase === 'ready' && !observation(state.payload, now, false).stale) {
          for (const lane of LANES) {
            const notices = state.alerts.notices.filter(n => lane.ids.includes(n.id));
            if (notices.length) lines.push(row('error', `Low quota: ${lane.pool} ${notices.map(n => `${n.id.endsWith('5h') ? '5h' : 'weekly'} ${percent(n.value)}`).join(', ')} remaining`, inner));
          }
        }
      }
    }
    else {
      if (state.payload?.observations && state.payload.ok) {
        const rows = array(state.payload.observations);
        lines = [['label', `History: ${rows.length} observations | rows ${rows.length ? state.offset + 1 : 0}-${Math.min(rows.length, state.offset + 2)}`]];
        for (const saved of rows.slice(state.offset, state.offset + 2)) {
          lines.push(['muted', stamp(saved?.observed_at)]);
          const meters = array(saved?.buckets ?? saved?.meters);
          for (const [id, label] of METERS) lines.push(['label', `${label}: ${percent(meters.find(m => m?.id === id)?.remaining_fraction)} remaining`]);
        }
        if (!rows.length) lines.push(['muted', 'No saved observations. R to refresh metadata.']);
        if (state.phase !== 'ready') lines.unshift(['error', 'LAST OBSERVATIONS / UNVERIFIED - previous history retained']);
      } else lines = usageLines(state.payload, now, inner, { retained: state.phase !== 'ready' });
      if (state.phase === 'loading') {
        if (!state.payload) lines = [];
        lines.unshift(...acquisitionLines({ action: state.action, elapsedMs: now - state.startedAt, width: inner }));
      }
      if (state.error) lines.unshift(['error', `Metadata unavailable (${state.error}). R to retry.`]);
    }
    const content = h(Box, { flexDirection: 'column' }, ...lines.map(line));
    if (ambient) return h(Box, { flexDirection: 'column', width, paddingX: 1 }, content);
    return h(Overlay, { zone: 'center' }, h(Dialog, { width, title: 'Quota details',
      hint: line(['muted', state.payload?.observations ? 'R refresh | Esc/q close details | ↑/↓ history' : 'R refresh | Esc/q close details | metadata only'], 'hint') }, content));
  }
  detailsApp = sdk.defineWidgetApp({
    id: 'agy-plus-usage-details', mode: 'modal', help: 'Quota details and history; R refresh, Esc/q close details',
    usage: '/agy-plus-usage-details [status|refresh [--credits]|history [1..1000]]',
    init(arg = '') {
      const args = parseArguments(arg); if (!args || args.alerts !== undefined) return null;
      return initial(args, args.action === 'history' ? null : dockState);
    },
    reduce(state, { ch = '', key = {} }) {
      if (key.escape || ch === 'q' || ch === 'Q') return null;
      if (ch.toLowerCase() === 'r') return { ...state, request: state.request + 1, action: 'refresh', offset: 0, phase: 'loading', error: null, startedAt: clock() };
      if (key.downArrow && state.payload?.observations) return { ...state, offset: Math.min(Math.max(0, state.payload.observations.length - 2), state.offset + 2) };
      if (key.upArrow && state.payload?.observations) return { ...state, offset: Math.max(0, state.offset - 2) };
      return state;
    },
    render: ctx => h(Viewer, { ...ctx, ambient: false })
  });
  dockApp = sdk.defineWidgetApp({
    id: 'agy-plus-usage', mode: 'ambient', zone: 'dock-top', help: 'Toggle cached quota dock; refresh or details via slash command',
    usage: '/agy-plus-usage [status|refresh [--credits]|details|history [1..1000]|alerts on|off]',
    init(arg = '') {
      const args = parseArguments(arg); if (!args) return null;
      if (args.alerts !== undefined) {
        alerts = { ...alerts, enabled: args.alerts, notices: [] };
        if (args.alerts && dockState?.payload) alerts = observeAlerts({ ...alerts, lastObserved: null, levels: {} }, dockState.payload, clock(), true);
        return dockState ? remember(dockApp, { ...dockState, alerts }) : remember(dockApp, initial({ action: 'status', credits: false, limit: 20 }));
      }
      if (args.details || args.action === 'history') {
        sdk.openWidget(detailsApp, detailsApp.init(args.action === 'history' ? `history ${args.limit}` : ''));
        // Public host opens details as modal, then keeps/opens this ambient dock.
        return dockState ?? remember(dockApp, initial({ action: 'status', credits: false, limit: 20 }));
      }
      return remember(dockApp, initial(args, dockState));
    },
    reduce(state, { ch = '', key = {} }) {
      // Hot reload may retain the old modal slot; only unmarked legacy state can close.
      if (state.surface === undefined && (key.escape || ch === 'q' || ch === 'Q')) return null;
      return state; // New ambient state stays inert, including R/q/Esc.
    },
    render: ctx => h(Viewer, { ...ctx, ambient: true })
  });
}
