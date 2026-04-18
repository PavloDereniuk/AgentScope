import { PrivyProvider as BasePrivyProvider, usePrivy } from '@privy-io/react-auth';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { setTokenGetter } from './api-client';

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID;

// Fail fast at module load rather than letting Privy initialize with
// the literal string "undefined" — that surfaces as an opaque "login
// failed" later and is painful to diagnose.
if (!PRIVY_APP_ID || typeof PRIVY_APP_ID !== 'string') {
  throw new Error('VITE_PRIVY_APP_ID is required. Add it to the dashboard env before building.');
}

export function PrivyProvider({ children }: { children: ReactNode }) {
  return (
    <BasePrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: 'dark',
        },
        loginMethods: ['email', 'wallet'],
      }}
    >
      <TokenSync />
      {children}
    </BasePrivyProvider>
  );
}

function TokenSync() {
  const { getAccessToken } = usePrivy();

  useEffect(() => {
    setTokenGetter(getAccessToken);
  }, [getAccessToken]);

  return null;
}

export { usePrivy as useAuth };
