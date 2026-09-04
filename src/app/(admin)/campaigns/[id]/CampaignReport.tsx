"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert, Spinner, StatusBadge, api, formatDate, formatPercent, useDebounced, useLoader,
} from "@/components/ui";

type Stats = {
  total: number;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  suppressed: number;
  cancelled: number;
  uniqueOpens: number;
  totalOpens: number;
  openRate: number;
};

type Campaign = {
  id: string;
  name: string;
  subject: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  totalRecipients: number;
};

type Recipient = {
  id: string;
  email: string;
  deliveryStatus: string;
  sentAt: string | null;
  firstOpenedAt: string | null;
  openCount: number;
  attempts: number;
  lastError: string | null;
};

const STATUSES = ["QUEUED", "SENDING", "SENT", "FAILED", "SUPPRESSED", "CANCELLED"];

export default function CampaignReport({
  campaignId, initialStatus, onStatusChange,
}: { campaignId: string; initialStatus: string; onStatusChange: (s: string) => void }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const pageSize = 50;
  const isLive = initialStatus === "QUEUED" || initialStatus === "SENDING";

  const fetchSummary = useCallback(async () => {
    void tick;
    return api<{ campaign: Campaign; stats: Stats }>(`/api/campaigns/${campaignId}`);
  }, [campaignId, tick]);

  const fetchRecipients = useCallback(async () => {
    void tick;
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (status) params.set("status", status);
    return api<{ recipients: Recipient[]; total: number }>(
      `/api/campaigns/${campaignId}/recipients?${params}`,
    );
  }, [campaignId, page, debouncedSearch, status, tick]);

  const summary = useLoader(fetchSummary);
  const recipientPage = useLoader(fetchRecipients);

  const campaign = summary.data?.campaign ?? null;
  const stats = summary.data?.stats ?? null;
  const rows = recipientPage.data?.recipients ?? null;
  const total = recipientPage.data?.total ?? 0;
  const error = summary.error ?? recipientPage.error;

  // While a campaign is in flight the numbers change under the admin's feet, so
  // poll gently rather than making them reload. Bumping `tick` re-runs both
  // loaders through their memoized identity.
  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(timer);
  }, [isLive]);

  // Keep the parent's status badge in sync with what the server reports.
  const reportedStatus = campaign?.status;
  useEffect(() => {
    if (reportedStatus) onStatusChange(reportedStatus);
  }, [reportedStatus, onStatusChange]);

  const act = async (action: "pause" | "resume" | "cancel") => {
    if (action === "cancel" && !confirm("Cancel this campaign? Queued emails will not be sent.")) return;
    setBusy(true);
    summary.setError(null);
    try {
      await api(`/api/campaigns/${campaignId}/${action}`, { method: "POST" });
      setTick((t) => t + 1);
    } catch (err) {
      summary.setError(err instanceof Error ? err.message : `Could not ${action} the campaign`);
    } finally {
      setBusy(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentStatus = campaign?.status ?? initialStatus;

  return (
    <div className="grid gap-5">
      {error ? <Alert kind="error">{error}</Alert> : null}

      <section className="card p-4">
        <p className="text-sm"><span className="hint">Subject: </span>{campaign?.subject}</p>
        <div className="mt-2 grid gap-1 text-xs sm:grid-cols-3" style={{ color: "var(--color-muted)" }}>
          <span>Created {formatDate(campaign?.createdAt)}</span>
          <span>Started {formatDate(campaign?.startedAt)}</span>
          <span>Completed {formatDate(campaign?.completedAt)}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {(currentStatus === "QUEUED" || currentStatus === "SENDING") ? (
            <button className="btn" disabled={busy} onClick={() => act("pause")}>Pause</button>
          ) : null}
          {currentStatus === "PAUSED" ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => act("resume")}>Resume</button>
          ) : null}
          {["QUEUED", "SENDING", "PAUSED"].includes(currentStatus) ? (
            <button className="btn btn-danger" disabled={busy} onClick={() => act("cancel")}>Cancel</button>
          ) : null}
          {(stats?.failed ?? 0) > 0 ? (
            <a className="btn" href={`/api/campaigns/${campaignId}/failures`}>Export failures (CSV)</a>
          ) : null}
        </div>
      </section>

      {stats === null ? (
        <Spinner />
      ) : (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Card label="Recipients" value={stats.total} />
          <Card label="Sent" value={stats.sent} />
          <Card label="Pending" value={stats.queued + stats.sending} />
          <Card label="Failed" value={stats.failed} />
          <Card label="Opened" value={stats.uniqueOpens} hint={`${stats.totalOpens} total opens`} />
          <Card label="Unique open rate" value={formatPercent(stats.openRate)} hint="of sent" />
        </section>
      )}

      {stats && (stats.suppressed > 0 || stats.cancelled > 0) ? (
        <p className="hint">
          {stats.suppressed > 0 ? `${stats.suppressed} recipient(s) skipped after unsubscribing. ` : ""}
          {stats.cancelled > 0 ? `${stats.cancelled} recipient(s) cancelled before delivery.` : ""}
        </p>
      ) : null}

      <section className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input className="input max-w-xs" placeholder="Search by email…" value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            aria-label="Search recipients" />
          <select className="input max-w-40" value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            aria-label="Filter by status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="hint ml-auto tabular-nums">{total} row{total === 1 ? "" : "s"}</span>
        </div>

        {rows === null ? (
          <Spinner />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ color: "var(--color-muted)" }}>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Delivery</th>
                  <th className="px-3 py-2 font-medium">Sent at</th>
                  <th className="px-3 py-2 font-medium">Opened</th>
                  <th className="px-3 py-2 font-medium">First opened</th>
                  <th className="px-3 py-2 text-right font-medium">Attempts</th>
                  <th className="px-3 py-2 font-medium">Last error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="px-3 py-2 break-all">{row.email}</td>
                    <td className="px-3 py-2"><StatusBadge status={row.deliveryStatus} /></td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: "var(--color-muted)" }}>
                      {formatDate(row.sentAt)}
                    </td>
                    <td className="px-3 py-2">{row.firstOpenedAt ? `Yes (${row.openCount})` : "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: "var(--color-muted)" }}>
                      {formatDate(row.firstOpenedAt)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.attempts}</td>
                    <td className="max-w-xs px-3 py-2 text-xs" style={{ color: "var(--color-muted)" }}>
                      {row.lastError ?? "—"}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr><td className="px-3 py-6 text-center hint" colSpan={7}>No matching recipients.</td></tr>
                ) : null}
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
      </section>

      <p className="hint">
        Opens are measured with a tracking pixel and are approximate. Clients that block remote images never
        register an open, while privacy proxies and security scanners can load the image without a person
        reading anything.
      </p>
    </div>
  );
}

function Card({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--color-muted)" }}>{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="hint mt-0.5">{hint}</p> : null}
    </div>
  );
}
