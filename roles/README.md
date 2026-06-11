# Roles go here.

A role is a directory whose name is referenced from an agent's
`roles` field (in `agents/<name>/agent.json` or via the `create_agent`
tool call). At agent creation, d-pi loads the matching role directory's
AGENTS.md / skills/ / extensions/ into the agent's context.

Layout (mirrors the network-level structure):
  roles/
    <role-name>/
      AGENTS.md           # role-level instructions
      skills/             # optional, role-scoped skills
      extensions/         # optional, role-scoped extensions

Naming:
  - Short, kebab-case role names: `researcher`, `code-reviewer`, `lark-bot`.
  - Avoid the literal name `root` — see "root implicit" in
    packages/d-pi-official/docs/group-architecture/roles.md (root agent
    implicitly loads `roles/root/` if present, which is a footgun if you
    meant something else).

Rules:
  - If a role is referenced but the directory does NOT exist, d-pi throws
    `Unknown agent role "<name>"` at agent creation. Every referenced role
    needs a directory.
  - A role directory may be empty (no AGENTS.md, no skills/, no extensions/) —
    the role then loads nothing extra.

This file is a placeholder so the directory exists in git. Delete it
once you add a real role.

See packages/d-pi-official/docs/group-architecture/roles.md for the full
contract.