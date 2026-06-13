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

# Network-level rules

## Lark source → lark-cli (reply channel rule)

When a message arrives through a d-pi source whose `sourceName`
identifies it as a Lark / Feishu source (e.g. `lark-bot`, or
whatever the `lark-subscribe-router` role is subscribed to), the
**reply channel for that user is `lark-cli`**, not d-pi
`send_message`. d-pi `send_message` is the agent-to-agent channel;
it does not reach a Lark user. To put a message in front of a
Lark user, the `lark-subscribe-router` agent must synthesise the
reply and send it via the `lark-im` skill / `lark-cli` (see
`roles/lark-subscribe-router/AGENTS.md` for the synthesis
pipeline).

Concretely:

- If you (any agent, not just the router) receive a message
  whose meta header has `sourceType: "source"` and
  `sourceName` matching a Lark source, treat it as **user input
  from Lark**, not as a peer-agent message.
- The reply path back to that user MUST go through the router
  (via `send_message` to the router's agentId, which you can
  read from `meta.agentId` of the message the router forwarded
  to you). Never call lark-cli / lark-im directly from a
  non-router agent — you don't have the user's `chat_id`, and
  bypassing the router breaks character consistency, source
  denylists, and reply coalescing.
- d-pi `send_message` is reserved for agent-to-agent comms only
  (you → router, you → root, you → another child). It must
  never be used to try to reach a Lark user; the call will
  succeed (it's just a JSON-RPC message) but the user will
  never see it.

### Inbound source routing — reply channel by origin

When deciding where to send a reply, match the inbound
`sourceType` to the right reply channel:

| Inbound `sourceType` | Reply channel |
|---|---|
| `connect` (Connect TUI) | **This terminal.** Reply directly in the conversation. The user is sitting at the TUI; the message is visible to them as soon as you emit text. Do NOT call `lark-cli` / `lark-im` — that would send a duplicate to a Lark user who never asked for anything. |
| `source` (Lark / Feishu / external) | `lark-cli` via the `lark-subscribe-router` agent (the routing chain documented above). |
| `agent` (peer agent) | `send_message` to the originating `meta.agentId`. |

The Connect TUI case is the easy one to get wrong: the user
opens a Connect session, types a message, sees the agent
replying — and then also gets a Lark message in the same chat
because the agent reflexively called `lark-cli`. Always
check the inbound meta before picking a reply channel.

This is the single source of truth for the rule; per-agent
AGENTS.md should cross-reference it rather than redefine it.