# BOOTSTRAP — group architecture

One-time deployment checklist for this `group-architecture/`. It
stands up the `lark-subscribe-router` role end-to-end inside a
d-pi workspace.

You (the human deployer or an initial agent given the task)
execute every step using bash + filesystem. **The router agent
itself reads a different file** — `roles/lark-subscribe-router/BOOTSTRAP.md`
— after being started. Don't duplicate that file's content here;
this file's job is to create the agent and hand it off.

After completion, the workspace has a running `lark-subscribe-router`
agent that can route Lark messages to child agents and reply to the
user via Lark.

## When to read this file

- First-time deployment of this architecture.
- After deleting the workspace state (re-bootstrap from scratch).
- When adding the `lark-subscribe-router` role to an existing
  workspace that doesn't have it yet.

## When NOT to read this file

- Routine agent starts — the router agent runs from
  `agents/lark-subscribe-router/agent.json` and reads its role-level
  `BOOTSTRAP.md` only on first run.
- To re-auth or upgrade lark-cli — that's the role-level
  `BOOTSTRAP.md` (re-run from the router agent).

---

## Status checklist

| # | Step | Who |
|---|---|---|
| 1 | d-pi workspace exists with this architecture loaded | you |
| 2 | `lark-cli` binary available (will be re-verified by role bootstrap) | you |
| 3 | `lark-subscribe-router` agent config written | you |
| 4 | Hub started; router agent worker booted | you |
| 5 | Role-level bootstrap delegated to router agent | router agent |
| 6 | Lark user bound as router admin | router agent |
| 7 | End-to-end Lark → d-pi → Lark verified | you + user |

---

## Step 1 — Verify d-pi workspace

The router agent's `agent.json` lives in the workspace, and the
hub reads group-architecture/ from the workspace root.

```bash
# Are you in a d-pi workspace?
[ -f .dpi/config.json ] || {
  echo "Not a d-pi workspace. Run 'd-pi init' first."
  exit 1
}

# Does this architecture's content exist?
for f in AGENTS.md roles/lark-subscribe-router/AGENTS.md; do
  [ -f "$f" ] || { echo "Missing: $f"; exit 1; }
done

echo "Workspace OK"
```

If `.dpi/config.json` is missing, run `d-pi init` in the workspace
root first. If group-architecture content is missing, copy this
repo's contents (minus `.git`) into the workspace root, OR symlink
individual pieces.

---

## Step 2 — Pre-flight: ensure lark-cli is reachable

The role bootstrap will install skills + run lark-cli; this step
just makes sure the bootstrap won't fail on missing prerequisites.

```bash
command -v lark-cli >/dev/null 2>&1 || {
  echo "lark-cli not on PATH. Install it:"
  echo "  npm install -g @larksuite/cli"
  exit 1
}
lark-cli --version
```

The role bootstrap's step 2 will install lark-cli if missing
(idempotent), but installing it here saves a round-trip.

---

## Step 3 — Create the lark-subscribe-router agent config

The router agent is a regular d-pi agent whose `roles` field
references `lark-subscribe-router`. Hub auto-discovers agents from
`agents/<name>/agent.json` on startup.

Write `agents/lark-subscribe-router/agent.json`:

```json
{
  "name": "lark-subscribe-router",
  "parentName": null,
  "roles": ["lark-subscribe-router"]
}
```

Notes:
- `parentName: null` = top-level agent (not a child of root). If
  you want the router to be a child of root, set
  `"parentName": "root"`. The architecture doesn't enforce either;
  choose based on your routing graph.
- `model` is intentionally omitted — the role bootstrap's step 3
  will run `lark-cli config init` and you can set a per-agent model
  via the hub's `--model` flag at serve time, or by editing this
  file later.
- Add `model`, `cwd`, `sessionId`, etc. as needed for your
  deployment. The fields above are the minimum the hub requires.

You can also create the agent via the d-pi CLI's `allow-user`-style
mechanism, but the direct file is simpler for a one-time setup:

```bash
mkdir -p agents/lark-subscribe-router
cat > agents/lark-subscribe-router/agent.json <<'JSON'
{
  "name": "lark-subscribe-router",
  "parentName": null,
  "roles": ["lark-subscribe-router"]
}
JSON
```

---

## Step 4 — Start the hub and verify the router agent boots

The hub reads `agents/<name>/agent.json` and creates a worker
process per agent. The router's worker loads the role's AGENTS.md
+ skills + scripts on startup.

Start the hub in a separate shell (or background it):

```bash
d-pi serve \
  --port 49091 \
  --model <your-model-id>  # e.g. anthropic/claude-sonnet-4
```

Verify the router worker came up:

```bash
# In another shell, after a few seconds:
d-pi allow-user list        # just to confirm CLI works
# Hub logs should show:
#   [d-pi hub] Creating agent "lark-subscribe-router" (...)
#   [d-pi worker ...] Agent "lark-subscribe-router" (...) ready on port ...
```

If the worker fails to start, check:
- `roles/lark-subscribe-router/AGENTS.md` exists (hub loads it)
- `roles/lark-subscribe-router/scripts/lark-source.js` exists (the
  role's bootstrap will need it, but the hub doesn't load scripts
  on agent startup — only AGENTS.md + skills/ + extensions/)

---

## Step 5 — Connect to the router agent and tell it to bootstrap

Connect to the router agent via d-pi connect mode:

```bash
# First, create a local d-pi user if you don't have one:
d-pi users list || d-pi users create <your-name>

# Then add yourself to the workspace's allow list (this is the
# bootstrap admin — NOT the Lark admin yet; that's step 6 inside
# the role bootstrap):
d-pi allow-user add <your-name> --key <your-publicKey> \
                       --description "Architecture bootstrap admin"

# Now connect to the router agent. In a TTY (interactive):
d-pi connect <your-name>@http://localhost:49091 \
  --agent lark-subscribe-router
```

In the connect TUI, send the router agent this initial prompt
(plain text — pi has no AskUserQuestion tool):

> Please read `roles/lark-subscribe-router/BOOTSTRAP.md` and execute
> it from start to finish. When it asks for my app_id / app_secret
> / brand, I'll paste them. When it asks me to visit a device-flow
> URL, I'll do that and paste back the device_code. Mark the
> workspace's bootstrap as done when step 6 completes.

The router agent then runs steps 1–5 of its role BOOTSTRAP, asks
you for credentials + the device-flow URL interaction, and binds
you as admin.

---

## Step 6 — Verify end-to-end

After the router agent completes its role bootstrap:

1. The router reports success (e.g. "Role bootstrap complete. Bindings
   written to bindings.yaml.").
2. Test from Lark: send a message in any chat where the bot is a
   member.
3. The router should see the event flow in via `scripts/lark-source.js`,
   route it appropriately, and reply via `lark-im`.

If anything is off, see Failure modes below or re-run the role-level
`BOOTSTRAP.md` from the router agent.

---

## Failure modes

| Step | Failure | Detection | Resolution |
|---|---|---|---|
| 1 | Workspace not initialized | `.dpi/config.json` missing | `d-pi init` |
| 1 | Architecture files missing | `roles/lark-subscribe-router/AGENTS.md` missing | Copy from this repo (or symlink) into workspace root |
| 2 | `lark-cli` missing | `command -v lark-cli` exits 1 | `npm install -g @larksuite/cli` |
| 3 | Agent config invalid | hub logs "Invalid agent config" | Validate JSON syntax; ensure required fields are present |
| 4 | Hub fails to start | hub exits non-zero | Check port not in use; verify model ID is valid |
| 4 | Router worker fails | hub log "Failed to restore agent" | Check `agents/lark-subscribe-router/agent.json` and role assets exist |
| 5 | Connect fails | "user not in allow list" | Run `d-pi allow-user add <name> --key <key>` first |
| 5 | Router doesn't know about bootstrap | It replies "I don't see BOOTSTRAP.md" | Check working dir inside the worker matches the workspace root; check role assets are in the right path |
| 6 | Lark events don't reach d-pi | No activity after Lark send | Check `lark-cli event status --fail-on-orphan`; verify bridge is registered as a d-pi source; check bridge logs on stdout/stderr |

---

## Re-bootstrap

To stand up the architecture on a new workspace, repeat from Step 1.
The `agent.json` file is the only state that needs to be re-created;
the role assets (AGENTS.md, BOOTSTRAP.md, scripts/) come from this
repo and don't change between deployments.

To add the router to an existing workspace, just Steps 3–5
(no need to re-init the workspace).

To rotate the router's Lark credentials without touching the
workspace structure, run the role-level
`roles/lark-subscribe-router/BOOTSTRAP.md` from the router agent
itself.

---

## See also

- `roles/lark-subscribe-router/AGENTS.md` — runtime context the
  router agent sees
- `roles/lark-subscribe-router/BOOTSTRAP.md` — role-level bootstrap
  the router agent runs on first start
- `roles/lark-subscribe-router/scripts/README.md` — operational
  bridge between lark-cli and d-pi
- `AGENTS.md` — network-level shared context injected into every
  agent in the workspace