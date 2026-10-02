/**
 * modscope — a Claude Code mod for debugging other mods.
 *
 * One file holds every `$` call: the loader scans this module statically and
 * requires `$` to be spelled `$.noun.event(...)` at the call site and to only
 * flow into functions declared in this same file — so all $-touching code
 * lives here. Pure helpers (data, diffing, formatting, pane tree) sit in
 * sibling modules.
 *
 * Registration order: the `traced` hooks are registered first so the tracer
 * wraps every dispatch; answering hooks (slash command, model tool, pane,
 * registry) sit beneath it. Each event gets at most one matcher-less hook,
 * so plugin.register / session.start / engine.create fold their own work
 * into the shared record path inline.
 */

import type { PluginOptions } from 'claude-code';
import { OWN, PANE_ID, STORE_KEY, cap, diffPaths, redact, summarize } from './util';
import {
  flags,
  state,
  ring,
  LIMITS,
  isBlocked,
  block,
  unblock,
  blockedNames,
  loadBlocklist,
  redactOn,
  type LinkRec,
  type ErrorRec,
  type TraceRec,
} from './state';
import { buildPane, statusLine } from './pane';
import {
  HELP,
  formatRegistry,
  formatRegistryDetail,
  formatTrace,
  formatEvent,
  formatErrors,
  formatLogs,
  formatStatus,
  replayScaffold,
} from './format';

/* eslint-disable @typescript-eslint/no-explicit-any */
type $ = any;
type E = any;
type Next = any;

interface TraceEntryLike {
  index: number;
  plugin: string;
  tier: string;
  outcome: string;
  reason?: string;
  ms: number;
  chunks?: number;
  received: unknown;
  returned: unknown;
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

/** Op events only interesting while tracing mod API traffic (`verbose`). */
const NOISY = new Set([
  'fs.read', 'fs.write', 'fs.list', 'fs.exists', 'fs.stat', 'fs.ancestors',
  'store.get', 'store.set', 'store.delete', 'store.keys',
  'env.get', 'env.set', 'settings.read', 'config.list',
  'clock.now', 'clock.sleep', 'clock.after', 'clock.every',
  'http.fetch', 'process.run', 'mcp.call',
  'model.complete', 'model.classify', 'model.fork',
  'audio.play', 'audio.speak',
  'ui.toast', 'ui.status', 'ui.invalidate', 'ui.panes', 'ui.blit',
  'tool.list', 'command.list', 'agent.list', 'prompt.read', 'turn.abort',
  'session.cwd', 'session.root', 'session.model', 'session.turns', 'session.id',
  'session.repo', 'session.surface', 'session.surfaces', 'session.messages',
  'session.usage', 'session.version', 'session.authorize',
]);

/** Trace outcomes that mean a hook failed or was dropped. */
const BAD = new Set(['rejected', 'expired', 'caught', 'skipped', 'kept']);



// ---------------------------------------------------------------------------
// Persistence ($.store — durable slice)
// ---------------------------------------------------------------------------

let initialized = false;
let persistQueued = false;

async function storeGet<T>($: $, k: string): Promise<T | undefined> {
  try {
    return (await $.store.get(`${STORE_KEY}/${k}`)) as T | undefined;
  } catch (err) {
    ring(state.faults, `store.get ${k}: ${errorMessage(err)}`, 20);
    return undefined;
  }
}

async function storeSet($: $, k: string, v: unknown): Promise<void> {
  try {
    await $.store.set(`${STORE_KEY}/${k}`, v);
  } catch {
    /* a full/unavailable store must never break the mod */
  }
}

/** Load durable state once, lazily — safe to call inside any dispatch.
 *  During `plugin.register` the `$` nouns are not bound yet ($.store is
 *  absent — verified), so the first read acts as a probe: a thrown call
 *  leaves `initialized` false and the load retries on the next dispatch. */
async function ensureInit($: $): Promise<void> {
  if (initialized) return;
  let savedFlags: Partial<typeof flags> | undefined;
  try {
    savedFlags = (await $.store.get(`${STORE_KEY}/flags`)) as Partial<typeof flags> | undefined;
  } catch {
    return;
  }
  initialized = true;
  if (savedFlags) Object.assign(flags, savedFlags);
  const savedBlock = await storeGet<string[]>($, 'blocklist');
  if (savedBlock) loadBlocklist(savedBlock);
  const errs = await storeGet<ErrorRec[]>($, 'errors');
  if (errs) state.errors = errs;
  const reg = await storeGet<typeof state.registry>($, 'registry');
  if (reg) {
    state.registry = reg;
    state.loadOrder = reg.length;
  }
  const rec = await storeGet<typeof state.recorded>($, 'recorded');
  if (rec) state.recorded = rec;
}

async function persistFlags($: $): Promise<void> {
  await storeSet($, 'flags', flags);
}

async function persistBlocklist($: $): Promise<void> {
  await storeSet($, 'blocklist', blockedNames());
}

async function persistRegistry($: $): Promise<void> {
  await storeSet($, 'registry', state.registry);
}

async function persistErrors($: $): Promise<void> {
  await storeSet($, 'errors', state.errors.slice(-LIMITS.errors));
}

async function persistRecorded($: $): Promise<void> {
  await storeSet($, 'recorded', state.recorded);
}

/** Debounced persist for high-frequency keys (errors, recorded). */
function persistSoon($: $, key: 'errors' | 'recorded'): void {
  if (persistQueued) return;
  persistQueued = true;
  try {
    $.clock.after(250, () => {
      persistQueued = false;
      if (key === 'errors') void persistErrors($);
      else void persistRecorded($);
    });
  } catch {
    persistQueued = false;
  }
}

// ---------------------------------------------------------------------------
// Recording pipeline (runs after next() settles; never throws)
// ---------------------------------------------------------------------------

/** Per-link view of a settled dispatch, with rewrite attribution. */
function linksOf(entries: readonly TraceEntryLike[]): LinkRec[] {
  return entries.map((t, i) => {
    const after = entries[i + 1];
    const last = i === entries.length - 1;
    const answeredEarly = last && t.plugin !== 'engine';
    // What this link rewrote shows in the next link's `received`.
    const changed = !last && after ? diffPaths(t.received, after.received) : [];
    return {
      plugin: t.plugin,
      tier: t.tier,
      outcome: t.outcome,
      reason: t.reason,
      ms: Math.round(t.ms * 10) / 10,
      chunks: t.chunks,
      changed,
      answeredEarly: answeredEarly || undefined,
      skipped: t.outcome === 'skipped' || undefined,
    };
  });
}

function settle(result: unknown, error: unknown): string {
  if (error) return 'rejected';
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if ('deny' in r) return '{deny}';
    if ('refuse' in r) return '{refuse}';
    if ('allow' in r) return '{allow}';
    if ('isError' in r && r.isError) return '{isError}';
    if ('value' in r) return '{value}';
    if ('result' in r) return '{result}';
  }
  return 'ok';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return '⟨unprintable error⟩';
  }
}

let lastRefresh = 0;

function refresh($: $): void {
  const now = Date.now();
  if (now - lastRefresh < 1000) return;
  lastRefresh = now;
  try {
    $.ui.status(statusLine());
    if (state.paneOpen) $.ui.invalidate('ui.render');
  } catch {
    /* cosmetic */
  }
}

function redactSafe(v: unknown): unknown {
  if (!redactOn()) return v;
  try {
    return redact(v);
  } catch {
    return v;
  }
}

interface Settled {
  seq: number;
  at: number;
  ms: number;
  input: string;
  result: unknown;
  error: unknown;
  bypassed?: boolean;
}

/** Book-keeping after a dispatch settles beneath us. Callers pass the trace
 *  entries they already hold — never `next` itself (loader rule). */
function record($: $, e: E, event: string, origin: { plugin: string; tier: string }, entries: readonly TraceEntryLike[], r: Settled): void {
  try {
    const links = linksOf(entries);
    ring<TraceRec>(
      state.trace,
      {
        seq: r.seq,
        at: r.at,
        event,
        origin: { plugin: origin.plugin, tier: origin.tier },
        ms: r.ms,
        input: r.input,
        result: settle(r.result, r.error),
        links,
        bypassed: r.bypassed,
      },
      traceLimit(),
    );

    for (const l of links) {
      if (BAD.has(l.outcome)) {
        ring(state.errors, { at: r.at, seq: r.seq, event, plugin: l.plugin, tier: l.tier, outcome: l.outcome, reason: l.reason }, LIMITS.errors);
      }
    }
    if (r.error) {
      ring(
        state.errors,
        { at: r.at, seq: r.seq, event, plugin: origin.plugin, tier: origin.tier, outcome: 'rejected', reason: errorMessage(r.error) },
        LIMITS.errors,
      );
    }
    if (links.length || r.error) persistSoon($, 'errors');

    if (event === 'ui.log' || event === 'ui.notice') {
      const text = typeof e?.text === 'string' ? e.text : '';
      if (text) ring(state.logs, { at: r.at, plugin: origin.plugin, sink: e?.to ?? event, text }, LIMITS.logs);
    }
    if (event === 'ui.close' && e?.id === PANE_ID) state.paneOpen = false;

    if (flags.recording) {
      ring(
        state.recorded,
        {
          at: Date.now(),
          seq: r.seq,
          event,
          origin: { ...origin },
          received: cap(redactSafe(e)),
          links: entries.map((t) => ({
            plugin: t.plugin,
            tier: t.tier,
            outcome: t.outcome,
            reason: t.reason,
            received: cap(redactSafe(t.received)),
            returned: cap(redactSafe(t.returned)),
          })),
          result: cap(redactSafe(r.result)),
          error: r.error ? errorMessage(r.error) : undefined,
        },
        LIMITS.recorded,
      );
      persistSoon($, 'recorded');
    }
    refresh($);
  } catch (fault) {
    ring(state.faults, `record ${event}: ${errorMessage(fault)}`, 20);
  }
}

function traceLimit(): number {
  const n = state.options['trace_max'];
  return typeof n === 'number' && n > 0 ? Math.min(n, 5000) : LIMITS.trace;
}

// ---------------------------------------------------------------------------
// The universal tracing hook
// ---------------------------------------------------------------------------

async function traced($: $, e: E, next: Next): Promise<unknown> {
  const event = next.event;
  const origin = next.origin;
  if (origin.plugin === OWN) return next(e);
  if (flags.paused) return next(e);
  if (!flags.verbose && NOISY.has(event)) return next(e);

  await ensureInit($);

  const seq = ++state.seq;
  const at = Date.now();
  const input = summarize(event, e, redactOn());

  let result: unknown;
  let error: unknown;
  try {
    result = await next(e);
  } catch (err) {
    error = err;
  }

  record($, e, event, origin, next.trace, { seq, at, ms: Date.now() - at, input, result, error });
  if (error) throw error;
  return result;
}

/** turn.step — the one streaming event: hooks are async generators. */
async function* tracedTurnStep($: $, e: E, next: Next): AsyncGenerator<unknown, unknown> {
  const origin = next.origin;
  if (origin.plugin === OWN || flags.paused) {
    yield* next(e);
    return;
  }
  await ensureInit($);
  const seq = ++state.seq;
  const at = Date.now();
  let error: unknown;
  let result: unknown;
  try {
    result = yield* next(e);
  } catch (err) {
    error = err;
  }
  record($, e, 'turn.step', origin, next.trace, { seq, at, ms: Date.now() - at, input: '', result, error });
  if (error) throw error;
  return result;
}

// ---------------------------------------------------------------------------
// plugin.register — registry + blocklist, recorded through the shared path
// ---------------------------------------------------------------------------

async function onPluginRegister($: $, e: E, next: Next): Promise<unknown> {
  await ensureInit($);
  const name = String(e?.name ?? '');
  if (name === OWN) state.ownTier = e?.tier;

  const seq = ++state.seq;
  const at = Date.now();
  const input = summarize('plugin.register', e, redactOn());

  if (name !== OWN && isBlocked(name) && e?.tier === 'user') {
    pushRegistry(e, 'refused', OWN);
    void persistRegistry($);
    record($, e, 'plugin.register', next.origin, next.trace, {
      seq,
      at,
      ms: Date.now() - at,
      input,
      result: { refuse: 'blocked by modscope' },
      error: undefined,
    });
    return { refuse: 'blocked by modscope' };
  }

  let result: unknown;
  let error: unknown;
  try {
    result = await next(e);
  } catch (err) {
    error = err;
  }

  try {
    const refused = Boolean(result && typeof result === 'object' && 'refuse' in (result as object));
    let refusedBy: string | undefined;
    if (refused) {
      // nearest-beneath-first: the deepest link whose return carried {refuse}
      for (const t of next.trace as Array<{ plugin: string; returned: unknown }>) {
        if (t.returned && typeof t.returned === 'object' && 'refuse' in (t.returned as object)) refusedBy = t.plugin;
      }
    }
    pushRegistry(e, refused ? 'refused' : 'allowed', refusedBy);
    void persistRegistry($);
  } catch {
    /* registry bookkeeping never breaks a load */
  }

  record($, e, 'plugin.register', next.origin, next.trace, { seq, at, ms: Date.now() - at, input, result, error });
  if (error) throw error;
  return result;
}

function pushRegistry(e: E, outcome: 'allowed' | 'refused', refusedBy?: string): void {
  const existing = state.registry.findIndex((r) => r.name === e?.name && r.tier === e?.tier);
  const rec = {
    order: existing >= 0 ? state.registry[existing].order : ++state.loadOrder,
    at: Date.now(),
    name: String(e?.name ?? '?'),
    tier: String(e?.tier ?? '?'),
    root: String(e?.root ?? ''),
    version: e?.version ? String(e.version) : undefined,
    provenance: String(e?.provenance ?? '?'),
    events: Array.isArray(e?.uses?.events) ? e.uses.events.map(String) : [],
    calls: Array.isArray(e?.uses?.calls) ? e.uses.calls.map(String) : [],
    env: e?.uses?.env
      ? { reads: [...(e.uses.env.reads ?? [])].map(String), writes: [...(e.uses.env.writes ?? [])].map(String) }
      : undefined,
    outcome,
    refusedBy,
  };
  if (existing >= 0) state.registry[existing] = rec;
  else state.registry.push(rec);
}

// ---------------------------------------------------------------------------
// engine.create — the fold that builds each plugin's $; its next(e) result is
// the table under construction and must not be assigned or jumped past, so it
// gets a dedicated handler (recorded via finally; bypass doesn't apply).
// ---------------------------------------------------------------------------

async function onEngineCreate($: $, e: E, next: Next): Promise<unknown> {
  const origin = next.origin;
  if (origin.plugin === OWN || flags.paused) return next(e);
  await ensureInit($);
  const seq = ++state.seq;
  const at = Date.now();
  const input = summarize('engine.create', e, redactOn());
  let error: unknown;
  try {
    return await next(e);
  } catch (err) {
    error = err;
    throw err;
  } finally {
    record($, e, 'engine.create', origin, next.trace, {
      seq,
      at,
      ms: Date.now() - at,
      input,
      result: error ? undefined : '(built $)',
      error,
    });
  }
}

// ---------------------------------------------------------------------------
// ui.render — our own pane; leave every other component alone
// ---------------------------------------------------------------------------

async function onPaneRender($: $, e: E, next: Next): Promise<unknown> {
  if (e?.requestId !== PANE_ID) return next(e);
  try {
    return buildPane($.ui.resolve(e) as Record<string, (p: any, ...c: any[]) => unknown>, {
      togglePause: () => {
        flags.paused = !flags.paused;
        void persistFlags($);
        try {
          $.ui.invalidate('ui.render');
        } catch {
          /* cosmetic */
        }
      },
      clear: () => {
        state.trace = [];
        state.logs = [];
        try {
          $.ui.invalidate('ui.render');
        } catch {
          /* cosmetic */
        }
      },
      showErrors: () => {
        try {
          void $.command.run({ command: 'modscope', args: 'errors' }).catch(() => {});
        } catch {
          /* may reject mid-turn; harmless */
        }
      },
    });
  } catch {
    return next(e);
  }
}

// ---------------------------------------------------------------------------
// session.start — trace the dispatch, then bind command + tool
// ---------------------------------------------------------------------------

async function onSessionStart($: $, e: E, next: Next): Promise<unknown> {
  await ensureInit($);
  const seq = ++state.seq;
  const at = Date.now();
  const input = summarize('session.start', e, redactOn());

  let result: unknown;
  let error: unknown;
  try {
    result = await next(e);
  } catch (err) {
    error = err;
  }

  if (!error) {
    try {
      state.sessionId = await $.session.id().catch(() => undefined);
      await $.command.register({
        name: 'modscope',
        description: 'Debug mods: trace events, attribute changes, surface mod errors',
        argumentHint: '[list|trace|errors|logs|watch|bypass|block|rec|export|doctor|help]',
      });
      await $.tool.register({
        name: 'modscope_query',
        description:
          'Query modscope, the mod-debugger: which mods are loaded and in what order, recent event dispatches with per-mod attribution, mod errors, and mod log lines.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['summary', 'registry', 'mod', 'trace', 'event', 'errors', 'logs', 'help'] },
            plugin: { type: 'string', description: 'mod name, for kind=mod or kind=logs' },
            event: { type: 'string', description: 'event name substring filter, for kind=trace' },
            seq: { type: 'number', description: 'dispatch seq number, for kind=event' },
            limit: { type: 'number', description: 'rows for kind=trace (default 15)' },
          },
        },
      });
      try {
        $.ui.status(statusLine());
      } catch {
        /* cosmetic */
      }
    } catch (err) {
      ring(state.faults, `session.start: ${errorMessage(err)}`, 20);
    }
  }

  record($, e, 'session.start', next.origin, next.trace, { seq, at, ms: Date.now() - at, input, result, error });
  if (error) throw error;
  return result;
}

// ---------------------------------------------------------------------------
// /modscope command dispatch
// ---------------------------------------------------------------------------

async function runCommand($: $, args: string): Promise<string> {
  await ensureInit($);
  const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const a1 = rest[0];
  const a2 = rest.slice(1).join(' ');

  switch (sub ?? 'help') {
    case 'help':
      return HELP;
    case 'list':
    case 'registry':
    case 'mods':
      return formatRegistry();
    case 'mod': {
      if (!a1) return 'usage: /modscope mod <name>';
      return formatRegistryDetail(a1);
    }
    case 'trace': {
      const n = a1 && /^\d+$/.test(a1) ? parseInt(a1, 10) : 12;
      const filter = /^\d+$/.test(a1 ?? '') ? a2 : rest.join(' ');
      return formatTrace(n, filter);
    }
    case 'event': {
      const seq = parseInt(a1 ?? '', 10);
      if (!Number.isFinite(seq)) return 'usage: /modscope event <seq>';
      return formatEvent(seq);
    }
    case 'errors':
    case 'err':
      return formatErrors();
    case 'logs':
    case 'log':
      return formatLogs(a1);
    case 'status':
      return formatStatus();
    case 'watch': {
      try {
        await $.ui.open({ id: PANE_ID, title: 'modscope', focus: true, closeOnEscape: true });
        state.paneOpen = true;
        return 'modscope pane open (Esc to close).';
      } catch (err) {
        return `could not open pane: ${errorMessage(err)}`;
      }
    }
    case 'pause':
      flags.paused = true;
      void persistFlags($);
      return 'tracing paused — dispatches pass through unrecorded.';
    case 'resume':
      flags.paused = false;
      void persistFlags($);
      return 'tracing resumed.';
    case 'verbose': {
      const want = a1 === undefined ? !flags.verbose : a1 === 'on' || a1 === 'true';
      flags.verbose = want;
      void persistFlags($);
      return want ? 'verbose on — tracing $ op calls too (fs, store, env, model, ...)' : 'verbose off — tracing semantic events only.';
    }
    case 'bypass': {
      return (
        'bypass lives in the companion plugin `modscope-bisect` (this marketplace).\n' +
        'Why separate: next.to is refused at load for non-managed mods — a mod is only\n' +
        'allowed to call it when seated via prependPlugins/appendPlugins. Install\n' +
        'modscope-bisect, enable it, and seat it in prependPlugins to skip user-tier\n' + 
        'mods entirely (links show as skipped in this trace). Without a managed seat,\n' +
        'bisect with /modscope block <name> + reload instead.'
      );
    }
    case 'block': {
      if (!a1) return 'usage: /modscope block <name>';
      if (block(a1)) {
        void persistBlocklist($);
        return (
          `${a1} will be refused at plugin.register for mods loaded after the session binds ` +
          `(hot-reloads). Verified: $ nouns are unbound during plugin.register, so a mod in the ` +
          `same cold-start batch can only be refused via the "blocklist" option in modscope's ` +
          `plugin.json — add "${a1}" there for guaranteed refusal.`
        );
      }
      return `${a1} is already blocked.`;
    }
    case 'unblock': {
      if (!a1) return 'usage: /modscope unblock <name>';
      if (unblock(a1)) {
        void persistBlocklist($);
        return `${a1} unblocked (takes effect on next load).`;
      }
      return `${a1} was not blocked.`;
    }
    case 'blocklist':
      return blockedNames().length ? `blocked: ${blockedNames().join(', ')}` : 'blocklist empty.';
    case 'rec': {
      if (a1 === 'stop') {
        flags.recording = false;
        void persistFlags($);
        return `recording stopped — ${state.recorded.length} dispatch(es) captured. /modscope export to write them out.`;
      }
      flags.recording = true;
      state.recorded = [];
      void persistFlags($);
      void persistRecorded($);
      return `recording — full event payloads captured (cap ${LIMITS.recorded}). '/modscope rec stop' to stop, '/modscope export' to write a replay scaffold.`;
    }
    case 'export': {
      if (!state.recorded.length) return 'nothing recorded — run /modscope rec first.';
      const name = a1 || 'modscope-recording';
      const jsonName = name.endsWith('.json') ? name : `${name}.json`;
      const testName = jsonName.replace(/\.json$/, '.test.ts');
      try {
        await $.fs.write(jsonName, JSON.stringify({ recordedAt: Date.now(), dispatches: state.recorded }, null, 2));
        await $.fs.write(testName, replayScaffold(state.recorded));
        return `wrote ${jsonName} (${state.recorded.length} dispatches) and ${testName} (replay scaffold for \`claude plugin test\`).`;
      } catch (err) {
        return `export failed: ${errorMessage(err)}`;
      }
    }
    case 'doctor': {
      const name = a1 ?? 'modscope';
      const rec = state.registry.find((r) => r.name === name);
      if (!rec) return `no mod named "${name}" in the registry. Try /modscope list.`;
      try {
        const r = await $.process.run(['claude', 'plugin', 'validate', rec.root], { timeoutMs: 30000 });
        return `$ claude plugin validate ${rec.root}\n${r.stdout ?? ''}${r.stderr ?? ''}\nexit ${r.exitCode}`;
      } catch (err) {
        return `doctor failed: ${errorMessage(err)}`;
      }
    }
    case 'clear': {
      state.trace = [];
      state.errors = [];
      state.logs = [];
      void persistErrors($);
      return 'trace, errors and logs cleared.';
    }
    default:
      return `unknown subcommand "${sub}".\n\n${HELP}`;
  }
}

/** The model-facing query tool: `mcp__modscope__modscope_query`. */
async function queryTool($: $, e: E): Promise<string> {
  await ensureInit($);
  const kind = typeof e?.kind === 'string' ? e.kind : 'summary';
  switch (kind) {
    case 'summary':
      return formatStatus();
    case 'registry':
    case 'list':
      return formatRegistry();
    case 'mod':
      return formatRegistryDetail(String(e?.plugin ?? e?.name ?? ''));
    case 'trace':
      return formatTrace(typeof e?.limit === 'number' ? e.limit : 15, String(e?.event ?? e?.plugin ?? ''));
    case 'event':
      return formatEvent(Number(e?.seq ?? 0));
    case 'errors':
      return formatErrors();
    case 'logs':
      return formatLogs(e?.plugin ? String(e.plugin) : undefined);
    case 'help':
      return HELP;
    default:
      return `unknown kind "${kind}" — one of summary|registry|mod|trace|event|errors|logs|help`;
  }
}

// ---------------------------------------------------------------------------
// register — literal patterns only (the host scans them)
// ---------------------------------------------------------------------------

// `on` is typed loosely on purpose: a single generic tracer can't satisfy the
// per-event handler generics the typed `On` asks for. Runtime behaviour is
// what `claude plugin validate` / `claude plugin test` check.
export function register(on: any, options: PluginOptions): void {
  state.options = (options ?? {}) as Record<string, unknown>;
  flags.verbose = Boolean(state.options['trace_api_calls']);
  const optBlock = state.options['blocklist'];
  for (const n of Array.isArray(optBlock) ? optBlock : optBlock ? [optBlock] : []) block(String(n));

  // --- engine events ---------------------------------------------------------
  on('tool.call', traced);
  on('tool.check', traced);
  on('tool.describe', traced);
  on('prompt.submit', traced);
  on('prompt.fill', traced);
  on('prompt.suggest', traced);
  on('prompt.edit', traced);
  on('prompt.section', traced);
  on('prompt.context', traced);
  on('prompt.compose', traced);
  on('prompt.attachment', traced);
  on('skill.prompt', traced);
  on('attribution.text', traced);
  on('command.run', traced);
  on('command.describe', traced);
  on('config.set', traced);
  on('config.describe', traced);
  on('turn.start', traced);
  on('turn.complete', traced);
  on('session.end', traced);
  on('session.compact', traced);
  on('session.receive', traced);
  on('session.attach', traced);
  on('session.detach', traced);
  on('session.measure', traced);
  on('agent.offer', traced);
  on('agent.spawn', traced);
  on('ui.render', traced);
  on('ui.resolve', traced);
  on('ui.press', traced);
  on('ui.input', traced);
  on('ui.select', traced);
  on('ui.message', traced);
  on('ui.scroll', traced);
  on('ui.focus', traced);
  on('classic.*', traced);
  on('turn.step', tracedTurnStep);

  // --- $ op events: the ones another mod emits that are meaningful always ----
  on('ui.log', traced);
  on('ui.notice', traced);
  on('ui.open', traced);
  on('ui.close', traced);
  on('tool.register', traced);
  on('command.register', traced);
  on('agent.register', traced);

  // --- $ op events: noisy plumbing, traced only under /modscope verbose ------
  on('model.complete', traced);
  on('model.classify', traced);
  on('model.fork', traced);
  on('audio.play', traced);
  on('audio.speak', traced);
  on('mcp.call', traced);
  on('session.cwd', traced);
  on('session.root', traced);
  on('session.model', traced);
  on('session.turns', traced);
  on('session.id', traced);
  on('session.messages', traced);
  on('session.repo', traced);
  on('session.surface', traced);
  on('session.surfaces', traced);
  on('session.authorize', traced);
  on('session.usage', traced);
  on('session.version', traced);
  on('turn.abort', traced);
  on('prompt.read', traced);
  on('tool.list', traced);
  on('command.list', traced);
  on('config.list', traced);
  on('agent.list', traced);
  on('ui.toast', traced);
  on('ui.status', traced);
  on('ui.invalidate', traced);
  on('ui.panes', traced);
  on('ui.blit', traced);
  on('fs.read', traced);
  on('fs.write', traced);
  on('fs.list', traced);
  on('fs.exists', traced);
  on('fs.stat', traced);
  on('fs.ancestors', traced);
  on('store.get', traced);
  on('store.set', traced);
  on('store.delete', traced);
  on('store.keys', traced);
  on('clock.now', traced);
  on('clock.sleep', traced);
  on('clock.after', traced);
  on('clock.every', traced);
  on('http.fetch', traced);
  on('process.run', traced);
  on('settings.read', traced);
  on('env.get', traced);
  on('env.set', traced);

  // --- combined tracing + answering hooks -------------------------------------
  on('plugin.register', onPluginRegister);
  on('session.start', onSessionStart);
  on('engine.create', onEngineCreate);
  on('ui.render', { component: 'Pane' }, onPaneRender);
  on('command.run', { command: 'modscope' }, async ($: $, e: E) => ({ text: await runCommand($, String(e?.args ?? '')) }));
  on('tool.call', { tool: 'mcp__modscope__modscope_query' }, async ($: $, e: E) => ({
    result: { content: [{ type: 'text', text: await queryTool($, e) }], isError: false },
  }));
}
