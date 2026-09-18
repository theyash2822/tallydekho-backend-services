/**
 * Keep internal failure detail out of 5xx response bodies.
 *
 * Roughly two hundred handlers answer a caught exception with
 * `message: err.message`. When the exception came from Postgres that ships the
 * driver's text to the client — table and column names, constraint names, the
 * offending value in a unique violation, `syntax error at or near …`. It is a
 * free schema map for anyone probing the API, and the client can do nothing
 * with it anyway.
 *
 * Fixing it at each call site would mean editing every handler in the codebase.
 * Fixing it here relies on the status code the handler already chose: 4xx is a
 * statement about the caller's request and keeps its message, 5xx means
 * "something broke inside" and gets a fixed sentence plus the request id. The
 * original text still reaches the logs, correlated by that id.
 *
 * Deliberately not a substitute for correct status codes. A conflict answered
 * with 500 becomes unreadable to the client — which is a reason to fix the
 * status, not to widen this shield.
 */
import { randomUUID } from 'node:crypto';

const GENERIC_MESSAGE = 'Internal server error';

/** Response envelopes in use: legacy `{status,message}` and v1 `{success,error}`. */
function replaceMessages(body, requestId) {
  if (!body || typeof body !== 'object') return body;
  const out = Array.isArray(body) ? [...body] : { ...body };
  if (typeof out.message === 'string') out.message = GENERIC_MESSAGE;
  if (out.error && typeof out.error === 'object') {
    out.error = { ...out.error, message: GENERIC_MESSAGE, requestId };
  }
  if (typeof out.error === 'string') out.error = GENERIC_MESSAGE;
  delete out.stack;
  delete out.detail;
  if (!out.error) out.requestId = requestId;
  return out;
}

/** Correlation id shared by the response body, the header and the server log. */
export function requestContext(req, res, next) {
  const id = req.get('x-request-id') || randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}

export function internalErrorShield(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500) {
      const leaked = body?.error?.message ?? body?.message;
      if (leaked && leaked !== GENERIC_MESSAGE) {
        console.error('[5xx]', {
          requestId: req.requestId,
          method: req.method,
          path: req.originalUrl?.split('?')[0],
          workspaceId: req.workspace?.id ?? req.headers['x-workspace-id'] ?? null,
          companyId: req.company?.id ?? null,
          status: res.statusCode,
          message: leaked,
        });
      }
      return originalJson(replaceMessages(body, req.requestId));
    }
    return originalJson(body);
  };
  next();
}

export const INTERNAL_ERROR_MESSAGE = GENERIC_MESSAGE;
