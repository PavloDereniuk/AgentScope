import { createContext, useContext } from 'react';

export type AuthActions = {
  /** Clears the Privy session and navigates to the landing page. */
  signOut: () => void;
  /** True from the moment signOut is called until the redirect fires. */
  isSigningOut: boolean;
};

export const AuthActionsContext = createContext<AuthActions | null>(null);

export function useAuthActions(): AuthActions {
  const ctx = useContext(AuthActionsContext);
  if (!ctx) {
    throw new Error('useAuthActions must be used inside <ProtectedRoute>');
  }
  return ctx;
}
