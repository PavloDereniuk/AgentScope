/**
 * Privy JWT auth middleware (task 3.3).
 *
 * Every protected route expects an `Authorization: Bearer <privy_token>`
 * header. The middleware validates the token via `AuthVerifier`, injects
 * the Privy user DID into `c.var.userId`, and hands off to the next
 * handler. Any failure (missing header, malformed prefix, rejected token)
 * surfaces as a `401 UNAUTHORIZED` through the global error middleware.
 *
 * The verifier is passed in explicitly — tests drive the middleware with a
 * fake verifier, production wires up `createPrivyVerifier` from env.
 */

import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AuthVerifier } from '../lib/auth-verifier';
import type { Logger } from '../logger';

/**
 * Context variables attached by `requireAuth`. Apps that use this
 * middleware should type their Hono instance as `new Hono<ApiEnv>()` so
 * `c.get('userId')` is statically typed.
 */
export interface ApiVariables {
  userId: string;
}

export type ApiEnv = {
  Variables: ApiVariables;
};

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

/**
 * Build an auth middleware bound to a specific verifier + logger.
 * Apply with `app.use('/api/*', requireAuth(verifier, logger))`.
 */
export function requireAuth(verifier: AuthVerifier, logger: Logger): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    // Tokens are accepted only via `Authorization: Bearer <token>`. The dashboard
    // consumes SSE via fetch+ReadableStream, so the old `?token=` query-param
    // fallback is unneeded and would expose credentials in access logs / Referer.
    const header = c.req.header('Authorization');
    if (!header) {
      throw new HTTPException(401, { message: 'missing authorization header' });
    }
    const match = BEARER_RE.exec(header);
    if (!match?.[1]) {
      throw new HTTPException(401, { message: 'malformed authorization header' });
    }
    const token = match[1];

    try {
      const { userId } = await verifier.verify(token);
      c.set('userId', userId);
    } catch (err) {
      // Not logged as error: invalid tokens are routine (expired sessions,
      // stale frontends). Ops dashboards can grep for this at debug level.
      logger.debug({ err }, 'auth token verification failed');
      throw new HTTPException(401, { message: 'invalid token' });
    }

    await next();
  };
}
