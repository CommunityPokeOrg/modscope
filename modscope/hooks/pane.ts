/**
 * The `/modscope watch` pane: a live tail of the trace with per-link outcomes.
 * Pure builder — the register module passes the resolved element table, the
 * data, and the action closures (whose $ calls must stay in that file).
 */

import { clock } from './util';
import { flags, state } from './state';
import type { TraceRec } from './state';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PaneActions {
  togglePause: () => void;
  clear: () => void;
  showErrors: () => void;
}

export function statusLine(): string {
  const parts = [`modscope ${state.trace.length}tr`];
  if (state.errors.length) parts.push(`${state.errors.length}err`);
  if (flags.recording) parts.push('\u25cf rec');
  if (flags.paused) parts.push('paused');
  return parts.join(' \u00b7 ');
}

export function buildPane(els: Record<string, (p: any) => unknown>, actions: PaneActions): unknown {
  const { Box, Text, Button } = els;
  const rows: TraceRec[] = state.trace.slice(-24);
  const children: unknown[] = [];

  // Element constructors take a single props object; children ride in
  // props.children (JSX `h` merges rest args there for us only under JSX).
  const t = (props: Record<string, unknown>, text: string) => Text({ ...props, children: text });

  children.push(t({ color: 'cyan', bold: true }, ' modscope — live trace'));
  children.push(t({ dimColor: true }, ` ${statusLine()}  (newest at bottom)`));
  children.push(t({ dimColor: true }, ' '));

  if (!rows.length) {
    children.push(t({ dimColor: true }, ' nothing traced yet'));
  }
  for (const r of rows) {
    const bad = r.links.some((l) => l.outcome === 'rejected' || l.outcome === 'expired');
    const head = `#${r.seq} ${clock(r.at)} ${r.event} ${r.origin.plugin !== 'engine' ? r.origin.plugin : ''} ${r.ms}ms ${r.bypassed ? '[bypass] ' : ''}${r.result}`;
    children.push(t({ color: bad ? 'red' : undefined, wrap: 'truncate' }, head));
    for (const l of r.links) {
      if (l.outcome === 'passed' && !l.changed.length && !l.answeredEarly) continue;
      const note = [
        l.outcome !== 'passed' ? l.outcome : '',
        l.changed.length ? `wrote ${l.changed.slice(0, 3).join(',')}` : '',
        l.answeredEarly ? 'answered here' : '',
        l.reason ? l.reason.slice(0, 60) : '',
      ]
        .filter(Boolean)
        .join(' ');
      children.push(
        t(
          {
            dimColor: l.outcome === 'passed',
            color: l.outcome === 'rejected' || l.outcome === 'expired' ? 'red' : undefined,
            wrap: 'truncate',
          },
          `   ${l.plugin} ${note}`,
        ),
      );
    }
  }

  const controls: unknown[] = [
    Button({ key: 'pause', label: flags.paused ? 'Resume' : 'Pause', hotkey: 'p', dimColor: true, onPress: actions.togglePause }),
    Button({ key: 'clear', label: 'Clear', hotkey: 'c', dimColor: true, onPress: actions.clear }),
    Button({ key: 'errors', label: `Errors (${state.errors.length})`, hotkey: 'e', dimColor: true, onPress: actions.showErrors }),
  ];
  children.push(t({ dimColor: true }, ' '));
  children.push(Box({ flexDirection: 'row', gap: 2, children: controls }));

  return Box({ flexDirection: 'column', paddingLeft: 1, children });
}
