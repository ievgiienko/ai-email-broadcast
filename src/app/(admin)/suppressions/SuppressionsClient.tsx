"use client";

import { useCallback, useState } from "react";
import { Alert, EmptyState, Spinner, api, formatDate, useDebounced, useLoader } from "@/components/ui";

type Suppression = {
  id: string;
  email: string;
  reason: string;
  note: string | null;
  createdAt: string;
};

export default function SuppressionsClient() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const pageSize = 50;

  const fetchSuppressions = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (debouncedSearch) params.set("search", debouncedSearch);
    return api<{ suppressions: Suppression[]; total: number }>(`/api/suppressions?${params}`);
  }, [page, debouncedSearch]);

  const { data, error, reload, setError } = useLoader(fetchSuppressions);
  const rows = data?.suppressions ?? null;
  const total = data?.total ?? 0;

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/suppressions", { method: "POST", body: JSON.stringify({ email }) });
      setEmail("");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that address");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: Suppression) => {
    if (!confirm(`Remove ${row.email} from the suppression list? They will receive future campaigns again.`)) return;
    try {
      await api("/api/suppressions", { method: "DELETE", body: JSON.stringify({ email: row.email }) });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that address");
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-xl font-semibold">Unsubscribed &amp; suppressed</h1>
        <p className="hint mt-1">
          These addresses are never sent to, even if they appear in an imported list. Importing a CSV
          never re-subscribes someone — only removing them here does.
        </p>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <form onSubmit={add} className="card flex flex-wrap items-end gap-2 p-4">
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="supEmail">Suppress an address manually</label>
          <input id="supEmail" className="input" type="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="person@example.com" />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>Add</button>
      </form>

      <input className="input max-w-xs" placeholder="Search…" value={search}
        onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        aria-label="Search suppression list" />

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="Nobody has unsubscribed">
          Unsubscribes land here automatically.
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ color: "var(--color-muted)" }}>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-0">
                  <td className="px-3 py-2 break-all">{row.email}</td>
                  <td className="px-3 py-2"><span className="badge">{row.reason}</span></td>
                  <td className="px-3 py-2" style={{ color: "var(--color-muted)" }}>{formatDate(row.createdAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <button className="btn px-2 py-1 text-xs" onClick={() => remove(row)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pageCount > 1 ? (
        <div className="flex items-center justify-between">
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span className="hint">Page {page} of {pageCount}</span>
          <button className="btn" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      ) : null}
    </div>
  );
}
