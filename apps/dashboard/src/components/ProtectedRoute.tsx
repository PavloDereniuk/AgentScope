import { AuthActionsContext } from '@/lib/auth-actions';
import { usePrivy } from '@privy-io/react-auth';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Fallback to localhost landing for dev. In production set VITE_LANDING_URL
// to the deployed landing domain so sign-out exits the app cleanly.
const LANDING_URL = import.meta.env.VITE_LANDING_URL ?? 'http://localhost:4321';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { ready, authenticated, login, logout } = usePrivy();
  // Track whether we already auto-opened the modal once this mount, so
  // dismissing it does not immediately re-open (spammy) — user falls back
  // to the manual Sign In button.
  const autoTriggered = useRef(false);
  // Gate rendering: once the user initiates sign-out, we suppress the
  // `!authenticated` login UI and show a transitional loader until the
  // redirect to landing fires. Without this, Privy flips `authenticated`
  // to false the instant local session clears, flashing the login screen
  // for a frame before navigation takes effect.
  const [isSigningOut, setIsSigningOut] = useState(false);

  // Privy's login may be sync or return a Promise depending on version —
  // wrap defensively so a rejection surfaces in the console instead of
  // becoming an unhandled rejection.
  const callLogin = useCallback(() => {
    try {
      const maybePromise = login() as unknown;
      if (maybePromise && typeof (maybePromise as { catch?: unknown }).catch === 'function') {
        (maybePromise as Promise<unknown>).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error('[auth] Privy login failed', err);
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] Privy login threw synchronously', err);
    }
  }, [login]);

  const signOut = useCallback(() => {
    setIsSigningOut(true);
    logout()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[auth] Privy logout failed', err);
      })
      .finally(() => {
        // Exit to landing regardless of logout success; if it failed,
        // the landing still gives the user a clean path to retry.
        window.location.href = LANDING_URL;
      });
  }, [logout]);

  // Auto-open the Privy modal on first arrival when unauthenticated.
  // Skipped while signing out so we don't re-prompt after clearing session.
  useEffect(() => {
    if (ready && !authenticated && !autoTriggered.current && !isSigningOut) {
      autoTriggered.current = true;
      callLogin();
    }
  }, [ready, authenticated, callLogin, isSigningOut]);

  const authActions = useMemo(() => ({ signOut, isSigningOut }), [signOut, isSigningOut]);

  if (!ready || isSigningOut) {
    return (
      <div className="grid min-h-screen place-items-center">
        <p className="text-muted-foreground">{isSigningOut ? 'Signing out…' : 'Loading...'}</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-2xl font-bold">AgentScope</h1>
          <p className="text-muted-foreground">Sign in to continue</p>
          <button
            type="button"
            onClick={callLogin}
            className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return <AuthActionsContext.Provider value={authActions}>{children}</AuthActionsContext.Provider>;
}
