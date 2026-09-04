"use client";

import Link from "next/link";
import { useState } from "react";
import CampaignWizard, { type CampaignDraft } from "./CampaignWizard";
import CampaignReport from "./CampaignReport";
import { StatusBadge } from "@/components/ui";

/**
 * A DRAFT campaign shows the composer wizard; anything further along shows the
 * report. Content is intentionally frozen once a campaign leaves DRAFT.
 */
export default function CampaignDetail({
  initial, initialListIds,
}: { initial: CampaignDraft; initialListIds: string[] }) {
  const [status, setStatus] = useState(initial.status);

  return (
    <div className="grid gap-5">
      <div>
        <Link className="hint hover:underline" href="/campaigns">← All campaigns</Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{initial.name}</h1>
          <StatusBadge status={status} />
        </div>
      </div>

      {status === "DRAFT" ? (
        <CampaignWizard
          initial={initial}
          initialListIds={initialListIds}
          onQueued={() => setStatus("QUEUED")}
        />
      ) : (
        <CampaignReport campaignId={initial.id} initialStatus={status} onStatusChange={setStatus} />
      )}
    </div>
  );
}
