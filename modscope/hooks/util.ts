/**
 * Shared helpers: payload clipping, deep-diffing of frozen event snapshots,
 * secret redaction, and small format utilities.
 */

export const OWN = 'modscope';
export const PANE_ID = 'modscope';
export const STORE_KEY = 'modscope/state';

export type Json = Record<string, unknown>;

/** Cap a recorded payload for storage: strings shortened, depth and arrays bounded. */
export function cap(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > 2000 ? value.slice(0, 2000) + `\u2026(+${value.length - 2000}ch)` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth > 8) return '\u2026';
  if (Array.isArray(value)) {
    const out = value.slice(0, 50).map((v) => cap(v, depth + 1));
    if (value.length > 50) out.push(`\u2026(+${value.length - 50} items)` as unknown as never);
    return out;
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(value as Json)) out[k] = cap(v, depth + 1);
  return out;
}

const SECRET_KEY =
  /token|secret|passw|passwd|password|api[-_]?key|access[-_]?key|auth|cookie|credential|private[-_]?key|bearer|session[-_]?key/i;
const SECRET_VALUE =
  /sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

/** Deep-copy `value` with secret-looking keys and token-like strings masked. */
export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return SECRET_VALUE.test(value) ? value.replace(SECRET_VALUE, '\u27e8redacted\u27e9') : value;
  }
  if (typeof value !== 'object') return value;
  if (depth > 8) return '\u2026';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Json = {};
  for (const [k, v] of Object.entries(value as Json)) {
    out[k] = SECRET_KEY.test(k) ? '\u27e8redacted\u27e9' : redact(v, depth + 1);
  }
  return out;
}

/** JSON.stringify with a length cap; never throws. */
export function clip(value: unknown, max = 400): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return '\u27e8unserializable\u27e9';
  }
  if (text === undefined) return typeof value === 'undefined' ? 'undefined' : String(value);
  return text.length > max ? text.slice(0, max) + `\u2026(+${text.length - max}ch)` : text;
}

/** Paths whose values differ between two snapshots (`b` received after `a`). */
export function diffPaths(a: unknown, b: unknown, path = '', out: string[] = [], max = 12): string[] {
  if (out.length >= max) return out;
  if (Object.is(a, b)) return out;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') {
    out.push(path || '(root)');
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(path || '(root)');
    return out;
  }
  const keys = new Set([...Object.keys(a as Json), ...Object.keys(b as Json)]);
  for (const k of keys) {
    diffPaths((a as Json)[k], (b as Json)[k], path ? `${path}.${k}` : k, out, max);
    if (out.length >= max) {
      out[max - 1] = `${out[max - 1]} \u2026`;
      break;
    }
  }
  return out;
}

/** One-line summary of an event payload, tuned per event family. */
export function summarize(event: string, e: unknown, redactOn: boolean): string {
  const raw = (redactOn ? redact(e) : e) as Json | undefined;
  const j = (raw ?? {}) as Json;
  const s = (v: unknown, n = 80) => (typeof v === 'string' ? clip(v, n).slice(1, -1) || v : clip(v, n));
  try {
    switch (event) {
      case 'tool.call':
      case 'tool.check':
      case 'tool.describe':
        return `${j.tool ?? '?'} ${s(j.command ?? j.file_path ?? j.pattern ?? j.prompt ?? j.url ?? '')}`;
      case 'classic.PreToolUse':
        return `${j.tool_name ?? j.tool ?? '?'} ${s(j.command ?? '')}`;
      case 'command.run':
        return `/${j.command ?? '?'} ${s(j.args ?? '', 120)}`;
      case 'command.describe':
        return `/${j.command ?? '?'}`;
      case 'prompt.submit':
      case 'prompt.read':
      case 'prompt.fill':
        return s(j.text ?? j.value ?? '', 160);
      case 'ui.render':
        return `${j.component ?? '?'} @${j.surface ?? '?'}${j.requestId ? ` (${j.requestId})` : ''}`;
      case 'ui.resolve':
        return `${j.component ?? '?'} @${j.surface ?? '?'}`;
      case 'ui.press':
      case 'ui.focus':
        return `${j.plugin ?? '?'}.${j.element ?? j.id ?? '?'}`;
      case 'ui.open':
        return `pane ${j.id ?? '?'} ${s(j.title ?? '', 40)}`;
      case 'ui.close':
        return `pane ${j.id ?? '?'} ${j.origin ? `(${s(j.origin, 40)})` : ''}`;
      case 'ui.log':
        return s(j.text ?? '', 160);
      case 'ui.notice':
        return `${j.tool_use_id ?? ''} ${s(j.text ?? '', 120)}`;
      case 'ui.message':
        return clip(cap(raw), 200);
      case 'plugin.register':
        return `${j.name ?? '?'}@${j.provenance ?? '?'} [${j.tier ?? '?'}]`;
      case 'engine.create':
        return `plugin ${j.plugin ?? j.name ?? '?'}`;
      case 'session.start':
      case 'session.receive':
        return s(j.cwd ?? j.model ?? '', 120);
      case 'session.end':
        return s(j.reason ?? '', 120);
      case 'session.compact':
        return s(j.trigger ?? '', 120);
      case 'agent.spawn':
        return `${j.agent ?? j.type ?? '?'} ${s(j.prompt ?? j.description ?? '', 80)}`;
      case 'agent.offer':
        return s(j.agent ?? j.name ?? '', 80);
      case 'tool.register':
        return `mcp__${j.plugin ?? OWN}__${j.name ?? '?'}`;
      case 'command.register':
      case 'agent.register':
        return s(j.name ?? j.agent ?? '', 80);
      case 'config.set':
        return `${j.key ?? '?'} = ${s(j.value, 60)}`;
      case 'config.describe':
      case 'config.list':
        return s(j.key ?? '', 80);
      case 'store.set':
        return `${j.key ?? '?'}`;
      case 'store.get':
      case 'store.delete':
        return `${j.key ?? '?'}`;
      case 'fs.read':
      case 'fs.write':
      case 'fs.stat':
      case 'fs.exists':
      case 'fs.ancestors':
        return s(j.path ?? '', 120);
      case 'fs.list':
        return s(j.path ?? '', 120);
      case 'env.get':
      case 'env.set':
        return `${j.name ?? '?'}`;
      case 'http.fetch':
        return s(typeof j.request === 'object' && j.request ? (j.request as Json).url : j.url, 120);
      case 'process.run':
        return Array.isArray(j.argv) ? (j.argv as unknown[]).map(String).join(' ').slice(0, 120) : clip(raw, 120);
      case 'mcp.call':
        return `${j.server ?? '?'}.${j.tool ?? '?'}`;
      case 'model.complete':
      case 'model.classify':
      case 'model.fork':
        return s((j as Json).prompt ?? (j as Json).text ?? '', 120);
      case 'skill.prompt':
        return `/${j.skill ?? j.name ?? '?'}`;
      case 'turn.start':
      case 'turn.complete':
      case 'turn.abort':
        return s(j.agentId ?? '', 60);
      default:
        return clip(cap(raw), 200);
    }
  } catch {
    return clip(cap(raw), 200);
  }
}

/** HH:MM:SS.mmm timestamp for display. */
export function clock(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
