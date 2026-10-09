import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  artifactPath,
  KINDS,
  kindForCollection,
  kindForReferenceType,
  kindForTemplateType,
  unsupportedTypeMessage,
} from '../src/kinds.ts';

describe('kinds', () => {
  const expected: [string, string, string, string][] = [
    // template type, collection, plane, delete mode
    ['Microsoft.Synapse/workspaces/notebooks', 'notebooks', 'data', 'collection'],
    [
      'Microsoft.Synapse/workspaces/sparkJobDefinitions',
      'sparkJobDefinitions',
      'data',
      'collection',
    ],
    ['Microsoft.Synapse/workspaces/sqlscripts', 'sqlScripts', 'data', 'collection'],
    ['Microsoft.Synapse/workspaces/kqlscripts', 'kqlScripts', 'data', 'collection'],
    [
      'Microsoft.Synapse/workspaces/sparkConfigurations',
      'sparkConfigurations',
      'data',
      'collection',
    ],
    ['Microsoft.Synapse/workspaces/datasets', 'datasets', 'data', 'collection'],
    ['Microsoft.Synapse/workspaces/dataflows', 'dataflows', 'data', 'collection'],
    ['Microsoft.Synapse/workspaces/pipelines', 'pipelines', 'data', 'collection'],
    ['Microsoft.Synapse/workspaces/triggers', 'triggers', 'data', 'collection'],
    ['Microsoft.Synapse/workspaces/linkedServices', 'linkedServices', 'data', 'collection'],
    ['Microsoft.Synapse/workspaces/credentials', 'credentials', 'data', 'collection'],
    ['Microsoft.Synapse/workspaces/databases', 'databases', 'lakedb', 'lakedb'],
    [
      'Microsoft.Synapse/workspaces/managedVirtualNetworks/managedPrivateEndpoints',
      'managedVirtualNetworks/default/managedPrivateEndpoints',
      'endpoint',
      'endpoint',
    ],
    ['Microsoft.Synapse/workspaces/integrationRuntimes', 'integrationRuntimes', 'arm', 'never'],
    ['Microsoft.Synapse/workspaces/bigDataPools', 'bigDataPools', 'skip', 'never'],
    ['Microsoft.Synapse/workspaces/sqlPools', 'sqlPools', 'skip', 'never'],
    [
      'Microsoft.Synapse/workspaces/managedVirtualNetworks',
      'managedVirtualNetworks',
      'skip',
      'never',
    ],
  ];

  for (const [type, collection, plane, deleteMode] of expected) {
    it(`maps ${type}`, () => {
      const kind = kindForTemplateType(type);
      assert.ok(kind, 'kind found');
      assert.equal(kind.collection, collection);
      assert.equal(kind.plane, plane);
      assert.equal(kind.delete, deleteMode);
    });
  }

  it('covers every kind exactly once', () => {
    assert.equal(KINDS.length, expected.length);
    assert.equal(new Set(KINDS.map((kind) => kind.id)).size, KINDS.length);
  });

  it('matches template types case-insensitively', () => {
    assert.equal(kindForTemplateType('MICROSOFT.SYNAPSE/WORKSPACES/PIPELINES')?.id, 'pipelines');
  });

  it('does not know other types', () => {
    assert.equal(kindForTemplateType('Microsoft.Synapse/workspaces/widgets'), undefined);
    assert.equal(kindForTemplateType('Microsoft.Storage/storageAccounts'), undefined);
    assert.equal(kindForTemplateType('Microsoft.Synapse/workspaces'), undefined);
  });

  it('names the type and the supported ones when unsupported', () => {
    const message = unsupportedTypeMessage('Microsoft.Synapse/workspaces/widgets');
    assert.match(message, /unsupported type Microsoft\.Synapse\/workspaces\/widgets/);
    assert.match(message, /pipelines/);
  });

  it('uses 2021-04-01 for lake databases and 2019-06-01-preview for everything else', () => {
    for (const kind of KINDS) {
      assert.equal(kind.apiVersion, kind.id === 'databases' ? '2021-04-01' : '2019-06-01-preview');
    }
  });

  it('maps reference types to kinds', () => {
    const references: Record<string, string> = {
      PipelineReference: 'pipelines',
      DatasetReference: 'datasets',
      LinkedServiceReference: 'linkedServices',
      NotebookReference: 'notebooks',
      SparkJobDefinitionReference: 'sparkJobDefinitions',
      DataFlowReference: 'dataflows',
      CredentialReference: 'credentials',
      SqlScriptReference: 'sqlScripts',
    };
    for (const [referenceType, id] of Object.entries(references)) {
      assert.equal(kindForReferenceType(referenceType)?.id, id);
    }
    assert.equal(kindForReferenceType('IntegrationRuntimeReference'), undefined);
    assert.equal(KINDS.filter((kind) => kind.referenceType !== undefined).length, 8);
  });

  it('finds a live artifact kind by collection, ignoring case', () => {
    assert.equal(kindForCollection('sqlscripts')?.id, 'sqlScripts');
    assert.equal(
      kindForCollection('managedVirtualNetworks/default/managedPrivateEndpoints')?.id,
      'managedPrivateEndpoints',
    );
  });

  it('encodes names in the artifact path', () => {
    const pipelines = kindForTemplateType('Microsoft.Synapse/workspaces/pipelines');
    assert.ok(pipelines);
    assert.equal(
      artifactPath(pipelines, 'my pipeline/1?'),
      '/pipelines/my%20pipeline%2F1%3F?api-version=2019-06-01-preview',
    );
  });
});
