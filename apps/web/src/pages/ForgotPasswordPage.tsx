import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '../components/Panel';
import { api } from '../lib/api';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const res = await api.post<{ ok: boolean; token?: string }>('/auth/password/forgot', { email });
      setSent(true);
      setDevToken(res.token ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Reset password</h1>
        <p className="sub">We send a reset link if the account exists.</p>
        {error && <Alert>{error}</Alert>}
        {sent ? (
          <div className="stack">
            <Alert kind="info">If that address has an account, a reset link is on its way.</Alert>
            {devToken && (
              <p className="mono muted">
                Development token: <Link to={`/reset-password?token=${devToken}`}>{devToken}</Link>
              </p>
            )}
            <Link to="/login">Back to sign in</Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <button className="primary full" type="submit">
              Send reset link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
