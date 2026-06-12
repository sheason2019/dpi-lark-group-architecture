# Changelog

All notable changes to this architecture are recorded here. Versions
follow the lockstep versioning policy of the pi-mono monorepo (one
version per release across all packages), but this architecture is
content-only and ships via direct commits — there is no `version`
field. Date-stamped entries below.

## 2026-06-12 — Routing: drop `[routed via ...]` prefix and `[report-to-user handle=...]` marker

The router/child message contract is simplified. Previously, the
router added a `[routed via lark-subscribe-router, handle=X]` prefix
when forwarding a user message to a child, and the child echoed
back a `[report-to-user handle=X]` marker to identify the target
chat. Both were redundant with the d-pi meta header (`sourceType:
"agent"` + `agentId`) which already carries the same provenance
information, and the handle token was internal router state that
leaked into the LLM prompt as dead text.

New contract:

- **Forwarding (router → child)**: send the user's message body
  verbatim, no prefix. The child reads `meta.agentId` to identify
  the sender and to know where to reply (target = router's
  agentId).
- **Reporting (child → router)**: child just calls
  `send_message(agent_id=<router's agentId>, message=...)` — no
  marker. The router uses `meta.agentId === <child's id>` to
  look up the per-child routing map (which it maintains as
  `C → (sourceName, chat_id, thread)`) and relay to Lark.

The router still maintains a routing map, but it's now strictly
internal (the child never sees it). The `chat_id`, `sender_id`,
Lark message types, and meta headers remain strictly server-side
state and never leak to either the child's LLM context or the
Lark user's message body.

`lark-subscribe-router/AGENTS.md` and `BOOTSTRAP.md` updated to
reflect the new contract.

## 2026-06-11 — Initial bootstrap + SDK bridge

### Added

- `roles/lark-subscribe-router/AGENTS.md` — character persona for the
  Lark router agent (character / routing rules / `[report-to-user
  handle=...]` marker protocol).
- `roles/lark-subscribe-router/BOOTSTRAP.md` — 7-step agent-driven
  bootstrap (plain-text prompts, never tool-prompted). Steps 1-5
  are environment; steps 6-7 wire the bridge and verify.
- `roles/lark-subscribe-router/scripts/lark-source.js` — first
  bridge implementation: spawns one `lark-cli event consume` per
  EventKey and pipes NDJSON into JSON-RPC 2.0 notifications on
  stdout.
- `roles/lark-subscribe-router/scripts/lark-source-sdk.js` —
  second bridge implementation using
  `@larksuiteoapi/node-sdk`'s `WSClient`. Reads
  `LARK_APP_ID` / `LARK_APP_SECRET` from process env (injected by
  d-pi `create_source.env`, never persisted to disk, never
  committed). Recommended bridge — picks the right WebSocket
  domain (lark-websocket vs feishu-websocket) from the app's
  brand metadata, bypassing the lark-cli bus daemon bug.
- `roles/lark-subscribe-router/scripts/package.json` — local Node
  project (private, scoped to `scripts/`). One dep:
  `@larksuiteoapi/node-sdk` ^1.66.1.
- `roles/lark-subscribe-router/scripts/.gitignore` —
  `node_modules/`, `package-lock.json`, `.env*` ignored.
- `roles/lark-subscribe-router/scripts/README.md` — bridge
  selection guide (SDK vs subprocess), config tables, install
  + register instructions.
- `AGENTS.md` — root architecture doc.
- `BOOTSTRAP.md` — architecture-level bootstrap (create router
  agent, hand off to role-level BOOTSTRAP).

### Fixed (in the lark-source.js subprocess bridge)

- `stdio: ["pipe", "pipe", "pipe"]` + `child.stdin.unref()` so
  lark-cli's `event consume` doesn't see stdin EOF (it treats EOF
  as a shutdown signal designed for AI subprocess callers).
- Spawned `tail -f /dev/null` as a shared stdin holder per
  bridge process. tail never writes data and never closes its
  stdout, so lark-cli reads an open-but-empty pipe forever and
  reaches the "ready" state. lark-cli's own help text confirms
  this is the only way to keep `event consume` alive without a
  TTY.
- `lark-cli event list` does not accept `--as` (it's a static
  query of the developer-console catalog, not identity-aware).
  Dropped `--as` from the discovery invocation.
- `lark-cli event consume` rejects EventKeys the app hasn't
  enabled in the console (exit 2/3) — bridge now exits 0 if at
  least one child ran cleanly, else the worst exit code. The
  bridge is healthy iff it proved the Lark connection works for
  any single key; partial per-key failures are lark-cli's
  app-config problem to surface on stderr.
- lark-cli's chatty stderr (`[event] bus daemon started`,
  `[event] ready event_key=…`, `[event] listening for events`)
  used to flood the d-pi supervisor and (via the source-manager
  pre-patch behavior) the subscribed agent. Now forwarded to
  the bridge's own stderr with a per-key tag, visible to the
  d-pi supervisor log only.
- `mergedStdout.setMaxListeners(0)` — dynamic discovery may
  spawn 10+ lark-cli children; default Node cap is 10, which
  triggered `MaxListenersExceededWarning` for `unpipe` /
  `error` / `close` / `finish` listeners on the PassThrough.

### End-to-end verified

A live Lark app (`cli_a91bf7a326b85bc8`, Lark international brand,
user 李绪杰 / `ou_cf65d3a32cc4b7fd27bfe756875df1b6`) was
registered, device-flow user-auth completed, the SDK bridge was
spawned by d-pi with `LARK_APP_ID` + `LARK_APP_SECRET` injected
via `create_source.env`, and a real "你好" p2p message was
delivered to the router agent as a `steer`-mode
`events.emit` notification. The full chain Lark-server → SDK
WebSocket → bridge stdout → d-pi hub → router agent worked.

### Known issue (out of scope)

`lark-cli` 1.0.51's event bus daemon hardcodes
`feishu-websocket` as the source name regardless of the app's
brand config. Lark-international apps get "Incorrect domain
name" from the WebSocket gateway and the bus immediately exits.
Tracked at the lark-cli upstream
(`https://github.com/larksuite/cli`). The subprocess bridge
(`lark-source.js`) is broken on lark-cli 1.0.51 for
Lark-international apps; the SDK bridge
(`lark-source-sdk.js`) is the working default.
