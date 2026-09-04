"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, api } from "@/components/ui";

export default function NewCampaignForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ campaign: { id: string } }>("/api/campaigns", {
        method: "POST",
        body: JSON.stringify({ name, subject }),
      });
      router.push(`/campaigns/${result.campaign.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the campaign");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card grid gap-3 p-4">
      {error ? <Alert kind="error">{error}</Alert> : null}
      <div>
        <label className="label" htmlFor="name">Internal name</label>
        <input id="name" className="input" required autoFocus value={name}
          onChange={(e) => setName(e.target.value)} placeholder="October newsletter" />
        <p className="hint mt-1">Only you see this.</p>
      </div>
      <div>
        <label className="label" htmlFor="subject">Email subject</label>
        <input id="subject" className="input" value={subject}
          onChange={(e) => setSubject(e.target.value)} placeholder="What's new this month" />
        <p className="hint mt-1">You can change this in the next step.</p>
      </div>
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create draft"}
      </button>
    </form>
  );
}
