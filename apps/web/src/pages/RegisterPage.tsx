import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Alert } from '../components/Panel';
import { useAuth } from '../lib/auth';

export function RegisterPage() {
  const { register, user, googleEnabled, loading } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) return <Navigate to="/import" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(name, email, password);
      navigate('/import', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Create account</h1>
        <p className="sub">A workspace is created with your account.</p>
        {error && <Alert>{error}</Alert>}
        <form onSubmit={onSubmit} noValidate>
          <label className="field">
            <span>Name</span>
            <input name="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
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
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby="password-hint"
            />
            <span id="password-hint" className="muted mono">
              Minimum 12 characters, with upper case, lower case and a digit.
            </span>
          </label>
          <button className="primary full" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create Account'}
          </button>
        </form>

        {googleEnabled && (
          <>
            <div className="divider">or</div>
            <a className="button full" style={{ display: 'block', textAlign: 'center' }} href="/api/auth/google">
              Continue with Google
            </a>
          </>
        )}

        <p style={{ marginTop: 24 }}>
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
