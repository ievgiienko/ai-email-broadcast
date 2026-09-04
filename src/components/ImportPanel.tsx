"use client";

import { useState } from "react";
import { Alert, api } from "@/components/ui";
import type { ColumnRole } from "@/lib/csv";

type Summary = {
  received: number;
  imported: number;
  duplicates: number;
  invalid: number;
  skippedSuppressed: number;
  invalidSamples: string[];
};

type PreviewResponse = {
  delimiter: string;
  hasHeader: boolean;
  header: string[];
  mapping: ColumnRole[];
  preview: string[][];
  totalRows: number;
  content: string;
};

const ROLE_LABELS: Record<ColumnRole, string> = {
  email: "Email",
  firstName: "First Name",
  lastName: "Last Name",
  ignore: "Ignore",
};

/** Paste box + CSV/TXT upload wizard for one list. */
export default function ImportPanel({ listId, onImported }: { listId: string; onImported: () => void }) {
  const [tab, setTab] = useState<"paste" | "file">("paste");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="grid gap-4">
      <div className="flex gap-1">
        <button className={`btn px-3 py-1.5 text-xs ${tab === "paste" ? "btn-active" : ""}`}
          onClick={() => { setTab("paste"); setSummary(null); setError(null); }}>
          Paste addresses
        </button>
        <button className={`btn px-3 py-1.5 text-xs ${tab === "file" ? "btn-active" : ""}`}
          onClick={() => { setTab("file"); setSummary(null); setError(null); }}>
          Upload CSV / TXT
        </button>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {summary ? <ImportSummaryView summary={summary} /> : null}

      {tab === "paste" ? (
        <PasteImport listId={listId} onDone={(s) => { setSummary(s); setError(null); onImported(); }} onError={setError} />
      ) : (
        <FileImport listId={listId} onDone={(s) => { setSummary(s); setError(null); onImported(); }} onError={setError} />
      )}
    </div>
  );
}

function ImportSummaryView({ summary }: { summary: Summary }) {
  return (
    <Alert kind={summary.imported > 0 ? "success" : "info"}>
      <div className="grid gap-1">
        <p>
          <strong>{summary.imported}</strong> imported ·{" "}
          <strong>{summary.duplicates}</strong> duplicate{summary.duplicates === 1 ? "" : "s"} ·{" "}
          <strong>{summary.invalid}</strong> invalid ·{" "}
          <strong>{summary.skippedSuppressed}</strong> skipped (unsubscribed)
        </p>
        {summary.invalidSamples.length > 0 ? (
          <p className="text-xs opacity-80">
            Rejected, for example: {summary.invalidSamples.slice(0, 5).join(", ")}
          </p>
        ) : null}
      </div>
    </Alert>
  );
}

/* ------------------------------------------------------------------ paste */

function PasteImport({
  listId, onDone, onError,
}: { listId: string; onDone: (s: Summary) => void; onError: (e: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const result = await api<{ summary: Summary }>("/api/import/paste", {
        method: "POST",
        body: JSON.stringify({ text, listId }),
      });
      onDone(result.summary);
      setText("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-2">
      <label className="label" htmlFor="pasteBox">Paste email addresses</label>
      <textarea
        id="pasteBox"
        className="input font-mono text-xs"
        rows={8}
        placeholder={"john@example.com\nanna@example.com, test@example.com; third@example.com"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="hint">
        Separate with new lines, commas, semicolons or spaces. `Name &lt;addr@example.com&gt;` is understood too.
      </p>
      <div>
        <button className="btn btn-primary" disabled={busy || text.trim().length === 0} onClick={submit}>
          {busy ? "Importing…" : "Import addresses"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- file */

function FileImport({
  listId, onDone, onError,
}: { listId: string; onDone: (s: Summary) => void; onError: (e: string) => void }) {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mapping, setMapping] = useState<ColumnRole[]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [isPlain, setIsPlain] = useState(false);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    setPreview(null);
    try {
      const plain = file.name.toLowerCase().endsWith(".txt");
      const body = new FormData();
      body.append("file", file);
      const result = await api<PreviewResponse>("/api/import/preview", { method: "POST", body });
      setIsPlain(plain && result.header.length < 2);
      setPreview(result);
      setMapping(result.mapping);
      setHasHeader(result.hasHeader);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not read that file");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api<{ summary: Summary }>("/api/import/file", {
        method: "POST",
        body: JSON.stringify({
          content: preview.content,
          delimiter: preview.delimiter,
          hasHeader,
          mapping,
          listId,
          plain: isPlain,
        }),
      });
      onDone(result.summary);
      setPreview(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const setRole = (index: number, role: ColumnRole) =>
    setMapping((prev) => {
      const next = [...prev];
      // Email maps to exactly one column, so selecting a new one clears the old.
      if (role === "email") {
        for (let i = 0; i < next.length; i++) if (next[i] === "email") next[i] = "ignore";
      }
      next[index] = role;
      return next;
    });

  const emailMapped = isPlain || mapping.includes("email");
  const delimiterLabel = preview?.delimiter === "\t" ? "Tab" : preview?.delimiter === ";" ? "Semicolon" : "Comma";

  return (
    <div className="grid gap-3">
      <div>
        <label className="label" htmlFor="fileInput">Step 1 — choose a .csv or .txt file</label>
        <input id="fileInput" className="input" type="file" accept=".csv,.txt,text/csv,text/plain"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }} />
        <p className="hint mt-1">UTF-8 is assumed. Maximum 10 MB.</p>
      </div>

      {busy && !preview ? <p className="hint">Reading file…</p> : null}

      {preview ? (
        <>
          <div className="card p-3 text-sm">
            <p className="font-medium">Step 2 — detected format</p>
            <p className="hint mt-1">
              Delimiter: <strong>{delimiterLabel}</strong> · {preview.totalRows} data row
              {preview.totalRows === 1 ? "" : "s"}
              {isPlain ? " · treating this as a plain address list" : ""}
            </p>
            {!isPlain ? (
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
                First row is a header
              </label>
            ) : null}
          </div>

          {!isPlain ? (
            <div className="card overflow-x-auto p-3">
              <p className="mb-2 text-sm font-medium">Step 3 &amp; 4 — preview and column mapping</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left">
                    {preview.header.map((label, index) => (
                      <th key={index} className="px-2 py-2 align-top">
                        <div className="font-medium">{label}</div>
                        <select
                          className="input mt-1 px-1 py-0.5 text-xs"
                          value={mapping[index] ?? "ignore"}
                          onChange={(e) => setRole(index, e.target.value as ColumnRole)}
                          aria-label={`Map column ${label}`}
                        >
                          {(Object.keys(ROLE_LABELS) as ColumnRole[]).map((role) => (
                            <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                          ))}
                        </select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.preview.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-b last:border-0">
                      {preview.header.map((_h, cellIndex) => (
                        <td key={cellIndex} className="px-2 py-1 whitespace-nowrap"
                          style={{ color: "var(--color-muted)" }}>
                          {row[cellIndex] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!emailMapped ? (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                  Map one column to Email — it is required.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy || !emailMapped} onClick={confirm}>
              {busy ? "Importing…" : `Import ${preview.totalRows} row${preview.totalRows === 1 ? "" : "s"}`}
            </button>
            <button className="btn" onClick={() => setPreview(null)} disabled={busy}>Cancel</button>
          </div>
        </>
      ) : null}
    </div>
  );
}
