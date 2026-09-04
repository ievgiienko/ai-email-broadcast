"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Editor from "@/components/Editor";
import { Alert, Modal, api } from "@/components/ui";

export type CampaignDraft = {
  id: string;
  name: string;
  subject: string;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  contentHtml: string;
  textBody: string | null;
  textBodyIsCustom: boolean;
  status: string;
  totalRecipients: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type List = { id: string; name: string; contactCount: number };

type Audience = {
  totalMemberships: number;
  uniqueContacts: number;
  duplicatesRemoved: number;
  suppressed: number;
  finalRecipients: number;
  maxEmailsPerHour: number;
  estimatedDuration: string;
};

const STEPS = ["Compose", "Recipients", "Preview", "Send"] as const;

export default function CampaignWizard({
  initial, initialListIds, onQueued,
}: { initial: CampaignDraft; initialListIds: string[]; onQueued: () => void }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(initial);
  const [listIds, setListIds] = useState<string[]>(initialListIds);
  const [lists, setLists] = useState<List[]>([]);
  const [audience, setAudience] = useState<Audience | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void api<{ lists: List[] }>("/api/lists").then((d) => setLists(d.lists)).catch(() => undefined);
  }, []);

  const set = <K extends keyof CampaignDraft>(key: K, value: CampaignDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/campaigns/${draft.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: draft.name,
          subject: draft.subject,
          fromName: draft.fromName,
          fromEmail: draft.fromEmail,
          replyTo: draft.replyTo,
          contentHtml: draft.contentHtml,
          textBody: draft.textBodyIsCustom ? draft.textBody : undefined,
          textBodyIsCustom: draft.textBodyIsCustom,
          listIds,
        }),
      });
      setDirty(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, listIds]);

  const loadAudience = useCallback(async () => {
    try {
      setAudience(await api<Audience>(`/api/campaigns/${draft.id}/audience`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not compute the audience");
    }
  }, [draft.id]);

  const goTo = async (next: number) => {
    if (next > step && !(await save())) return;
    setStep(next);
    if (next >= 1) void loadAudience();
  };

  const toggleList = (id: string) => {
    setListIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setDirty(true);
    setAudience(null);
  };

  return (
    <div className="grid gap-4">
      <ol className="flex flex-wrap gap-1 text-sm">
        {STEPS.map((label, index) => (
          <li key={label}>
            <button
              className={`btn px-3 py-1.5 text-xs ${index === step ? "btn-active" : ""}`}
              aria-current={index === step ? "step" : undefined}
              onClick={() => void goTo(index)}
            >
              {index + 1}. {label}
            </button>
          </li>
        ))}
      </ol>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="success">{notice}</Alert> : null}

      {step === 0 ? (
        <ComposeStep draft={draft} set={set} />
      ) : step === 1 ? (
        <RecipientsStep lists={lists} listIds={listIds} toggleList={toggleList} audience={audience} />
      ) : step === 2 ? (
        <PreviewStep campaignId={draft.id} onNotice={setNotice} onError={setError} />
      ) : (
        <SendStep
          draft={draft}
          audience={audience}
          lists={lists.filter((l) => listIds.includes(l.id))}
          onQueued={() => { onQueued(); router.refresh(); }}
          onError={setError}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {step > 0 ? <button className="btn" onClick={() => void goTo(step - 1)}>Back</button> : null}
        {step < STEPS.length - 1 ? (
          <button className="btn btn-primary" onClick={() => void goTo(step + 1)} disabled={saving}>
            {saving ? "Saving…" : "Continue"}
          </button>
        ) : null}
        <button className="btn" onClick={() => void save()} disabled={saving || !dirty}>
          {dirty ? "Save draft" : "Saved"}
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- step: 1 */

function ComposeStep({
  draft, set,
}: {
  draft: CampaignDraft;
  set: <K extends keyof CampaignDraft>(key: K, value: CampaignDraft[K]) => void;
}) {
  const [showText, setShowText] = useState(draft.textBodyIsCustom);

  return (
    <div className="grid gap-4">
      <section className="card grid gap-4 p-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="cname">Internal name</label>
          <input id="cname" className="input" value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="csubject">Subject</label>
          <input id="csubject" className="input" value={draft.subject}
            onChange={(e) => set("subject", e.target.value)} />
          <p className="hint mt-1">Personalization works here too, e.g. “A note for {"{{firstName}}"}”.</p>
        </div>
        <div>
          <label className="label" htmlFor="cfromName">Sender name</label>
          <input id="cfromName" className="input" value={draft.fromName ?? ""}
            onChange={(e) => set("fromName", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cfromEmail">Sender email</label>
          <input id="cfromEmail" className="input" type="email" value={draft.fromEmail ?? ""}
            onChange={(e) => set("fromEmail", e.target.value)} />
          <p className="hint mt-1">
            Leave blank to use the sender from Settings. Whatever you use must be verified with your
            SMTP provider, or they will reject the message.
          </p>
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="creplyTo">Reply-To (optional)</label>
          <input id="creplyTo" className="input" type="email" value={draft.replyTo ?? ""}
            onChange={(e) => set("replyTo", e.target.value)} />
        </div>
      </section>

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="label mb-0">Email content</span>
          <span className="hint">
            Variables: {"{{firstName}}"} · {"{{lastName}}"} · {"{{email}}"} · {"{{unsubscribeUrl}}"}
          </span>
        </div>
        <Editor value={draft.contentHtml} onChange={(html) => set("contentHtml", html)} />
        <p className="hint mt-1">
          A missing variable renders as empty text, never as the raw placeholder. An unsubscribe link is
          appended automatically unless you place {"{{unsubscribeUrl}}"} yourself.
        </p>
      </div>

      <section className="card p-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showText}
            onChange={(e) => {
              setShowText(e.target.checked);
              set("textBodyIsCustom", e.target.checked);
            }} />
          Write a custom plain-text version
        </label>
        <p className="hint mt-1">
          Otherwise a plain-text alternative is generated from your HTML automatically.
        </p>
        {showText ? (
          <textarea className="input mt-3 font-mono text-xs" rows={8} value={draft.textBody ?? ""}
            onChange={(e) => set("textBody", e.target.value)} aria-label="Plain text body" />
        ) : null}
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- step: 2 */

function RecipientsStep({
  lists, listIds, toggleList, audience,
}: { lists: List[]; listIds: string[]; toggleList: (id: string) => void; audience: Audience | null }) {
  return (
    <div className="grid gap-4">
      <section className="card p-4">
        <h2 className="font-medium">Select lists</h2>
        {lists.length === 0 ? (
          <p className="hint mt-2">No lists yet — create one under Lists first.</p>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {lists.map((list) => (
              <label key={list.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                <input type="checkbox" checked={listIds.includes(list.id)} onChange={() => toggleList(list.id)} />
                <span className="flex-1">{list.name}</span>
                <span className="hint tabular-nums">{list.contactCount}</span>
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="font-medium">Audience</h2>
        {audience === null ? (
          <p className="hint mt-2">Select lists and continue to calculate the audience.</p>
        ) : (
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Across lists" value={audience.totalMemberships} />
            <Stat label="Duplicates removed" value={audience.duplicatesRemoved} />
            <Stat label="Unsubscribed" value={audience.suppressed} />
            <Stat label="Will receive" value={audience.finalRecipients} strong />
          </dl>
        )}
        <p className="hint mt-3">
          An address on several selected lists receives the campaign exactly once. Comparison ignores case.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div>
      <dt className="hint">{label}</dt>
      <dd className={`tabular-nums ${strong ? "text-2xl font-semibold" : "text-xl"}`}>{value}</dd>
    </div>
  );
}

/* --------------------------------------------------------------- step: 3 */

function PreviewStep({
  campaignId, onNotice, onError,
}: { campaignId: string; onNotice: (m: string) => void; onError: (m: string | null) => void }) {
  const [preview, setPreview] = useState<{ subject: string; html: string; text: string } | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [mode, setMode] = useState<"html" | "text">("html");
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ subject: string; html: string; text: string }>(`/api/campaigns/${campaignId}/preview`)
      .then(setPreview)
      .catch((err) => onError(err instanceof Error ? err.message : "Preview failed"));
  }, [campaignId, onError]);

  const sendTest = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    onError(null);
    try {
      const result = await api<{ message: string }>(`/api/campaigns/${campaignId}/test`, {
        method: "POST",
        body: JSON.stringify({ to: testTo }),
      });
      onNotice(result.message);
      setTestOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Test send failed");
    } finally {
      setBusy(false);
    }
  };

  const width = useMemo(() => (device === "mobile" ? 390 : 700), [device]);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className={`btn px-3 py-1.5 text-xs ${device === "desktop" ? "btn-active" : ""}`}
          onClick={() => setDevice("desktop")}>Desktop</button>
        <button className={`btn px-3 py-1.5 text-xs ${device === "mobile" ? "btn-active" : ""}`}
          onClick={() => setDevice("mobile")}>Mobile</button>
        <span className="mx-1 h-4 w-px" style={{ backgroundColor: "var(--color-border)" }} />
        <button className={`btn px-3 py-1.5 text-xs ${mode === "html" ? "btn-active" : ""}`}
          onClick={() => setMode("html")}>HTML</button>
        <button className={`btn px-3 py-1.5 text-xs ${mode === "text" ? "btn-active" : ""}`}
          onClick={() => setMode("text")}>Plain text</button>
        <button className="btn ml-auto" onClick={() => setTestOpen(true)}>Send test email</button>
      </div>

      {preview === null ? (
        <p className="hint">Rendering…</p>
      ) : (
        <div className="card p-4">
          <p className="text-sm"><span className="hint">Subject: </span><strong>{preview.subject}</strong></p>
          <div className="mt-3 overflow-x-auto">
            {mode === "html" ? (
              // Rendered in a sandboxed iframe: no scripts, no same-origin access.
              <iframe
                title="Email preview"
                sandbox=""
                srcDoc={preview.html}
                style={{ width, height: 620, maxWidth: "100%", border: "1px solid var(--color-border)", borderRadius: 8, background: "#fff" }}
              />
            ) : (
              <pre className="whitespace-pre-wrap rounded-lg border p-3 font-mono text-xs">{preview.text}</pre>
            )}
          </div>
          <p className="hint mt-2">
            The preview omits the tracking pixel, so opening it never registers as an open.
          </p>
        </div>
      )}

      <Modal open={testOpen} title="Send test email" onClose={() => setTestOpen(false)}>
        <form onSubmit={sendTest} className="grid gap-3">
          <div>
            <label className="label" htmlFor="testTo">Recipient</label>
            <input id="testTo" className="input" type="email" required autoFocus value={testTo}
              onChange={(e) => setTestTo(e.target.value)} />
          </div>
          <p className="hint">
            You receive exactly what the campaign will send. Test emails create no recipient records and
            are excluded from campaign statistics — but they do count against your SMTP hourly limit.
          </p>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send test"}
          </button>
        </form>
      </Modal>
    </div>
  );
}

/* --------------------------------------------------------------- step: 4 */

function SendStep({
  draft, audience, lists, onQueued, onError,
}: {
  draft: CampaignDraft;
  audience: Audience | null;
  lists: List[];
  onQueued: () => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      await api(`/api/campaigns/${draft.id}/send`, { method: "POST" });
      setConfirmOpen(false);
      onQueued();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not queue the campaign");
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <section className="card p-4">
        <h2 className="font-medium">Confirm before sending</h2>
        <dl className="mt-3 grid gap-2 text-sm">
          <Row label="Subject" value={draft.subject || <span className="text-red-600">Not set</span>} />
          <Row label="Sender" value={`${draft.fromName ?? ""} <${draft.fromEmail ?? "—"}>`} />
          <Row label="Reply-To" value={draft.replyTo || "—"} />
          <Row label="Lists" value={lists.length > 0 ? lists.map((l) => l.name).join(", ") : "None selected"} />
          <Row label="Unique recipients" value={audience ? String(audience.finalRecipients) : "…"} />
          <Row label="Duplicates removed" value={audience ? String(audience.duplicatesRemoved) : "…"} />
          <Row label="Unsubscribed, skipped" value={audience ? String(audience.suppressed) : "…"} />
          <Row
            label="Estimated duration"
            value={audience ? `${audience.estimatedDuration} at ${audience.maxEmailsPerHour}/hour` : "…"}
          />
        </dl>
      </section>

      <div>
        <button
          className="btn btn-primary"
          disabled={busy || !audience || audience.finalRecipients === 0 || !draft.subject.trim()}
          onClick={() => setConfirmOpen(true)}
        >
          Queue campaign
        </button>
        {audience?.finalRecipients === 0 ? (
          <p className="hint mt-2">No recipients — select at least one non-empty list.</p>
        ) : null}
      </div>

      <Modal open={confirmOpen} title="Queue this campaign?" onClose={() => setConfirmOpen(false)}>
        <div className="grid gap-3 text-sm">
          <p>
            This queues <strong>{audience?.finalRecipients ?? 0}</strong> emails. Sending happens in the
            background at your configured rate, and you can pause or cancel at any point — but messages
            already handed to the SMTP server cannot be recalled.
          </p>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={send}>
              {busy ? "Queueing…" : "Yes, queue it"}
            </button>
            <button className="btn" onClick={() => setConfirmOpen(false)} disabled={busy}>Cancel</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2 border-b pb-2 last:border-0">
      <dt className="hint w-44 shrink-0">{label}</dt>
      <dd className="flex-1 break-words">{value}</dd>
    </div>
  );
}
