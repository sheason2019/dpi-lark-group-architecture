# Skills go here.

Each skill is a directory containing a SKILL.md file. The directory name
becomes the skill name. d-pi auto-discovers this directory at agent startup
and adds it to the agent's skill search path; the LLM uses `read` to load
SKILL.md on demand.

Layout:
  skills/
    <skill-name>/
      SKILL.md          # required, markdown teaching content
      ...                # optional supporting files referenced from SKILL.md

Naming:
  - Directory name = skill name; short kebab-case (`git-bisect`,
    `lark-message-send`).
  - The SKILL.md filename is fixed — d-pi will NOT load `README.md`,
    `skill.md`, or any other case variant.

See packages/d-pi-official/docs/group-architecture/directory-convention.md
for the full contract.