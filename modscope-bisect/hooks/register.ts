/**
 * modscope-bisect — companion to the modscope mod-debugger.
 *
 * One glob hook that answers `next.to(e, <tier>)` instead of `next(e)`: every
 * dispatch jumps past user-tier mods (target 'builtin', the default) or past
 * all mods (target 'core'). Links skipped this way show as `skipped` in
 * modscope's `next.trace` view, which is how you bisect: run the failing
 * action with bypass on, then read which mods were jumped over.
 *
 * `next.to` is refused at load for mods that are not seated via
 * prependPlugins/appendPlugins — this plugin intentionally fails to load in
 * the 'user' tier rather than pretend to work.
 *
 * `turn.step` is excluded: it is the streaming event and a non-generator hook
 * on it would break the stream.
 */

export function register(on: any, options: Record<string, unknown>): void {
  if (!options?.enabled) return;
  const target = options?.target;
  on('!turn.step', async ($: any, e: any, next: any) => {
    if (next.origin.plugin === 'modscope-bisect') return next(e);
    if (target === 'core') return next.to(e, 'core');
    return next.to(e, 'builtin');
  });
}
