import { PrivyProvider as BasePrivyProvider, usePrivy } from '@privy-io/react-auth';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { setTokenGetter } from './api-client';

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string;

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
