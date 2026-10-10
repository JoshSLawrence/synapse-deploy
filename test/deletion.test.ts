import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planDeletions } from '../src/deletion.ts';
import type { LiveArtifact } from '../src/deletion.ts';
import { kindForCollection } from '../src/kinds.ts';
import { artifactKey } from '../src/template.ts';
import type { Artifact } from '../src/template.ts';

function live(collection: string, name: string, references: string[] = []): LiveArtifact {
  const kind = kindForCollection(collection);
  assert.ok(kind, collection);
  return { kind, name, key: artifactKey(kind.id, name), references };
}

function inTemplate(collection: string, name: string, skip?: string): Artifact {
  const kind = kindForCollection(collection);
  assert.ok(kind, collection);
  return {
    key: artifactKey(kind.id, name),
    kind,
    name,
    type: `Microsoft.Synapse/workspaces/${collection}`,
    body: {},
    dependsOn: [],
    ...(skip === undefined ? {} : { skip }),
  };
}

describe('planDeletions', () => {
  it('compares names case-insensitively and counts skipped template resources as present', () => {
    const { artifacts } = planDeletions(
      [
        live('pipelines', 'PL_Keep'),
        live('linkedServices', 'ls_listed'),
        live('notebooks', 'nb_old'),
      ],
      [
        inTemplate('pipelines', 'pl_keep'),
        inTemplate('linkedServices', 'ls_listed', 'service default'),
      ],
    );
    assert.deepEqual(
      artifacts.map((artifact) => artifact.key),
      ['notebooks/nb_old'],
    );
  });

  it('never proposes a service default, but does propose a lookalike', () => {
    const { artifacts } = planDeletions(
      [
        live('linkedServices', 'other-WorkspaceDefaultStorage'),
        live('linkedServices', 'x-WorkspaceDefaultStorage-copy'),
        live('credentials', 'WorkspaceSystemIdentity'),
        live('managedVirtualNetworks/default/managedPrivateEndpoints', 'synapse-ws-sql--other'),
        live(
          'managedVirtualNetworks/default/managedPrivateEndpoints',
          'synapse-ws-custstgacct--myworkspace-stexample',
        ),
        live('managedVirtualNetworks/default/managedPrivateEndpoints', 'pe_old'),
      ],
      [],
    );
    assert.deepEqual(
      artifacts.map((artifact) => artifact.name),
      ['x-WorkspaceDefaultStorage-copy', 'pe_old'],
    );
  });

  it('orders a referenced artifact after its referrers and ignores a self-reference', () => {
    const { nodes } = planDeletions(
      [
        live('datasets', 'ds', ['linkedServices/ls']),
        live('linkedServices', 'ls'),
        live('pipelines', 'pl', ['datasets/ds', 'pipelines/pl']),
        live('notebooks', 'untouched', ['pipelines/kept_elsewhere']),
      ],
      [],
    );
    const dependsOn = Object.fromEntries(nodes.map((node) => [node.key, node.dependsOn]));
    assert.deepEqual(dependsOn['linkedServices/ls'], ['datasets/ds']);
    assert.deepEqual(dependsOn['datasets/ds'], ['pipelines/pl']);
    assert.deepEqual(dependsOn['pipelines/pl'], []);
  });

  it('fails on a reference cycle, naming it', () => {
    assert.throws(
      () =>
        planDeletions(
          [live('pipelines', 'a', ['pipelines/b']), live('pipelines', 'b', ['pipelines/a'])],
          [],
        ),
      /pipelines\/a -> pipelines\/b -> pipelines\/a refer to one another/,
    );
  });
});
