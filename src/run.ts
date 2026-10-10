import * as core from '@actions/core';
import { deployIntegrationRuntime } from './arm.ts';
import { createTokenProvider } from './auth.ts';
import type { TokenProvider } from './auth.ts';
import { armScope, dataPlaneScope, dataPlaneUrl } from './cloud.ts';
import { listLiveArtifacts, planDeletions, planLakeChildren } from './deletion.ts';
import type { LiveArtifact } from './deletion.ts';
import { buildGraph, schedule } from './graph.ts';
import type { GraphNode } from './graph.ts';
import { createHttp, defaultSleep } from './http.ts';
import type { Http } from './http.ts';
import type { Inputs } from './inputs.ts';
import { deleteLakeChild, describeLakeChild } from './lakedb.ts';
import type { LakeChild } from './lakedb.ts';
import type { LroContext } from './lro.ts';
import {
  logDeleted,
  logDeployed,
  logFailed,
  logSkipped,
  setOutputs,
  writeSummary,
} from './report.ts';
import type { Counts, Row } from './report.ts';
import { deleteArtifact, deployArtifact, hasManagedVirtualNetwork } from './synapse.ts';
import type { SynapseContext } from './synapse.ts';
import { loadTemplate } from './template.ts';
import type { Artifact } from './template.ts';

/**
 * Everything the run reaches outside the process through. Tests pass a fake
 * token provider, loopback endpoints and an instant sleep; no test-only input
 * or environment variable exists in shipped code.
 */
export interface Deps {
  tokens: TokenProvider;
  endpoints: { dataPlane: string; arm: string };
  http: Http;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function defaultDeps(inputs: Inputs): Deps {
  const tokens = createTokenProvider({
    mode: inputs.auth,
    clientId: inputs.clientId,
    clientSecret: inputs.clientSecret,
    tenantId: inputs.tenantId,
    authorityHost: inputs.cloud.login,
  });
  return {
    tokens,
    endpoints: {
      dataPlane: dataPlaneUrl(inputs.cloud, inputs.workspaceName),
      arm: inputs.cloud.arm.replace(/\/+$/, ''),
    },
    http: createHttp({ tokens }),
    sleep: defaultSleep,
    now: Date.now,
  };
}

export const SKIP_ENDPOINTS =
  'managed private endpoints are not deployed (deploy-managed-private-endpoints is false)';

async function group<T>(name: string, work: () => Promise<T> | T): Promise<T> {
  core.startGroup(name);
  try {
    return await work();
  } finally {
    core.endGroup();
  }
}

function labelOf(artifact: Pick<Artifact, 'kind' | 'name'>): string {
  return `${artifact.kind.id}/${artifact.name}`;
}

function list(labels: readonly string[]): string {
  const shown = labels.slice(0, 10).join(', ');
  return labels.length > 10 ? `${shown}, and ${labels.length - 10} more` : shown;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Phase 3 of the design: the managed virtual network probe. With no network,
 * endpoints in the template cannot be deployed and the run says so before it
 * changes anything; without any, there is nothing to deploy or delete.
 */
async function inspectWorkspace(
  inputs: Inputs,
  synapse: SynapseContext,
  artifacts: readonly Artifact[],
): Promise<Awaited<ReturnType<typeof hasManagedVirtualNetwork>> | undefined> {
  if (!inputs.deployManagedPrivateEndpoints) {
    return undefined;
  }
  const probe = await hasManagedVirtualNetwork(synapse);
  if (!probe.exists) {
    const endpoints = artifacts.filter(
      (artifact) => artifact.kind.id === 'managedPrivateEndpoints' && artifact.skip === undefined,
    );
    if (endpoints.length > 0) {
      throw new Error(
        `deploy-managed-private-endpoints is true, but workspace ${inputs.workspaceName} has no ` +
          "managed virtual network, so the template's managed private endpoints (" +
          `${list(endpoints.map(labelOf))}) cannot be deployed. Set it to false, or deploy to a ` +
          'workspace with a managed virtual network.',
      );
    }
    core.info(
      `workspace ${inputs.workspaceName} has no managed virtual network: no endpoints to deploy or delete`,
    );
  }
  return probe;
}

interface Plan {
  deletions: LiveArtifact[];
  deletionNodes: GraphNode[];
  children: LakeChild[];
}

function childKey(child: LakeChild): string {
  return `${child.type}:${child.database.toLowerCase()}/${child.name.toLowerCase()}`;
}

/** Relationships first: a table goes after every relationship of its database. */
function childNodes(children: readonly LakeChild[]): GraphNode[] {
  return children.map((child) => ({
    key: childKey(child),
    dependsOn:
      child.type === 'tables'
        ? children
            .filter((other) => other.type === 'relationships' && other.database === child.database)
            .map(childKey)
        : [],
  }));
}

/**
 * Deploys the template (and, with delete-artifacts, removes what it no longer
 * holds) through the phases of design 3.7. Resolves when everything planned
 * finished; rejects with a summary line otherwise, after the outputs and the
 * job summary are written.
 */
export async function run(inputs: Inputs, deps: Deps): Promise<Counts> {
  // 1. Read: no network, so a template error fails in milliseconds.
  const all = await group('Template', async () => {
    const { artifacts } = await loadTemplate(inputs);
    const prepared = artifacts.map((artifact) =>
      artifact.skip === undefined &&
      artifact.kind.id === 'managedPrivateEndpoints' &&
      !inputs.deployManagedPrivateEndpoints
        ? { ...artifact, skip: SKIP_ENDPOINTS }
        : artifact,
    );
    const runtimes = prepared.filter(
      (artifact) => artifact.kind.plane === 'arm' && artifact.skip === undefined,
    );
    if (runtimes.length > 0 && (!inputs.subscriptionId || !inputs.resourceGroup)) {
      throw new Error(
        `The template has integration runtimes (${list(runtimes.map(labelOf))}), which are ` +
          'deployed through Azure Resource Manager: set the subscription-id and resource-group ' +
          'inputs.',
      );
    }
    core.info(`${prepared.length} resource(s) in ${inputs.templateFile}`);
    return prepared;
  });
  const deployable = all.filter((artifact) => artifact.skip === undefined);
  const nodes = buildGraph(all, deployable);
  const byKey = new Map(deployable.map((artifact) => [artifact.key, artifact]));
  const labelFor = (key: string): string => {
    const artifact = byKey.get(key);
    return artifact === undefined ? key : labelOf(artifact);
  };

  const lro: LroContext = { http: deps.http, sleep: deps.sleep, now: deps.now };
  const dataScope = dataPlaneScope(inputs.cloud);
  const synapse: SynapseContext = { ...lro, dataPlane: deps.endpoints.dataPlane, scope: dataScope };
  const needsArm = deployable.some((artifact) => artifact.kind.plane === 'arm');

  // 2. Sign in, so a missing role or a mis-set identity fails before the plan.
  await group('Sign in', async () => {
    await deps.tokens.getToken(dataScope);
    if (needsArm) {
      await deps.tokens.getToken(armScope(inputs.cloud));
    }
    core.info(`signed in to ${new URL(deps.endpoints.dataPlane).host}`);
  });

  // 3. Inspect. The deletion plan is computed now so that missing read rights
  // fail before anything changes and the plan is in the log up front.
  const plan: Plan = await group('Workspace', async () => {
    const probe = await inspectWorkspace(inputs, synapse, all);
    if (!inputs.deleteArtifacts) {
      return { deletions: [], deletionNodes: [], children: [] };
    }
    const live = await listLiveArtifacts(synapse, probe);
    const { artifacts, nodes: deletionNodes } = planDeletions(live, all);
    const children = await planLakeChildren(synapse, live, all);
    core.info(`${live.length} artifact(s) in the workspace`);
    return { deletions: artifacts, deletionNodes, children };
  });

  // 4. Report the plan.
  const rows: Row[] = [];
  const counts: Counts = { deployed: 0, skipped: 0, deleted: 0 };
  const verb = inputs.dryRun ? 'would ' : '';
  await group('Plan', () => {
    for (const artifact of all) {
      if (artifact.skip !== undefined) {
        logSkipped(labelOf(artifact), artifact.skip);
        rows.push({
          section: 'skip',
          artifact: labelOf(artifact),
          outcome: 'skipped',
          detail: artifact.skip,
        });
        counts.skipped++;
      }
    }
    core.info(
      `${verb}deploy ${deployable.length}, skip ${counts.skipped}, delete ${plan.deletions.length}` +
        (plan.children.length > 0
          ? ` (and ${plan.children.length} lake database table(s) or relationship(s))`
          : ''),
    );
    for (const artifact of deployable) {
      core.info(`${verb}deploy ${labelOf(artifact)}`);
    }
    for (const artifact of plan.deletions) {
      core.info(`${verb}delete ${labelOf(artifact)}`);
    }
    for (const child of plan.children) {
      core.info(`${verb}delete ${describeLakeChild(child)}`);
    }
  });

  if (inputs.dryRun) {
    counts.deployed = deployable.length;
    counts.deleted = plan.deletions.length;
    for (const artifact of deployable) {
      rows.push({
        section: 'deploy',
        artifact: labelOf(artifact),
        outcome: 'would deploy',
        detail: '',
      });
    }
    for (const artifact of plan.deletions) {
      rows.push({
        section: 'delete',
        artifact: labelOf(artifact),
        outcome: 'would delete',
        detail: '',
      });
    }
    for (const child of plan.children) {
      rows.push({
        section: 'delete',
        artifact: describeLakeChild(child),
        outcome: 'would delete',
        detail: '',
      });
    }
    setOutputs(counts);
    await writeSummary({
      dryRun: true,
      verdict: '',
      counts,
      rows,
      lakeChildren: plan.children.length,
    });
    core.info('dry run: nothing was changed');
    return counts;
  }

  // 5. Deploy.
  const problems: string[] = [];
  let lakeChildren = 0;
  const deployed = await group(`Deploy (${deployable.length})`, () =>
    schedule(nodes, async (key) => {
      const artifact = byKey.get(key);
      if (artifact === undefined) {
        throw new Error(`internal error: ${key} is not a deployable artifact`);
      }
      const label = labelOf(artifact);
      const started = deps.now();
      try {
        if (artifact.kind.plane === 'arm') {
          await deployIntegrationRuntime(
            {
              ...lro,
              arm: deps.endpoints.arm,
              scope: armScope(inputs.cloud),
              subscriptionId: inputs.subscriptionId,
              resourceGroup: inputs.resourceGroup,
              workspace: inputs.workspaceName,
            },
            artifact.name,
            artifact.body,
          );
        } else {
          await deployArtifact(synapse, artifact.kind, artifact.name, artifact.body);
        }
      } catch (error) {
        logFailed(label, messageOf(error));
        rows.push({
          section: 'deploy',
          artifact: label,
          outcome: 'failed',
          detail: messageOf(error),
        });
        throw error;
      }
      const elapsed = deps.now() - started;
      logDeployed(label, elapsed);
      rows.push({
        section: 'deploy',
        artifact: label,
        outcome: 'deployed',
        detail: seconds(elapsed),
      });
      counts.deployed++;
    }),
  );
  if (deployed.failed.length > 0 || deployed.notStarted.length > 0) {
    for (const key of deployed.notStarted) {
      rows.push({
        section: 'deploy',
        artifact: labelFor(key),
        outcome: 'not started',
        detail: 'an earlier deployment failed',
      });
    }
    problems.push(
      `Deployed ${counts.deployed} of ${deployable.length}; ${deployed.failed.length} failed ` +
        `(${list(deployed.failed.map(({ key }) => labelFor(key)))}); ` +
        `${deployed.notStarted.length} not started.` +
        (inputs.deleteArtifacts ? ' Deletion skipped because deployment failed.' : ''),
    );
  }

  // 6. Delete, only after every deployment succeeded.
  if (problems.length === 0 && inputs.deleteArtifacts) {
    const total = plan.deletions.length + plan.children.length;
    const byLiveKey = new Map(plan.deletions.map((artifact) => [artifact.key, artifact]));
    const childByKey = new Map(plan.children.map((child) => [childKey(child), child]));
    const failedDeletes: string[] = [];
    let attempted = 0;
    let failedCount = 0;
    let childrenDeleted = 0;
    await group(`Delete (${total})`, async () => {
      const removed = await schedule(plan.deletionNodes, async (key) => {
        const artifact = byLiveKey.get(key);
        if (artifact === undefined) {
          throw new Error(`internal error: ${key} is not a deletion candidate`);
        }
        const label = labelOf(artifact);
        const started = deps.now();
        try {
          await deleteArtifact(synapse, artifact.kind, artifact.name);
        } catch (error) {
          logFailed(label, messageOf(error));
          rows.push({
            section: 'delete',
            artifact: label,
            outcome: 'failed',
            detail: messageOf(error),
          });
          failedDeletes.push(label);
          throw error;
        }
        const elapsed = deps.now() - started;
        logDeleted(label, elapsed);
        rows.push({
          section: 'delete',
          artifact: label,
          outcome: 'deleted',
          detail: seconds(elapsed),
        });
        counts.deleted++;
      });
      attempted += removed.succeeded.length + removed.failed.length;
      failedCount += removed.failed.length;
      if (removed.failed.length > 0) {
        return;
      }
      const emptied = await schedule(
        childNodes(plan.children),
        async (key) => {
          const child = childByKey.get(key);
          if (child === undefined) {
            throw new Error(`internal error: ${key} is not a lake database child`);
          }
          const label = describeLakeChild(child);
          const started = deps.now();
          try {
            await deleteLakeChild(synapse, child);
          } catch (error) {
            logFailed(label, messageOf(error));
            rows.push({
              section: 'delete',
              artifact: label,
              outcome: 'failed',
              detail: messageOf(error),
            });
            failedDeletes.push(label);
            throw error;
          }
          const elapsed = deps.now() - started;
          logDeleted(label, elapsed);
          rows.push({
            section: 'delete',
            artifact: label,
            outcome: 'deleted',
            detail: seconds(elapsed),
          });
          childrenDeleted++;
        },
        // One at a time: parallel DDL deletes on one database are unverified.
        1,
      );
      failedCount += emptied.failed.length;
      attempted += emptied.succeeded.length + emptied.failed.length;
    });
    lakeChildren = childrenDeleted;
    if (failedCount > 0 || attempted < total) {
      problems.push(
        `Deletion failed: ${failedCount} of ${total} failed (${list(failedDeletes)}); ` +
          `${total - attempted} not started.`,
      );
    }
  }

  // 7. Finish: outputs and summary first, so a red run still reports them.
  setOutputs(counts);
  const verdict = problems.join(' ');
  await writeSummary({ dryRun: false, verdict, counts, rows, lakeChildren });
  if (verdict) {
    throw new Error(verdict);
  }
  core.info(
    `deployed ${counts.deployed}, skipped ${counts.skipped}, deleted ${counts.deleted}` +
      (lakeChildren > 0 ? ` (and ${lakeChildren} lake database tables or relationships)` : ''),
  );
  return counts;
}
