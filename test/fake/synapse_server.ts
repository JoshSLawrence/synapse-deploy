import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { armScope, dataPlaneScope, findCloud } from '../../src/cloud.ts';
import { DEFAULT_API_VERSION, KINDS, LAKE_DATABASE_API_VERSION } from '../../src/kinds.ts';
import type { TokenProvider } from '../../src/auth.ts';

/**
 * An in-memory stand-in for a Synapse development endpoint and the slice of
 * Azure Resource Manager used for integration runtimes, on 127.0.0.1. It
 * encodes the services' behaviour as observed on live Azure (see
 * DEFAULT_CONFIG); the other modes keep shapes the deployer must still
 * tolerate. Generic names only.
 */

const NO_MANAGED_VNET_MESSAGE =
  'The workspace does not have a managed virtual network associated with it.';
// Synapse answers this text, trailing space included, to an update and to a
// delete of a started trigger alike.
const TRIGGER_ENABLED_MESSAGE =
  'Cannot update enabled Trigger; the trigger needs to be disabled first. ';
// What the service sends on every operation poll that is not final.
const RETRY_AFTER = '10';
const IR_TYPE = 'Microsoft.Synapse/workspaces/integrationRuntimes';
// Collections whose GET-after-delete answers `<Kind>NotFound`.
const NOT_FOUND_CODES: Record<string, string> = {
  pipelines: 'PipelineNotFound',
  triggers: 'TriggerNotFound',
  datasets: 'DatasetNotFound',
  linkedservices: 'LinkedServiceNotFound',
  dataflows: 'DataFlowNotFound',
};
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const DATA_TOKEN = 'fake-data-token';
const ARM_TOKEN = 'fake-arm-token';

export interface FakeConfig {
  /**
   * Data-plane PUT: `lro` (202 + operationId + same-host Location), `sync`
   * (200 + resource) or `lro-no-location` (202 + operationId, polled at the
   * root operationResults, which notebooks do not serve).
   */
  putMode: 'sync' | 'lro' | 'lro-no-location';
  /**
   * DELETE: `lro` (202 + Location; an endpoint answers 202 without one and
   * lingers, see `endpointDeletePolls`) or `sync` (200).
   */
  deleteMode: 'sync' | 'lro';
  /** What an `lro` delete's operation answers when finished. */
  deleteCompletion: 'ok' | 'not-found';
  /** How many times an operation answers "in progress" before it finishes. */
  lroPolls: number;
  /** Items per page of a list. */
  pageSize: number;
  hasManagedVnet: boolean;
  /** Endpoint PUT: 200 + `Provisioning` (`sync`) or an operation first (`lro`). */
  endpointPutMode: 'sync' | 'lro' | 'lro-no-location';
  /** GETs of an endpoint that answer `Provisioning` before the final state. */
  endpointPolls: number;
  endpointFinalState: 'Succeeded' | 'Failed';
  /**
   * GETs of a deleted endpoint that still answer 200 `Succeeded` before the
   * 404; 0 removes it at once.
   */
  endpointDeletePolls: number;
  /**
   * Started trigger PUT: `lro-failed` (202, then the operation ends Failed
   * with TriggerEnabledCannotUpdate) or `sync-400` (400 on the PUT).
   */
  triggerPutMode: 'lro-failed' | 'sync-400';
  /**
   * Started trigger DELETE: `lro-failed` (202, then the operation ends Failed
   * with DeleteDataFactoryResourceOrchestrationError) or `sync-409` (409 with
   * a `{"Message"}` body). Both happen on Azure.
   */
  triggerDeleteMode: 'lro-failed' | 'sync-409';
  /**
   * Integration runtime PUT: `workspace-location` (202 + operationId + a
   * Location under the workspace path; DELETE is an operation too),
   * `async-operation` (201 + Azure-AsyncOperation), `location-only` (202 +
   * Location), `operation-id` (202 + operationId and no Location, served under
   * the workspace path), `provisioning-body` (200 + Provisioning, then GETs of
   * the resource) or `sync` (200 + Succeeded). Every mode but the first
   * deletes synchronously.
   */
  armMode:
    | 'workspace-location'
    | 'async-operation'
    | 'location-only'
    | 'operation-id'
    | 'provisioning-body'
    | 'sync';
  /** How many times an ARM operation or resource GET answers "in progress". */
  armPolls: number;
  /** Delay before every answer, so that concurrent operations overlap. */
  latencyMs: number;
}

export type FaultResponse =
  | { status: number; headers?: Record<string, string>; body?: string }
  | { reset: true }
  | { stallBody: true }
  | { closeEarly: true };

export interface Fault {
  method?: string;
  path: RegExp;
  /** The first matching request that fires, 1-based; default 1. */
  nth?: number;
  /** How many consecutive matches fire; default 1; Infinity for a storm. */
  count?: number;
  response: FaultResponse;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  body: unknown;
  time: number;
  authorization: string | undefined;
}

export interface SeedItem {
  name: string;
  [key: string]: unknown;
}

interface Stored {
  name: string;
  body: Record<string, unknown>;
  gets: number;
  /** Ends the write's operation when provisioning finishes (endpoints, ARM). */
  release?: () => void;
  /** A deleted endpoint: GETs left that still answer 200 before the 404. */
  deleting?: number;
}

interface Operation {
  /** The path prefix of its operationResults collection; "" at the root. */
  base: string;
  remaining: number;
  flavor: 'data' | 'async' | 'location';
  body: unknown;
  failMessage: string | undefined;
  failCode?: string;
  /** The 202 body of a poll that is not final. */
  inProgress?: unknown;
  /** Where the operation is served, repeated on its 202 polls. */
  location?: string;
  retryAfter?: string;
  /** Notebooks poll at /notebookOperationResults; the root collection refuses them. */
  notebook?: boolean;
  goneAfter: boolean;
  done: boolean;
  end: () => void;
}

/** The write being served; an operation that outlives the response adopts it. */
interface Writing {
  end: () => void;
  adopted: boolean;
}

interface Database {
  name: string;
  body: Record<string, unknown>;
  tables: Map<string, Stored>;
  relationships: Map<string, Stored>;
}

export interface FakeSynapse {
  /** `http://127.0.0.1:<port>`: serves both the data plane and ARM. */
  url: string;
  endpoints: { dataPlane: string; arm: string };
  /** Issues the tokens the server accepts: one per scope kind. */
  tokens: TokenProvider;
  config: FakeConfig;
  requests: RecordedRequest[];
  /** Scopes the token provider was asked for. */
  tokenScopes: string[];
  maxConcurrentRequests: number;
  /** Writes (PUT, DELETE) that have not finished, counting an operation until it completes. */
  maxConcurrentOperations: number;
  /** Ends every open operation and zeroes the maxima; use after a test abandons operations. */
  resetMetrics(): void;
  writes(): RecordedRequest[];
  seed(collection: string, items: SeedItem[]): void;
  seedDatabase(
    name: string,
    options?: {
      origin?: unknown;
      symscdm?: unknown;
      // Replaces the whole body, so tests can leave Origin or Properties out.
      raw?: Record<string, unknown>;
      tables?: string[];
      relationships?: string[];
    },
  ): void;
  get(collection: string, name: string): Record<string, unknown> | undefined;
  names(collection: string): string[];
  databaseChildren(database: string, kind: 'tables' | 'relationships'): string[];
  /** Makes the operation of a later PUT or DELETE of this name finish as Failed. */
  failOperation(name: string, message: string): void;
  addFault(fault: Fault): void;
  clearFaults(): void;
  close(): Promise<void>;
}

// The defaults are the response shapes observed on live Azure on 2026-10-10;
// the other modes exist so tests can still exercise shapes the deployer must
// tolerate.
const DEFAULT_CONFIG: FakeConfig = {
  putMode: 'lro',
  deleteMode: 'lro',
  deleteCompletion: 'ok',
  lroPolls: 1,
  pageSize: 2,
  hasManagedVnet: true,
  endpointPutMode: 'sync',
  endpointPolls: 1,
  endpointFinalState: 'Succeeded',
  endpointDeletePolls: 4,
  triggerPutMode: 'lro-failed',
  triggerDeleteMode: 'lro-failed',
  armMode: 'workspace-location',
  armPolls: 1,
  latencyMs: 0,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function startFakeSynapse(overrides: Partial<FakeConfig> = {}): Promise<FakeSynapse> {
  const cloud = findCloud('AzureCloud');
  if (cloud === undefined) {
    throw new Error('AzureCloud is missing from the cloud table');
  }
  const scopes = { data: dataPlaneScope(cloud), arm: armScope(cloud) };
  const config: FakeConfig = { ...DEFAULT_CONFIG, ...overrides };

  const collections = new Map<string, Map<string, Stored>>();
  const canonical = new Map<string, string>();
  for (const kind of KINDS) {
    if (kind.plane === 'data' || kind.plane === 'endpoint') {
      collections.set(kind.collection, new Map());
      canonical.set(kind.collection.toLowerCase(), kind.collection);
    }
  }
  const armVersion =
    KINDS.find((kind) => kind.id === 'integrationRuntimes')?.apiVersion ?? DEFAULT_API_VERSION;
  const ENDPOINT_BASE = '/managedVirtualNetworks/default';
  const endpointCollection = 'managedVirtualNetworks/default/managedPrivateEndpoints';
  const databases = new Map<string, Database>();
  const integrationRuntimes = new Map<string, Stored>();
  const operations = new Map<string, Operation>();
  const failures = new Map<string, string>();
  const faults: { fault: Fault; matches: number }[] = [];
  const requests: RecordedRequest[] = [];
  const tokenScopes: string[] = [];
  let nextId = 1;
  let inFlight = 0;
  let openOperations = 0;

  const state = {
    maxConcurrentRequests: 0,
    maxConcurrentOperations: 0,
  };

  const openEnds = new Set<() => void>();

  function beginOperation(): () => void {
    openOperations++;
    state.maxConcurrentOperations = Math.max(state.maxConcurrentOperations, openOperations);
    const end = () => {
      if (openEnds.delete(end)) {
        openOperations--;
      }
    };
    openEnds.add(end);
    return end;
  }

  const tokens: TokenProvider = {
    getToken(scope) {
      tokenScopes.push(scope);
      if (scope === scopes.data) {
        return Promise.resolve(DATA_TOKEN);
      }
      if (scope === scopes.arm) {
        return Promise.resolve(ARM_TOKEN);
      }
      return Promise.reject(new Error(`The fake server has no token for scope ${scope}`));
    },
  };

  let origin = '';

  function send(
    res: http.ServerResponse,
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
  ): void {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(text);
  }

  function error(res: http.ServerResponse, status: number, code: string, message: string): void {
    send(res, status, { error: { code, message } });
  }

  function resource(collection: string, stored: Stored): Record<string, unknown> {
    return { id: `/${collection}/${stored.name}`, ...stored.body, name: stored.name };
  }

  function newOperation(
    spec: Partial<Operation> & Pick<Operation, 'flavor' | 'body'>,
    name: string,
    writing: Writing,
    pathFor?: (id: string) => string,
  ): string {
    const id = `op${nextId++}`;
    writing.adopted = true;
    const end = writing.end;
    operations.set(id, {
      base: '',
      remaining: config.lroPolls,
      failMessage: failures.get(name.toLowerCase()),
      goneAfter: false,
      done: false,
      end,
      ...(pathFor === undefined
        ? {}
        : { location: `${origin}${pathFor(id)}`, retryAfter: RETRY_AFTER }),
      ...spec,
    });
    return id;
  }

  // The 404 each collection answers. Lake databases have their own shape.
  function notFound(res: http.ServerResponse, collection: string, name: string): void {
    const lower = collection.toLowerCase();
    const message = `${collection}/${name} was not found`;
    const code = NOT_FOUND_CODES[lower];
    if (code !== undefined) {
      send(res, 404, { code, message });
    } else if (lower === 'sqlscripts' || lower === 'notebooks') {
      send(res, 404, { code: '404', details: null, error: null, message, target: null });
    } else if (collection === endpointCollection) {
      send(res, 404, {
        error: {
          code: 'UnknownError',
          message: JSON.stringify({ ErrorType: 'PrivateEndpointNotFound', Message: message }),
        },
      });
    } else {
      error(res, 404, 'NotFound', message);
    }
  }

  function lakeNotFound(res: http.ServerResponse, entityType: string, name: string): void {
    send(res, 404, {
      Code: 'ResourceNotFound',
      Message: `Resource not found. ResourceId: '${entityType}-${name}, Version: '.`,
    });
  }

  // The acknowledgement of a lake database write. The values are placeholders:
  // only the PascalCase key set was observed.
  function lakeAck(entityType: string, name: string): Record<string, unknown> {
    return {
      DDLType: 'Create',
      EntityName: name,
      EntityType: entityType,
      ObjectId: ZERO_GUID,
      ObjectVersion: 1,
      OriginObjectId: ZERO_GUID,
      PublishStatus: 'Published',
    };
  }

  function page<T>(items: T[], skip: number): { slice: T[]; next: number | undefined } {
    const slice = items.slice(skip, skip + config.pageSize);
    return {
      slice,
      next: skip + config.pageSize < items.length ? skip + config.pageSize : undefined,
    };
  }

  function listValue(
    res: http.ServerResponse,
    url: URL,
    path: string,
    items: Record<string, unknown>[],
  ): void {
    const skip = Number(url.searchParams.get('skiptoken') ?? '0');
    const { slice, next } = page(items, skip);
    const body: Record<string, unknown> = { value: slice };
    if (next !== undefined) {
      const query = new URL(url.toString());
      query.searchParams.set('skiptoken', String(next));
      body.nextLink = `${origin}${path}${query.search}`;
    }
    send(res, 200, body);
  }

  function listItems(res: http.ServerResponse, url: URL, items: Record<string, unknown>[]): void {
    // The token holds a '+', which a client that forgets to URL-encode it turns into a space.
    const token = url.searchParams.get('continuationToken');
    const skip = token === null ? 0 : Number(/^cursor\+\/(\d+)==$/.exec(token)?.[1] ?? Number.NaN);
    if (Number.isNaN(skip)) {
      error(res, 400, 'BadRequest', `Unknown continuation token ${String(token)}`);
      return;
    }
    const { slice, next } = page(items, skip);
    const body: Record<string, unknown> = { items: slice };
    if (next !== undefined) {
      body.continuationToken = `cursor+/${next}==`;
    }
    send(res, 200, body);
  }

  // The keys a data-plane write answers with next to its operationId. The
  // values are placeholders: only the key set was observed.
  function acceptedBody(
    collection: string,
    name: string,
    id: string,
    withArtifactId: boolean,
  ): Record<string, unknown> {
    return {
      ...(withArtifactId ? { artifactId: ZERO_GUID } : {}),
      changed: true,
      created: '2026-10-10T00:00:00Z',
      id: `/${collection}/${name}`,
      name,
      operationId: id,
      recordId: 1,
      state: 'Accepted',
      type: `Microsoft.Synapse/workspaces/${collection}`,
    };
  }

  function putAnswer(
    res: http.ServerResponse,
    collection: string,
    stored: Stored,
    mode: 'sync' | 'lro' | 'lro-no-location',
    apiVersion: string,
    base: string,
    writing: Writing,
    failure?: { code: string; message: string },
  ): void {
    if (mode === 'sync') {
      send(res, 200, resource(collection, stored));
      return;
    }
    if (base !== '') {
      // Endpoints: an operation is a non-default shape, kept bare.
      const id = newOperation(
        { flavor: 'data', body: resource(collection, stored), base },
        stored.name,
        writing,
      );
      send(
        res,
        202,
        { operationId: id },
        mode === 'lro'
          ? { Location: `${base}/operationResults/${id}?api-version=${apiVersion}` }
          : {},
      );
      return;
    }
    const notebook = collection === 'notebooks';
    const id = newOperation(
      {
        flavor: 'data',
        body: resource(collection, stored),
        notebook,
        inProgress: { status: 'InProgress' },
        ...(failure === undefined ? {} : { failCode: failure.code, failMessage: failure.message }),
      },
      stored.name,
      writing,
      (opId) =>
        `${notebook ? '/notebookOperationResults' : '/operationResults'}/${opId}?api-version=${apiVersion}`,
    );
    const op = operations.get(id);
    send(
      res,
      202,
      acceptedBody(collection, stored.name, id, true),
      mode === 'lro' && op?.location !== undefined
        ? { Location: op.location, 'Retry-After': RETRY_AFTER }
        : {},
    );
  }

  function handleCollection(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    collection: string,
    name: string | undefined,
    body: unknown,
    apiVersion: string,
    writing: Writing,
  ): void {
    const items = collections.get(collection);
    if (items === undefined) {
      error(res, 404, 'NotFound', `Unknown collection ${collection}`);
      return;
    }
    const method = req.method ?? 'GET';
    const isEndpoint = collection === endpointCollection;
    if (isEndpoint && !config.hasManagedVnet) {
      error(res, 400, 'BadRequest', NO_MANAGED_VNET_MESSAGE);
      return;
    }
    if (name === undefined) {
      if (method !== 'GET') {
        error(res, 405, 'MethodNotAllowed', `${method} on a collection`);
        return;
      }
      listValue(
        res,
        url,
        `/${collection}`,
        [...items.values()].map((stored) => resource(collection, stored)),
      );
      return;
    }
    const key = name.toLowerCase();
    const existing = items.get(key);
    if (method === 'GET') {
      if (existing === undefined) {
        notFound(res, collection, name);
        return;
      }
      if (existing.deleting !== undefined) {
        // A deleted endpoint is still served for a while, then it is gone.
        if (existing.deleting <= 0) {
          items.delete(key);
          notFound(res, collection, name);
          return;
        }
        existing.deleting--;
        send(res, 200, resource(collection, existing));
        return;
      }
      if (isEndpoint) {
        existing.gets++;
        const state =
          existing.gets > config.endpointPolls ? config.endpointFinalState : 'Provisioning';
        existing.body.properties = {
          ...record(existing.body.properties),
          provisioningState: state,
        };
        if (state !== 'Provisioning') {
          existing.release?.();
        }
      }
      send(res, 200, resource(collection, existing));
      return;
    }
    if (method === 'PUT') {
      const written = record(structuredClone(body));
      if (
        collection === 'triggers' &&
        existing !== undefined &&
        record(existing.body.properties).runtimeState === 'Started'
      ) {
        const failure = { code: 'TriggerEnabledCannotUpdate', message: TRIGGER_ENABLED_MESSAGE };
        if (config.triggerPutMode === 'sync-400') {
          error(res, 400, failure.code, failure.message);
        } else {
          putAnswer(res, collection, existing, 'lro', apiVersion, '', writing, failure);
        }
        return;
      }
      if (isEndpoint && existing !== undefined && existing.deleting === undefined) {
        const withoutState = (properties: unknown) => {
          const rest = { ...record(properties) };
          delete rest.provisioningState;
          return JSON.stringify(rest);
        };
        if (
          record(existing.body.properties).provisioningState === 'Succeeded' &&
          withoutState(existing.body.properties) === withoutState(written.properties)
        ) {
          // Nothing to change: the service answers at once, already provisioned.
          send(res, 200, resource(collection, existing));
          return;
        }
      }
      const stored: Stored = { name, body: written, gets: 0 };
      let answering = writing;
      if (isEndpoint) {
        stored.body.properties = {
          ...record(written.properties),
          provisioningState: 'Provisioning',
        };
        // The write stays open until the client's provisioning wait can end,
        // however the PUT itself was answered.
        existing?.release?.();
        stored.release = writing.end;
        writing.adopted = true;
        answering = { end: () => undefined, adopted: false };
      }
      items.set(key, stored);
      putAnswer(
        res,
        collection,
        stored,
        isEndpoint ? config.endpointPutMode : config.putMode,
        apiVersion,
        isEndpoint ? ENDPOINT_BASE : '',
        answering,
      );
      return;
    }
    if (method === 'DELETE') {
      if (existing === undefined || existing.deleting === 0) {
        if (existing !== undefined) {
          items.delete(key);
        }
        notFound(res, collection, name);
        return;
      }
      if (record(existing.body.properties).runtimeState === 'Started') {
        if (config.triggerDeleteMode === 'sync-409') {
          send(res, 409, { Message: TRIGGER_ENABLED_MESSAGE });
        } else {
          finishDelete(res, collection, name, apiVersion, '', writing, {
            failCode: 'DeleteDataFactoryResourceOrchestrationError',
            failMessage: TRIGGER_ENABLED_MESSAGE,
            goneAfter: false,
          });
        }
        return;
      }
      existing.release?.();
      if (isEndpoint && config.deleteMode === 'lro') {
        // 202 with no Location and no body; the endpoint lingers, see GET.
        if (config.endpointDeletePolls > 0) {
          existing.deleting = config.endpointDeletePolls;
        } else {
          items.delete(key);
        }
        send(res, 202);
        return;
      }
      items.delete(key);
      finishDelete(res, collection, name, apiVersion, isEndpoint ? ENDPOINT_BASE : '', writing);
      return;
    }
    error(res, 405, 'MethodNotAllowed', method);
  }

  function finishDelete(
    res: http.ServerResponse,
    collection: string,
    name: string,
    apiVersion: string,
    base: string,
    writing: Writing,
    extra: Partial<Operation> = {},
  ): void {
    // A failing operation is the service's answer however deletes usually go.
    if (config.deleteMode === 'sync' && extra.failMessage === undefined) {
      send(res, 200, {});
      return;
    }
    // Notebook deletes are assumed to poll under /notebookOperationResults like
    // their PUTs; only the PUT was observed.
    const notebook = collection === 'notebooks';
    const id = newOperation(
      {
        flavor: 'data',
        // The operation ends 200 with an empty body.
        body: undefined,
        inProgress: { status: 'InProgress' },
        goneAfter: config.deleteCompletion === 'not-found',
        notebook,
        base,
        ...extra,
      },
      name,
      writing,
      (opId) =>
        `${notebook ? '/notebookOperationResults' : `${base}/operationResults`}/${opId}?api-version=${apiVersion}`,
    );
    const accepted = acceptedBody(collection, name, id, false);
    send(res, 202, base === '' ? accepted : undefined, {
      Location: operations.get(id)?.location ?? '',
    });
  }

  const OPERATION_FLAVOR = {
    operationresults: 'data',
    notebookoperationresults: 'data',
    asyncoperations: 'async',
    armoperations: 'location',
  } as const;

  // An operation is only reachable where the service would serve it, so a
  // client that polls the wrong operationResults base gets a 404.
  function handleOperation(
    res: http.ServerResponse,
    id: string,
    collection: keyof typeof OPERATION_FLAVOR,
    base: string,
  ): void {
    const op = operations.get(id);
    if (
      op === undefined ||
      op.flavor !== OPERATION_FLAVOR[collection] ||
      (collection !== 'asyncoperations' && collection !== 'armoperations' && op.base !== base)
    ) {
      error(res, 404, 'NotFound', `Operation ${id} was not found`);
      return;
    }
    if (op.notebook === true && collection === 'operationresults') {
      error(res, 400, 'UnsupportedOperation', 'Notebook operations are not served here.');
      return;
    }
    if (op.notebook !== true && collection === 'notebookoperationresults') {
      error(res, 404, 'NotFound', `Operation ${id} was not found`);
      return;
    }
    if (op.remaining > 0) {
      op.remaining--;
      if (op.flavor === 'async') {
        send(res, 200, { status: 'InProgress' });
      } else {
        send(
          res,
          202,
          op.inProgress,
          op.location === undefined
            ? {}
            : { Location: op.location, 'Retry-After': op.retryAfter ?? RETRY_AFTER },
        );
      }
      return;
    }
    if (!op.done) {
      op.done = true;
      op.end();
    }
    if (op.goneAfter) {
      error(res, 404, 'NotFound', `Operation ${id} is gone`);
    } else if (op.failMessage !== undefined) {
      send(res, 200, {
        status: 'Failed',
        error: { code: op.failCode ?? 'Failed', message: op.failMessage },
      });
    } else if (op.flavor === 'async') {
      send(res, 200, { status: 'Succeeded' });
    } else {
      send(res, 200, op.body);
    }
  }

  // Lake database listings (and GETs) answer {id, name, properties, type},
  // with the entity's own fields nested under `properties`, as verified on a
  // real workspace (2021-04-01).
  function lakeItem(
    type: string,
    name: string,
    properties: Record<string, unknown>,
    path: string[],
  ): Record<string, unknown> {
    return {
      id: `/subscriptions/${ZERO_GUID}/resourcegroups/rg-example/providers/microsoft.synapse/workspaces/myworkspace/databases/${path.map(encodeURIComponent).join('/')}`,
      name,
      properties,
      type,
    };
  }

  function handleDatabases(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    segments: string[],
    body: unknown,
  ): void {
    const method = req.method ?? 'GET';
    const [, dbName, childKind, childName] = segments;
    if (dbName === undefined) {
      listItems(
        res,
        url,
        [...databases.values()].map((db) => lakeItem('DATABASE', db.name, db.body, [db.name])),
      );
      return;
    }
    const db = databases.get(dbName.toLowerCase());
    if (childKind === undefined) {
      if (method === 'GET') {
        if (db === undefined) {
          lakeNotFound(res, 'DATABASE', dbName);
        } else {
          send(res, 200, lakeItem('DATABASE', db.name, db.body, [db.name]));
        }
      } else if (method === 'PUT') {
        const written = record(structuredClone(body));
        databases.set(dbName.toLowerCase(), {
          name: dbName,
          body: record(written.properties),
          tables: db?.tables ?? new Map<string, Stored>(),
          relationships: db?.relationships ?? new Map<string, Stored>(),
        });
        send(res, 200, lakeAck('DATABASE', dbName));
      } else if (method === 'DELETE') {
        if (db === undefined) {
          lakeNotFound(res, 'DATABASE', dbName);
        } else {
          databases.delete(dbName.toLowerCase());
          send(res, 200, {});
        }
      } else {
        error(res, 405, 'MethodNotAllowed', method);
      }
      return;
    }
    if (db === undefined) {
      lakeNotFound(res, 'DATABASE', dbName);
      return;
    }
    if (childKind !== 'tables' && childKind !== 'relationships') {
      error(res, 404, 'NotFound', `Unknown database child ${childKind}`);
      return;
    }
    const children = db[childKind];
    if (childName === undefined) {
      listItems(
        res,
        url,
        [...children.values()].map((child) =>
          lakeItem(childKind === 'tables' ? 'TABLE' : 'RELATIONSHIP', child.name, child.body, [
            db.name,
            childKind,
            child.name,
          ]),
        ),
      );
    } else if (method === 'PUT') {
      const written = record(structuredClone(body));
      children.set(childName.toLowerCase(), {
        name: childName,
        body: record(written.properties),
        gets: 0,
      });
      send(res, 200, lakeAck(childKind === 'tables' ? 'TABLE' : 'RELATIONSHIP', childName));
    } else if (method === 'DELETE') {
      if (children.delete(childName.toLowerCase())) {
        send(res, 200, {});
      } else {
        lakeNotFound(res, childKind === 'tables' ? 'TABLE' : 'RELATIONSHIP', childName);
      }
    } else if (method === 'GET') {
      const child = children.get(childName.toLowerCase());
      if (child === undefined) {
        lakeNotFound(res, childKind === 'tables' ? 'TABLE' : 'RELATIONSHIP', childName);
      } else {
        send(
          res,
          200,
          lakeItem(childKind === 'tables' ? 'TABLE' : 'RELATIONSHIP', child.name, child.body, [
            db.name,
            childKind,
            child.name,
          ]),
        );
      }
    } else {
      error(res, 405, 'MethodNotAllowed', method);
    }
  }

  function handleArm(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    segments: string[],
    pathname: string,
    body: unknown,
    writing: Writing,
  ): void {
    const method = req.method ?? 'GET';
    const name = segments[segments.length - 1] ?? '';
    const key = pathname.toLowerCase();
    if (segments[segments.length - 2]?.toLowerCase() !== 'integrationruntimes') {
      error(res, 404, 'NotFound', `Unknown ARM path ${pathname}`);
      return;
    }
    const existing = integrationRuntimes.get(key);
    if (method === 'GET') {
      if (existing === undefined) {
        error(res, 404, 'NotFound', `${name} was not found`);
        return;
      }
      existing.gets++;
      const state = existing.gets > config.armPolls ? 'Succeeded' : 'Provisioning';
      existing.body.properties = { ...record(existing.body.properties), provisioningState: state };
      if (state === 'Succeeded') {
        existing.release?.();
      }
      send(res, 200, { id: pathname, ...existing.body, name });
      return;
    }
    if (method === 'DELETE') {
      existing?.release?.();
      integrationRuntimes.delete(key);
      if (config.armMode === 'workspace-location' && existing !== undefined) {
        const base = `/${segments.slice(0, -2).join('/')}`;
        const id = newOperation(
          { flavor: 'data', body: undefined, base, remaining: config.armPolls },
          name,
          writing,
          (opId) => `${base}/operationResults/${opId}?api-version=${armVersion}`,
        );
        // Unlike the PUT's, the DELETE's answer carries no Retry-After.
        send(res, 202, undefined, { Location: operations.get(id)?.location ?? '' });
        return;
      }
      send(res, 200, {});
      return;
    }
    if (method !== 'PUT') {
      error(res, 405, 'MethodNotAllowed', method);
      return;
    }
    const stored: Stored = { name, body: record(structuredClone(body)), gets: 0 };
    const sync = config.armMode === 'sync';
    stored.body.properties = {
      ...record(stored.body.properties),
      provisioningState: sync ? 'Succeeded' : 'Provisioning',
    };
    existing?.release?.();
    integrationRuntimes.set(key, stored);
    const answer = { id: pathname, ...stored.body, name };
    switch (config.armMode) {
      case 'workspace-location': {
        const base = `/${segments.slice(0, -2).join('/')}`;
        const done = {
          etag: `"${ZERO_GUID}"`,
          type: IR_TYPE,
          ...answer,
          properties: { ...record(stored.body.properties), provisioningState: 'Succeeded' },
        };
        const id = newOperation(
          { flavor: 'data', body: done, base, remaining: config.armPolls },
          name,
          writing,
          (opId) => `${base}/operationResults/${opId}?api-version=${armVersion}`,
        );
        send(
          res,
          202,
          { id: pathname, name, type: IR_TYPE, operationId: id },
          { Location: operations.get(id)?.location ?? '', 'Retry-After': RETRY_AFTER },
        );
        return;
      }
      case 'sync':
        send(res, 200, answer);
        return;
      case 'provisioning-body':
        // Open until the client's GETs see Succeeded.
        stored.release = writing.end;
        writing.adopted = true;
        send(res, 200, answer);
        return;
      case 'operation-id': {
        const base = `/${segments.slice(0, -2).join('/')}`;
        const id = newOperation({ flavor: 'data', body: answer, base }, name, writing);
        send(res, 202, { operationId: id });
        return;
      }
      case 'location-only': {
        const id = newOperation(
          { flavor: 'location', body: answer, remaining: config.armPolls },
          name,
          writing,
        );
        send(res, 202, undefined, { Location: `/armOperations/${id}?api-version=${armVersion}` });
        return;
      }
      case 'async-operation': {
        const id = newOperation(
          { flavor: 'async', body: answer, remaining: config.armPolls },
          name,
          writing,
        );
        send(res, 201, answer, {
          'Azure-AsyncOperation': `${origin}/asyncOperations/${id}?api-version=${armVersion}`,
        });
        return;
      }
    }
  }

  async function applyFault(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
  ): Promise<boolean> {
    // Every matching fault counts the request, fired or not, so "the 2nd
    // request" means the same thing whichever fault answers it.
    let firing: Fault | undefined;
    for (const entry of faults) {
      const { fault } = entry;
      if (fault.method !== undefined && fault.method !== req.method) {
        continue;
      }
      if (!fault.path.test(path)) {
        continue;
      }
      entry.matches++;
      const first = fault.nth ?? 1;
      if (
        firing === undefined &&
        entry.matches >= first &&
        entry.matches < first + (fault.count ?? 1)
      ) {
        firing = fault;
      }
    }
    if (firing !== undefined) {
      const response = firing.response;
      if ('reset' in response) {
        req.socket.destroy();
      } else if ('stallBody' in response) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
        res.write('{"partial":');
      } else if ('closeEarly' in response) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
        res.write('{"partial":');
        await sleep(5);
        req.socket.destroy();
      } else {
        send(res, response.status, response.body ?? '', response.headers);
      }
      return true;
    }
    return false;
  }

  function route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    body: unknown,
    writing: Writing,
  ): void {
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const first = (segments[0] ?? '').toLowerCase();
    const isArm = ['subscriptions', 'asyncoperations', 'armoperations'].includes(first);
    if (req.headers.authorization !== `Bearer ${isArm ? ARM_TOKEN : DATA_TOKEN}`) {
      error(
        res,
        401,
        'InvalidAuthenticationToken',
        'The token is missing or has the wrong audience.',
      );
      return;
    }
    const expectedVersion =
      first === 'databases' ? LAKE_DATABASE_API_VERSION : isArm ? armVersion : DEFAULT_API_VERSION;
    const version = url.searchParams.get('api-version');
    if (version !== expectedVersion) {
      error(
        res,
        400,
        'InvalidApiVersionParameter',
        `The api-version '${version ?? ''}' is invalid here; use '${expectedVersion}'.`,
      );
      return;
    }
    const operationAt = segments.findIndex(
      (segment) => segment.toLowerCase() === 'operationresults',
    );
    if (first === 'asyncoperations' || first === 'armoperations') {
      handleOperation(res, segments[1] ?? '', first, '');
    } else if (first === 'notebookoperationresults') {
      handleOperation(res, segments[1] ?? '', first, '');
    } else if (operationAt >= 0) {
      const base = operationAt === 0 ? '' : `/${segments.slice(0, operationAt).join('/')}`;
      handleOperation(res, segments[operationAt + 1] ?? '', 'operationresults', base);
    } else if (first === 'subscriptions') {
      handleArm(req, res, segments, url.pathname, body, writing);
    } else if (first === 'databases') {
      handleDatabases(req, res, url, segments, body);
    } else if (first === 'managedvirtualnetworks') {
      if (segments[1] !== 'default' || segments[2] !== 'managedPrivateEndpoints') {
        error(res, 404, 'NotFound', `Unknown path ${url.pathname}`);
      } else {
        handleCollection(
          req,
          res,
          url,
          endpointCollection,
          segments[3],
          body,
          DEFAULT_API_VERSION,
          writing,
        );
      }
    } else {
      const collection = canonical.get(first);
      if (collection === undefined || collection === endpointCollection) {
        error(res, 404, 'NotFound', `Unknown path ${url.pathname}`);
      } else {
        handleCollection(
          req,
          res,
          url,
          collection,
          segments[1],
          body,
          DEFAULT_API_VERSION,
          writing,
        );
      }
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      inFlight++;
      state.maxConcurrentRequests = Math.max(state.maxConcurrentRequests, inFlight);
      res.on('close', () => {
        inFlight--;
      });
      try {
        const url = new URL(req.url ?? '/', origin);
        const text = await readRequestBody(req);
        let body: unknown = text === '' ? undefined : text;
        try {
          body = text === '' ? undefined : (JSON.parse(text) as unknown);
        } catch {
          // Kept as text.
        }
        const method = req.method ?? 'GET';
        requests.push({
          method,
          path: url.pathname,
          query: url.search,
          body,
          time: Date.now(),
          authorization: req.headers.authorization,
        });

        if (await applyFault(req, res, url.pathname)) {
          return;
        }
        const writing: Writing = {
          end: method === 'PUT' || method === 'DELETE' ? beginOperation() : () => undefined,
          adopted: false,
        };
        try {
          if (config.latencyMs > 0) {
            await sleep(config.latencyMs);
          }
          route(req, res, url, body, writing);
        } finally {
          if (!writing.adopted) {
            writing.end();
          }
        }
      } catch (err) {
        if (!res.headersSent) {
          error(res, 500, 'InternalServerError', err instanceof Error ? err.message : String(err));
        }
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  function items(collection: string): Map<string, Stored> {
    const found = collections.get(canonical.get(collection.toLowerCase()) ?? collection);
    if (found === undefined) {
      throw new Error(`The fake server has no collection ${collection}`);
    }
    return found;
  }

  return {
    url: origin,
    endpoints: { dataPlane: origin, arm: origin },
    tokens,
    config,
    requests,
    tokenScopes,
    get maxConcurrentRequests() {
      return state.maxConcurrentRequests;
    },
    get maxConcurrentOperations() {
      return state.maxConcurrentOperations;
    },
    resetMetrics() {
      for (const end of [...openEnds]) {
        end();
      }
      state.maxConcurrentRequests = 0;
      state.maxConcurrentOperations = 0;
    },
    writes: () => requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE'),
    seed(collection, seeded) {
      for (const { name, ...body } of seeded) {
        items(collection).set(name.toLowerCase(), { name, body, gets: 0 });
      }
    },
    seedDatabase(name, options = {}) {
      databases.set(name.toLowerCase(), {
        name,
        body: options.raw ?? {
          Origin: { Type: options.origin ?? 'SPARK' },
          Properties: { IsSyMSCDMDatabase: options.symscdm ?? true },
        },
        tables: new Map(
          (options.tables ?? []).map((t) => [t.toLowerCase(), { name: t, body: {}, gets: 0 }]),
        ),
        relationships: new Map(
          (options.relationships ?? []).map((r) => [
            r.toLowerCase(),
            { name: r, body: {}, gets: 0 },
          ]),
        ),
      });
    },
    get: (collection, name) => items(collection).get(name.toLowerCase())?.body,
    names: (collection) => [...items(collection).values()].map((stored) => stored.name),
    databaseChildren: (database, kind) =>
      [...(databases.get(database.toLowerCase())?.[kind].values() ?? [])].map(
        (child) => child.name,
      ),
    failOperation: (name, message) => failures.set(name.toLowerCase(), message),
    addFault: (fault) => faults.push({ fault, matches: 0 }),
    clearFaults: () => {
      faults.length = 0;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
