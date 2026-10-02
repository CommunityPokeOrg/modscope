import { describe, expect, test, tier } from 'claude-code/testing';

/* eslint-disable @typescript-eslint/no-explicit-any */

tier('user');

// The answers the engine would give beneath every plugin: stub the $ calls
// modscope itself makes (store persistence, registrations, status line).
const seen = { commands: [] as string[], tools: [] as string[] };

const stubCore = (on: any) => {
  on('session.id', () => ({ value: 'test-session' }));
  on('store.get', ($: any, e: any) => ({ value: e.key === 'modscope/state/blocklist' ? ['ghostmod'] : undefined }));
  on('store.set', () => ({ value: undefined }));
  on('command.register', ($: any, e: any) => {
    seen.commands.push(e.name);
    return { value: { command: e.name } };
  });
  on('tool.register', ($: any, e: any) => {
    seen.tools.push(e.name);
    return { value: { tool: `mcp__stub__${e.name}` } };
  });
  on('ui.status', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('ui.open', () => ({ value: undefined }));
  on('ui.log', () => ({ value: undefined }));
  on('clock.after', () => ({ value: undefined }));
};

const cmd = ($: any, args: string) =>
  $.command.run({ command: 'modscope', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } });

const start = async ($: any, on: any) => {
  on('session.start', ($2: any, e: any) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: '/tmp' });
};

describe('modscope', () => {
  test('registers /modscope and its query tool on session.start', async ($, on) => {
    stubCore(on);
    await start($, on);
    expect(seen.commands).toContain('modscope');
    expect(seen.tools).toContain('modscope_query');
  });

  test('traces a dispatch and attributes it to the calling mod', async ($, on) => {
    stubCore(on);
    on('tool.call', ($2: any, e: any) => ({ result: { stdout: 'ok' } }));
    await start($, on);
    await $.tool.call({ tool: 'Bash', tool_use_id: 't-1', command: 'ls -la' });
    const { text } = await cmd($, 'trace');
    expect(text).toContain('tool.call');
  });

  test('records an error when a hook beneath throws', { plugins: [
    {
      name: 'bomber',
      register(on2: any) {
        on2('tool.call', () => {
          throw new Error('kaboom');
        });
      },
    },
  ] }, async ($, on) => {
    stubCore(on);
    on('tool.call', ($2: any, e: any) => ({ result: { ok: true } }));
    await start($, on);
    // A hook's throw does not abort the dispatch: the link is skipped and the
    // chain continues — the trace record is where the failure shows.
    const r = await $.tool.call({ tool: 'Bash', tool_use_id: 't-2', command: 'oops' });
    expect(r).toEqual({ result: { ok: true } });
    const { text } = await cmd($, 'errors');
    // The trace names the failed link and its outcome; the thrown message
    // itself is an engine-side diagnostic, not carried in next.trace.
    expect(text).toContain('bomber');
    expect(text).toContain('skipped');
  });

  test('sees a mod rewriting the event it passes on', { plugins: [
    {
      name: 'rewriter',
      register(on2: any) {
        on2('tool.call', ($3: any, e: any, next: any) => next({ ...e, injected: 'x' }));
      },
    },
  ] }, async ($, on) => {
    stubCore(on);
    on('tool.call', ($2: any, e: any) => ({ result: { got: e.injected ?? null } }));
    await start($, on);
    await $.tool.call({ tool: 'Bash', tool_use_id: 't-3', command: 'echo hi' });
    const { text } = await cmd($, 'event 9999').catch(() => ({ text: '' }));
    const trace = await cmd($, 'trace tool.call');
    expect(trace.text).toContain('rewriter');
    expect(trace.text).toContain('injected');
  });

  test('blocklist persists and shows; registry records the mod', { plugins: [
    {
      name: 'badmod',
      register(on2: any) {
        on2('tool.call', ($3: any, e: any, next2: any) => next2(e));
      },
    },
  ] }, async ($, on) => {
    stubCore(on);
    on('tool.call', ($2: any, e: any) => ({ result: { ok: true } }));
    await start($, on);
    const { text } = await cmd($, 'list');
    expect(text).toContain('badmod');
    expect(text).toContain('allowed');
    // The seeded store blocklist (ghostmod) loads once $ binds; /modscope block
    // adds and persists. A refused inline plugin errors the test harness, so
    // refusal itself is covered by the badmod trace record, not an assertion.
    const { text: blocked } = await cmd($, 'blocklist');
    expect(blocked).toContain('ghostmod');
    await cmd($, 'block sneaky');
    const { text: blocked2 } = await cmd($, 'blocklist');
    expect(blocked2).toContain('sneaky');
    expect(blocked2).toContain('ghostmod');
  });

  test('the model tool answers summary/registry/trace/errors', async ($, on) => {
    stubCore(on);
    on('tool.call', ($2: any, e: any) => ({ result: { ok: true } }));
    await start($, on);
    await $.tool.call({ tool: 'Bash', tool_use_id: 't-5', command: 'ls' });
    const r: any = await $.tool.call({ tool: 'mcp__modscope__modscope_query', tool_use_id: 'q-1', kind: 'trace' });
    expect(r.result.isError).toBe(false);
    expect(r.result.content[0].text).toContain('tool.call');
  });

  test('the watch pane renders', async ($, on) => {
    stubCore(on);
    await start($, on);
    const { text } = await cmd($, 'watch');
    expect(text).toContain('pane');
    const ui = await $.ui.mount({
      plugin: 'modscope',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'modscope',
      props: {
        title: 'modscope',
        isFocused: true,
        bodyColumns: 100,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 24 },
        view: {},
      },
      viewport: { columns: 120, rows: 40, isFullscreen: true },
    });
    const found = await ui.find({ type: 'Text', text: /modscope/ });
    expect(found).toBeTruthy();
  });
});
