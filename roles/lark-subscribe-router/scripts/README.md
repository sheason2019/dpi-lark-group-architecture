# scripts/

Auxiliary scripts that bridge external systems into d-pi sources.

This directory is part of the `lark-subscribe-router` role. Files
here are operational helpers, not LLM-callable skills.

The `package.json` here is a local Node project (private, scoped
to this directory). `npm install --ignore-scripts` brings in
`@larksuiteoapi/node-sdk`. `node_modules/` and `package-lock.json`
are gitignored.

## The bridge: `lark-source-sdk.js`

The single supported bridge. Reads `LARK_APP_ID` and `LARK_APP_SECRET`
from the process env (injected by d-pi `create_source.env` at
spawn time — never hardcoded, never persisted to disk), discovers
EventKeys via `lark-cli event list --json`, then opens a single
WebSocket connection via the official Node SDK and emits one
JSON-RPC 2.0 notification per incoming event.

### Why this exists

lark-cli 1.0.51's event bus daemon hardcodes the `feishu-websocket`
source name regardless of the app's brand config. Lark-international
apps get "Incorrect domain name" and the bus immediately exits. The
official Node SDK's `WSClient` reads the app's tenant metadata and
picks the right WebSocket domain, so it works for both Lark and
Feishu apps. The SDK also accepts an explicit `domain` override
(`Lark.Domain.Feishu` or `Lark.Domain.Lark`) — the bridge maps
`LARK_BRAND` to that enum so the domain matches the app's
registration (cross-registration requests 401).

### Configuration

| Env var | Required | Description |
|---|---|---|
| `LARK_APP_ID` | yes | App id, e.g. `cli_a91bf7a326b85bc8` |
| `LARK_APP_SECRET` | yes | App secret (tenant mode). Injected by `create_source.env`; never committed. |
| `LARK_BRAND` | no | `lark` (default) or `feishu`. Mapped to the SDK's `Lark.Domain` enum to pick the WebSocket endpoint. Must match the app's tenant registration. |
| `LARK_LOG_LEVEL` | no | `debug` / `info` / `warn` / `error` (default `warn`). NOTE: the SDK enum is lowercase; `DEBUG` (uppercase) is silently ignored. |
| `LARK_EVENT_DENYLIST` | no | Comma-separated EventKey blacklist. Denied EventKeys are NOT registered with the WSClient — they never reach d-pi. Use to mute auto-triggered events that aren't conversation signals (read receipts, reactions, ...). Literal `*` mutes everything (temporary mute). Unset = subscribe to all EventKeys the app has registered. Example: `im.message.message_read_v1,im.message.reaction.created_v1`. |

### Install (one-time)

```bash
cd roles/lark-subscribe-router/scripts
npm install --ignore-scripts
```

`--ignore-scripts` per the workspace's security policy (AGENTS.md:
never run lifecycle scripts unless asked). The SDK has no
install-time hooks.

### Register as a d-pi source

```ts
create_source({
  name: "lark-bot",
  command: "node",
  args: ["/abs/path/to/roles/lark-subscribe-router/scripts/lark-source-sdk.js"],
  env: {
    LARK_APP_ID: "<app_id>",
    LARK_APP_SECRET: "<app_secret>",
    LARK_BRAND: "feishu",            // or "lark" — match app's registration
    LARK_LOG_LEVEL: "warn",
    LARK_EVENT_DENYLIST: "im.message.message_read_v1,im.message.reaction.created_v1,im.message.reaction.deleted_v1",
  },
});
```

Then subscribe the router agent:

```ts
subscribe_source({ source_name: "lark-bot" })
```

### Stdout / stderr contract

- **stdout**: one JSON-RPC 2.0 notification per line (NDJSON-of-JSON-RPC):
  ```json
  {
    "jsonrpc": "2.0",
    "method": "events.emit",
    "params": {
      "type": "<EventKey>",
      "id":   "<event_id|message_id|id>",
      "data": { ...full original Lark event envelope... },
      "mode": "steer"
    }
  }
  ```
- **stderr**: prefix-tagged log lines only. The bridge re-routes the
  SDK's `console.*` chatter to stderr so it doesn't pollute the
  stdout JSON-RPC stream. The d-pi source-manager writes these to
  the hub's supervisor log (visible in the hub's terminal /
  journal) and stops there — subscribed agents don't see them.

  ```
  [lark-source-sdk] starting (appId=..., brand=..., logLevel=...)
  [lark-source-sdk] discovered N EventKey(s) to subscribe:
  [lark-source-sdk]   - im.message.receive_v1
  [lark-source-sdk]   - ...
  [lark-source-sdk] ready: subscribed to N EventKey(s), waiting for events.
  [lark-source-sdk] received SIGTERM, closing WebSocket and exiting.
  ```

### Mode = "steer" (always)

`params.mode = "steer"` for every emitted notification. Lark is
real-time user-facing input; the user is actively waiting for a
response, so we mirror TUI Ctrl+Enter (interrupt) rather than Enter
(queue).

### Exit / restart semantics

- Clean shutdown on SIGINT / SIGTERM (the destroy path d-pi uses).
- Any unhandled error writes a `[fatal]` line to stderr and exits 1;
  d-pi's source-manager restarts with exponential backoff
  (see `packages/d-pi/src/hub/source-manager.ts`).
- WS drops are handled by the SDK's built-in `autoReconnect`.

### Reference

- d-pi source validator: `packages/d-pi/src/hub/source-validator.ts`
  (`validateLine`, `JsonRpcMessage`)
- d-pi source-manager: `packages/d-pi/src/hub/source-manager.ts`
  (mode coercion, broadcast pipeline, restart policy)
- SDK WSClient domain enum: `Lark.Domain.Feishu` / `Lark.Domain.Lark`
  in `@larksuiteoapi/node-sdk`
- lark-cli event skill: `~/.agents/skills/lark-event/SKILL.md`
