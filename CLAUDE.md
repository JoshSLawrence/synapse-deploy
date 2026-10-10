# synapse-deploy

A GitHub Action (Node 24, ESM TypeScript) that deploys Azure Synapse workspace
artifacts from an exported workspace template, through the workspace's
development endpoint. The deploy, delete and dry-run phases are in
`src/run.ts`; releases are cut by the `Release` workflow.

## Hard rule

This repository is public and personal. Nothing in it may reference any
organization, team or employer, their repositories, real Azure resource names
or suffixes, or subscription, tenant or client IDs. That covers code, tests,
fixtures, docs, this file, workflow files, commit messages, PR text and release
notes. Use generic placeholders: `contoso`, `example`, `myworkspace`,
`rg-example`, `stexample`, `00000000-0000-0000-0000-000000000000`.

Before committing, grep the diff and the commit message for generic patterns:
GUIDs other than all zeros (the lake fixture IDs
`00000000-0000-0000-0000-0000000000[0-9a-f]{2}` are placeholders too),
`onmicrosoft`, `subscriptions/` followed by a
non-zero GUID, and any hostname that is not a cloud endpoint in `src/cloud.ts`
or under `example`. The hosts allowed in fixtures are `contoso`, `example.com`,
`*.example`, `stexample`, `examplestorage`, `myworkspace` (such as
`stexample.dfs.core.windows.net` and `sql.example.com`) and the ARM schema host
`schema.management.azure.com`.

## Layout

```text
.gitattributes
.github/
  dependabot.yml
  scripts/
    azure-e2e/
      azure.sh
      build-fixtures.sh
      check.sh
      cleanup.sh
      lib.sh
      log-check.sh
      prepare.sh
      snapshot.sh
      steps.sh
    check-dist.sh
    release-test.sh
    release.sh
    smoke.sh
  workflows/
    azure-e2e.yaml
    ci.yaml
    release.yaml
  zizmor.yml
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
examples/
  deploy.yaml
  plan-and-deploy.yaml
LICENSE
mise.toml
package-lock.json
package.json
README.md
scripts/
  build.mjs
  readme-tables.ts
SECURITY.md
src/
  arm.ts
  auth.ts
  cloud.ts
  defaults.ts
  deletion.ts
  exit_guard.ts
  expression.ts
  graph.ts
  http.ts
  inputs.ts
  kinds.ts
  lakedb.ts
  lro.ts
  main.ts
  mask.ts
  report.ts
  run.ts
  synapse.ts
  template.ts
test/
  fake/
    synapse_server.ts
  fixtures/
    azure-e2e/
    templates/
  support/
  readme.test.ts
  *.test.ts
THIRD_PARTY_NOTICES.md
tsconfig.json
```

## Tasks

Tools come from `mise.toml` (Node is pinned there); run everything through
mise so CI and a laptop use the same versions.

| Task                    | Does                                              |
| ----------------------- | ------------------------------------------------- |
| `mise run build`        | Bundle `src/main.ts` into `dist/` (esbuild)       |
| `mise run check-dist`   | Rebuild and fail if `dist/` differs from Git      |
| `mise run docs`         | Regenerate the README's inputs and outputs tables |
| `mise run lint`         | Every pre-commit hook on all files                |
| `mise run smoke`        | Run the built action with no network              |
| `mise run test`         | `node --test` over `test/**/*.test.ts`            |
| `mise run test-release` | Test the pure functions of `release.sh`           |
| `mise run typecheck`    | `tsc --noEmit`                                    |

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
packages bundled into it, written by the same build, so any change to
`src/`, `scripts/build.mjs`, `package-lock.json` or the toolchain needs a
rebuilt `dist/` in the same commit. The `Build` check fails on a stale
`dist/`. A Dependabot npm pull request fails it by design: check out the
branch, run `mise run build`, commit `dist/` and push.

## Documentation

The README's inputs and outputs tables are generated from `action.yml`
between `<!-- NAME:start -->` and `<!-- NAME:end -->` markers (`inputs` and
`outputs`).
Never hand-edit them: change `action.yml`, then run `mise run docs`.
`test/readme.test.ts` fails when they are stale. The two files in `examples/`
are linted by actionlint; zizmor stays off `examples/` because it flags the
`@v1` ref by design.

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
- Shell scripts are shellcheck clean (`mise run lint`), with no suppressions.
- Never add a lint suppression to make a check pass; fix the cause or ask.

### Workflows

- `permissions: {}` at the top; each job grants only what it needs.
- Every action is pinned to a full commit SHA with a `# vX.Y.Z` comment, and
  checkout uses `persist-credentials: false`.
- Tools come from `mise.toml` through `jdx/mise-action`.
- One command per `run:` step; logic lives in `.github/scripts/*.sh`.
- `timeout-minutes` on every job, and concurrency per ref. The two exceptions
  are `azure-e2e` and `release`, which share one group each and never cancel
  a run in progress.
- actionlint and zizmor must be clean (they run in `mise run lint`).
  `.github/zizmor.yml` ignores only the `self-repository` rule, and only for
  `azure-e2e.yaml` (its `uses: ./`); switch to `$/` once actionlint accepts it.

## Versioning

Semantic versioning. Major for removing or renaming an input or
output, changing a default's behaviour, deleting something the previous version
kept, or needing a new permission. Minor for new inputs, outputs or artifact
kinds. Patch for fixes. Exact `vX.Y.Z` tags exist only through releases and are
immutable; `vMAJOR` is a lightweight tag the release workflow moves to the
latest release of that major.

## Releasing

1. Dispatch `Azure E2E` on main and approve the `azure-e2e` deployment.
2. Dispatch `Release` from main with `version` and `dry-run: true`, and grep
   the printed release notes for forbidden terms.
3. Dispatch it for real:
   `gh workflow run release.yaml --ref main -f version=v1.2.3`.

Release re-runs typecheck, test, build, `check-dist` and smoke, requires a
successful `Azure E2E` run for the commit (`skip-e2e` only when Azure is
down), creates the immutable release with generated notes and moves `vMAJOR`
(PATCH, fast-forward only). It releases main's current head only; if main
moved, run Azure E2E and Release again.

If the tag move is refused, the log prints the exact command: run it at once
with your own credentials. A re-run with the same version resumes (it only
moves the major tag) but works only while main has not moved. Exact tags are
protected by a ruleset (the owner is a bypass actor); `vMAJOR` is not.

## Live e2e

`Azure E2E` (`.github/workflows/azure-e2e.yaml`) deploys the fixtures in
`test/fixtures/azure-e2e/` to a real workspace with the checked-out commit's
committed `dist/` (`uses: ./`), checks counts and state after each step
(deploy, redeploy, dry run, deploy with deletion), then restores the
workspace and fails if it does not end as it began.
A second job, `log-check.sh`, scans the finished job log.

- It runs in the `azure-e2e` environment (deployment branches: `main` only,
  a required reviewer). The environment's secrets are `AZURE_CLIENT_ID`,
  `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` and
  `AZURE_SYNAPSE_WORKSPACE`.
- Dispatch only. Never add `pull_request`, `pull_request_target` or
  `workflow_call`: the environment holds the test identity.
- Never set the repository variables `ACTIONS_STEP_DEBUG` or
  `ACTIONS_RUNNER_DEBUG`, and never re-run with debug logging: the run log is
  public. The workflow refuses to run at debug level.
- Every step of the e2e job has its own `timeout-minutes`, and the job's is
  their sum rounded up, so the job timeout never ends a step (a cancelled or
  timed-out job's remaining steps get only a few minutes). A healthy run takes
  about 5 minutes; the caps are only for hangs. A deploy step gets 25 minutes,
  longer than the action's own 20 minute operation deadline, so the action
  reports its error before the runner kills it. Raise the job timeout when you
  add a step. The cleanup signs in again first, because a federated token
  cannot be refreshed after about an hour.
- A cancelled or timed-out run can leave leftovers in the workspace. The next
  run refuses to start (`--require-empty`) until they are removed by hand.
- No artifact uploads: public run artifacts are downloadable by anyone.
- One run at a time, also across repositories that use the same workspace.
- The log check proves that hosts, resource paths, GUIDs and tokens never
  appear unmasked in the whole log. It does not prove that a bare workspace
  or resource-group name never appears: those rely on the runner's
  case-sensitive secret masking. Read the first public log and the job
  summary by hand. Allow-listing a real value to silence a finding is a
  hard-rule violation; its allow-list takes runner and checkout boilerplate
  GUIDs only (the worker ID, per-step directories under the temp folder and
  checkout's `git-credentials-<guid>.config`), each cut out of the line by an
  anchored pattern so any other ID on the line is still reported.
- The test identity runs with Synapse Artifact Publisher, Synapse Linked Data
  Manager and Contributor on the workspace, and cannot start triggers, so the
  e2e does not test a started trigger (the fake-server tests cover the
  refusal shapes). If something else fails under these roles, that is a README
  finding: document the role the live test actually needs; drop the check
  rather than widening the role silently.
- `build-fixtures.sh` regenerates the exported templates in
  `test/fixtures/azure-e2e/` from its `workspace/` Git folder; set
  `ACTIONS_DIR` to a checkout of `JoshSLawrence/actions`.
