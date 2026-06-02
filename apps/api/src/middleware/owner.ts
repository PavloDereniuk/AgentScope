/**
 * Owner-only authorization middleware (Cluster F — admin panel).
 *
 * Layers *on top of* `requireAuth`: by the time this runs, `c.var.userId`
 * already holds the verified Privy DID. We simply gate on membership of the
 * owner allowlist (`OWNER_PRIVY_DID_SET` from config — the same set that
 * bypasses `MAX_AGENTS_PER_USER`). Non-owners get a flat `403` with no
 * detail, so the admin surface is invisible to regular authenticated users.
 *
 * This is deliberately NOT a role system. AgentScope is single-owner; the
 * grant-ops panel needs exactly one privileged identity, and an env allowlist
 * is the honest minimum. SSO/RBAC stays out of scope (see POST-MVP-ROADMAP).
 */

import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from '../logger';
import type { ApiEnv } from './auth';

/**
 * Build an owner-gate middleware bound to the configured owner DID set.
 * Apply *after* `requireAuth` so `c.var.userId` is populated. An empty set
 * means no one is an owner — every request is rejected, which is the safe
 * default for an environment that forgot to set `OWNER_PRIVY_DIDS`.
 */
export function requireOwner(ownerDids: Set<string>, logger: Logger): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const userId = c.get('userId');
    if (!ownerDids.has(userId)) {
      // Debug, not error: a non-owner probing /api/admin is routine noise,
      // not an operational fault. The 403 carries no body detail so the
      // endpoint set isn't enumerable by outsiders.
      logger.debug({ userId }, 'admin access denied: not an owner');
      throw new HTTPException(403, { message: 'forbidden' });
    }
    await next();
  };
}

/** Pure predicate — also used by the `/api/me` handler to report ownership. */
export function isOwner(ownerDids: Set<string>, userId: string): boolean {
  return ownerDids.has(userId);
}
