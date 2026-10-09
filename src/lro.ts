import * as core from '@actions/core';
import {
  ensureSuccess,
  HttpError,
  headerValue,
  pathOf,
  responseError,
  retryWaitMs,
  serviceMessageOf,
} from './http.ts';
import { DEFAULT_API_VERSION } from './kinds.ts';
import type { Http, Response } from './http.ts';

/**
 * Long-running operation rules (design 3.4). Every function here is called
 * with the response to the initial PUT or DELETE and returns once the
 * operation has finished, or throws.
 *
 * Polls go through Http.request(), which already retries 429, 5xx and
 * connection errors up to 5 times (about 2 minutes of waiting). So a 429
 * storm during a poll fails the operation when request() gives up, not at
 * the 20 minute deadline; a 429 that request() resolves is invisible here.
 * The 429 branches below only matter for an Http that returns one as is.
 */

export const OPERATION_DEADLINE_MS = 20 * 60_000;
export const BASE_POLL_WAIT_MS = 2_000;
export const MAX_POLL_WAIT_MS = 30_000;
export const MIN_POLL_WAIT_MS = 1_000;

export interface LroContext {
  http: Http;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Per operation; defaults to 20 minutes. */
  deadlineMs?: number;
}

export interface OperationTarget {
  /** Token scope for every poll. */
  scope: string;
  /** What the operation is for, such as "pipelines/pl_load"; used in messages. */
  label: string;
  /**
   * Path prefix of the operationResults collection when a PUT answers with an
   * operationId and no Location: "" at the root, "/managedVirtualNetworks/default"
   * for endpoints, ".../workspaces/<ws>" for ARM.
   */
  operationBase?: string;
}

export interface DeployTarget extends OperationTarget {
  /** The artifact's short name; a poll answering with it means done. */
  name: string;
  /**
   * Lake database entities: a 202 with only a Location header is an
   * operation, and a poll answer without status or name counts as done.
   */
  lenient?: boolean;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The body as an object; undefined when it is empty or not a JSON object. */
function tolerantBody(res: Response): Record<string, unknown> | undefined {
  if (res.text.trim() === '') {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(res.text));
  } catch {
    return undefined;
  }
}

/** The body as an object; undefined when it is empty, throws when it is not JSON. */
function strictBody(res: Response): Record<string, unknown> | undefined {
  return res.text.trim() === '' ? undefined : asRecord(res.json());
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function errorMessageOf(body: Record<string, unknown> | undefined): string {
  const error = asRecord(body?.error);
  return stringField(error, 'message') ?? stringField(body, 'message') ?? 'no reason given';
}

/**
 * Resolves a Location or Azure-AsyncOperation value against the request that
 * returned it and refuses another origin: the poll carries a bearer token.
 */
export function sameOriginUrl(requestUrl: string, target: string): string {
  const base = new URL(requestUrl);
  let resolved: URL;
  try {
    resolved = new URL(target, base);
  } catch {
    throw new Error(
      `Refusing to follow "${target}" from ${base.host}: it is not a valid URL. ` +
        'Re-run the job; if it persists, report the response.',
    );
  }
  if (resolved.origin !== base.origin) {
    throw new Error(
      `Refusing to send the token to ${resolved.host}: the service pointed ${base.host} ` +
        'at another host. Check for a proxy or a mis-set endpoint.',
    );
  }
  return resolved.toString();
}

/** Retry-After when sent (at least 1 s: 0 or a past date must not spin), else 2 s doubling to 30 s. */
export function pollWaitMs(headers: Response['headers'], poll: number, nowMs: number): number {
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== undefined && retryAfter.trim() !== '') {
    return Math.max(MIN_POLL_WAIT_MS, retryWaitMs(headers, poll, nowMs));
  }
  return Math.min(BASE_POLL_WAIT_MS * 2 ** (poll - 1), MAX_POLL_WAIT_MS);
}

/** True when the operation finished, else a short description of where it is. */
type Interpreter = (res: Response) => true | string;

async function poll(
  ctx: LroContext,
  target: OperationTarget,
  url: string,
  deadlineAt: number,
  interpret: Interpreter,
  initialHeaders: Response['headers'] = {},
): Promise<void> {
  let last: string | undefined;
  // A Retry-After on the initial answer says when the first poll is worth
  // making; without one the first poll goes out at once.
  const initialHint = headerValue(initialHeaders, 'retry-after');
  if (initialHint !== undefined && initialHint.trim() !== '') {
    await ctx.sleep(pollWaitMs(initialHeaders, 1, ctx.now()));
  }
  for (let n = 1; ; n++) {
    const res = await ctx.http.request('GET', url, target.scope);
    const verdict = interpret(res);
    if (verdict === true) {
      return;
    }
    last = verdict;
    if (ctx.now() >= deadlineAt) {
      break;
    }
    await ctx.sleep(pollWaitMs(res.headers, n, ctx.now()));
    if (ctx.now() >= deadlineAt) {
      break;
    }
  }
  const minutes = Math.round((ctx.deadlineMs ?? OPERATION_DEADLINE_MS) / 60_000);
  throw new Error(
    `${target.label} did not finish within ${minutes} minutes (last status: ${last ?? 'none'}). ` +
      'Check the operation in Synapse Studio and re-run the job.',
  );
}

function deadlineFor(ctx: LroContext): number {
  return ctx.now() + (ctx.deadlineMs ?? OPERATION_DEADLINE_MS);
}

// States after which nothing changes. ARM keeps waiting on values it does not
// know, so only the clearly terminal ones fail fast.
const FAILED_STATES = new Set(['failed', 'canceled', 'cancelled', 'rejected', 'deleted']);

function isFailedState(lower: string | undefined): lower is string {
  return lower !== undefined && FAILED_STATES.has(lower);
}

// Carries the service's own text so callers can match on it without the path.
function operationFailed(target: OperationTarget, what: string, reason: string): HttpError {
  return new HttpError(`${target.label} ${what}: ${reason}`, undefined, reason);
}

function unexpected(res: Response, target: OperationTarget): Error {
  if (res.status >= 200 && res.status < 300) {
    return new Error(
      `${target.label}: ${res.method} ${pathOf(res.url)} answered ${res.status}, which is not ` +
        `a valid answer here: ${serviceMessageOf(res.text) || 'empty body'}.`,
    );
  }
  const error = responseError(res);
  return new HttpError(`${target.label}: ${error.message}`, error.status, error.serviceMessage);
}

function interpretDeployPoll(target: DeployTarget): Interpreter {
  return (res) => {
    if (res.status === 204) {
      core.info(`${target.label}: the operation answered 204; treating it as done`);
      return true;
    }
    if (res.status === 404) {
      throw new Error(
        `${target.label}: the operation disappeared (404 from ${pathOf(res.url)}). ` +
          'Re-run the job; if it persists, check the workspace in Synapse Studio.',
      );
    }
    if (res.status === 429) {
      return 'HTTP 429';
    }
    if (res.status === 202) {
      return 'HTTP 202';
    }
    if (res.status !== 200 && res.status !== 201) {
      throw unexpected(res, target);
    }
    const body = strictBody(res);
    if (body === undefined) {
      return `HTTP ${res.status} with an empty body`;
    }
    const status = stringField(body, 'status');
    const lower = status?.toLowerCase();
    if (isFailedState(lower)) {
      throw operationFailed(target, lower, errorMessageOf(body));
    }
    if (lower === 'inprogress' || lower === 'accepted' || lower === 'running') {
      return `status ${String(status)}`;
    }
    const name = stringField(body, 'name');
    if (
      lower === 'succeeded' ||
      (name !== undefined && name.toLowerCase() === target.name.toLowerCase())
    ) {
      return true;
    }
    if (target.lenient === true && status === undefined && name === undefined) {
      return true;
    }
    throw new Error(
      `${target.label}: the operation answered with ${status === undefined ? 'no status' : `status ${status}`} ` +
        'and not the artifact; check it in Synapse Studio and re-run the job.',
    );
  };
}

async function followOperation(
  ctx: LroContext,
  put: Response,
  target: DeployTarget,
  operationId: string | undefined,
  deadlineAt: number,
): Promise<void> {
  const location = headerValue(put.headers, 'location');
  const url =
    location !== undefined
      ? sameOriginUrl(put.url, location)
      : new URL(
          `${target.operationBase ?? ''}/operationResults/${encodeURIComponent(operationId ?? '')}?api-version=${DEFAULT_API_VERSION}`,
          put.url,
        ).toString();
  await poll(ctx, target, url, deadlineAt, interpretDeployPoll(target), put.headers);
}

/**
 * Data-plane deploy: the PUT answered 2xx. With an operationId (or, for lake
 * database entities, a bare 202 with Location) the operation is polled; a
 * plain 200 or 201 is done; anything else fails.
 */
export async function awaitDataPlaneDeploy(
  ctx: LroContext,
  put: Response,
  target: DeployTarget,
): Promise<void> {
  const deadlineAt = deadlineFor(ctx);
  await startedOperation(ctx, put, target, deadlineAt);
}

/** Returns true when it followed an operation, false when the PUT was already final. */
async function startedOperation(
  ctx: LroContext,
  put: Response,
  target: DeployTarget,
  deadlineAt: number,
): Promise<boolean> {
  ensureSuccess(put);
  const operationId = stringField(tolerantBody(put), 'operationId');
  const hasLocation = headerValue(put.headers, 'location') !== undefined;
  if (operationId !== undefined || (target.lenient === true && put.status === 202 && hasLocation)) {
    await followOperation(ctx, put, target, operationId, deadlineAt);
    return true;
  }
  // Lake database entities are documented as synchronous: 200, and in practice 201 or 204.
  if (put.status === 200 || put.status === 201 || (target.lenient === true && put.status === 204)) {
    return false;
  }
  throw new Error(
    `${target.label}: PUT answered ${put.status} without an operation ID${put.status === 202 ? ' or Location' : ''}, so there is nothing ` +
      `to wait for: ${put.text.trim() || 'empty body'}. Re-run the job; if it persists, check the artifact in Synapse Studio.`,
  );
}

/**
 * Delete (rule R1): 404 on the DELETE is "already gone"; a Location header is
 * polled, where 404 ends the wait and every other unexpected status throws.
 */
export async function awaitDelete(
  ctx: LroContext,
  del: Response,
  target: OperationTarget,
): Promise<void> {
  if (del.status === 404) {
    core.info(`${target.label}: already deleted`);
    return;
  }
  ensureSuccess(del);
  const location = headerValue(del.headers, 'location');
  if (location === undefined) {
    return;
  }
  await poll(
    ctx,
    target,
    sameOriginUrl(del.url, location),
    deadlineFor(ctx),
    (res) => {
      if (res.status === 404) {
        core.info(`${target.label}: the delete operation is gone (404); treating it as done`);
        return true;
      }
      if (res.status === 429 || res.status === 202) {
        return `HTTP ${res.status}`;
      }
      if (res.status === 204) {
        return true;
      }
      if (res.status !== 200 && res.status !== 201) {
        throw unexpected(res, target);
      }
      // A body that is not JSON is not a "done": it may be a proxy's page.
      const body = strictBody(res);
      const status = stringField(body, 'status');
      const lower = status?.toLowerCase();
      if (isFailedState(lower)) {
        throw operationFailed(target, `delete ${lower}`, errorMessageOf(body));
      }
      if (lower === 'inprogress' || lower === 'accepted' || lower === 'running') {
        return `status ${String(status)}`;
      }
      if (lower === 'succeeded' || status === undefined) {
        return true;
      }
      throw new Error(
        `${target.label}: the delete operation answered with status ${status}, which is not ` +
          'known; check the artifact in Synapse Studio and re-run the job.',
      );
    },
    del.headers,
  );
}

function provisioningInterpreter(target: OperationTarget): Interpreter {
  return (res) => {
    if (res.status === 429) {
      return 'HTTP 429';
    }
    if (res.status < 200 || res.status >= 300) {
      throw unexpected(res, target);
    }
    const body = strictBody(res);
    const properties = asRecord(body?.properties);
    const state = stringField(properties, 'provisioningState');
    const lower = state?.toLowerCase();
    if (lower === 'succeeded') {
      return true;
    }
    if (isFailedState(lower)) {
      const error = asRecord(properties?.error);
      throw operationFailed(
        target,
        `provisioning ${lower}`,
        stringField(error, 'message') ?? errorMessageOf(body),
      );
    }
    return state === undefined ? 'no provisioningState yet' : `provisioningState ${state}`;
  };
}

/**
 * Managed private endpoint deploy: follow an operationId if there is one,
 * then GET the endpoint until it is provisioned. The run must not be green
 * while the endpoint is still provisioning.
 */
export async function awaitEndpointDeploy(
  ctx: LroContext,
  put: Response,
  target: DeployTarget,
): Promise<void> {
  const deadlineAt = deadlineFor(ctx);
  ensureSuccess(put);
  if (stringField(tolerantBody(put), 'operationId') !== undefined) {
    await startedOperation(ctx, put, target, deadlineAt);
  }
  await poll(ctx, target, put.url, deadlineAt, provisioningInterpreter(target), put.headers);
}

function interpretAsyncOperation(target: OperationTarget): Interpreter {
  return (res) => {
    if (res.status === 429 || res.status === 202) {
      return `HTTP ${res.status}`;
    }
    if (res.status < 200 || res.status >= 300) {
      throw unexpected(res, target);
    }
    const body = strictBody(res);
    const status = stringField(body, 'status');
    const lower = status?.toLowerCase();
    if (lower === 'succeeded') {
      return true;
    }
    if (isFailedState(lower)) {
      throw operationFailed(target, lower, errorMessageOf(body));
    }
    return status === undefined ? 'no status yet' : `status ${status}`;
  };
}

/** ARM PUT: Azure-AsyncOperation, a bare Location, a provisioning body, or an operationId. */
export async function awaitArmDeploy(
  ctx: LroContext,
  put: Response,
  target: DeployTarget,
): Promise<void> {
  const deadlineAt = deadlineFor(ctx);
  ensureSuccess(put);
  const body = tolerantBody(put);

  if (stringField(body, 'operationId') !== undefined) {
    await startedOperation(ctx, put, target, deadlineAt);
    return;
  }
  const asyncOperation = headerValue(put.headers, 'azure-asyncoperation');
  if (asyncOperation !== undefined) {
    await poll(
      ctx,
      target,
      sameOriginUrl(put.url, asyncOperation),
      deadlineAt,
      interpretAsyncOperation(target),
      put.headers,
    );
    return;
  }
  if (put.status === 202) {
    const location = headerValue(put.headers, 'location');
    if (location === undefined) {
      throw new Error(
        `${target.label}: ARM answered 202 with neither Azure-AsyncOperation nor Location, so there ` +
          'is nothing to wait for. Re-run the job; if it persists, check the resource in the portal.',
      );
    }
    await poll(
      ctx,
      target,
      sameOriginUrl(put.url, location),
      deadlineAt,
      (res) => {
        if (res.status === 429 || res.status === 202) {
          return `HTTP ${res.status}`;
        }
        if (res.status === 200 || res.status === 201 || res.status === 204) {
          return true;
        }
        throw unexpected(res, target);
      },
      put.headers,
    );
    return;
  }
  if (put.status === 200 || put.status === 201) {
    const state = stringField(asRecord(body?.properties), 'provisioningState');
    if (state !== undefined && state.toLowerCase() !== 'succeeded') {
      await poll(ctx, target, put.url, deadlineAt, provisioningInterpreter(target));
    }
    return;
  }
  throw new Error(
    `${target.label}: ARM answered ${put.status}, which has nothing to wait for or confirm. ` +
      'Re-run the job; if it persists, check the resource in the portal.',
  );
}
