// Portions derived from Azure/Synapse-workspace-deployment.
// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

/**
 * The one table every other module derives from: which template types the
 * deployer knows, how each is written to the workspace, whether it can be
 * deleted, and which `type` of `referenceName` object points at it.
 */

export const DEFAULT_API_VERSION = '2019-06-01-preview';
export const LAKE_DATABASE_API_VERSION = '2021-04-01';

export type KindId =
  | 'notebooks'
  | 'sparkJobDefinitions'
  | 'sqlScripts'
  | 'kqlScripts'
  | 'sparkConfigurations'
  | 'datasets'
  | 'dataflows'
  | 'pipelines'
  | 'triggers'
  | 'linkedServices'
  | 'credentials'
  | 'databases'
  | 'managedPrivateEndpoints'
  | 'integrationRuntimes'
  | 'bigDataPools'
  | 'sqlPools'
  | 'managedVirtualNetworks';

/**
 * How a kind is written:
 * - `data`: PUT /<collection>/<name> on the development endpoint;
 * - `lakedb`: one PUT per DDL entity (lakedb.ts);
 * - `endpoint`: a data-plane PUT that is then awaited until provisioned;
 * - `arm`: a PUT through Azure Resource Manager (arm.ts);
 * - `skip`: never deployed, left to infrastructure as code.
 */
export type Plane = 'data' | 'lakedb' | 'endpoint' | 'arm' | 'skip';

/**
 * How a kind is deleted:
 * - `collection`: DELETE /<collection>/<name>;
 * - `lakedb`: only lake databases (Spark origin, SyMSCDM), plus their children;
 * - `endpoint`: only when the endpoints are deployed (virtual network path);
 * - `never`: left alone.
 */
export type DeleteMode = 'collection' | 'lakedb' | 'endpoint' | 'never';

export interface Kind {
  id: KindId;
  /** Lowercased template type after `microsoft.synapse/workspaces/`. */
  templateTail: string;
  /** Path of the collection on the development endpoint (or under the workspace for ARM). */
  collection: string;
  plane: Plane;
  delete: DeleteMode;
  apiVersion: string;
  /** The `type` of a `{referenceName, type}` object that points at this kind. */
  referenceType?: string;
}

export const TEMPLATE_TYPE_PREFIX = 'microsoft.synapse/workspaces/';

function dataKind(id: KindId, collection: string, referenceType?: string): Kind {
  return {
    id,
    templateTail: id.toLowerCase(),
    collection,
    plane: 'data',
    delete: 'collection',
    apiVersion: DEFAULT_API_VERSION,
    ...(referenceType === undefined ? {} : { referenceType }),
  };
}

function skipKind(id: KindId): Kind {
  return {
    id,
    templateTail: id.toLowerCase(),
    collection: id,
    plane: 'skip',
    delete: 'never',
    apiVersion: DEFAULT_API_VERSION,
  };
}

export const KINDS: readonly Kind[] = [
  dataKind('notebooks', 'notebooks', 'NotebookReference'),
  dataKind('sparkJobDefinitions', 'sparkJobDefinitions', 'SparkJobDefinitionReference'),
  dataKind('sqlScripts', 'sqlScripts', 'SqlScriptReference'),
  dataKind('kqlScripts', 'kqlScripts'),
  dataKind('sparkConfigurations', 'sparkConfigurations'),
  dataKind('datasets', 'datasets', 'DatasetReference'),
  dataKind('dataflows', 'dataflows', 'DataFlowReference'),
  dataKind('pipelines', 'pipelines', 'PipelineReference'),
  dataKind('triggers', 'triggers'),
  dataKind('linkedServices', 'linkedServices', 'LinkedServiceReference'),
  dataKind('credentials', 'credentials', 'CredentialReference'),
  {
    id: 'databases',
    templateTail: 'databases',
    collection: 'databases',
    plane: 'lakedb',
    delete: 'lakedb',
    apiVersion: LAKE_DATABASE_API_VERSION,
  },
  {
    id: 'managedPrivateEndpoints',
    templateTail: 'managedvirtualnetworks/managedprivateendpoints',
    collection: 'managedVirtualNetworks/default/managedPrivateEndpoints',
    plane: 'endpoint',
    delete: 'endpoint',
    apiVersion: DEFAULT_API_VERSION,
  },
  {
    id: 'integrationRuntimes',
    templateTail: 'integrationruntimes',
    collection: 'integrationRuntimes',
    plane: 'arm',
    delete: 'never',
    apiVersion: DEFAULT_API_VERSION,
  },
  skipKind('bigDataPools'),
  skipKind('sqlPools'),
  skipKind('managedVirtualNetworks'),
];

const byTail = new Map(KINDS.map((kind) => [kind.templateTail, kind]));
const byCollection = new Map(KINDS.map((kind) => [kind.collection.toLowerCase(), kind]));
const byReferenceType = new Map(
  KINDS.flatMap((kind) =>
    kind.referenceType === undefined ? [] : [[kind.referenceType.toLowerCase(), kind]],
  ),
);

/** The kind of a template resource type, or undefined when it is unsupported. */
export function kindForTemplateType(type: string): Kind | undefined {
  const lower = type.toLowerCase();
  if (!lower.startsWith(TEMPLATE_TYPE_PREFIX)) {
    return undefined;
  }
  return byTail.get(lower.slice(TEMPLATE_TYPE_PREFIX.length));
}

/** The kind of a live artifact, from the collection it was listed in. */
export function kindForCollection(collection: string): Kind | undefined {
  return byCollection.get(collection.toLowerCase());
}

/** The kind a `{referenceName, type}` object points at; other types give undefined. */
export function kindForReferenceType(referenceType: string): Kind | undefined {
  return byReferenceType.get(referenceType.toLowerCase());
}

export function unsupportedTypeMessage(type: string): string {
  return (
    `unsupported type ${type}; the deployer handles ` +
    KINDS.map((kind) => kind.templateTail).join(', ') +
    '.'
  );
}

/** `<collection>/<encoded name>?api-version=...`, relative to the workspace endpoint. */
export function artifactPath(kind: Kind, name: string): string {
  return `/${kind.collection}/${encodeURIComponent(name)}?api-version=${kind.apiVersion}`;
}
