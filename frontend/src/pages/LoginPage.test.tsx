import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../lib/auth';
import { LoginPage } from './LoginPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderLogin() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    mockFetch((url) => {
      if (url.includes('/auth/config')) return jsonResponse({ googleEnabled: true, mode: 'real' });
      if (url.includes('/auth/me')) return jsonResponse({ error: { message: 'Unauthenticated' } }, 401);
      return jsonResponse({ error: { message: 'Unexpected route' } }, 404);
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('renders the email/password form', async () => {
    renderLogin();
    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('offers Google sign-in when the API reports it is configured', async () => {
    renderLogin();
    expect(await screen.findByText(/continue with google/i)).toBeInTheDocument();
  });

  it('shows the API error message when credentials are rejected', async () => {
    mockFetch((url) => {
      if (url.includes('/auth/config')) return jsonResponse({ googleEnabled: false, mode: 'real' });
      if (url.includes('/auth/login')) return jsonResponse({ error: { message: 'Invalid email or password' } }, 401);
      return jsonResponse({ error: { message: 'Unauthenticated' } }, 401);
    });
    renderLogin();
    await userEvent.type(await screen.findByLabelText(/email/i), 'someone@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByText('Invalid email or password')).toBeInTheDocument());
  });
});
