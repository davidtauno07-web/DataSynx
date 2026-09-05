import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const NAV = [
  { to: '/import', label: 'Import' },
  { to: '/processing', label: 'Processing' },
  { to: '/export', label: 'Export' },
];

export function Layout() {
  const { user, workspace, mode, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">DataSynx</span>
        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : undefined)}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          {mode === 'demo' && <span className="pill warn">Demo mode</span>}
          <span className="mono muted">{workspace?.name ?? ''}</span>
          <span className="mono">{user?.email}</span>
          <button
            onClick={async () => {
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
