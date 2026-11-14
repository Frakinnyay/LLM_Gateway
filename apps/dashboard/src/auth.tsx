import { createContext, useContext } from 'react';

/** Admin token lives only in React state (memory): a page refresh logs out. Nothing is written to localStorage/cookies. */
export interface AuthState { token: string; logout: () => void }
export const AuthContext = createContext<AuthState | null>(null);
export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('AuthContext missing');
  return v;
}
