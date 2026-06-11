<!--
TODO: fill in network-level shared context for this d-pi group architecture.

This AGENTS.md is loaded into the system prompt of every agent (root + all
sub-agents) at hub startup and on sub-agent creation. It is the "inherited
floor" of project-level instructions.

Conventions (see packages/d-pi/src/workspace/workspace.ts:
`collectGroupArchitectureContext`):
  - Markdown only. d-pi reads this verbatim; no YAML frontmatter is parsed.
  - Content stacks with role-level and agent-level AGENTS.md files; later
    files append (no deduplication). The LLM sees the merged concatenation.
  - Keep this file focused on cross-cutting project rules (code style,
    repo conventions, shared "do not do X" guardrails). Per-task
    instructions belong in role-level AGENTS.md instead.

Examples of what to put here:
  - Repo-wide testing conventions ("run `npm test` from the workspace
    root, do not cd into sub-packages")
  - Branch / commit conventions
  - Credentials handling rules
  - Cross-cutting "always do X before Y" project workflow
-->