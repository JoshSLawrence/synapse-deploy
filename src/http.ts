import * as core from '@actions/core';
import { HttpClient } from '@actions/http-client';
import type { HttpClientResponse } from '@actions/http-client';
import type { IncomingHttpHeaders } from 'node:http';
import type { TokenProvider } from './auth.ts';

export const userAgent = 'synapse-deploy';

// Without a socket timeout a stalled connection never settles, so the job
// runs until the runner kills it. Large workspaces take minutes to answer the
// database queries, hence 5 minutes for data-plane calls.
export const DATA_PLANE_SOCKET_TIMEOUT_MS = 300_000;

export const MAX_ATTEMPTS = 5;
export const BASE_RETRY_WAIT_MS = 2_000;
export const MAX_RETRY_WAIT_MS = 60_000;
export const MAX_SERVICE_MESSAGE_CHARS = 2_000;

// IMF-fixdate and RFC 850 ("Sun, 06 Nov 1994 08:49:37 GMT"), or asctime
// ("Sun Nov  6 08:49:37 1994").
const HTTP_DATE = /^(?:[A-Za-z]{3,9}, \d.*|[A-Za-z]{3} [A-Za-z]{3} .*)\d{2}:\d{2}:\d{2}/;

// Retrying cannot fix a bad certificate or an unknown host; failing at once
// shows the cause instead of two minutes of waiting. EAI_AGAIN (a DNS blip)
// and resets are worth retrying.
const PERMANENT_ERROR_CODE =
  /^(?:CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_(?:GET_ISSUER_CERT|VERIFY_LEAF_SIGNATURE)|ENOTFOUND$)/;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// Redirects stay off: every request carries a bearer token, and none of the
// Azure endpoints used here is expected to redirect.
export function createHttpClient(socketTimeout: number): HttpClient {
  return new HttpClient(userAgent, [], { socketTimeout, allowRedirects: false });
}

export function isRedirectStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 300 && status < 400;
}

export function redirectError(location: string | undefined): Error {
  return new Error(
    `Unexpected redirect to ${location ?? 'an unknown location'}; redirects are disabled because every request carries a bearer token.`,
  );
}

/**
 * Reads a response body, always settling. @actions/http-client's own readBody
 * listens only for data and end, so a connection reset or stalled body leaves
 * its promise pending forever and the job can exit green with work undone.
 */
export function readBody(
  res: HttpClientResponse,
  idleTimeoutMs: number = DATA_PLANE_SOCKET_TIMEOUT_MS,
): Promise<string> {
  const message = res.message;
  const host = (message as unknown as { req?: { host?: string } }).req?.host ?? 'the server';

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let ended = false;

    const fail = (reason: string) => {
      if (!ended) {
        ended = true;
        reject(new Error(`${reason}; re-run the job.`));
      }
    };

    message.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    message.on('end', () => {
      if (!ended) {
        ended = true;
        resolve(Buffer.concat(chunks).toString());
      }
    });
    message.on('error', (err: Error) => {
      fail(`Reading the response from ${host} failed: ${err.message}`);
    });
    message.on('aborted', () => {
      fail(`Connection closed before the response from ${host} was complete`);
    });
    message.on('close', () => {
      if (!message.complete) {
        fail(`Connection closed before the response from ${host} was complete`);
      }
    });
    message.setTimeout(idleTimeoutMs, () => {
      const reason = `No data from ${host} for ${Math.round(idleTimeoutMs / 1000)} s`;
      fail(reason);
      message.destroy(new Error(reason));
    });
  });
}

// A 401 or 403 is almost always a missing role, which the raw status does not say.
export function permissionHint(status: number | undefined, role: string): string {
  return status === 401 || status === 403
    ? ` The identity is likely missing ${role}; grant it and re-run the job.`
    : '';
}

const GENERIC_ROLE =
  'a role for this call (Synapse RBAC on the workspace for the development endpoint, ' +
  'Azure RBAC on the workspace for Azure Resource Manager)';

export type Method = 'GET' | 'PUT' | 'DELETE';

export interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  /** Parses the body; throws a readable error when it is not JSON. */
  json(): unknown;
  method: Method;
  /** The URL as requested, query included. */
  url: string;
  /** How many attempts it took, 1 when the first one answered. */
  attempts: number;
}

/** A non-2xx answer, or a retryable failure that outlasted its attempts. */
export class HttpError extends Error {
  readonly status: number | undefined;
  readonly serviceMessage: string;

  constructor(
    message: string,
    status: number | undefined,
    serviceMessage: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'HttpError';
    this.status = status;
    this.serviceMessage = serviceMessage;
  }
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The service's own explanation: error.message, message, else the raw text. */
export function serviceMessageOf(text: string): string {
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as { error?: unknown; message?: unknown };
      const inner =
        typeof record.error === 'object' && record.error !== null
          ? (record.error as { message?: unknown }).message
          : undefined;
      if (typeof inner === 'string') {
        message = inner;
      } else if (typeof record.message === 'string') {
        message = record.message;
      }
    }
  } catch {
    // Not JSON: the raw text is the best explanation there is.
  }
  return message.length > MAX_SERVICE_MESSAGE_CHARS
    ? message.slice(0, MAX_SERVICE_MESSAGE_CHARS) + '...'
    : message;
}

/** Builds the error for a response the caller does not accept. */
export function responseError(res: Response): HttpError {
  const serviceMessage = serviceMessageOf(res.text);
  const attempts = res.attempts > 1 ? ` after ${res.attempts} attempts` : '';
  return new HttpError(
    `${res.method} ${pathOf(res.url)} failed with status ${res.status}${attempts}` +
      (serviceMessage ? `: ${serviceMessage}` : '') +
      '.' +
      permissionHint(res.status, GENERIC_ROLE),
    res.status,
    serviceMessage,
  );
}

/** Returns the response when it is 2xx, else throws responseError. */
export function ensureSuccess(res: Response): Response {
  if (res.status < 200 || res.status >= 300) {
    throw responseError(res);
  }
  return res;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const record = err as { code?: unknown; cause?: unknown };
  return typeof record.code === 'string' ? record.code : errorCode(record.cause);
}

/** True for a connection error that retrying cannot fix. */
export function isPermanentConnectionError(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && PERMANENT_ERROR_CODE.test(code);
}

/** The first value of a header, typed so a repeated header cannot leak `any`. */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw: string | string[] | undefined = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * How long to wait before the next attempt: Retry-After (seconds or an HTTP
 * date) when the server sent one, else 2 s doubling; never more than 60 s.
 */
export function retryWaitMs(headers: IncomingHttpHeaders, attempt: number, nowMs: number): number {
  const header = headerValue(headers, 'retry-after');
  let wait = BASE_RETRY_WAIT_MS * 2 ** (attempt - 1);
  if (header !== undefined && header.trim() !== '') {
    const value = header.trim();
    if (/^\d+$/.test(value)) {
      wait = Number(value) * 1000;
    } else if (HTTP_DATE.test(value)) {
      // Date.parse accepts far more than HTTP dates ("1.5", "-1"), which
      // must not turn into a zero wait.
      // HTTP dates are always GMT, even asctime, which does not say so.
      const date = Date.parse(/GMT$/.test(value) ? value : `${value} GMT`);
      if (!Number.isNaN(date)) {
        wait = Math.max(0, date - nowMs);
      }
    }
  }
  return Math.min(wait, MAX_RETRY_WAIT_MS);
}

export interface Http {
  /**
   * Sends one request with a fresh token and returns the answer, whatever its
   * status, except: a 3xx throws, and 429, 500, 502, 503, 504 or a connection
   * error is retried (5 attempts in all) before it throws.
   */
  request(method: Method, url: string, scope: string, body?: unknown): Promise<Response>;
}

export interface HttpOptions {
  tokens: TokenProvider;
  client?: HttpClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxAttempts?: number;
  /** Idle limit while reading a body; the default matches the socket timeout. */
  bodyIdleTimeoutMs?: number;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHttp(options: HttpOptions): Http {
  const client = options.client ?? createHttpClient(DATA_PLANE_SOCKET_TIMEOUT_MS);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const bodyIdleTimeoutMs = options.bodyIdleTimeoutMs ?? DATA_PLANE_SOCKET_TIMEOUT_MS;

  return {
    async request(method, url, scope, body) {
      // Request bodies hold parameter values, so they are never logged.
      const payload = body === undefined ? null : JSON.stringify(body);

      for (let attempt = 1; ; attempt++) {
        // A fresh token on every attempt: a retry after a long wait must not
        // reuse a token that has expired meanwhile. A sign-in failure is not
        // retried here.
        const token = await options.tokens.getToken(scope);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        };
        if (payload !== null) {
          headers['Content-Type'] = 'application/json';
        }

        const started = now();
        let status: number;
        let responseHeaders: IncomingHttpHeaders;
        let text: string;
        try {
          const res = await client.request(method, url, payload, headers);
          status = res.message.statusCode ?? 0;
          responseHeaders = res.message.headers;
          text = await readBody(res, bodyIdleTimeoutMs);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          core.debug(`${method} ${pathOf(url)} failed: ${reason} (attempt ${attempt})`);
          if (isPermanentConnectionError(err)) {
            throw new HttpError(
              `${method} ${pathOf(url)} failed: ${reason}. Retrying cannot help; ` +
                'check the host name, the TLS certificate and any proxy in between.',
              undefined,
              reason,
              err,
            );
          }
          if (attempt >= maxAttempts) {
            throw new HttpError(
              `${method} ${pathOf(url)} failed after ${attempt} attempts: ${reason}`,
              undefined,
              reason,
              err,
            );
          }
          await sleep(retryWaitMs({}, attempt, now()));
          continue;
        }

        core.debug(
          `${method} ${pathOf(url)} -> ${status} (attempt ${attempt}, ${now() - started} ms)`,
        );

        if (isRedirectStatus(status)) {
          throw redirectError(headerValue(responseHeaders, 'location'));
        }

        const response: Response = {
          status,
          headers: responseHeaders,
          text,
          json: () => {
            try {
              return JSON.parse(text) as unknown;
            } catch {
              throw new Error(
                `${method} ${pathOf(url)} answered with status ${status} and a body that is not JSON.`,
              );
            }
          },
          method,
          url,
          attempts: attempt,
        };

        if (!RETRYABLE_STATUSES.has(status)) {
          return response;
        }
        if (attempt >= maxAttempts) {
          throw responseError(response);
        }
        await sleep(retryWaitMs(responseHeaders, attempt, now()));
      }
    },
  };
}
