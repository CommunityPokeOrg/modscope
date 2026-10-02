# modscope

A Claude Code [mod](https://claude.com/blog/claude-code-mods) for debugging
other mods: it sits in the hook chain and records every event dispatch with
per-mod attribution, so you can see which mod rewrote, denied, refused or
broke a call — and reproduce it.

The repo is a plugin marketplace with two plugins:

| plugin | purpose |
|---|---|
| `modscope` | the debugger: registry, trace, errors, logs, watch pane, recording & replay export, blocklist |
| `modscope-bisect` | optional companion: routes every event past user-tier mods (`next.to`) to bisect a culprit. Only usable when seated in `prependPlugins`/`appendPlugins` — `next.to` is refused at load for ordinary mods. |

## Install

```text
/plugin marketplace add CommunityPokeOrg/modscope
/plugin install modscope@communitypoke
```

For local development (loads the plugin from this checkout):

```sh
claude --plugin-dir ./modscope
```

Recommended seating: add `"modscope"` to `prependPlugins` in
`~/.claude/settings.json` so the tracer wraps **all** other mods rather than
only the ones beneath it in the user tier. It works at the default user tier
too, tracing every dispatch it sits beneath.

## Usage

`/modscope` with no argument prints help. Subcommands:

```text
/modscope list                  loaded mods, load order, tier, refused mods
/modscope mod <name>            one mod's declared hooks and $ calls
/modscope trace [n] [filter]    recent dispatches with per-link attribution
/modscope event <seq>           full per-link breakdown of one dispatch
/modscope errors                mod hook failures / budget expiries / drops
/modscope logs [mod]            ui.log / ui.notice lines, by origin mod
/modscope watch                 live trace pane (Esc to close)
/modscope pause | resume        stop/start recording (dispatches unaffected)
/modscope verbose [on|off]      also trace $ op calls (fs, store, env, ...)
/modscope block <name>          refuse a mod at its next plugin.register
/modscope unblock <name>
/modscope blocklist             show blocked names
/modscope rec [/modscope rec stop]   record full payloads for replay
/modscope export [name]         write <name>.json + a replay .test.ts scaffold
/modscope doctor [mod]          run `claude plugin validate` on a mod's root
/modscope clear                 drop in-memory trace/errors/logs
/modscope status                counters and flags
```

Claude itself can query the same data through the `mcp__modscope__modscope_query`
tool the plugin registers — ask it "which mod denied that tool call" and it can
look at the trace instead of guessing.

### Reading the trace

Each dispatch shows one line per chain link (a mod's hook, or `engine`):

```text
#17 14:02:11.309 tool.call  blowfish[user]  12ms => {result}
   blowfish     wrote command,description
   promptguard  returned {deny}  answered here
```

`changed` fields on a link are computed by diffing what that hook received
against what the *next* link received — i.e. what the hook rewrote on the way
down. A link that answers without calling `next()` is marked `answered here`.
`skipped` / `expired` / `rejected` links land in `/modscope errors`.

### Reproducing a failure

1. `/modscope rec` — run the failing action — `/modscope rec stop`.
2. `/modscope export repro` writes `repro.json` (full captured dispatches) and
   `repro.test.ts` — a `claude plugin test` scaffold where each recorded
   dispatch is stubbed with the result the chain produced live. Drop it into a
   plugin's `tests/` dir, hook the event under test, and iterate.

### Bisecting

Install `modscope-bisect`, set its `enabled` option to `true`, and seat it in
`prependPlugins` (or `appendPlugins`) in `~/.claude/settings.json`. Every event
then jumps to `builtin` (default) or `core` past user mods; skipped links show
up in the trace so you can read exactly what was bypassed. Disable it to
restore the chain.

For same-session bisect without a managed seat, `/modscope block <name>` +
reload also narrows the culprit.

## Plugin options (`userConfig` in plugin.json)

| option | default | effect |
|---|---|---|
| `trace_max` | 150 | in-memory ring size for dispatches (10–5000) |
| `trace_api_calls` | false | start in verbose mode (trace `$` op calls too) |
| `redact` | true | redact secrets-looking fields from captured payloads |
| `blocklist` | `[]` | mod names refused at `plugin.register`. Unlike `/modscope block`, this is enforced even for mods in the same cold-start batch — options are read in `register()` before any `$` call can run. |

## Development

```sh
npm install                    # typescript only (dev-time typecheck)
npm run validate               # claude plugin validate modscope
npm test                       # claude plugin test modscope
npm run typecheck              # tsc --noEmit
```

`vendor/claude-code.d.ts` is a vendored copy of the mod API types, for
typechecking only — the runtime provides `claude-code` / `claude-code/testing`.

## Verified vs. unverified

Verified by `claude plugin validate` + `claude plugin test` (offline, real
engine host) and the shipped `claude-code` type surface:

- hook/module conventions: `register(on, options)`, matcher literal patterns,
  per-event handler typing, `next.trace` shape (nearest-beneath-first, engine
  last), outcomes (`passed`, `returned`, `skipped`, `rejected`, `expired`,
  `caught`, `kept`), `plugin.register` `{refuse}` verdicts.
- the loader's static scan: one matcher-less `on()` per event per module,
  `next.to` restricted to managed (prepend/append) seats at *load* time, `$`
  must be spelled `$.noun.event(...)` and only flow into same-file functions
  (hence the single-file `register.ts`), `next.to` takes a literal tier.
- during `plugin.register` a plugin's `$` nouns are not bound yet
  (`$.store` is absent) — the store probe retries until bound, which is why
  manifest-option blocklisting is the only cold-start refusal path.
- a hook that throws does not abort the dispatch: its link is marked
  `skipped` and the chain continues; the error text is an engine-side
  diagnostic and is **not** carried in `next.trace` — modscope records *which*
  link failed and its outcome, not the message.
- `turn.step` is the only streaming event and needs an `async function*` hook
  (`yield* next(e)`); `modscope-bisect` deliberately does not hook it.
- element constructors take children inside `props` (`props.children`), not as
  rest args.
- `mcp__<plugin>__<name>` tools via `$.tool.register` + a `tool.call` matcher
  hook; `/modscope` via `$.command.register` + a `command.run` matcher hook;
  pane via `$.ui.open` + a `ui.render` `{component:'Pane'}` matcher returning
  an element tree.

Unverified / scoped out (documented rather than faked):

- The **cold-start** refusal of a mod that registers *before* modscope in load
  order is impossible — its `plugin.register` has already been decided. Order
  within a tier is the host's; seat `modscope` in `prependPlugins` for maximal
  coverage.
- Hook error **text**: see above — only outcome is observable from a mod.
- `telemetry.*` events need `{to:'collector'}` addressing and are left
  untouched deliberately.
- `modscope-bisect` on real loads: verified to validate, and `next.to`
  mechanics are per the shipped types; exercising it end-to-end needs a managed
  seat, which the test harness can't fully emulate (a refused inline plugin
  aborts the test).

## License

MIT
