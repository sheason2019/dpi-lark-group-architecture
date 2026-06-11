# BOOTSTRAP — lark-subscribe-router

One-time setup checklist for this role. Run once per deployment.
After completion the role is operational and the router agent can
handle live Lark traffic.

This file is NOT loaded as agent context at runtime (unlike
`AGENTS.md`). It is a procedural guide for the human deployer
and for the agent itself when verifying / re-bootstrapping.

## Status checklist

| # | Step | Who | Status |
|---|---|---|---|
| 1 | Lark skills installed into `roles/lark-subscribe-router/skills/` | human / setup script | ☐ |
| 2 | `lark-cli` binary on PATH | human / setup script | ☐ |
| 3 | Bot identity configured (app_id, app_secret) | human / setup script | ☐ |
| 4 | Current user authenticated via device flow | human (browser) | ☐ |
| 5 | Current user bound as agent group admin | agent | ☐ |

When all five are checked, the role is ready.

---

## §1 — Prerequisites (human / setup script runs these)

Steps 1.1–1.4 require interactive input, browser access, or
system-level installs. They are NOT done by the agent at runtime.

### 1.1 Install lark skills into this role's skills/ directory

The 21 lark-* skills MUST live under
`roles/lark-subscribe-router/skills/` so that d-pi's
`collectGroupArchitectureContext` picks them up as role-scoped
skills (`packages/dpi/src/workspace/workspace.ts:collectGroupArchitectureContext`).

`npx skills add` installs to `~/.agents/skills/` by default and does
NOT accept a custom target directory. Use one of the two
workarounds below.

**Option A — install globally, then move:**

```bash
npx skills add larksuite/cli -g -y
mkdir -p roles/lark-subscribe-router/skills
mv ~/.agents/skills/lark-* roles/lark-subscribe-router/skills/

# commit the skills into the role's git tree so the agent picks
# them up regardless of the deployment's global state
cd roles/lark-subscribe-router/skills
for d in lark-*/; do
  if [ -d "$d/references" ]; then
    git add "$d/SKILL.md" "$d/references/" 2>/dev/null || git add "$d"
  else
    git add "$d/SKILL.md" 2>/dev/null || git add "$d"
  fi
done
git commit -m "chore(roles/lark-subscribe-router): install lark-cli skills"
cd -
```

**Option B — clone the source repo and copy the skills directly
(no global install):**

```bash
git clone https://github.com/larksuite/cli /tmp/lark-cli
mkdir -p roles/lark-subscribe-router/skills
cp -r /tmp/lark-cli/skills/lark-* roles/lark-subscribe-router/skills/

# commit as above
```

**Verify:**

```bash
ls roles/lark-subscribe-router/skills/
# expect: ~21 directories named lark-*/ (lark-event, lark-im, lark-contact,
# lark-shared, lark-doc, lark-drive, lark-calendar, lark-task, etc.)
#
# Each lark-*/SKILL.md must exist with non-empty frontmatter
# (name + description fields).
```

Note: option A leaves `npx skills add` as the install source, which
makes future upgrades easier (`npx skills update`). Option B is
fully self-contained but requires manual upgrades.

### 1.2 Install lark-cli binary

```bash
npm install -g @larksuite/cli
```

This is the official npm package (NOT the unrelated `lark-cli` from
`npm.im/lark-cli` which is a different project).

**Verify:**

```bash
lark-cli --version
# expect: lark-cli version 1.x
```

### 1.3 Configure bot identity

Bot-side calls (when the bridge runs as `--as bot`) use
`tenant_access_token`. Configure the app credentials from the Lark
developer console:

```bash
lark-cli config init
# prompts for: app_id, app_secret (paste), brand (feishu vs lark)
```

**Verify:**

```bash
lark-cli config list
# expect: app-id present, brand present, default-as: auto
```

If `lark-cli config init` is not available, fall back to setting
env vars `LARK_APP_ID` / `LARK_APP_SECRET` directly.

### 1.4 Authenticate the current user

User-side calls (when the agent invokes `lark-cli im ... --as user`)
use `user_access_token`. Authenticate via OAuth device flow:

```bash
lark-cli auth login --no-wait
# prints a device authorization URL; visit it in a browser
# after approving, copy the device_code printed by the next step
lark-cli auth login --device-code <device_code>
```

This step is interactive (browser-side). The `--no-wait` flag lets a
script print the URL without blocking; the second invocation completes
the flow after the human approves in the browser.

**Verify:**

```bash
lark-cli auth status
# expect: "identity": "user", grantedAt present,
# scope contains required perms (e.g. im:message:readonly for receive,
# contact:user.base:readonly for sender lookup)
```

If the scope list is missing critical permissions, re-run
`lark-cli auth login --scope "<needed scopes>"`.

---

## §2 — Admin binding (agent executes via d-pi + lark-cli tools)

After §1 is complete, the agent should execute this section. It uses
the lark-cli skills (now in role) plus the d-pi CLI to identify the
current user and bind them as this agent group's admin.

### 2.1 Discover the current user's Lark identity

Use the `lark-contact` skill (via lark-cli as the user identity
configured in 1.4) to look up who the authenticated user is:

```bash
lark-cli contact +me --as user
# Returns: { "open_id": "ou_xxx", "name": "...", "email": "..." }
```

Record `open_id`, `name`, `email`. These identify the user to d-pi.

### 2.2 Create a d-pi local user for them

```bash
d-pi users create <display-name>
# e.g. d-pi users create "Alice LarkUser"
# Creates ~/.d-pi/users/<name>.json with keypair.
# Output prints the publicKey.
```

Pick a name that's recognisable but stable (e.g. the user's display
name or a slug of their open_id). Store the publicKey for step 2.3.

### 2.3 Add the user to this workspace's allow list as admin

```bash
d-pi allow-user add <name> --key <publicKey-from-2.2> \
                     --description "<Lark user> (<open_id>) — admin"
```

This must be run from inside a d-pi workspace (i.e. after
`d-pi init`). If no workspace exists, run `d-pi init` first.

### 2.4 Persist the Lark ↔ d-pi binding

Write a binding file so future reloads and the router agent can
re-derive the link without re-querying Lark:

```yaml
# roles/lark-subscribe-router/bindings.yaml
admins:
  - d_pi_user: <name-from-2.2>
    lark:
      open_id: <open_id-from-2.1>
      name: <name-from-2.1>
      email: <email-from-2.1>
    permissions: [route, synthesize, send-user-message]
    bound_at: <iso8601>
```

(Schema TBD — for now, free-form YAML/JSON is fine. The router agent
reads this on startup to know who to trust.)

### 2.5 Verify the bind

```bash
d-pi allow-user list
# expect: the new user listed with description matching step 2.3
```

Then send a test message in Lark to the bot and confirm the d-pi
source emits a notification (check the bridge's stdout via
`journalctl` / `tail -f` of the source log, or just wait for an
inbound event to appear in the agent's session).

---

## §3 — Failure modes

| Failure | Detection | Resolution |
|---|---|---|
| Skills not in role `skills/` | `ls roles/lark-subscribe-router/skills/lark-event` fails | Re-run §1.1 |
| `lark-cli: command not found` | shell error | Re-run §1.2 |
| Bot calls return `tenant_access_token invalid` | lark-cli error message mentions token | Re-run §1.3, verify app_id / app_secret |
| User calls return `user_access_token expired` | lark-cli auth status | Re-run §1.4 |
| `d-pi: Not a d-pi workspace` | CLI error | Run `d-pi init` first, then §2 |
| Allow-user add fails with "no workspace" | CLI error | Same as above |
| Bridge emits nothing when Lark messages arrive | source supervisor logs | Check `lark-cli event status` to see if bus daemon is running; restart source |

---

## §4 — Re-bootstrap / upgrade

Re-running this file is safe and idempotent:

- §1.1 (skills): if skills exist in target dir, `npx skills add` will
  skip / update. Re-run after upgrading `@larksuite/cli` to pick up
  new skills.
- §1.2 (binary): `npm install -g` upgrades in place.
- §1.3 (bot identity): re-run `lark-cli config init` only if app
  credentials rotate.
- §1.4 (user auth): `lark-cli auth login` refreshes tokens.
- §2 (admin binding): re-running creates an extra local user;
  clean up with `d-pi users delete <old-name>` first if rotating
  the binding.

To rotate the bot credentials or rebind to a different user,
re-run the corresponding step only.

---

## See also

- `AGENTS.md` — runtime context the router agent sees
- `scripts/README.md` — operational bridge (lark-source.js)
- d-pi source validator: `packages/d-pi/src/hub/source-validator.ts`
- d-pi role loader: `packages/d-pi/src/workspace/workspace.ts`
  (`collectGroupArchitectureContext`)