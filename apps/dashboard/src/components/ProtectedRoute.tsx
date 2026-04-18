import { usePrivy } from '@privy-io/react-auth';
import type { ReactNode } from 'react';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { ready, authenticated, login } = usePrivy();

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center">
        <p className="text-muted-foreground">Loading...</p>
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
            onClick={() => {
              // Privy's login may be sync or return a Promise depending on
              // version — wrap defensively so a rejection surfaces in the
              // console instead of becoming an unhandled rejection.
              try {
                const maybePromise = login() as unknown;
                if (
                  maybePromise &&
                  typeof (maybePromise as { catch?: unknown }).catch === 'function'
                ) {
                  (maybePromise as Promise<unknown>).catch((err: unknown) => {
                    // eslint-disable-next-line no-console
                    console.error('[auth] Privy login failed', err);
                  });
                }
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('[auth] Privy login threw synchronously', err);
              }
            }}
            className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
