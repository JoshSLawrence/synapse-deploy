# synapse-deploy

A GitHub Action (Node 24, ESM TypeScript) that deploys Azure Synapse workspace
artifacts from an exported workspace template, through the workspace's
development endpoint. It is being rewritten for v1.0.0: until the rewrite is
finished `src/run.ts` validates the inputs and then fails with "not
implemented yet".

## Hard rule

This repository is public and personal. Nothing in it may reference any
organization, team or employer, their repositories, real Azure resource names
or suffixes, or subscription, tenant or client IDs. That covers code, tests,
fixtures, docs, this file, workflow files, commit messages, PR text and release
notes. Use generic placeholders: `contoso`, `example`, `myworkspace`,
`rg-example`, `stexample`, `00000000-0000-0000-0000-000000000000`.

Before committing, grep the diff and the commit message for generic patterns:
GUIDs other than all zeros, `onmicrosoft`, `subscriptions/` followed by a
non-zero GUID, and any hostname that is not a cloud endpoint in `src/cloud.ts`
or under `example`. The hosts allowed in fixtures are `contoso`, `example.com`,
`*.example`, `stexample`, `examplestorage`, `myworkspace` (such as
`stexample.dfs.core.windows.net` and `sql.example.com`) and the ARM schema host
`schema.management.azure.com`.

## Layout

```text
.github/
  dependabot.yml
  scripts/
    check-dist.sh
    smoke.sh
  workflows/
    ci.yaml
.gitattributes
.gitignore
.markdownlint-cli2.yaml
.pre-commit-config.yaml
.prettierignore
.prettierrc.json
action.yml
AGENTS.md -> CLAUDE.md
CLAUDE.md
dist/
  index.js
  index.js.map
  licenses.txt
eslint.config.js
LICENSE
mise.toml
package-lock.json
package.json
README.md
scripts/
  build.mjs
src/
  auth.ts
  cloud.ts
  exit_guard.ts
  http.ts
  inputs.ts
  kinds.ts
  main.ts
  mask.ts
  run.ts
test/
  fixtures/
    templates/
  *.test.ts
THIRD_PARTY_NOTICES.md
tsconfig.json
```

## Tasks

Tools come from `mise.toml` (Node is pinned there); run everything through
mise so CI and a laptop use the same versions.

| Task                  | Does                                              |
| --------------------- | ------------------------------------------------- |
| `mise run build`      | Bundle `src/main.ts` into `dist/` (esbuild)       |
| `mise run check-dist` | Rebuild and fail if `dist/` differs from Git      |
| `mise run lint`       | Every pre-commit hook on all files                |
| `mise run smoke`      | Run the built action with no network             |
| `mise run test`       | `node --test` over `test/**/*.test.ts`            |
| `mise run typecheck`  | `tsc --noEmit`                                    |

`npm run lint` runs the same pre-commit hooks. Run `npm ci` first. Tests use
Node's built-in runner and type stripping, so `.ts` files run directly: no
enums, namespaces or parameter properties, and imports carry the `.ts`
extension.

## CI and updates

- The required checks are `Lint`, `Test` and `Build`. `Test (node 26)` is not
  required; it shows early what the next Node major breaks.
- Dependabot updates npm packages and GitHub Actions. It does not update the
  `mise.toml` tools or the `rev` pins in `.pre-commit-config.yaml`: bump those
  by hand.

## dist/ is committed

GitHub runs `dist/index.js`; `dist/licenses.txt` carries the notices of the
packages bundled into it, written by the same build, so any change to `src/`, `scripts/build.mjs`,
`package-lock.json` or the toolchain needs a rebuilt `dist/` in the same
commit. The `Build` check fails on a stale `dist/`. A Dependabot npm pull
request fails it by design: check out the branch, run `mise run build`, commit
`dist/` and push.

## Conventions

- Match the existing style; Prettier and ESLint (type-aware) are the arbiters.
  `no-floating-promises` and `no-misused-promises` are errors: a promise that
  is never awaited can leave a request pending while the run reports success.
- Comments explain why, not what.
- Error messages say what went wrong and what to do about it.
- Files whose logic is derived from Azure/Synapse-workspace-deployment keep the
  Microsoft copyright and MIT header and are listed in
  `THIRD_PARTY_NOTICES.md`; code written new carries no such header.
- Shell scripts: `#!/usr/bin/env bash`, `set -euo pipefail`, `chmod +x`, and
  `log_info`/`log_warn`/`log_error` helpers.
- `test/fixtures/templates/*/legacy.json` is recorded data from the predecessor
  implementation and is frozen; never regenerate or edit it.
- Never add a lint suppression to make a check pass; fix the cause or ask.

### Workflows

- `permissions: {}` at the top; each job grants only what it needs.
- Every action is pinned to a full commit SHA with a `# vX.Y.Z` comment, and
  checkout uses `persist-credentials: false`.
- Tools come from `mise.toml` through `jdx/mise-action`.
- One command per `run:` step; logic lives in `.github/scripts/*.sh`.
- `timeout-minutes` on every job, and concurrency per ref.
- actionlint and zizmor must be clean (they run in `mise run lint`).

## Versioning

Semantic versioning from v1.0.0. Major for removing or renaming an input or
output, changing a default's behaviour, deleting something the previous version
kept, or needing a new permission. Minor for new inputs, outputs or artifact
kinds. Patch for fixes. Tags exist only through releases; there is no moving
major tag.
