import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import type { User, Workspace } from './types';

interface AuthState {
  user: User | null;
  workspace: Workspace | null;
  mode: 'real' | 'demo';
  googleEnabled: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [mode, setMode] = useState<'real' | 'demo'>('real');
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<{ user: User; workspace: Workspace; mode: 'real' | 'demo' }>('/auth/me');
      setUser(me.user);
      setWorkspace(me.workspace);
      setMode(me.mode);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setWorkspace(null);
      } else {
        throw err;
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await api.get<{ googleEnabled: boolean; mode: 'real' | 'demo' }>('/auth/config');
        if (!cancelled) {
          setGoogleEnabled(config.googleEnabled);
          setMode(config.mode);
        }
      } catch {
        // Config is advisory only; sign-in still works without it.
      }
      try {
        await refresh();
      } catch {
        // Network failure is surfaced by the pages that need data.
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    await api.post('/auth/login', { email, password });
    await refresh();
  }, [refresh]);

  const register = useCallback(async (name: string, email: string, password: string) => {
    await api.post('/auth/register', { name, email, password });
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
    setWorkspace(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, workspace, mode, googleEnabled, loading, refresh, login, register, logout }),
    [user, workspace, mode, googleEnabled, loading, refresh, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
