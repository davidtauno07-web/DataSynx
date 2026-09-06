import { useCallback, useEffect, useState } from 'react';
import { Alert, Empty, Panel } from '../../components/Panel';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

interface Account {
  id: string;
  provider: string;
  address: string;
  connectedAt: string;
}

interface MessageSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  hasAttachments?: boolean;
}

interface Props {
  onImported: () => void;
}

/**
 * Lists and searches mail; only the messages the user explicitly ticks are
 * imported. Nothing is ever sent, modified or deleted.
 */
export function EmailConnector({ onImported }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    const res = await api.get<{ accounts: Account[] }>('/email/accounts');
    setAccounts(res.accounts);
    setAccountId((current) => current ?? res.accounts[0]?.id ?? null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const config = await api.get<{ gmailEnabled: boolean }>('/email/config');
        setEnabled(config.gmailEnabled);
        await loadAccounts();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Email connector unavailable');
      }
    })();
  }, [loadAccounts]);

  async function connect() {
    setError(null);
    try {
      const res = await api.get<{ url: string }>('/email/gmail/connect');
      window.location.href = res.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Gmail authorisation');
    }
  }

  async function search() {
    if (!accountId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.get<{ messages: MessageSummary[] }>(
        `/email/accounts/${accountId}/messages?q=${encodeURIComponent(query)}&max=25`,
      );
      setMessages(res.messages);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  }

  async function importSelected() {
    if (!accountId || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ files: unknown[]; failures: unknown[] }>(`/email/accounts/${accountId}/import`, {
        messageIds: [...selected],
        includeAttachments: true,
      });
      setNotice(`Imported ${res.files.length} item(s); ${res.failures.length} failed.`);
      setSelected(new Set());
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Panel title="Email Connector">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}

      {!enabled ? (
        <Empty>
          Gmail is not configured in this deployment. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and
          GMAIL_REDIRECT_URI to enable it.
        </Empty>
      ) : accounts.length === 0 ? (
        <div className="stack">
          <p className="muted">Connect a mailbox with read-only access. DataSynx never sends, modifies or deletes mail.</p>
          <button className="primary" onClick={connect}>
            Connect Gmail
          </button>
        </div>
      ) : (
        <div className="stack">
          <label className="field">
            <span>Mailbox</span>
            <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.address} · connected {formatDateTime(account.connectedAt)}
                </option>
              ))}
            </select>
          </label>
          <div className="inline">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search mail (e.g. has:attachment invoice)"
              aria-label="Search mail"
            />
            <button onClick={search} disabled={busy}>
              Search
            </button>
            <button onClick={connect} disabled={busy}>
              Add mailbox
            </button>
          </div>

          {messages === null ? (
            <Empty>Search your mailbox, then select the messages to import.</Empty>
          ) : messages.length === 0 ? (
            <Empty>No messages matched that search.</Empty>
          ) : (
            <>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th aria-label="Select" />
                      <th>From</th>
                      <th>Subject</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messages.map((message) => (
                      <tr key={message.id}>
                        <td>
                          <input
                            type="checkbox"
                            style={{ width: 16 }}
                            checked={selected.has(message.id)}
                            onChange={() => toggle(message.id)}
                            aria-label={`Select ${message.subject}`}
                          />
                        </td>
                        <td>{message.from}</td>
                        <td>
                          {message.subject}
                          <div className="muted mono">{message.snippet}</div>
                        </td>
                        <td className="mono">{formatDateTime(message.date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className="primary" onClick={importSelected} disabled={busy || selected.size === 0}>
                Import {selected.size} selected
              </button>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
