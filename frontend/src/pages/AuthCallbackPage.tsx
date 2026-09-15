import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/** Landing page after the Google OAuth redirect: cookies are already set. */
export function AuthCallbackPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refresh()
      .then(() => navigate('/import', { replace: true }))
      .catch((err: Error) => setError(err.message));
  }, [refresh, navigate]);

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Completing sign in…</h1>
        {error && <p className="muted">{error}</p>}
      </div>
    </div>
  );
}
