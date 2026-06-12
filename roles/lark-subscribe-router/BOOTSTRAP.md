# BOOTSTRAP — lark-subscribe-router

One-time setup checklist for this role. You (the router agent)
execute every step using your tools (`bash`, `lark-cli`, d-pi CLI).
Some steps require user input — when a step does, the guide says
so explicitly. To collect that input, just **ask the user in plain
text** (e.g. "Please paste your app_id and app_secret"). The user
will reply in the chat; you continue once you have what you need.
There is no AskUserQuestion tool — plain text is the only mechanism.

After all five steps are checked, the role is operational: Lark
events flow through `scripts/lark-source.js` into d-pi, you route
them, and you reply to the user via `lark-im`.

This file is NOT loaded into your runtime context by default (unlike
`AGENTS.md`). Read it when:
- The agent group's `agent.json` (or equivalent) shows bootstrap has
  not been run (e.g. no `allow-user` for the current Lark user, or
  no Lark skills in `roles/lark-subscribe-router/skills/`)
- The human explicitly says "bootstrap the Lark router"
- This is your first turn after a fresh deployment

Do NOT re-run completed steps on every agent start. After bootstrap
succeeds, mark it done in the workspace state and skip this file
unless re-bootstrap is requested.

## Status checklist

| # | Step | Requires user input? |
|---|---|---|
| 1 | Lark skills installed in `roles/lark-subscribe-router/skills/` | no |
| 2 | `lark-cli` binary installed and on PATH | no |
| 3 | Bot identity configured (app_id, app_secret) | **yes** — ask user |
| 4 | Current user authenticated via device flow | **yes** — ask user to visit URL |
| 5 | Current user bound as agent group admin | no (uses step 3+4 output) |
| 6 | Bridge registered as a d-pi source | no (uses step 1+3 output) |
| 6.0 | `npm install` in `scripts/` (SDK bridge only) | no |
| 6.1 | User re-pastes `app_secret` for SDK bridge | **yes** — ask user |
| 6.2 | `create_source` called with `env` for SDK bridge | no |
| 6.3 | `create_source` called without `env` for subprocess bridge | no |
| 6.4 | `list_sources` shows source running | no |
| 7 | End-to-end Lark → d-pi → Lark verified | yes (user sends a real Lark msg) |

When all seven are checked, mark bootstrap done and proceed to
runtime.

---

## Step 1 — Install lark-cli skills into this role's skills/

The 21 lark-* skills MUST live under
`roles/lark-subscribe-router/skills/` so that d-pi's
`collectGroupArchitectureContext` picks them up as role-scoped
skills (`packages/d-pi/src/workspace/workspace.ts:collectGroupArchitectureContext`).

`npx skills add` does not support custom target directories, so
install globally and then move into the role.

Execute:

```bash
npx skills add larksuite/cli -g -y
mkdir -p roles/lark-subscribe-router/skills
shopt -s nullglob
for d in ~/.agents/skills/lark-*; do
  mv "$d" "roles/lark-subscribe-router/skills/"
done
```

Verify:

```bash
ls roles/lark-subscribe-router/skills/
# expect ~21 directories named lark-*/ (lark-event, lark-im,
# lark-contact, lark-shared, lark-doc, lark-drive, lark-calendar,
# lark-task, etc.)

# Spot-check a skill loads (each has SKILL.md with frontmatter)
head -5 roles/lark-subscribe-router/skills/lark-event/SKILL.md
```

Note: this makes a one-time copy. If the user later updates lark-cli
skills (`npx skills update`), re-run this step to refresh the
role's `skills/` directory.

---

## Step 2 — Install lark-cli binary

The official npm package is `@larksuite/cli` (NOT the unrelated
`npm.im/lark-cli`, which is a different project).

Execute:

```bash
npm install -g @larksuite/cli
```

Verify:

```bash
lark-cli --version
# expect: lark-cli version 1.x
hash -r   # in case the binary path changed
```

---

## Step 3 — Configure bot identity

Bot-side calls (when `scripts/lark-source.js` runs as `--as bot`)
use `tenant_access_token`. Requires app credentials from the Lark
developer console.

**Ask the user (plain text):**

> Please paste your Lark app credentials. I'll need:
> 1. **app_id** — from the developer console app page
> 2. **app_secret** — from the same page (treat as sensitive)
> 3. **brand** — `feishu` or `lark` (default to `lark` if unsure)

Wait for the reply before proceeding.

**Initialize via lark-cli:**

Execute:

```bash
lark-cli config init <<EOF
$app_id
$app_secret
$brand
EOF
```

(Or use the interactive form if the heredoc isn't supported.)

Verify:

```bash
lark-cli config list
# expect: app-id present, brand present, default-as: auto
```

If `lark-cli config init` is not available in this version, fall
back to env vars:

```bash
export LARK_APP_ID=$app_id
export LARK_APP_SECRET=$app_secret
export LARK_BRAND=$brand
```

Persist these env vars (e.g. via `~/.bashrc` or the workspace's
own config) so they survive agent restarts.

---

## Step 4 — Authenticate current user

User-side calls (`lark-cli im ... --as user`, `lark-cli contact ...`)
use `user_access_token`. Device-flow login is interactive (browser),
but you (the agent) can drive it.

Execute:

```bash
lark-cli auth login --no-wait
```

This prints a JSON blob including a verification URL. **Show the URL
to the user in plain text and ask:**

> Please visit this URL in a browser, approve the authorization, and
> paste the device_code back here:
> <verification-URL>

Wait for the user to reply with the device_code.

After the user replies:

```bash
lark-cli auth login --device-code "$device_code"
```

Verify:

```bash
lark-cli auth status
# expect: "identity": "user", grantedAt present, scope non-empty.
# Critical scopes for the router:
#   - im:message.p2p_msg:readonly (im.message.receive_v1 events)
#   - im:message.group_msg:get_as_user
#   - contact:user.base:readonly (sender lookup)
#   - contact:user:search
# If scope list is missing critical perms, re-run:
#   lark-cli auth login --scope "<needed scopes>"
```

Persist the user identity (open_id from step 5) and the fact that
auth is done in `roles/lark-subscribe-router/bindings.yaml`.

---

## Step 5 — Bind current user as agent group admin

After step 3 (bot) and step 4 (user) succeed, bind the user as
admin of this agent group. This makes them authorized to use the
router and to be reached for user-bound messages.

Execute:

```bash
# 1. Discover the current user's Lark identity
USER_INFO=$(lark-cli contact +me --as user)
# Extract: open_id, name, email (parse with jq or string match)
OPEN_ID=$(echo "$USER_INFO" | jq -r '.data.user.open_id // .open_id // .data.open_id')
NAME=$(echo "$USER_INFO" | jq -r '.data.user.name // .name // .data.name')
EMAIL=$(echo "$USER_INFO" | jq -r '.data.user.email // .email // .data.email // ""')
echo "User: $NAME <$EMAIL> open_id=$OPEN_ID"

# 2. Create a d-pi local user for them
CREATE_OUT=$(d-pi users create "$NAME" --description "Lark user $OPEN_ID")
PUBLIC_KEY=$(echo "$CREATE_OUT" | grep -oE 'MC[A-Za-z0-9+/=_-]+' | head -1)
# Fallback: read from ~/.d-pi/users/<name>.json
if [ -z "$PUBLIC_KEY" ]; then
  PUBLIC_KEY=$(jq -r '.publicKey' "$HOME/.d-pi/users/$NAME.json")
fi
echo "d-pi user '$NAME' created with publicKey=$PUBLIC_KEY"

# 3. Add the user to this workspace's allow-user list as admin
# (must run from inside the d-pi workspace)
d-pi allow-user add "$NAME" --key "$PUBLIC_KEY" \
                       --description "Lark user $OPEN_ID <$EMAIL> — admin"

# 4. Persist the Lark ↔ d-pi binding for future reloads
cat > roles/lark-subscribe-router/bindings.yaml <<YAML
admins:
  - d_pi_user: $NAME
    lark:
      open_id: $OPEN_ID
      name: $NAME
      email: $EMAIL
    permissions:
      - route
      - synthesize
      - send-user-message
    bound_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
YAML
```

Verify:

```bash
d-pi allow-user list
# expect: $NAME listed with description matching step 3

# The workspace's agents/root/agent.json should now reference this
# user, or at minimum the role-loader should accept routing to them
ls agents/*/agent.json
```

Note: `d-pi users create` writes to `~/.d-pi/users/<name>.json` (global).
`d-pi allow-user add` writes to `<workspace>/auths/secrets/<name>.json`
(workspace-local). Both are required.

---

## Step 6 — Register the bridge as a d-pi source

After step 4 (user auth) succeeds, register the Lark bridge as a
d-pi source so Lark events actually flow into the workspace.

There are two bridge implementations in `scripts/`. Use the
SDK-based one (`lark-source-sdk.js`) unless you have a specific
reason to prefer the lark-cli subprocess bridge
(`lark-source.js`).

| Bridge | Mechanism | When to use |
|---|---|---|
| `lark-source-sdk.js` | Uses `@larksuiteoapi/node-sdk`'s `WSClient` to connect directly to Lark's WebSocket gateway. The SDK reads the app's brand metadata and picks `lark-websocket` vs `feishu-websocket` correctly. | **Default.** Bypasses the lark-cli 1.0.51 `feishu-websocket` hardcode bug. Requires `npm install` in `scripts/`. |
| `lark-source.js` | Spawns one `lark-cli event consume <key>` subprocess per EventKey and pipes NDJSON into a JSON-RPC stream. | Use only if the SDK can't connect (e.g. very old Node, sandboxed env without `npm install`). |

### 6.0 Install SDK dependencies (one-time)

```bash
cd /private/tmp/dpi-smoke/roles/lark-subscribe-router/scripts
npm install --ignore-scripts
```

`--ignore-scripts` is for the workspace's security policy
(AGENTS.md: never run lifecycle scripts unless asked). The SDK has
no install-time hooks so this is fine.

### 6.1 Ask the user for `app_secret`

The SDK bridge needs `LARK_APP_ID` and `LARK_APP_SECRET` in its
process env. Step 3 collected `app_id` from the user. Ask the
user to re-confirm `app_secret` for injection into the source
env (it was provided in step 3 originally; re-confirming keeps
the secret out of agent memory and out of the workspace files).

Plain-text prompt:

> To register the Lark bridge as a d-pi source, I need the bot
> app secret. You provided it during step 3. Paste it again now
> and I'll inject it into the source env. It will live only in
> d-pi's in-memory source record (never written to disk, never
> committed to git).

If the user prefers not to paste, they can decline and we fall
back to the `lark-source.js` subprocess bridge (which uses
lark-cli's own keychain-stored secret).

### 6.2 Register the SDK bridge

Use the `create_source` tool. Pass `app_id` and `app_secret` via
`env` (d-pi source-manager merges these into the bridge's
process env at spawn time; never written to disk).

```
create_source(
  name = "lark-bot"
  command = "node"
  args = [
    "/abs/path/to/roles/lark-subscribe-router/scripts/lark-source-sdk.js"
  ]
  env = {
    "LARK_APP_ID":     "<app_id from step 3>"
    "LARK_APP_SECRET": "<app_secret the user just pasted>"
    "LARK_BRAND":      "lark"     # or "feishu"
    "LARK_LOG_LEVEL":  "warn"     # keep quiet; "info" for debugging
  }
)
```

On success: `Source "lark-bot" created and running. You have been
automatically subscribed to this source.`

The hub spawns the bridge subprocess. The bridge:

1. Reads `LARK_APP_ID` / `LARK_APP_SECRET` from env
2. Spawns `lark-cli event list --json` to discover EventKeys
3. Constructs an `Lark.WSClient` (picks the right WebSocket
   domain from the app metadata — fixes the lark-cli 1.0.51
   `feishu-websocket` hardcode)
4. Registers one handler per EventKey
5. Emits JSON-RPC 2.0 notifications on stdout as events arrive

### 6.3 Register the subprocess bridge (fallback)

If the user can't provide `app_secret` for the SDK bridge, or if
`npm install` fails, use the subprocess bridge. It uses lark-cli's
own keychain-stored secret (no app_secret in source env).

```
create_source(
  name = "lark-bot"
  command = "node"
  args = [
    "/abs/path/to/roles/lark-subscribe-router/scripts/lark-source.js"
  ]
)
```

No `env` needed. No `npm install` needed. The bridge spawns
`lark-cli event consume <key> --as bot` for each EventKey.

**Limitation**: as of lark-cli 1.0.51 the event bus daemon
hardcodes `feishu-websocket` regardless of brand config, so
Lark-international apps get "Incorrect domain name" and no
events flow. Use the SDK bridge unless you can work around that.

### 6.4 Verify

```
list_sources()
# expect: sources = [{ name: "lark-bot", command: "node",
#   args: [...], status: "running", subscriberCount: 1 }]
```

Bridge stderr (visible in d-pi supervisor log) should show:

```
[lark-source-sdk] starting (appId=..., brand=lark, logLevel=WARN)
[lark-source-sdk] discovered N EventKey(s) to subscribe:
[lark-source-sdk]   - im.message.receive_v1
[lark-source-sdk]   - ... (etc.)
[lark-source-sdk] ready: subscribed to N EventKey(s), waiting for events.
```

The `ready` line means the WSClient connected and the EventKey
handshake succeeded. After this, real Lark events will appear in
the agent's context as `[meta({sourceName: "lark-bot"...})]`
JSON-RPC notifications.

---

## Step 7 — Verify end-to-end




Send a real Lark message to the bot (the user does this):

1. User sends "ping" in a Lark chat with the bot.
2. The Lark event reaches `scripts/lark-source.js` over the bridge.
3. d-pi wraps it with the meta header and delivers to you.
4. You see `[meta({...sourceType: "source", sourceName: "lark-bot"...})]`
   in your user-side message context.
5. You route it to a child agent (or to root if no specific role
   matches).
6. The child agent's `send_message(agent_id=<your agentId>, ...)`
   response comes back. You look up the routing map (by the
   child's agentId in the inbound meta) and relay the synthesized
   text to the user via `lark-im`.

If any link in this chain breaks, see Failure modes below.

Mark bootstrap done: create or update a workspace-state marker
(e.g. `.dpi/bootstrap/done.json`) so future agent starts don't
re-run this file unnecessarily.

---

## Failure modes

| Step | Failure | Detection | Resolution |
|---|---|---|---|
| 1 | Skills not visible to agent | `ls roles/lark-subscribe-router/skills/lark-event/SKILL.md` fails | Re-run step 1; check d-pi's role loader picks up the path |
| 2 | `lark-cli: command not found` | shell error | Re-run `npm install -g @larksuite/cli`; check `$PATH` |
| 3 | Bot token errors (401 from Lark) | lark-cli error mentions token | Verify app_id / app_secret in lark-cli config list; re-init if rotated |
| 4 | Device code rejected or expired | lark-cli auth status shows no user identity | Re-run `lark-cli auth login --no-wait`, ask user to re-authorize |
| 4 | Scope missing critical perms | lark-cli auth status scope list | Re-run `lark-cli auth login --scope "<scopes>"` |
| 5 | `d-pi: Not a d-pi workspace` | CLI error | Run `d-pi init` first, then re-run step 5 |
| 5 | Allow-user add fails with "publicKey invalid" | CLI error | PublicKey extraction failed; read from `~/.d-pi/users/$NAME.json` directly |
| 6 | No event reaches d-pi after Lark send | d-pi source log | Check `lark-cli event status --fail-on-orphan`; verify the bridge is registered as a d-pi source |
| 6 | Event reaches d-pi but no reply comes back to the user | router AGENTS.md logs | Verify the child's `send_message` target is the router's agentId; verify the router's per-child routing map has a fresh entry for that child |

---

## Re-bootstrap / upgrade

Re-running this file is safe and idempotent. To upgrade or rotate:

- **Step 1**: re-run after `npx skills update` to pick up new lark skills.
- **Step 2**: re-run `npm install -g @larksuite/cli@latest`.
- **Step 3**: re-run only if app credentials rotate (rare).
- **Step 4**: `lark-cli auth login` refreshes the token; expires in ~2h
  by default, auto-refreshed by lark-cli.
- **Step 5**: to rebind to a different user, run `d-pi users delete
  <old-name>` first, then re-run step 5.

After any re-bootstrap, delete the workspace-state marker
(`.dpi/bootstrap/done.json`) so the next agent start knows to
verify, not assume.

---

## See also

- `AGENTS.md` — runtime context the router agent sees during normal
  operation (after bootstrap)
- `scripts/README.md` — operational bridge between lark-cli and d-pi
- d-pi source validator: `packages/d-pi/src/hub/source-validator.ts`
- d-pi role loader: `packages/d-pi/src/workspace/workspace.ts`
  (`collectGroupArchitectureContext`)