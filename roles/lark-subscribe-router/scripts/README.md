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
# Single EventKey (positional for ergonomics)
node lark-source.js im.message.receive_v1 --as bot

# Multiple EventKeys via repeated flag
node lark-source.js \
  --event-key im.message.receive_v1 \
  --event-key im.message.reaction.created_v1 \
  --event-key im.message.reaction.deleted_v1 \
  --as bot

# Bounded run (CI / smoke testing)
node lark-source.js im.message.receive_v1 --max-events 1 --timeout 30s
```

### Flags

| Flag | Default | Description |
|---|---|---|
| `--event-key`, `-e` | (required, ≥1) | EventKey to subscribe to. Repeatable for multiple keys. First positional arg also accepted as EventKey for ergonomics. |
| `--as user\|bot\|auto` | `auto` | Identity passed through to lark-cli. |
| `--max-events N` | unlimited | Exit after N events received. |
| `--timeout D` | no timeout | Exit after duration D (e.g. `30s`, `2m`). |
| `--quiet` | off | Pass through to lark-cli. NOT recommended — silences the `ready` marker that the lark-event skill expects. |
| `-p key=value`, `--param key=value` | none | Pass through to lark-cli. Repeatable. |

### Register as a d-pi source

```ts
create_source({
  name: "lark-bot",
  command: "node",
  args: ["/abs/path/to/lark-source.js",
         "--event-key", "im.message.receive_v1",
         "--event-key", "im.message.reaction.created_v1",
         "--as", "bot"],
})
```

Then subscribe the router agent:

```ts
subscribe_source({ source_name: "lark-bot" })
```

Multiple EventKeys collapse into one d-pi source (single child
process, single meta header `sourceName="lark-bot"`, multiplexed
events). The router agent distinguishes events by `params.type`
inside each notification.

### Validation rules (no semantic filtering)

The bridge accepts every Lark event that has all required fields. It
does NOT filter by `message_type`, content, sender, chat, etc. — the
router agent decides what to do with each event.

Required fields (event is skipped + logged to stderr if missing):
- `type` (string)
- `chat_id` (oc_xxx)
- `message_id` (om_xxx)
- `sender_id` (ou_xxx)

### Mode = "steer" (always)

`params.mode = "steer"` for every emitted notification. Lark is
real-time user-facing input; the user is actively waiting for a
response, so we mirror TUI Ctrl+Enter (interrupt) rather than Enter
(queue).

### Exit / restart semantics

- One lark-cli subprocess per `--event-key`.
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