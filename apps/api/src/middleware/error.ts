/**
 * Global error handling for the API.
 *
 * Response format (stable public contract — matches SPEC §6):
 *   { "error": { "code": "SCREAMING_SNAKE", "message": "human readable" } }
 *
 * Route handlers throw `HTTPException` from 'hono/http-exception' to signal
 * known errors (401/404/etc). Anything else is treated as an unexpected
 * failure: logged with full stack, returned to the client as a generic 500
 * so internals never leak.
 */

import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from '../logger';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/**
 * Map an HTTP status code to a stable error code string.
 * Unknown 4xx → BAD_REQUEST, unknown 5xx (and everything else) → INTERNAL_ERROR.
 */
export function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 429:
      return 'TOO_MANY_REQUESTS';
    default:
      if (status >= 400 && status < 500) return 'BAD_REQUEST';
      return 'INTERNAL_ERROR';
  }
}

/**
 * Attach global onError + notFound handlers to a Hono app.
 * Accepts any Hono instance regardless of its Env/Variables generics.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional — helper must accept any app shape.
export function registerErrorHandlers(app: Hono<any, any, any>, logger: Logger): void {
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const status = err.status;
      const body: ApiErrorBody = {
        error: {
          code: statusToCode(status),
          message: err.message || statusToCode(status),
        },
      };
      logger.warn(
        { status, path: c.req.path, method: c.req.method, message: err.message },
        'http exception',
      );
      return c.json(body, status);
    }

    logger.error(
      { err, path: c.req.path, method: c.req.method },
      'unhandled error in request handler',
    );
    const body: ApiErrorBody = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    };
    return c.json(body, 500 satisfies ContentfulStatusCode);
  });

  app.notFound((c) => {
    const body: ApiErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: `Route not found: ${c.req.method} ${c.req.path}`,
      },
    };
    return c.json(body, 404);
  });
}
