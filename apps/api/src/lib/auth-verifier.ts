/**
 * Auth token verification abstraction.
 *
 * Middleware depends on the narrow `AuthVerifier` interface so tests can
 * pass a fake without touching Privy's SDK or the network. Production
 * wires up `createPrivyVerifier` which delegates to `@privy-io/server-auth`.
 */

import { PrivyClient } from '@privy-io/server-auth';

export interface VerifiedClaims {
  /** Stable Privy DID, e.g. `did:privy:abc123`. Used as our `user_id`. */
  userId: string;
}

export interface AuthVerifier {
  /**
   * Validate a bearer token (Privy access token). Throws on any failure —
   * expired, invalid signature, malformed, or transport error. Callers
   * should treat every rejection as a 401.
   */
  verify(token: string): Promise<VerifiedClaims>;
}

/**
 * Build an `AuthVerifier` backed by a real Privy client. Call once at
 * server startup and pass the returned verifier into `requireAuth`.
 */
export function createPrivyVerifier(appId: string, appSecret: string): AuthVerifier {
  const client = new PrivyClient(appId, appSecret);
  return {
    async verify(token) {
      const claims = await client.verifyAuthToken(token);
      return { userId: claims.userId };
    },
  };
}
