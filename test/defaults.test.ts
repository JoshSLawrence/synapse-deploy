import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Json } from '../src/expression.ts';
import { isServiceDefault, remapDefaultName, remapDefaultReferences } from '../src/defaults.ts';

describe('isServiceDefault', () => {
  it('matches the workspace default linked services, anchored', () => {
    assert.equal(isServiceDefault('linkedServices', 'myworkspace-WorkspaceDefaultStorage'), true);
    assert.equal(isServiceDefault('linkedServices', 'myworkspace-workspacedefaultsqlserver'), true);
    assert.equal(isServiceDefault('linkedServices', 'x-WorkspaceDefaultStorage-copy'), false);
    assert.equal(isServiceDefault('linkedServices', 'WorkspaceDefaultStorage'), false);
    assert.equal(isServiceDefault('linkedServices', 'ls_user'), false);
  });

  it('matches the system identity credential only', () => {
    assert.equal(isServiceDefault('credentials', 'WorkspaceSystemIdentity'), true);
    assert.equal(isServiceDefault('credentials', 'workspacesystemidentity'), true);
    assert.equal(isServiceDefault('credentials', 'my-WorkspaceSystemIdentity'), false);
  });

  it('matches the synapse-ws endpoints only', () => {
    assert.equal(isServiceDefault('managedPrivateEndpoints', 'synapse-ws-sql--devws'), true);
    assert.equal(
      isServiceDefault('managedPrivateEndpoints', 'synapse-ws-sqlOnDemand--devws'),
      true,
    );
    assert.equal(isServiceDefault('managedPrivateEndpoints', 'synapse-ws-kusto--devws'), true);
    assert.equal(isServiceDefault('managedPrivateEndpoints', 'pe_storage'), false);
  });

  it('scopes each rule to its kind', () => {
    assert.equal(isServiceDefault('datasets', 'a-WorkspaceDefaultStorage'), false);
    assert.equal(isServiceDefault('pipelines', 'WorkspaceSystemIdentity'), false);
    assert.equal(isServiceDefault('linkedServices', 'synapse-ws-sql--x'), false);
  });
});

describe('remapDefaultName', () => {
  it('rewrites another workspace prefix to the target', () => {
    assert.equal(
      remapDefaultName('devws-WorkspaceDefaultStorage', 'myworkspace'),
      'myworkspace-WorkspaceDefaultStorage',
    );
    assert.equal(
      remapDefaultName('devws-workspacedefaultsqlserver', 'myworkspace'),
      'myworkspace-WorkspaceDefaultSqlServer',
    );
  });

  it('leaves the target, other names and unanchored names alone', () => {
    assert.equal(
      remapDefaultName('MyWorkspace-WorkspaceDefaultStorage', 'myworkspace'),
      'MyWorkspace-WorkspaceDefaultStorage',
    );
    assert.equal(remapDefaultName('ls_user', 'myworkspace'), 'ls_user');
    assert.equal(
      remapDefaultName('x-devws-WorkspaceDefaultStorage-copy', 'myworkspace'),
      'x-devws-WorkspaceDefaultStorage-copy',
    );
  });
});

describe('remapDefaultReferences', () => {
  it('remaps referenceName anywhere and the last segment of dependsOn strings', () => {
    const body = {
      dependsOn: [
        'Microsoft.Synapse/workspaces/myworkspace/linkedServices/devws-WorkspaceDefaultStorage',
      ],
      properties: {
        linkedServiceName: {
          referenceName: 'devws-WorkspaceDefaultSqlServer',
          type: 'LinkedServiceReference',
        },
        activities: [
          {
            dependsOn: [{ activity: 'devws-WorkspaceDefaultStorage' }],
            other: 'devws-WorkspaceDefaultStorage',
          },
        ],
      },
    };
    assert.deepEqual(remapDefaultReferences(body, 'myworkspace'), {
      dependsOn: [
        'Microsoft.Synapse/workspaces/myworkspace/linkedServices/myworkspace-WorkspaceDefaultStorage',
      ],
      properties: {
        linkedServiceName: {
          referenceName: 'myworkspace-WorkspaceDefaultSqlServer',
          type: 'LinkedServiceReference',
        },
        activities: [
          {
            dependsOn: [{ activity: 'devws-WorkspaceDefaultStorage' }],
            other: 'devws-WorkspaceDefaultStorage',
          },
        ],
      },
    });
  });

  it('leaves non-linked-service names that look like defaults alone', () => {
    const body: Json = {
      dependsOn: [
        'Microsoft.Synapse/workspaces/myworkspace/pipelines/devws-WorkspaceDefaultStorage',
      ],
      properties: {
        activities: [
          {
            pipeline: { referenceName: 'devws-WorkspaceDefaultStorage', type: 'PipelineReference' },
          },
          {
            dataset: { referenceName: 'devws-WorkspaceDefaultSqlServer', type: 'DatasetReference' },
          },
        ],
      },
    };
    assert.deepEqual(remapDefaultReferences(body, 'myworkspace'), body);
  });
});
