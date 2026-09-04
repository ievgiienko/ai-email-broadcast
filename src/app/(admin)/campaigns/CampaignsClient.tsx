"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { Alert, EmptyState, Spinner, StatusBadge, api, formatDate, useLoader } from "@/components/ui";

type CampaignRow = {
  id: string;
  name: string;
  subject: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  totalRecipients: number;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  uniqueOpens: number;
};

export default function CampaignsClient() {
  const router = useRouter();
  const fetchCampaigns = useCallback(async () => {
    const data = await api<{ campaigns: CampaignRow[] }>("/api/campaigns");
    return data.campaigns;
  }, []);

  const { data: rows, error, setError } = useLoader(fetchCampaigns);

  const duplicate = async (id: string) => {
    try {
      const result = await api<{ campaign: { id: string } }>(`/api/campaigns/${id}/duplicate`, { method: "POST" });
      router.push(`/campaigns/${result.campaign.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Duplicate failed");
    }
  };

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Campaigns</h1>
        <Link className="btn btn-primary" href="/campaigns/new">New campaign</Link>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No campaigns yet">Create one to start sending.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ color: "var(--color-muted)" }}>
                <th className="px-3 py-2 font-medium">Campaign</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Recipients</th>
                <th className="px-3 py-2 text-right font-medium">Queued</th>
                <th className="px-3 py-2 text-right font-medium">Sent</th>
                <th className="px-3 py-2 text-right font-medium">Failed</th>
                <th className="px-3 py-2 text-right font-medium">Opens</th>
                <th className="hidden px-3 py-2 font-medium lg:table-cell">Created</th>
                <th className="hidden px-3 py-2 font-medium lg:table-cell">Completed</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const openRate = row.sent > 0 ? (row.uniqueOpens / row.sent) * 100 : 0;
                return (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <Link href={`/campaigns/${row.id}`} className="font-medium hover:underline">{row.name}</Link>
                      <p className="hint line-clamp-1">{row.subject || "No subject"}</p>
                    </td>
                    <td className="px-3 py-2"><StatusBadge status={row.status} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.totalRecipients}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.queued + row.sending}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.sent}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.failed}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.uniqueOpens}
                      <span className="hint"> ({openRate.toFixed(0)}%)</span>
                    </td>
                    <td className="hidden px-3 py-2 lg:table-cell" style={{ color: "var(--color-muted)" }}>
                      {formatDate(row.createdAt)}
                    </td>
                    <td className="hidden px-3 py-2 lg:table-cell" style={{ color: "var(--color-muted)" }}>
                      {formatDate(row.completedAt)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button className="btn px-2 py-1 text-xs" onClick={() => duplicate(row.id)}>Duplicate</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="hint">
        Open counts are approximate: some clients block tracking images, while security scanners can load
        them automatically. Treat them as a signal, not proof that a person read the email.
      </p>
    </div>
  );
}
