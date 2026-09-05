import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert } from '../components/Panel';
import { api } from '../lib/api';

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password/reset', { token, password });
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Choose a new password</h1>
        <p className="sub">The reset link expires shortly after it is issued.</p>
        {error && <Alert>{error}</Alert>}
        <form onSubmit={onSubmit} noValidate>
          <label className="field">
            <span>Reset token</span>
            <input name="token" required value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className="primary full" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </form>
        <p style={{ marginTop: 24 }}>
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
