# scripts/

Auxiliary scripts that bridge external systems into d-pi sources.

This directory is part of the `lark-subscribe-router` role. Files
here are operational helpers, not LLM-callable skills.

## `lark-source.js`

Bridges `lark-cli event consume <EventKey>` output to d-pi source
JSON-RPC 2.0 notifications.

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
            "mode":"next"}}
```

Stderr is passed through (lark-cli's `ready` markers, d-pi supervisor
logs, validation warnings) — never mixes with stdout.

### Register as a d-pi source

Once the role is loaded by a d-pi workspace, run (from the
`create_source` tool or `.dpi/...` config):

```ts
create_source({
  name: "lark-bot",
  command: "node",
  args: ["/abs/path/to/lark-source.js",
         "im.message.receive_v1",
         "--as", "bot"],
})
```

Then subscribe the router agent to it:

```ts
subscribe_source({ source_name: "lark-bot" })
```

### Filtering which events to forward

By default the bridge forwards every validated Lark event. To filter
server-side at the source level (cheaper than dropping in the router):

- Use `lark-cli`'s `--jq` flag (passed through `--param` only partially;
  best to fork the bridge if you need it).
- Or fork this script and adjust `validateEvent` to drop specific
  `type`s or `message_type`s before they reach the router.

### Validation rules

The bridge rejects events missing:

- `type` (event key)
- `chat_id` starting with `oc_`
- `message_id` starting with `om_`
- `sender_id` starting with `ou_`

Rejected events are logged to stderr and skipped (do not crash the
bridge).

### Mode

`mode: "next"` (queue at agent's next turn) by default. To make
specific event types urgent (interrupt agent mid-turn with `"steer"`),
override `toNotification()` in a fork.

### Exit / restart semantics

- Bridge exits with the same code as lark-cli.
- lark-cli `--timeout` / `--max-events` produce a clean exit 0 — use
  these for bounded runs.
- Any non-zero exit triggers d-pi's source supervisor to restart
  the source with exponential backoff (see
  `packages/d-pi/src/hub/source-manager.ts`).

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