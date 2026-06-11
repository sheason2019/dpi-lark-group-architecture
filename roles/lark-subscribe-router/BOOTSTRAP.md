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

After step 4 (user auth) succeeds, register
`scripts/lark-source.js` as a d-pi source so Lark events actually
flow into the workspace. The bridge spawns `lark-cli event consume`
subprocesses (one per EventKey) and converts their NDJSON output to
JSON-RPC 2.0 notifications on its own stdout.

Use the `create_source` tool (you have it as part of the d-pi
built-in extension). No `--event-key` is specified — the bridge
dynamically queries `lark-cli event list --json` at startup to
discover every EventKey the app has registered, and subscribes to
all of them.

**Tool call:**

```
create_source(
  name   = "lark-bot"
  command = "node"
  args = [
    "/abs/path/to/roles/lark-subscribe-router/scripts/lark-source.js",
    "--as", "bot"
  ]
)
```

(use the absolute path to the script in this workspace.)

On success you should see `Source "lark-bot" created and running.`
and you're auto-subscribed to it (per the tool contract). The hub
spawns the bridge subprocess, which in turn spawns one `lark-cli
event consume` per EventKey. All stderr from the bridge and its
lark-cli children is forwarded to your context.

If you want to subscribe to only a subset of events (e.g. only
message events, no reactions), pass them explicitly:

```
create_source(
  name   = "lark-bot"
  command = "node"
  args = [
    "/abs/path/to/roles/lark-subscribe-router/scripts/lark-source.js",
    "--event-key", "im.message.receive_v1",
    "--event-key", "im.chat.member.user.added_v1",
    "--as", "bot"
  ]
)
```

Verify:

```
list_sources()
# expect: sources = [{ name: "lark-bot", command: "node",
#   args: [...], status: "running", subscriberCount: 1 }]
```

Also check the bridge's stderr — you should see lines like:

```
[lark-source] No --event-key specified; querying `lark-cli event list --json` to discover all registered events...
[lark-source] Discovered 11 EventKey(s) to subscribe:
[lark-source]   - im.message.receive_v1
[lark-source]   - im.message.reaction.created_v1
[lark-source]   - ... (etc.)
[lark-source/im.message.receive_v1] [ready] im.message.receive_v1
[lark-source/im.message.reaction.created_v1] [ready] im.message.reaction.created_v1
[lark-source/...] [ready] ...
```

The `[ready]` lines come from `lark-cli event consume` (see the
lark-event skill's subprocess contract). One per EventKey.

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
6. The child agent's `[report-to-user handle=...]` response comes
   back. You synthesize and send via `lark-im`.

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
| 6 | Event reaches d-pi but no `[report-to-user]` reply | router AGENTS.md logs | Verify bindings.yaml; ensure router has the user as admin |

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