import { useCallback, useMemo, useState } from 'react';
import { AuthContext } from './auth';
import { CachePanel, CostChart, ProviderPanel, RequestTable, TryIt } from './components';

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <main className="login">
      <h1>LLM Gateway</h1>
      <p>Enter the admin token (<code>ADMIN_API_TOKEN</code>). It is kept in memory only; refreshing the page signs you out.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (value) onLogin(value); }}>
        <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Admin token" aria-label="Admin token" />
        <button type="submit" disabled={!value}>Sign in</button>
      </form>
    </main>
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const logout = useCallback(() => setToken(null), []);
  const auth = useMemo(() => (token ? { token, logout } : null), [token, logout]);

  if (!auth) return <Login onLogin={setToken} />;
  return (
    <AuthContext.Provider value={auth}>
      <header className="top">
        <h1>LLM Gateway</h1>
        <button onClick={logout}>Sign out</button>
      </header>
      <main className="grid">
        <ProviderPanel />
        <CachePanel />
        <CostChart />
        <RequestTable />
        <TryIt />
      </main>
    </AuthContext.Provider>
  );
}
