/**
 * Plain-text renderers shared by the /modscope command and the
 * mcp__modscope__modscope_query tool.
 */

import { clock, clip } from './util';
import { flags, state, blockedNames, type TraceRec, type RecordedDispatch } from './state';

const OUTCOME_GLYPH: Record<string, string> = {
  passed: '  ',
  returned: '=>',
  rejected: 'xx',
  expired: '!!',
  caught: 'cc',
  kept: 'kk',
  skipped: '--',
};

export function formatRegistry(): string {
  if (!state.registry.length) {
    return 'No mods recorded yet. modscope sees mods that load after it; seat it in `prependPlugins` to catch them all.';
  }
  const lines = ['order  mod                          tier     provenance            events  calls  verdict'];
  for (const r of state.registry) {
    const name = `${r.name}${r.version ? `@${r.version}` : ''}`.slice(0, 28).padEnd(28);
    lines.push(
      `${String(r.order).padStart(4)}   ${name} ${r.tier.padEnd(8)} ${r.provenance.slice(0, 20).padEnd(20)} ${String(r.events.length).padStart(5)} ${String(r.calls.length).padStart(6)}  ${r.outcome}${r.refusedBy ? ` by ${r.refusedBy}` : ''}`,
    );
  }
  return lines.join('\n');
}

export function formatRegistryDetail(name: string): string {
  const r = state.registry.find((m) => m.name === name);
  if (!r) return `No mod named "${name}" in the registry. Try /modscope list.`;
  const lines = [
    `${r.name}${r.version ? ` v${r.version}` : ''} — ${r.outcome}${r.refusedBy ? ` by ${r.refusedBy}` : ''}`,
    `  tier:       ${r.tier}   (load order #${r.order})`,
    `  provenance: ${r.provenance}`,
    `  root:       ${r.root}`,
    `  hooks:      ${r.events.length ? r.events.join(', ') : '(none)'}`,
    `  $ calls:    ${r.calls.length ? r.calls.join(', ') : '(none)'}`,
  ];
  if (r.env && (r.env.reads.length || r.env.writes.length)) {
    lines.push(`  env:        reads ${r.env.reads.join(', ') || '-'}; writes ${r.env.writes.join(', ') || '-'}`);
  }
  return lines.join('\n');
}

function formatLink(l: TraceRec['links'][number]): string {
  const g = OUTCOME_GLYPH[l.outcome] ?? '??';
  const bits = [`${g} ${l.plugin}[${l.tier}] ${l.outcome} ${l.ms}ms`];
  if (l.chunks != null) bits.push(`${l.chunks} chunks`);
  if (l.changed.length) bits.push(`wrote ${l.changed.join(', ')}`);
  if (l.answeredEarly) bits.push('ANSWERED HERE');
  if (l.skipped) bits.push('skipped');
  if (l.reason) bits.push(`— ${l.reason}`);
  return `    ${bits.join('  ')}`;
}

export function formatTrace(limit = 12, filter = ''): string {
  let rows = state.trace.slice();
  if (filter) rows = rows.filter((r) => r.event.includes(filter) || r.origin.plugin.includes(filter) || r.input.includes(filter));
  rows = rows.slice(-limit);
  if (!rows.length) return filter ? `No traced dispatches match "${filter}".` : 'Nothing traced yet.';
  const out: string[] = [`${rows.length} of ${state.trace.length} traced dispatches (newest last)${flags.paused ? ' — PAUSED' : ''}`];
  for (const r of rows) {
    const head = `#${r.seq} ${clock(r.at)} ${r.event.padEnd(18)} ${r.origin.plugin !== 'engine' ? `${r.origin.plugin}[${r.origin.tier}]` : 'engine'} ${r.ms}ms ${r.bypassed ? '[bypassed] ' : ''}=> ${r.result}`;
    out.push(head);
    if (r.input) out.push(`    in: ${r.input}`);
    const interesting = r.links.filter((l) => l.outcome !== 'passed' || l.changed.length || l.answeredEarly);
    for (const l of interesting) out.push(formatLink(l));
    const passed = r.links.length - interesting.length;
    if (passed > 0) out.push(`    (${passed} link${passed === 1 ? '' : 's'} passed clean)`);
  }
  return out.join('\n');
}

export function formatEvent(seq: number): string {
  const r = state.trace.find((t) => t.seq === seq);
  if (!r) return `No dispatch #${seq} in the trace. Try /modscope trace.`;
  const lines = [
    `#${r.seq} ${r.event} @ ${clock(r.at)}  — ${r.ms}ms, settled ${r.result}${r.bypassed ? ' (bypassed to builtin)' : ''}`,
    `  origin: ${r.origin.plugin} [${r.origin.tier}]`,
    `  in:     ${r.input}`,
    '  chain:',
  ];
  for (const l of r.links) lines.push(formatLink(l));
  const rec = state.recorded.find((d) => d.seq === seq);
  if (rec) lines.push(`  recorded: full payload in the recording buffer (/modscope export)`);
  else lines.push('  recorded: no (run /modscope rec to capture full payloads)');
  return lines.join('\n');
}

export function formatErrors(): string {
  if (!state.errors.length) return 'No mod errors recorded.';
  const lines = [`${state.errors.length} error${state.errors.length === 1 ? '' : 's'} recorded:`];
  for (const e of state.errors.slice(-25)) {
    lines.push(`  ${clock(e.at)} ${e.event.padEnd(16)} ${e.plugin}${e.tier ? `[${e.tier}]` : ''} ${e.outcome}${e.reason ? ` — ${e.reason.slice(0, 140)}` : ''}${e.seq ? `  (#${e.seq})` : ''}`);
  }
  return lines.join('\n');
}

export function formatLogs(plugin?: string): string {
  const rows = plugin ? state.logs.filter((l) => l.plugin === plugin) : state.logs;
  if (!rows.length) return plugin ? `No captured log lines from ${plugin}.` : 'No captured log lines yet. (ui.log/ui.notice calls are captured.)';
  return rows
    .slice(-50)
    .map((l) => `  ${clock(l.at)} ${l.plugin.padEnd(20)} [${l.sink}] ${l.text.slice(0, 140)}`)
    .join('\n');
}

export function formatStatus(): string {
  const lines = [
    `modscope — seated [${state.ownTier ?? 'unknown'}]${flags.paused ? ' paused' : ''}`,
    `  trace:    ${state.trace.length} dispatches (cap ${clip(state.trace.length ? traceCap() : 0)})`,
    `  registry: ${state.registry.length} mods (${state.registry.filter((r) => r.outcome === 'refused').length} refused)`,
    `  errors:   ${state.errors.length}`,
    `  logs:     ${state.logs.length} lines`,
    `  verbose:  ${flags.verbose ? 'on' : 'off'}  recording: ${flags.recording ? `on (${state.recorded.length} captured)` : 'off'}`,
  ];
  if (blockedNames().length) lines.push(`  blocked:  ${blockedNames().join(', ')}`);
  if (state.faults.length) lines.push(`  internal faults: ${state.faults.slice(-3).join(' | ')}`);
  return lines.join('\n');
}

function traceCap(): number {
  return state.trace.length;
}

export const HELP = `modscope — debug other mods. Commands:

  /modscope list                  loaded mods, tiers, load order, declared hooks
  /modscope mod <name>            one mod's declared hooks, $ calls, env use
  /modscope trace [n] [filter]    recent dispatches with per-mod attribution
  /modscope event <seq>           full detail for one traced dispatch
  /modscope errors                mods that threw, timed out, or were skipped
  /modscope logs [mod]            ui.log / ui.notice lines by origin mod
  /modscope watch                 open the live trace pane
  /modscope pause | resume        stop/start tracing (dispatches unaffected)
  /modscope verbose [on|off]      also trace noisy $ op calls (fs, store, ...)
  /modscope bypass                how to bisect mods (modscope-bisect plugin)
                                  skips user mods — bisect a culprit fast
  /modscope block <name>          refuse a mod at plugin.register (next load)
  /modscope unblock <name>
  /modscope blocklist             show blocked names
  /modscope rec | rec stop        capture full event payloads for replay
  /modscope export [file]         write recording JSON + replay test scaffold
  /modscope doctor <name>         run \`claude plugin validate\` on a mod's root
  /modscope clear                 drop in-memory trace/errors/logs
  /modscope status                counters and flags
  /modscope help                  this text

Claude can also query the trace itself via the mcp__modscope__modscope_query tool.`;

/** A replay scaffold: each recorded dispatch becomes a stub-answer test. */
export function replayScaffold(recorded: RecordedDispatch[]): string {
  const rows = recorded.map((d) => ({
    event: d.event,
    origin: d.origin,
    received: d.received,
    result: d.result,
    error: d.error,
  }));
  return `import { describe, expect, test } from 'claude-code/testing';

// Replay scaffold exported by modscope — ${rows.length} recorded dispatches.
// The stub answers each event with the result the chain produced live;
// hook the same event in the mod under test to reproduce the failure,
// or delete the stub to let the engine handle it.
const RECORDED = ${JSON.stringify(rows, null, 2)};

describe('modscope replay', () => {
  for (const r of RECORDED) {
    test(\`\${r.event} (from \${r.origin.plugin})\`, async ($, on) => {
      on(r.event, () => r.result);
      const [noun, verb] = r.event.split('.');
      if (!verb || !($[noun] && typeof $[noun][verb] === 'function')) return;
      if (r.error) {
        await expect($[noun][verb](r.received)).rejects.toThrow();
      } else {
        await $[noun][verb](r.received);
      }
    });
  }
});
`;
}
