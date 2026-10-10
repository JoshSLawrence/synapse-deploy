# synapse-deploy

[![CI](https://github.com/JoshSLawrence/synapse-deploy/actions/workflows/ci.yaml/badge.svg)](https://github.com/JoshSLawrence/synapse-deploy/actions/workflows/ci.yaml)

A GitHub Action that deploys Azure Synapse workspace artifacts (pipelines,
notebooks, linked services, lake databases, ...) from an exported workspace
template (`TemplateForWorkspace.json`) through the workspace's development
endpoint, with optional deletion of what the template no longer holds and a
dry run.

## What it does

A run goes through these phases:

1. Reads and evaluates the template, with no network. ARM expressions are
   limited to `parameters`, `variables`, `concat` and `resourceId`, which is
   all the export writes.
2. Signs in.
3. Inspects the workspace (and lists it, when deleting).
4. Logs the plan.
5. Deploys in dependency order, up to 8 at a time, waiting for each
   long-running operation (20 minutes at most for each).
6. Deletes, only after every deployment succeeded, dependents first. A
   deleted managed private endpoint is awaited until the workspace no longer
   returns it.
7. Writes the three outputs and a job summary table, even when a deployment
   or deletion fails.

## Quick start (OIDC)

You need:

- An Entra app registration or user-assigned managed identity with a
  federated credential for your repository and environment. The audience is
  `api://AzureADTokenExchange` in every cloud.
- The roles in [Permissions](#permissions).
- A workspace development endpoint that the runner can reach.

The exported parameters file carries the source workspace's values, so add a
second parameters file with the target's (later files win). Here
`parameters/production.json` is your own ARM parameters file, such as:

```json
{
  "parameters": {
    "storageAccountUrl": {
      "value": "https://stexample.dfs.core.windows.net"
    }
  }
}
```

Then add a job:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: JoshSLawrence/synapse-deploy@v1
        with:
          workspace-name: myworkspace
          template-file: workspace/TemplateForWorkspace.json
          parameters-file: |
            workspace/TemplateParametersForWorkspace.json
            workspace/parameters/production.json
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
```

## Authentication

The action signs in itself; no `azure/login` step is needed.

| `auth`             | Inputs it needs                                  |
| ------------------ | ------------------------------------------------ |
| `oidc` (default)   | `client-id`, `tenant-id`; job: `id-token: write` |
| `client-secret`    | `client-id`, `tenant-id`, `client-secret`        |
| `managed-identity` | `client-id` (optional)                           |

- `client-secret` comes from a secret and is masked at once.
- `managed-identity` is for an Azure-hosted self-hosted runner. `client-id`
  selects a user-assigned identity; empty means the system-assigned one.
  `tenant-id` is ignored. Sign-in waits up to 120 seconds for the identity
  endpoint.
- `cloud` is `AzureCloud` (default), `AzureChinaCloud` or `AzureUSGovernment`
  (case-insensitive, the names `azure/login` uses).

## Inputs

<!-- inputs:start -->
<!-- markdownlint-disable MD013 -->

| Input                              | Required | Default      | Description                                                                                                                                                                                                                      |
| ---------------------------------- | -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-name`                   | yes      |              | Target workspace. Overrides the template's workspaceName parameter.                                                                                                                                                              |
| `template-file`                    | yes      |              | The exported TemplateForWorkspace.json.                                                                                                                                                                                          |
| `parameters-file`                  | no       |              | ARM parameters files (TemplateParametersForWorkspace.json or your own), space- or newline-separated (so paths can't contain spaces); later files win.                                                                            |
| `parameters`                       | no       |              | name=value lines, applied after the files. Typed by the template's parameter type; object and array values are JSON.                                                                                                             |
| `cloud`                            | no       | `AzureCloud` | AzureCloud, AzureChinaCloud or AzureUSGovernment.                                                                                                                                                                                |
| `auth`                             | no       | `oidc`       | oidc (GitHub OIDC), client-secret or managed-identity.                                                                                                                                                                           |
| `client-id`                        | no       |              | Client ID of the app registration (oidc, client-secret), or of a user-assigned managed identity (empty: the system-assigned one).                                                                                                |
| `tenant-id`                        | no       |              | Tenant ID (oidc, client-secret).                                                                                                                                                                                                 |
| `client-secret`                    | no       |              | Client secret (client-secret). Store it as a secret.                                                                                                                                                                             |
| `subscription-id`                  | no       |              | Subscription of the workspace. Needed only to deploy integration runtimes.                                                                                                                                                       |
| `resource-group`                   | no       |              | Resource group of the workspace. Needed only to deploy integration runtimes.                                                                                                                                                     |
| `delete-artifacts`                 | no       | `false`      | Delete artifacts that are in the workspace but not in the template. Never deletes integration runtimes, pools, the managed virtual network or the workspace's own defaults.                                                      |
| `deploy-managed-private-endpoints` | no       | `false`      | Deploy the template's managed private endpoints. When false they are neither deployed nor deleted. When true with delete-artifacts, endpoints not in the template are deleted (never synapse-ws-*, which the workspace creates). |
| `dry-run`                          | no       | `false`      | Sign in, read the template and the workspace, and report what would be deployed and deleted, without changing anything.                                                                                                          |

<!-- markdownlint-enable MD013 -->
<!-- inputs:end -->

`parameters` lines are `name=value`. The first `=` splits the line. Values are
typed by the template parameter's type (object and array values are JSON) and
applied after the files. A value taken from `${{ secrets.X }}` stays masked,
and a bad line is reported by its number only.

## Outputs

<!-- outputs:start -->
<!-- markdownlint-disable MD013 -->

| Output     | Description                                                  |
| ---------- | ------------------------------------------------------------ |
| `deployed` | Number of artifacts deployed (would be, in a dry run).       |
| `skipped`  | Number of template resources skipped (defaults, pools, ...). |
| `deleted`  | Number of artifacts deleted (would be, in a dry run).        |

<!-- markdownlint-enable MD013 -->
<!-- outputs:end -->

`deleted` counts artifacts only: lake database tables and relationships are
reported in the log and the job summary, not in `deleted`. In a dry run the
outputs are what would happen.

## What is deployed and deleted

<!-- markdownlint-disable MD013 -->

| Template type                                                                                                                                      | Deployed                                       | Deleted (`delete-artifacts`)                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| notebooks, sparkJobDefinitions, sqlScripts, kqlScripts, sparkConfigurations, datasets, dataflows, pipelines, triggers, linkedServices, credentials | yes                                            | yes, when not in the template                                                         |
| databases (lake databases)                                                                                                                         | yes, table by table                            | lake databases not in the template; tables and relationships missing from one that is |
| managed private endpoints                                                                                                                          | only with `deploy-managed-private-endpoints`   | only with `deploy-managed-private-endpoints`; never `synapse-ws-*`                    |
| integrationRuntimes                                                                                                                                | yes, through Azure Resource Manager            | never                                                                                 |
| bigDataPools, sqlPools, managedVirtualNetworks                                                                                                     | skipped (leave them to infrastructure as code) | never                                                                                 |
| any other type                                                                                                                                     | the run fails before any change                | n/a                                                                                   |

<!-- markdownlint-enable MD013 -->

- Only lake databases created in Studio (Spark origin, database template flag)
  are ever deleted, never databases that a notebook created.
- Deletion runs only when every deployment succeeded.
- The action never starts or stops triggers. A started trigger refuses
  updates and deletes ("Stop the trigger first").
- With endpoints requested and no managed virtual network in the workspace, a
  managed private endpoint in the template fails the run before any change.
  Without a managed private endpoint in the template, the run logs it and
  continues.

## Permissions

These are the minimal roles for the calls the action makes.

<!-- markdownlint-disable MD013 -->

| When                                  | Role                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Always                                | Synapse Artifact Publisher (Synapse RBAC, workspace scope)                                                                                                                                                                                                                                                 |
| `deploy-managed-private-endpoints`    | also Synapse Linked Data Manager (or Synapse Administrator)                                                                                                                                                                                                                                                |
| The template has integration runtimes | Azure RBAC on the workspace: Owner or Contributor, or a custom role with `Microsoft.Synapse/workspaces/integrationRuntimes/read`, `Microsoft.Synapse/workspaces/integrationRuntimes/write`, `Microsoft.Synapse/workspaces/operationResults/read` and `Microsoft.Synapse/workspaces/operationStatuses/read` |

<!-- markdownlint-enable MD013 -->

- Without integration runtimes the action never calls Azure Resource Manager,
  so it needs no Azure RBAC role at all.
- Synapse RBAC roles cannot manage integration runtimes (Microsoft's note).
- Lake databases have no separate action in Microsoft's table.
- The custom role for integration runtimes is untested.

The live test runs with Synapse Artifact Publisher and Synapse Linked Data
Manager, plus Contributor on the workspace for integration runtimes, and
covers lake databases and managed private endpoints.

See Microsoft's [Azure Synapse RBAC roles][synapse-rbac].

## Dry run

With `dry-run: true` the action signs in, reads the template, logs and
summarizes what would be deployed, skipped and deleted, and sets the outputs to
those counts. It writes nothing. It reads the workspace only with
`delete-artifacts` (to list what exists) or `deploy-managed-private-endpoints`
(to probe the managed virtual network). The same roles are enough, but a dry
run only reads.

A typical use is a pull request job. OIDC needs `id-token: write`, which pull
requests from forks never get, so run the job for same-repository pull
requests only.

A pull request can edit the workflow, so give the job its own environment and
federated credential, never the production one. Use a separate identity (a
different app registration, so a different `client-id`) that is ideally
read-only: Synapse Artifact User can read artifacts, but listing the workspace
under that role is untested. Restrict the production environment's deployment
branches to `main` (and require a reviewer); otherwise a pull request can
switch the job to it.
See [`examples/plan-and-deploy.yaml`](examples/plan-and-deploy.yaml).

## Reserved names

The workspace's own artifacts are never deployed or deleted:

- linked services named `*-WorkspaceDefaultStorage` and
  `*-WorkspaceDefaultSqlServer` (case-insensitive, anchored at the end of the
  name, whatever the linked service's type)
- the credential `WorkspaceSystemIdentity`
- managed private endpoints named `synapse-ws-*`

References to the source workspace's default linked services are rewritten to
the target's (`<target>-WorkspaceDefaultStorage`).

## Validate and export the template

The Synapse export usually comes from Studio's Publish (the
`workspace_publish` branch). To build it from the Git folder in CI instead,
without Azure credentials or a workspace (the runner needs outbound HTTPS),
compose `shared/setup` and `synapse/build`
from [JoshSLawrence/actions][actions] (pin
`40c13146c9512361c323fcc49134c832cfdc3c03 # v0.6.0`; the folder needs a
`mise.toml` that pins node). Upload `template-dir` as an artifact and deploy
it in a later job.
[`examples/plan-and-deploy.yaml`](examples/plan-and-deploy.yaml) does this.

## Examples

- [`examples/deploy.yaml`](examples/deploy.yaml): deploy the exported template
  when it changes on main.
- [`examples/plan-and-deploy.yaml`](examples/plan-and-deploy.yaml): build the
  template, dry-run on pull requests, deploy on main.

## Known limitations

- Only the four ARM functions above are evaluated.
- `parameters-file` paths cannot contain spaces.
- Integration runtimes are never deleted.
- Pools, the managed virtual network and workspace settings are not deployed;
  use infrastructure as code for them.
- Triggers are not started or stopped.
- The development endpoint must be reachable from the runner. A workspace with
  public network access off needs a self-hosted runner with a private endpoint
  to it.
- String defaults that look like JSON and that the export changed produce a
  warning. Fix them in Studio, or override them at run time.

## Migrating from Azure/Synapse-workspace-deployment

<!-- markdownlint-disable MD013 -->

| Azure/Synapse-workspace-deployment              | synapse-deploy                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `operation: deploy`                             | the only operation; remove it                                       |
| `operation: validate`, `validateDeploy`         | `synapse/build` (see above), then this action                       |
| `TargetWorkspaceName`                           | `workspace-name`                                                    |
| `TemplateFile`                                  | `template-file`                                                     |
| `ParametersFile`                                | `parameters-file` (several, later wins; optional)                   |
| `OverrideArmParameters` (YAML or `-name value`) | `parameters` (`name=value` lines) or a parameters file              |
| `FailOnMissingOverrides`                        | removed: a missing value always fails                               |
| `Environment` (required)                        | `cloud` (optional, default `AzureCloud`)                            |
| `resourceGroup`, `subscriptionId` (required)    | `resource-group`, `subscription-id` (only for integration runtimes) |
| `clientId`, `tenantId`                          | `client-id`, `tenant-id`                                            |
| `clientSecret`                                  | `client-secret` with `auth: client-secret`                          |
| `managedIdentity: true`                         | `auth: managed-identity`                                            |
| `federatedIdentity: true` (in some forks)       | `auth: oidc`, the default                                           |
| `DeleteArtifactsNotInTemplate`                  | `delete-artifacts`                                                  |
| `deployManagedPrivateEndpoint`                  | `deploy-managed-private-endpoints`                                  |
| `ArtifactsFolder`, `npmpackage`                 | removed                                                             |

<!-- markdownlint-enable MD013 -->

- `Environment` values map as `Azure Public` to `AzureCloud`, `Azure China` to
  `AzureChinaCloud` and `Azure US Government` to `AzureUSGovernment`. `Azure
  Germany` is not supported.
- A YAML overrides file (`name: value` per line) becomes an ARM parameters
  file, `{"parameters": {"name": {"value": <value>}}}`, passed as a second
  `parameters-file` entry. Short values can go in `parameters` instead.

Behaviour differences:

- Artifacts deploy in parallel, in dependency order.
- The workspace defaults are reserved by name, whatever their type.
- Template parameter defaults are applied.
- Literal text that looks like `parameters('x')` inside notebooks and SQL is
  left alone.
- A parameters file or `parameters` line that sets a parameter the template
  does not declare fails the run; upstream ignored extra keys.
- Key Vault `reference` entries in a parameters file are refused with a clear
  message; pass the value in `parameters` instead.
- There is a dry run.
- No Azure Reader role is needed without integration runtimes.

## Versioning

Semantic versioning. `@v1` follows the latest `v1.x.y`; exact tags are
immutable releases. For supply-chain safety, pin a full commit SHA with a
comment and let Dependabot bump it:

```yaml
- uses: JoshSLawrence/synapse-deploy@<full commit SHA> # v1.0.0
```

A major version is for removing or renaming an input or output, changing a
default's behaviour, deleting something the previous version kept, or needing
a new permission. A minor version is for new inputs, outputs or artifact
kinds. A patch is for fixes.

## Security

See [`SECURITY.md`](SECURITY.md).

## Credits

Inspired by, and partly derived from,
[Azure/Synapse-workspace-deployment][upstream] (MIT, Microsoft). See
`THIRD_PARTY_NOTICES.md`.

## Trademarks

Azure and Synapse are trademarks of Microsoft. This project is not affiliated
with or endorsed by Microsoft.

## License

MIT; see `LICENSE`.

[actions]: https://github.com/JoshSLawrence/actions
[synapse-rbac]: https://learn.microsoft.com/azure/synapse-analytics/security/synapse-workspace-synapse-rbac-roles
[upstream]: https://github.com/Azure/Synapse-workspace-deployment
