# scripts/

Auxiliary scripts that bridge external systems into d-pi sources.

This directory is part of the `lark-subscribe-router` role. Files
here are operational helpers, not LLM-callable skills.

## `lark-source.js`

Bridges one or more `lark-cli event consume <EventKey>` streams to
d-pi source JSON-RPC 2.0 notifications.

### Contract

**Input** (lark-cli stdout, NDJSON):
```json
{"type":"im.message.receive_v1","event_id":"evt_001","chat_id":"oc_xxx",
 "sender_id":"ou_xxx","message_id":"om_xxx","message_type":"text",
 "content":"...","create_time":"..."}
```

**Output** (bridge stdout, one JSON-RPC 2.0 notification per line):
```json
{"jsonrpc":"2.0","method":"events.emit",
 "params":{"type":"im.message.receive_v1","id":"evt_001",
            "data":{...full original event...},
            "mode":"steer"}}
```

Stderr is prefixed with the EventKey and passed through (lark-cli's
`ready` markers, d-pi supervisor logs, validation warnings) — never
mixes with stdout.

### Usage

```bash
# Default: subscribe to ALL events the app has registered
# (queries `lark-cli event list --json` at startup)
node lark-source.js --as bot

# Subscribe to specific events only
node lark-source.js --event-key im.message.receive_v1 \
                    --event-key im.message.reaction.created_v1 \
                    --as bot

# Backward-compat: single EventKey as positional arg
node lark-source.js im.message.receive_v1 --as bot

# Bounded run (CI / smoke testing)
node lark-source.js im.message.receive_v1 --max-events 1 --timeout 30s
```

### Flags

| Flag | Default | Description |
|---|---|---|
| `--event-key`, `-e` | dynamic discovery | EventKey to subscribe to. Repeatable for multiple keys. First positional arg also accepted as EventKey for ergonomics. If none given, runs `lark-cli event list --json` at startup and subscribes to everything the app has registered. |
| `--as user\|bot\|auto` | `auto` | Identity passed through to lark-cli. For the bridge, `bot` is the typical choice since Lark delivers events to the bot identity. |
| `--max-events N` | unlimited | Exit after N events received. |
| `--timeout D` | no timeout | Exit after duration D (e.g. `30s`, `2m`). |
| `--quiet` | off | Pass through to lark-cli. NOT recommended — silences the `ready` marker that the lark-event skill expects. |
| `-p key=value`, `--param key=value` | none | Pass through to lark-cli. Repeatable. |

### EventKey resolution (in order)

1. All `--event-key` flags → use exactly those
2. First positional arg (backward compat) → treat as EventKey
3. NONE of the above → spawn `lark-cli event list --json`, parse,
   subscribe to every EventKey the app has registered

### Register as a d-pi source

The typical (recommended) call — subscribe to all events the app
has registered:

```ts
create_source({
  name: "lark-bot",
  command: "node",
  args: ["/abs/path/to/lark-source.js", "--as", "bot"],
})
```

If you want to subscribe to only specific events (skip reactions, etc.):

```ts
create_source({
  name: "lark-bot",
  command: "node",
  args: ["/abs/path/to/lark-source.js",
         "--event-key", "im.message.receive_v1",
         "--as", "bot"],
})
```

Then subscribe the router agent:

```ts
subscribe_source({ source_name: "lark-bot" })
```

The bridge multiplexes events from multiple EventKeys onto one d-pi
source (single child process, single meta header
`sourceName="lark-bot"`). The router agent distinguishes events by
`params.type` inside each notification.

### Validation rules (noise filter only — NOT event filter)

This bridge is a **protocol converter**, not an event filter. Every
valid Lark event passes through verbatim, regardless of type,
schema, or what fields it has. The validation here exists only to
skip lark-cli stdout noise lines that aren't events at all.

Rejected (logged to stderr):
- Not valid JSON
- Valid JSON but missing `type` field (i.e. not a Lark event)

Accepted (passed through as-is, including events with no
chat_id / message_id / sender_id):
- `im.message.receive_v1` — IM messages
- `im.message.reaction.created_v1` / `deleted_v1` — reactions (no
  chat_id / sender_id)
- `im.chat.member.added_v1` / `removed_v1` — chat membership
  (no message_id)
- `calendar.event.created_v1` — calendar events (totally different
  schema)
- `task.task.created_v1` etc. — any other Lark event type

If you need to filter by event kind (e.g. only forward IM messages,
not reactions), do that in the **router agent** by checking
`params.data.type` — not in this bridge.

### Mode = "steer" (always)

`params.mode = "steer"` for every emitted notification. Lark is
real-time user-facing input; the user is actively waiting for a
response, so we mirror TUI Ctrl+Enter (interrupt) rather than Enter
(queue).

### Exit / restart semantics

- One lark-cli subprocess per EventKey (queried from
  `lark-cli event list --json` when no `--event-key` is given, or
  taken from `--event-key` flags).
- Bridge exits when all subprocesses have exited.
- Final exit code: first non-zero among subprocesses, or 0 if all
  clean.
- `--timeout` / `--max-events` produce clean exit 0 — use these for
  bounded runs.
- Any non-zero exit triggers d-pi's source supervisor to restart
  the source with exponential backoff (see
  `packages/d-pi/src/hub/source-manager.ts`).

### Multi-EventKey observability

- Stdout is one merged NDJSON-of-JSON-RPC stream — consumers see
  events from all EventKeys interleaved.
- Stderr is prefixed with `[lark-source/<EventKey>]` so per-key logs
  are distinguishable.
- Subprocess exit codes are logged per-key.

### Why this script exists

The router agent (`roles/lark-subscribe-router/AGENTS.md`) only sees
d-pi source output. The d-pi source contract is JSON-RPC 2.0
notifications. `lark-cli event consume` outputs raw Lark NDJSON
events. This bridge converts between the two formats so the router
can stay Lark-agnostic and only this script needs to know about
lark-cli's output shape.

### Reference

- d-pi source validator: `packages/d-pi/src/hub/source-validator.ts`
  (`validateLine`, `JsonRpcMessage`)
- d-pi SourceManager: `packages/d-pi/src/hub/source-manager.ts`
  (mode coercion, broadcast pipeline)
- lark-cli event skill: `~/.agents/skills/lark-event/SKILL.md`