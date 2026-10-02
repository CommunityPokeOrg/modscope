/**
 * Mod state: in-memory rings for the live trace/log feed, plus the durable
 * slice (flags, blocklist, registry, errors, recordings) the register module
 * mirrors to $.store. Pure data — nothing here takes $ (the loader requires
 * $ to stay inside the module file that calls it).
 */

export interface Flags {
  paused: boolean;
  verbose: boolean;
  recording: boolean;
}

export interface OriginRef {
  plugin: string;
  tier: string;
}

export interface LinkRec {
  plugin: string;
  tier: string;
  outcome: string;
  reason?: string;
  ms: number;
  chunks?: number;
  /** Event fields this link rewrote, seen from the next link's `received`. */
  changed: string[];
  /** This link answered without passing the event on (chain ended here). */
  answeredEarly?: boolean;
  /** This link was skipped by a `next.to` jump (bypass). */
  skipped?: boolean;
}

export interface TraceRec {
  seq: number;
  at: number;
  event: string;
  origin: OriginRef;
  ms: number;
  input: string;
  /** 'ok' | '{deny}' | '{refuse}' | 'rejected' | ... — how the dispatch settled. */
  result: string;
  links: LinkRec[];
  bypassed?: boolean;
}

export interface ErrorRec {
  at: number;
  seq?: number;
  event: string;
  plugin: string;
  tier?: string;
  outcome: string;
  reason?: string;
}

export interface RegistryRec {
  order: number;
  at: number;
  name: string;
  tier: string;
  root: string;
  version?: string;
  provenance: string;
  events: string[];
  calls: string[];
  env?: { reads: string[]; writes: string[] };
  outcome: 'allowed' | 'refused';
  refusedBy?: string;
}

export interface LogRec {
  at: number;
  plugin: string;
  sink: string;
  text: string;
}

export interface RecordedLink {
  plugin: string;
  tier: string;
  outcome: string;
  reason?: string;
  received: unknown;
  returned: unknown;
}

export interface RecordedDispatch {
  at: number;
  seq: number;
  event: string;
  origin: OriginRef;
  received: unknown;
  links: RecordedLink[];
  result?: unknown;
  error?: string;
}

export const LIMITS = { trace: 150, errors: 50, logs: 200, recorded: 40 };

export const flags: Flags = { paused: false, verbose: false, recording: false };

export const state = {
  /** Our own seat, learned from our own `plugin.register` event. */
  ownTier: undefined as string | undefined,
  sessionId: undefined as string | undefined,
  paneOpen: false,
  seq: 0,
  loadOrder: 0,
  trace: [] as TraceRec[],
  errors: [] as ErrorRec[],
  logs: [] as LogRec[],
  registry: [] as RegistryRec[],
  recorded: [] as RecordedDispatch[],
  /** Internal faults in modscope itself (never breaks a dispatch). */
  faults: [] as string[],
  options: {} as Record<string, unknown>,
};

export function ring<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

// ---------------------------------------------------------------------------
// Blocklist (plain data; persistence lives in the module file)
// ---------------------------------------------------------------------------

const blocklist = new Set<string>();

export function isBlocked(name: string): boolean {
  return blocklist.has(name);
}

export function block(name: string): boolean {
  if (blocklist.has(name)) return false;
  blocklist.add(name);
  return true;
}

export function unblock(name: string): boolean {
  return blocklist.delete(name);
}

export function blockedNames(): string[] {
  return [...blocklist].sort();
}

export function loadBlocklist(names: string[]): void {
  for (const n of names) blocklist.add(n);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export function option<T>(name: string, fallback: T): T {
  const v = state.options[name];
  return v === undefined ? fallback : (v as T);
}

export function traceMax(): number {
  const n = option('trace_max', LIMITS.trace);
  return typeof n === 'number' && n > 0 ? Math.min(n, 5000) : LIMITS.trace;
}

export function redactOn(): boolean {
  return state.options['redact'] !== false;
}
