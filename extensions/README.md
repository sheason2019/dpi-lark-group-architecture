# Extensions go here.

d-pi recursively scans this directory at agent startup and adds every
entry it finds to `additionalExtensionPaths`. Single `.ts` / `.js` / `.mjs`
files, directories with `package.json` + `pi.extensions`, and any
`index.ts` / `index.js` entry point are all valid.

Layout (typical):
  extensions/
    <name>.ts              # single-file extension
    <name>/                # or a directory with package.json
      package.json         # { "pi": { "extensions": ["./index.ts"] } }
      index.ts

This file is a placeholder so the directory exists in git. Delete it
once you add a real extension.

See packages/d-pi-official/docs/group-architecture/directory-convention.md
for the full contract.