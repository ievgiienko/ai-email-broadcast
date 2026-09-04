"use client";

import { useCallback, useState } from "react";
import { Alert, EmptyState, Modal, Spinner, api, formatDate, useDebounced, useLoader } from "@/components/ui";

export type ContactRow = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  createdAt: string;
};

/**
 * Shared contacts table. With a `listId` it shows and edits that list's
 * membership; without one it manages the global address book.
 */
export default function ContactsTable({ listId, reloadKey = 0 }: { listId?: string; reloadKey?: number }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ContactRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", firstName: "", lastName: "" });
  const [busy, setBusy] = useState(false);

  const pageSize = 50;

  const fetchContacts = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (listId) params.set("listId", listId);
    // reloadKey is part of the identity on purpose: a parent bumps it after an
    // import so this refetches.
    void reloadKey;
    const data = await api<{ contacts: ContactRow[]; total: number }>(`/api/contacts?${params}`);
    setSelected(new Set());
    return data;
  }, [page, debouncedSearch, listId, reloadKey]);

  const { data, error, reload, setError } = useLoader(fetchContacts);
  const rows = data?.contacts ?? null;
  const total = data?.total ?? 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api(`/api/contacts/${editing.id}`, { method: "PATCH", body: JSON.stringify(form) });
      } else {
        await api("/api/contacts", { method: "POST", body: JSON.stringify({ ...form, listId: listId ?? null }) });
      }
      setEditing(null);
      setAdding(false);
      setForm({ email: "", firstName: "", lastName: "" });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const bulkDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const question = listId
      ? `Remove ${ids.length} contact(s) from this list? They stay in your address book.`
      : `Permanently delete ${ids.length} contact(s) from every list?`;
    if (!confirm(question)) return;
    try {
      await api("/api/contacts", {
        method: "DELETE",
        body: JSON.stringify({ ids, listId: listId ?? null }),
      });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOnPageSelected = rows !== null && rows.length > 0 && rows.every((r) => selected.has(r.id));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="grid gap-3">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          placeholder="Search email or name…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          aria-label="Search contacts"
        />
        <button className="btn" onClick={() => { setForm({ email: "", firstName: "", lastName: "" }); setAdding(true); }}>
          Add contact
        </button>
        {selected.size > 0 ? (
          <button className="btn btn-danger" onClick={bulkDelete}>
            {listId ? `Remove ${selected.size} from list` : `Delete ${selected.size}`}
          </button>
        ) : null}
        <span className="hint ml-auto tabular-nums">{total} contact{total === 1 ? "" : "s"}</span>
      </div>

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title={search ? "No matches" : "No contacts here yet"}>
          {search ? "Try a different search." : "Add one manually, or import a batch."}
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ color: "var(--color-muted)" }}>
                <th className="w-10 px-3 py-2">
                  <input type="checkbox" checked={allOnPageSelected} aria-label="Select all on page"
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                    } />
                </th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">First name</th>
                <th className="px-3 py-2 font-medium">Last name</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">Added</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)}
                      aria-label={`Select ${row.email}`} />
                  </td>
                  <td className="px-3 py-2 break-all">{row.email}</td>
                  <td className="px-3 py-2">{row.firstName ?? "—"}</td>
                  <td className="px-3 py-2">{row.lastName ?? "—"}</td>
                  <td className="hidden px-3 py-2 sm:table-cell" style={{ color: "var(--color-muted)" }}>
                    {formatDate(row.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button className="btn px-2 py-1 text-xs"
                      onClick={() => {
                        setEditing(row);
                        setForm({ email: row.email, firstName: row.firstName ?? "", lastName: row.lastName ?? "" });
                      }}>
                      Edit
                    </button>
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

      <Modal
        open={adding || editing !== null}
        title={editing ? "Edit contact" : "Add contact"}
        onClose={() => { setAdding(false); setEditing(null); }}
      >
        <form onSubmit={submit} className="grid gap-3">
          <div>
            <label className="label" htmlFor="cEmail">Email</label>
            <input id="cEmail" className="input" type="email" required autoFocus value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="cFirst">First name</label>
              <input id="cFirst" className="input" value={form.firstName}
                onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
            </div>
            <div>
              <label className="label" htmlFor="cLast">Last name</label>
              <input id="cLast" className="input" value={form.lastName}
                onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            {editing ? (
              <button type="button" className="btn btn-danger"
                onClick={async () => {
                  if (!confirm("Delete this contact everywhere?")) return;
                  await api(`/api/contacts/${editing.id}`, { method: "DELETE" });
                  setEditing(null);
                  reload();
                }}>
                Delete
              </button>
            ) : null}
          </div>
        </form>
      </Modal>
    </div>
  );
}
